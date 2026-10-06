const { createHash } = require('crypto')
const Database = require('../Database')
const remoteAudio = require('./remoteAudio')
const { isStrmFile, getTrackId, hasCompleteTimeline } = require('./audioSource')
const withBookAudioLock = require('./bookAudioLock')
const pending = new Map()
const jobs = new Map()

function playbackError(message, status = 422) {
  return Object.assign(new Error(message), { status })
}

function locateTime(tracks, time) {
  let offset = 0
  for (let index = 0; index < tracks.length; index++) {
    const track = tracks[index]
    if (time === offset) return { trackId: getTrackId(track), currentTime: 0 }
    if (!(track.duration > 0)) return null
    if (time < offset + track.duration || (index === tracks.length - 1 && time === offset + track.duration)) return { trackId: getTrackId(track), currentTime: time - offset }
    offset += track.duration
  }
  return null
}

function selectPosition(tracks, progress, options) {
  if (options.trackId !== undefined) {
    if (typeof options.trackId !== 'string' || !tracks.some((track) => getTrackId(track) === options.trackId)) throw playbackError('所选音轨不存在或已被移除')
    const time = options.trackTime === undefined ? 0 : options.trackTime
    if (!Number.isFinite(time) || time < 0) throw playbackError('集内播放时间无效')
    return { trackId: options.trackId, currentTime: time }
  }
  if (options.startTime !== undefined) {
    if (!Number.isFinite(options.startTime) || options.startTime < 0) throw playbackError('播放时间无效')
    if (options.startTime === 0) return { trackId: getTrackId(tracks[0]), currentTime: 0 }
    const position = locateTime(tracks, options.startTime)
    if (!position) throw playbackError('尚不能把整本时间定位到具体音轨，请从集数列表选择，或先补全远程音频信息')
    return position
  }
  if (!progress?.isFinished) {
    const position = progress?.extraData?.trackProgress
    if (position) {
      if (!tracks.some((track) => getTrackId(track) === position.trackId)) throw playbackError('上次播放的音轨已被移除或改名，请从集数列表重新选择')
      return { trackId: position.trackId, currentTime: Number.isFinite(position.currentTime) && position.currentTime >= 0 ? position.currentTime : 0 }
    }
    if (progress?.currentTime > 0) {
      const position = locateTime(tracks, progress.currentTime)
      if (!position) throw playbackError('旧进度使用整本时间，当前时长不足以定位；请先补全远程信息，或手动选择音轨。原进度已保留')
      return position
    }
  }
  return { trackId: getTrackId(tracks[0]), currentTime: 0 }
}

async function ensureTrack(libraryItemId, trackId, force = false) {
  const key = `${libraryItemId}:${trackId}`
  if (pending.has(key)) return pending.get(key)
  const work = prepareTrack(libraryItemId, trackId, force)
  pending.set(key, work)
  try {
    return await work
  } finally {
    pending.delete(key)
  }
}

async function prepareTrack(libraryItemId, trackId, force) {
  let item = await Database.libraryItemModel.getExpandedById(libraryItemId)
  const original = item?.media?.includedAudioFiles?.find((track) => getTrackId(track) === trackId)
  if (!original) throw playbackError('所选音轨不存在或已被移除', 404)
  if (!isStrmFile(original)) return item
  const sourceHash = createHash('sha256').update(await remoteAudio.readStrm(original.metadata.path)).digest('hex')
  if (!force && !original.error && original.duration > 0 && original.remote?.sourceHash === sourceHash && original.remote?.probeStatus !== 'pending') return item

  const LibraryFile = require('../objects/files/LibraryFile')
  const AudioFileScanner = require('../scanner/AudioFileScanner')
  const file = new LibraryFile()
  await file.setDataFromPath(original.metadata.path, original.metadata.relPath || original.metadata.filename)
  const scanned = await AudioFileScanner.scan('book', file, {}, { probeRemote: true })
  if (scanned.remote?.sourceHash !== sourceHash) throw playbackError('探测期间 STRM 地址发生变化，请重试')

  await withBookAudioLock(libraryItemId, async () => {
    item = await Database.libraryItemModel.getExpandedById(libraryItemId)
    const current = item?.media?.includedAudioFiles?.find((track) => getTrackId(track) === trackId)
    if (!current) throw playbackError('探测期间音轨被移除，请重新选择', 409)
    const currentHash = createHash('sha256').update(await remoteAudio.readStrm(current.metadata.path)).digest('hex')
    if (currentHash !== sourceHash) throw playbackError('探测期间 STRM 地址发生变化，请重试', 409)
    const updated = scanned.error && current.remote?.sourceHash === sourceHash && current.duration > 0
      ? { ...current, error: scanned.error, remote: { ...current.remote, probeStatus: 'failed' } }
      : { ...scanned.toJSON(), index: current.index, exclude: current.exclude, manuallyVerified: current.manuallyVerified, addedAt: current.addedAt, trackNumFromFilename: current.trackNumFromFilename, discNumFromFilename: current.discNumFromFilename }
    item.media.audioFiles = item.media.audioFiles.map((track) => getTrackId(track) === trackId ? updated : track)
    const included = item.media.includedAudioFiles
    item.media.duration = hasCompleteTimeline(included) ? included.reduce((sum, track) => sum + track.duration, 0) : null
    item.media.chapters = included.length ? AudioFileScanner.getBookChaptersFromAudioFiles(item.media.title, included, { addLog() {} }) : []
    item.media.changed('audioFiles', true)
    await item.media.save()
  })
  if (scanned.error) throw playbackError(scanned.error, 502)
  return item
}

function describe(item, trackId) {
  const tracks = item.media.includedAudioFiles
  const index = tracks.findIndex((track) => getTrackId(track) === trackId)
  return {
    trackId,
    index,
    total: tracks.length,
    totalDuration: hasCompleteTimeline(tracks) ? tracks.reduce((sum, track) => sum + track.duration, 0) : null,
    tracks: tracks.map((track) => ({ id: getTrackId(track), title: track.metadata.filename, duration: track.duration || null, error: track.error || null }))
  }
}

function progressPayload(item, position, currentTime, finishedTrack = false) {
  const tracks = item.media.includedAudioFiles
  const index = tracks.findIndex((track) => getTrackId(track) === position.trackId)
  if (index < 0) throw playbackError('正在播放的音轨已被移除', 409)
  const track = tracks[index]
  if (!(track.duration > 0)) throw playbackError('音轨已改变，请重新打开播放器获取信息', 409)
  const time = Math.min(Math.max(0, currentTime), track.duration)
  const complete = hasCompleteTimeline(tracks)
  const duration = complete ? tracks.reduce((sum, file) => sum + file.duration, 0) : 0
  const absoluteTime = complete ? tracks.slice(0, index).reduce((sum, file) => sum + file.duration, 0) + time : time
  const isFinished = finishedTrack && index === tracks.length - 1 && time >= track.duration - 1
  return {
    duration,
    currentTime: absoluteTime,
    progress: isFinished ? 1 : duration ? absoluteTime / duration : 0,
    isFinished,
    trackProgress: { trackId: position.trackId, currentTime: time, index, total: tracks.length, title: track.metadata.filename, duration: track.duration }
  }
}

function startProbeJob(item, force = false) {
  const existing = jobs.get(item.id)
  if (existing?.status === 'running') return existing
  const trackIds = item.media.includedAudioFiles.filter(isStrmFile).map(getTrackId)
  const job = { status: 'running', total: trackIds.length, completed: 0, failed: 0 }
  jobs.set(item.id, job)
  Promise.resolve().then(async () => {
    for (const id of trackIds) {
      if (job.status === 'cancelled') break
      try {
        await ensureTrack(item.id, id, force)
      } catch (error) {
        job.failed++
        job.lastError = error.status ? error.message : '无法探测音轨，请检查本地文件及来源配置'
      }
      job.completed++
    }
    try {
      const updated = await Database.libraryItemModel.getExpandedById(item.id)
      if (updated) require('../SocketAuthority').libraryItemEmitter('item_updated', updated)
    } catch {
      // 任务进度仍可通过接口读取，通知失败不覆盖已经保存的探测结果。
    }
    if (job.status !== 'cancelled') job.status = 'completed'
    const timer = setTimeout(() => { if (jobs.get(item.id) === job) jobs.delete(item.id) }, 3600000)
    timer.unref()
  })
  return job
}

module.exports = { ensureTrack, selectPosition, locateTime, describe, progressPayload, startProbeJob, getProbeJob: (id) => jobs.get(id) || { status: 'idle' }, cancelProbeJob: (id) => { const job = jobs.get(id); if (job?.status === 'running') job.status = 'cancelled'; return job || { status: 'idle' } } }
