const uuidv4 = require('uuid').v4
const Path = require('path')
const serverVersion = require('../../package.json').version
const Logger = require('../Logger')
const SocketAuthority = require('../SocketAuthority')
const Database = require('../Database')

const date = require('../libs/dateAndTime')
const fs = require('../libs/fsExtra')
const uaParserJs = require('../libs/uaParser')
const requestIp = require('../libs/requestIp')

const { PlayMethod } = require('../utils/constants')

const PlaybackSession = require('../objects/PlaybackSession')
const DeviceInfo = require('../objects/DeviceInfo')
const Stream = require('../objects/Stream')
const { isStrmFile, getTrackId, hasCompleteTimeline } = require('../utils/audioSource')
const trackPlayback = require('../utils/trackPlayback')

class PlaybackSessionManager {
  constructor() {
    this.StreamsPath = Path.join(global.MetadataPath, 'streams')

    this.oldPlaybackSessionMap = {} // TODO: Remove after updated mobile versions

    /** @type {PlaybackSession[]} */
    this.sessions = []
    this.trackRequests = new Map()
  }

  /**
   * Get open session by id
   *
   * @param {string} sessionId
   * @returns {PlaybackSession}
   */
  getSession(sessionId) {
    return this.sessions.find((s) => s.id === sessionId)
  }
  getUserSession(userId) {
    return this.sessions.find((s) => s.userId === userId)
  }
  getStream(sessionId) {
    const session = this.getSession(sessionId)
    return session?.stream || null
  }

  /**
   *
   * @param {import('../controllers/LibraryItemController').LibraryItemControllerRequest} req
   * @param {Object} [clientDeviceInfo]
   * @returns {Promise<DeviceInfo>}
   */
  async getDeviceInfo(req, clientDeviceInfo = null) {
    const ua = uaParserJs(req.headers['user-agent'])
    const ip = requestIp.getClientIp(req)

    const deviceInfo = new DeviceInfo()
    deviceInfo.setData(ip, ua, clientDeviceInfo, serverVersion, req.user?.id)

    if (clientDeviceInfo?.deviceId) {
      const existingDevice = await Database.deviceModel.getOldDeviceByDeviceId(clientDeviceInfo.deviceId)
      if (existingDevice) {
        if (existingDevice.update(deviceInfo)) {
          await Database.deviceModel.updateFromOld(existingDevice)
        }
        return existingDevice
      }
    }

    await Database.deviceModel.createFromOld(deviceInfo)

    return deviceInfo
  }

  /**
   *
   * @param {import('../controllers/LibraryItemController').LibraryItemControllerRequest} req
   * @param {import('express').Response} res
   * @param {string} [episodeId]
   */
  async startSessionRequest(req, res, episodeId) {
    const deviceInfo = await this.getDeviceInfo(req, req.body?.deviceInfo)
    Logger.debug(`[PlaybackSessionManager] startSessionRequest for device ${deviceInfo.deviceDescription}`)
    const { libraryItem, body: options } = req
    try {
      const session = await this.startSession(req.user, deviceInfo, libraryItem, episodeId, options)
      res.json(session.toJSONForClient(libraryItem))
    } catch (error) {
      Logger.error('[PlaybackSessionManager] 无法创建播放会话', error.message)
      res.status(error.status || 500).send(error.status ? error.message : '无法创建播放会话')
    }
  }

  /**
   *
   * @param {import('../models/User')} user
   * @param {*} session
   * @param {*} payload
   * @param {import('express').Response} res
   */
  async syncSessionRequest(user, session, payload, res) {
    if (await this.syncSession(user, session, payload)) {
      res.sendStatus(200)
    } else {
      res.sendStatus(500)
    }
  }

  async syncLocalSessionsRequest(req, res) {
    const deviceInfo = await this.getDeviceInfo(req, req.body?.deviceInfo)
    const user = req.user
    const sessions = req.body.sessions || []

    const syncResults = []
    for (const sessionJson of sessions) {
      Logger.info(`[PlaybackSessionManager] Syncing local session "${sessionJson.displayTitle}" (${sessionJson.id}) (updatedAt: ${sessionJson.updatedAt})`)
      const result = await this.syncLocalSession(user, sessionJson, deviceInfo)
      syncResults.push(result)
    }

    res.json({
      results: syncResults
    })
  }

  /**
   *
   * @param {import('../models/User')} user
   * @param {*} sessionJson
   * @param {*} deviceInfo
   * @returns
   */
  async syncLocalSession(user, sessionJson, deviceInfo) {
    if (sessionJson.trackPlayback) return { id: sessionJson.id, success: false, error: '按集播放请通过在线会话同步进度' }
    // TODO: Combine libraryItem query with library query
    const libraryItem = await Database.libraryItemModel.getExpandedById(sessionJson.libraryItemId)
    const episode = sessionJson.episodeId && libraryItem && libraryItem.isPodcast ? libraryItem.media.podcastEpisodes.find((pe) => pe.id === sessionJson.episodeId) : null
    if (!libraryItem || (libraryItem.isPodcast && !episode)) {
      Logger.error(`[PlaybackSessionManager] syncLocalSession: Media item not found for session "${sessionJson.displayTitle}" (${sessionJson.id})`)
      return {
        id: sessionJson.id,
        success: false,
        error: 'Media item not found'
      }
    }

    const library = await Database.libraryModel.findByPk(libraryItem.libraryId)
    if (!library) {
      Logger.error(`[PlaybackSessionManager] syncLocalSession: Library not found for session "${sessionJson.displayTitle}" (${sessionJson.id})`)
      return {
        id: sessionJson.id,
        success: false,
        error: 'Library not found'
      }
    }

    sessionJson.userId = user.id
    sessionJson.serverVersion = serverVersion

    // TODO: Temp update local playback session id to uuidv4 & library item/book/episode ids
    if (sessionJson.id?.startsWith('play_local_')) {
      if (!this.oldPlaybackSessionMap[sessionJson.id]) {
        const newSessionId = uuidv4()
        this.oldPlaybackSessionMap[sessionJson.id] = newSessionId
        sessionJson.id = newSessionId
      } else {
        sessionJson.id = this.oldPlaybackSessionMap[sessionJson.id]
      }
    }
    if (sessionJson.libraryItemId !== libraryItem.id) {
      Logger.info(`[PlaybackSessionManager] Mapped old libraryItemId "${sessionJson.libraryItemId}" to ${libraryItem.id}`)
      sessionJson.libraryItemId = libraryItem.id
      sessionJson.bookId = episode ? null : libraryItem.media.id
    }
    if (!sessionJson.bookId && !episode) {
      sessionJson.bookId = libraryItem.media.id
    }
    if (episode && sessionJson.episodeId !== episode.id) {
      Logger.info(`[PlaybackSessionManager] Mapped old episodeId "${sessionJson.episodeId}" to ${episode.id}`)
      sessionJson.episodeId = episode.id
    }
    if (sessionJson.libraryId !== libraryItem.libraryId) {
      sessionJson.libraryId = libraryItem.libraryId
    }

    let session = await Database.getPlaybackSession(sessionJson.id)
    if (!session) {
      // New session from local
      session = new PlaybackSession(sessionJson)
      session.deviceInfo = deviceInfo

      if (session.mediaMetadata == null) {
        session.mediaMetadata = {}
      }

      // Populate mediaMetadata with the current library items metadata for any keys not set by client
      const libraryItemMediaMetadata = libraryItem.media.oldMetadataToJSON()
      for (const key in libraryItemMediaMetadata) {
        if (session.mediaMetadata[key] === undefined) {
          session.mediaMetadata[key] = libraryItemMediaMetadata[key]
        }
      }

      if (session.displayTitle == null || session.displayTitle === '') {
        session.displayTitle = libraryItem.title
      }
      if (session.displayAuthor == null || session.displayAuthor === '') {
        session.displayAuthor = libraryItem.authorNamesFirstLast
      }
      session.duration = libraryItem.media.getPlaybackDuration(sessionJson.episodeId)

      Logger.debug(`[PlaybackSessionManager] Inserting new session for "${session.displayTitle}" (${session.id})`)
      await Database.createPlaybackSession(session)
    } else {
      session.currentTime = sessionJson.currentTime
      session.timeListening = sessionJson.timeListening
      session.updatedAt = sessionJson.updatedAt

      let jsDate = new Date(sessionJson.updatedAt)
      if (isNaN(jsDate)) {
        jsDate = new Date()
      }
      session.date = date.format(jsDate, 'YYYY-MM-DD')
      session.dayOfWeek = date.format(jsDate, 'dddd')

      Logger.debug(`[PlaybackSessionManager] Updated session for "${session.displayTitle}" (${session.id})`)
      await Database.updatePlaybackSession(session)
    }

    const result = {
      id: session.id,
      success: true,
      progressSynced: false
    }

    const mediaItemId = session.episodeId || libraryItem.media.id
    let userProgressForItem = user.getMediaProgress(mediaItemId)
    if (userProgressForItem) {
      if (userProgressForItem.updatedAt.valueOf() > session.updatedAt) {
        Logger.info(`[PlaybackSessionManager] Not updating progress for "${session.displayTitle}" because it has been updated more recently (${userProgressForItem.updatedAt.valueOf()} > ${session.updatedAt}) (incoming currentTime: ${session.currentTime}) (current currentTime: ${userProgressForItem.currentTime})`)
      } else {
        Logger.info(`[PlaybackSessionManager] Updating progress for "${session.displayTitle}" with current time ${session.currentTime} (previously ${userProgressForItem.currentTime})`)
        const updateResponse = await user.createUpdateMediaProgressFromPayload({
          libraryItemId: libraryItem.id,
          episodeId: session.episodeId,
          ...session.mediaProgressObject,
          markAsFinishedPercentComplete: library.librarySettings.markAsFinishedPercentComplete,
          markAsFinishedTimeRemaining: library.librarySettings.markAsFinishedTimeRemaining
        })
        result.progressSynced = !!updateResponse.mediaProgress
        if (result.progressSynced) {
          userProgressForItem = updateResponse.mediaProgress
        }
      }
    } else {
      Logger.info(`[PlaybackSessionManager] Creating new media progress for media item "${session.displayTitle}"`)
      const updateResponse = await user.createUpdateMediaProgressFromPayload({
        libraryItemId: libraryItem.id,
        episodeId: session.episodeId,
        ...session.mediaProgressObject,
        markAsFinishedPercentComplete: library.librarySettings.markAsFinishedPercentComplete,
        markAsFinishedTimeRemaining: library.librarySettings.markAsFinishedTimeRemaining
      })
      result.progressSynced = !!updateResponse.mediaProgress
      if (result.progressSynced) {
        userProgressForItem = updateResponse.mediaProgress
      }
    }

    // Update user and emit socket event
    if (result.progressSynced) {
      SocketAuthority.clientEmitter(user.id, 'user_item_progress_updated', {
        id: userProgressForItem.id,
        sessionId: session.id,
        deviceDescription: session.deviceDescription,
        data: userProgressForItem.getOldMediaProgress()
      })
    }

    return result
  }

  /**
   *
   * @param {import('../controllers/SessionController').RequestWithUser} req
   * @param {*} res
   */
  async syncLocalSessionRequest(req, res) {
    const deviceInfo = await this.getDeviceInfo(req, req.body?.deviceInfo)
    const sessionJson = req.body
    const result = await this.syncLocalSession(req.user, sessionJson, deviceInfo)
    if (result.error) {
      res.status(500).send(result.error)
    } else {
      res.sendStatus(200)
    }
  }

  /**
   *
   * @param {import('../models/User')} user
   * @param {*} session
   * @param {*} syncData
   * @param {import('express').Response} res
   */
  async closeSessionRequest(user, session, syncData, res) {
    await this.closeSession(user, session, syncData)
    res.sendStatus(200)
  }

  /**
   *
   * @param {import('../models/User')} user
   * @param {DeviceInfo} deviceInfo
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {string|null} episodeId
   * @param {{forceDirectPlay?:boolean, forceTranscode?:boolean, mediaPlayer:string, supportedMimeTypes?:string[]}} options
   * @returns {Promise<PlaybackSession>}
   */
  async startSession(user, deviceInfo, libraryItem, episodeId, options) {
    const tracks = libraryItem.getTrackList(episodeId)
    const hasRemoteAudio = tracks.some(isStrmFile)
    if (hasRemoteAudio && options.supportsTrackPlayback === true) {
      return this.startTrackSession(user, deviceInfo, libraryItem, options)
    }
    if (hasRemoteAudio) {
      if (tracks.some((track) => isStrmFile(track) && (track.error || !Number.isFinite(track.duration) || track.duration <= 0))) {
        throw Object.assign(new Error('此客户端需要完整音频时长。请使用网页版按集播放，或在书籍页面执行“补全远程信息”后再试'), { status: 422 })
      }
      if (options.forceTranscode || (!options.forceDirectPlay && !libraryItem.media.checkCanDirectPlay(options.supportedMimeTypes, episodeId))) {
        throw Object.assign(new Error('当前播放器不支持此音频格式，STRM 音频暂不支持转码'), { status: 415 })
      }
    }
    // Close any sessions already open for user and device
    const userSessions = this.sessions.filter((playbackSession) => playbackSession.userId === user.id && playbackSession.deviceId === deviceInfo.id)
    for (const session of userSessions) {
      Logger.info(`[PlaybackSessionManager] startSession: Closing open session "${session.displayTitle}" for user "${user.username}" (Device: ${session.deviceDescription})`)
      await this.closeSession(user, session, null)
    }

    const shouldDirectPlay = options.forceDirectPlay || (!options.forceTranscode && libraryItem.media.checkCanDirectPlay(options.supportedMimeTypes, episodeId))
    const mediaPlayer = options.mediaPlayer || 'unknown'

    const mediaItemId = episodeId || libraryItem.media.id
    const userProgress = user.getMediaProgress(mediaItemId)
    let userStartTime = 0
    if (userProgress) {
      if (userProgress.isFinished) {
        Logger.info(`[PlaybackSessionManager] Starting session for user "${user.username}" and resetting progress for finished item "${libraryItem.media.title}"`)
        // Keep userStartTime as 0 so the client restarts the media
      } else {
        userStartTime = Number.parseFloat(userProgress.currentTime) || 0
        if (hasRemoteAudio && userProgress.extraData?.trackProgress) {
          const position = userProgress.extraData.trackProgress
          const index = tracks.findIndex((track) => getTrackId(track) === position.trackId)
          if (index < 0) throw Object.assign(new Error('上次播放的音轨已被移除，请从网页版重新选择'), { status: 422 })
          userStartTime = tracks.slice(0, index).reduce((sum, track) => sum + track.duration, 0) + position.currentTime
        }
      }
    }
    const newPlaybackSession = new PlaybackSession()
    newPlaybackSession.setData(libraryItem, user.id, mediaPlayer, deviceInfo, userStartTime, episodeId)

    let audioTracks = []
    if (shouldDirectPlay) {
      Logger.debug(`[PlaybackSessionManager] "${user.username}" starting direct play session for item "${libraryItem.id}" with id ${newPlaybackSession.id} (Device: ${newPlaybackSession.deviceDescription})`)
      audioTracks = libraryItem.getTrackList(episodeId)
      newPlaybackSession.playMethod = PlayMethod.DIRECTPLAY
    } else {
      Logger.debug(`[PlaybackSessionManager] "${user.username}" starting stream session for item "${libraryItem.id}" (Device: ${newPlaybackSession.deviceDescription})`)
      const stream = new Stream(newPlaybackSession.id, this.StreamsPath, user, libraryItem, episodeId, userStartTime)
      await stream.generatePlaylist()
      stream.start() // Start transcode

      audioTracks = [stream.getAudioTrack()]
      newPlaybackSession.stream = stream
      newPlaybackSession.playMethod = PlayMethod.TRANSCODE

      stream.on('closed', () => {
        Logger.debug(`[PlaybackSessionManager] Stream closed for session "${newPlaybackSession.id}" (Device: ${newPlaybackSession.deviceDescription})`)
        newPlaybackSession.stream = null
      })
    }
    newPlaybackSession.audioTracks = audioTracks

    this.sessions.push(newPlaybackSession)
    SocketAuthority.adminEmitter('user_stream_update', user.toJSONForPublic(this.sessions))

    return newPlaybackSession
  }

  async startTrackSession(user, deviceInfo, libraryItem, options) {
    const key = `${user.id}:${deviceInfo.id}`
    const request = Symbol()
    this.trackRequests.set(key, request)
    try {
      return await this.prepareTrackSession(user, deviceInfo, libraryItem, options, () => this.trackRequests.get(key) === request)
    } finally {
      if (this.trackRequests.get(key) === request) this.trackRequests.delete(key)
    }
  }

  async prepareTrackSession(user, deviceInfo, libraryItem, options, isCurrentRequest) {
    if (options.forceTranscode) throw Object.assign(new Error('STRM 音频暂不支持转码'), { status: 415 })
    const position = trackPlayback.selectPosition(libraryItem.media.includedAudioFiles, user.getMediaProgress(libraryItem.media.id), options)
    const prepared = await trackPlayback.ensureTrack(libraryItem.id, position.trackId)
    if (!isCurrentRequest()) throw Object.assign(new Error('此播放请求已被新的选集请求替代'), { status: 409 })
    libraryItem.media = prepared.media
    const file = libraryItem.media.includedAudioFiles.find((track) => getTrackId(track) === position.trackId)
    if (!options.forceDirectPlay && !options.supportedMimeTypes?.includes(file.mimeType)) throw Object.assign(new Error('当前播放器不支持此音轨格式，STRM 音频暂不支持转码'), { status: 415 })
    if (!(file.duration > 0)) throw Object.assign(new Error('当前音轨没有有效时长'), { status: 422 })
    for (const session of this.sessions.filter((session) => session.userId === user.id && session.deviceId === deviceInfo.id)) await this.closeSession(user, session)
    if (!isCurrentRequest()) throw Object.assign(new Error('此播放请求已被新的选集请求替代'), { status: 409 })
    const session = new PlaybackSession()
    session.setData(libraryItem, user.id, options.mediaPlayer || 'unknown', deviceInfo, Math.min(position.currentTime, Math.max(0, file.duration - 0.1)))
    session.trackPlayback = trackPlayback.describe(libraryItem, position.trackId)
    session.duration = file.duration
    session.chapters = file.chapters?.length ? structuredClone(file.chapters) : [{ id: 0, start: 0, end: file.duration, title: file.metadata.filename }]
    session.audioTracks = [{ ...structuredClone(file), id: position.trackId, index: 1, startOffset: 0, title: file.metadata.filename, contentUrl: `/api/items/${libraryItem.id}/file/${file.ino}` }]
    session.playMethod = PlayMethod.DIRECTPLAY
    this.sessions.push(session)
    SocketAuthority.libraryItemEmitter('item_updated', libraryItem)
    SocketAuthority.adminEmitter('user_stream_update', user.toJSONForPublic(this.sessions))
    return session
  }

  /**
   *
   * @param {import('../models/User')} user
   * @param {*} session
   * @param {*} syncData
   * @returns {Promise<boolean>}
   */
  async syncSession(user, session, syncData) {
    if (!syncData || !Number.isFinite(syncData.currentTime) || syncData.currentTime < 0 || !Number.isFinite(syncData.timeListened) || syncData.timeListened < 0) return false
    // TODO: Combine libraryItem query with library query
    const libraryItem = await Database.libraryItemModel.getExpandedById(session.libraryItemId)
    if (!libraryItem) {
      Logger.error(`[PlaybackSessionManager] syncSession Library Item not found "${session.libraryItemId}"`)
      return false
    }

    const library = await Database.libraryModel.findByPk(libraryItem.libraryId)
    if (!library) {
      Logger.error(`[PlaybackSessionManager] syncSession Library not found "${libraryItem.libraryId}"`)
      return false
    }

    session.currentTime = syncData.currentTime
    session.addListeningTime(syncData.timeListened)
    Logger.debug(`[PlaybackSessionManager] syncSession "${session.id}" (Device: ${session.deviceDescription}) | Total Time Listened: ${session.timeListening}`)

    let trackProgressPayload = {}
    if (session.trackPlayback) {
      if (!libraryItem.media.includedAudioFiles.some((track) => getTrackId(track) === session.trackPlayback.trackId && track.duration > 0)) return false
      trackProgressPayload = trackPlayback.progressPayload(libraryItem, session.trackPlayback, syncData.currentTime, syncData.finishedTrack === true)
    } else if (libraryItem.media.includedAudioFiles?.some(isStrmFile) && hasCompleteTimeline(libraryItem.media.includedAudioFiles)) {
      const position = trackPlayback.locateTime(libraryItem.media.includedAudioFiles, syncData.currentTime)
      if (position) trackProgressPayload.trackProgress = trackPlayback.progressPayload(libraryItem, position, position.currentTime).trackProgress
    }
    const updateResponse = await user.createUpdateMediaProgressFromPayload({
      libraryItemId: libraryItem.id,
      episodeId: session.episodeId,
      // duration no longer required (v2.15.1) but used if available
      duration: syncData.duration || session.duration || 0,
      currentTime: syncData.currentTime,
      progress: session.progress,
      markAsFinishedTimeRemaining: library.librarySettings.markAsFinishedTimeRemaining,
      markAsFinishedPercentComplete: library.librarySettings.markAsFinishedPercentComplete,
      ...trackProgressPayload
    })
    if (updateResponse.mediaProgress) {
      SocketAuthority.clientEmitter(user.id, 'user_item_progress_updated', {
        id: updateResponse.mediaProgress.id,
        sessionId: session.id,
        deviceDescription: session.deviceDescription,
        data: updateResponse.mediaProgress.getOldMediaProgress()
      })
    }
    this.saveSession(session)

    return true
  }

  /**
   *
   * @param {import('../models/User')} user
   * @param {*} session
   * @param {*} syncData
   * @returns
   */
  async closeSession(user, session, syncData = null) {
    if (syncData) {
      await this.syncSession(user, session, syncData)
    } else {
      await this.saveSession(session)
    }
    Logger.debug(`[PlaybackSessionManager] closeSession "${session.id}"`)
    SocketAuthority.adminEmitter('user_stream_update', user.toJSONForPublic(this.sessions))
    SocketAuthority.clientEmitter(session.userId, 'user_session_closed', session.id)
    return this.removeSession(session.id)
  }

  saveSession(session) {
    if (!session.timeListening) return // Do not save a session with no listening time

    if (session.lastSave) {
      return Database.updatePlaybackSession(session)
    } else {
      session.lastSave = Date.now()
      return Database.createPlaybackSession(session)
    }
  }

  /**
   *
   * @param {string} sessionId
   */
  async removeSession(sessionId) {
    const session = this.sessions.find((s) => s.id === sessionId)
    if (!session) return
    if (session.stream) {
      await session.stream.close()
    }
    this.sessions = this.sessions.filter((s) => s.id !== sessionId)
    Logger.debug(`[PlaybackSessionManager] Removed session "${sessionId}"`)
  }

  /**
   * Remove all stream folders in `/metadata/streams`
   */
  async removeOrphanStreams() {
    try {
      await fs.ensureDir(this.StreamsPath)
    } catch (error) {
      Logger.error(`[PlaybackSessionManager] Failed to create streams directory at "${this.StreamsPath}": ${error.message}`)
      throw new Error(`[PlaybackSessionManager] Failed to create streams directory at "${this.StreamsPath}"`, { cause: error })
    }
    try {
      const streamsInPath = await fs.readdir(this.StreamsPath)
      for (const streamId of streamsInPath) {
        if (/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/.test(streamId)) {
          // Ensure is uuidv4
          const session = this.sessions.find((se) => se.id === streamId)
          if (!session) {
            const streamPath = Path.join(this.StreamsPath, streamId)
            Logger.debug(`[PlaybackSessionManager] Removing orphan stream "${streamPath}"`)
            await fs.remove(streamPath)
          }
        }
      }
    } catch (error) {
      Logger.error(`[PlaybackSessionManager] cleanOrphanStreams failed`, error)
    }
  }

  /**
   * Close all open sessions that have not been updated in the last 36 hours
   */
  async closeStaleOpenSessions() {
    const updatedAtTimeCutoff = Date.now() - 1000 * 60 * 60 * 36
    const staleSessions = this.sessions.filter((session) => session.updatedAt < updatedAtTimeCutoff)
    for (const session of staleSessions) {
      const sessionLastUpdate = new Date(session.updatedAt)
      Logger.info(`[PlaybackSessionManager] Closing stale session "${session.displayTitle}" (${session.id}) last updated at ${sessionLastUpdate}`)
      await this.removeSession(session.id)
    }
  }
}
module.exports = PlaybackSessionManager
