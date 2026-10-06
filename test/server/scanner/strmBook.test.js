const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const fs = require('fs/promises')
const os = require('os')
const Path = require('path')
const Database = require('../../../server/Database')
const BookScanner = require('../../../server/scanner/BookScanner')
const LibraryItemScanner = require('../../../server/scanner/LibraryItemScanner')
const LibraryItemScanData = require('../../../server/scanner/LibraryItemScanData')
const ScanLogger = require('../../../server/scanner/ScanLogger')
const LibraryFile = require('../../../server/objects/files/LibraryFile')
const AudioMetaTags = require('../../../server/objects/metadata/AudioMetaTags')
const remoteAudio = require('../../../server/utils/remoteAudio')
const libraryFilters = require('../../../server/utils/queries/libraryFilters')
const Logger = require('../../../server/Logger')
const trackPlayback = require('../../../server/utils/trackPlayback')
const { getTrackId } = require('../../../server/utils/audioSource')
const PlaybackSessionManager = require('../../../server/managers/PlaybackSessionManager')

describe('STRM 书籍入库、缓存与重扫', () => {
  let directory, library, folder, file, previousSettings, previousServerSettings, previousDatabase, previousMetadataPath

  beforeEach(async () => {
    directory = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-strm-book-'))
    previousMetadataPath = global.MetadataPath
    global.MetadataPath = directory
    previousSettings = global.ServerSettings
    previousServerSettings = Database.serverSettings
    previousDatabase = Database.sequelize
    global.ServerSettings = {}
    Database.serverSettings = { scannerFindCovers: false }
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => str ? str[0].toUpperCase() + str.slice(1) : ''
    await Database.buildModels()
    library = await Database.libraryModel.create({ name: '有声书', mediaType: 'book', settings: Database.libraryModel.getDefaultLibrarySettingsForMediaType('book') })
    folder = await Database.libraryFolderModel.create({ libraryId: library.id, path: directory })
    await libraryFilters.getFilterData('book', library.id)
    await fs.writeFile(Path.join(directory, '001.strm'), 'https://example.com/audio.m4a')
    file = new LibraryFile()
    await file.setDataFromPath(Path.join(directory, '001.strm'), '001.strm')
    sinon.stub(BookScanner, 'saveMetadataFile').resolves()
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'debug')
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.close()
    Database.sequelize = previousDatabase
    Database.serverSettings = previousServerSettings
    global.ServerSettings = previousSettings
    global.MetadataPath = previousMetadataPath
    await fs.rm(directory, { recursive: true, force: true })
  })

  function scanData(files = [file]) {
    return new LibraryItemScanData({ libraryFolderId: folder.id, libraryId: library.id, mediaType: 'book', path: directory, relPath: '书名', isFile: false, libraryFiles: files, mediaMetadata: { title: '书名' } })
  }

  function validProbe(duration = 30) {
    return { audioStream: {}, duration, format: '音频容器', codec: 'aac', audioMetaTags: new AudioMetaTags(), remote: { mimeType: 'audio/mp4', size: 100000 } }
  }

  it('扫描不探测，播放时失败可重试，成功后缓存，强制重探失败保留有效信息', async () => {
    const probe = sinon.stub(remoteAudio, 'probe').resolves({ error: '来源暂时不可用' })
    const logger = new ScanLogger()
    const item = await BookScanner.scanNewBookLibraryItem(scanData(), library.settings, logger)
    expect(item).not.to.equal(null)
    let persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(probe.called).to.equal(false)
    expect(persisted.media.audioFiles[0].error).to.equal(null)
    expect(persisted.media.duration).to.equal(null)
    const id = getTrackId(file)
    try { await trackPlayback.ensureTrack(item.id, id) } catch (error) { expect(error.message).to.equal('来源暂时不可用') }
    persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(persisted.media.audioFiles[0].error).to.equal('来源暂时不可用')
    expect(persisted.media.audioFiles[0].metadata.path).to.equal(file.metadata.path)

    probe.resolves(validProbe())
    await trackPlayback.ensureTrack(item.id, id)
    persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(persisted.media.duration).to.equal(30)
    expect(persisted.media.audioFiles[0].error).to.equal(null)
    expect(persisted.media.audioFiles[0].mimeType).to.equal('audio/mp4')
    expect(persisted.media.audioFiles[0].remote.size).to.equal(100000)

    probe.resetHistory()
    await trackPlayback.ensureTrack(item.id, id)
    await BookScanner.rescanExistingBookLibraryItem(persisted, scanData(), library.settings, logger)
    expect(probe.called).to.equal(false)

    probe.resolves({ error: '网络故障' })
    try { await trackPlayback.ensureTrack(item.id, id, true) } catch (error) { expect(error.message).to.equal('网络故障') }
    persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(persisted.media.duration).to.equal(30)
    expect(persisted.media.audioFiles[0].error).to.equal('网络故障')
    expect(persisted.media.audioFiles[0].remote.mimeType).to.equal('audio/mp4')

    probe.resolves(validProbe(40))
    await trackPlayback.ensureTrack(item.id, id)
    persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(persisted.media.duration).to.equal(40)
    expect(persisted.media.audioFiles[0].error).to.equal(null)
    expect(persisted.id).to.equal(item.id)
  })

  it('根目录的单个引用文件可以手动重扫，保留文件型书籍身份', async () => {
    const probe = sinon.stub(remoteAudio, 'probe').resolves(validProbe())
    const data = scanData()
    data.path = file.metadata.path
    data.relPath = file.metadata.filename
    data.isFile = true
    data.ino = file.ino
    const item = await BookScanner.scanNewBookLibraryItem(data, library.settings, new ScanLogger())
    probe.resolves(validProbe(45))
    await LibraryItemScanner.scanLibraryItem(item.id)
    const persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(persisted.isFile).to.equal(true)
    expect(persisted.libraryFiles).to.have.length(1)
    expect(persisted.media.duration).to.equal(null)
    expect(probe.called).to.equal(false)
  })

  async function multipleFiles(count = 3) {
    const files = [file]
    for (let i = 2; i <= count; i++) {
      const name = `${String(i).padStart(3, '0')}.strm`
      const path = Path.join(directory, name)
      await fs.writeFile(path, `https://example.com/${i}.m4a`)
      const entry = new LibraryFile()
      await entry.setDataFromPath(path, name)
      files.push(entry)
    }
    return files
  }

  it('选择后面的音轨只探测该集，并发请求共用探测结果', async () => {
    const files = await multipleFiles(30)
    const probe = sinon.stub(remoteAudio, 'probe').callsFake(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return validProbe() })
    const item = await BookScanner.scanNewBookLibraryItem(scanData(files), library.settings, new ScanLogger())
    expect(probe.called).to.equal(false)
    const id = getTrackId(files[29])
    await Promise.all([trackPlayback.ensureTrack(item.id, id), trackPlayback.ensureTrack(item.id, id)])
    expect(probe.calledOnceWithExactly(files[29].metadata.path)).to.equal(true)
    const persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(persisted.media.duration).to.equal(null)
    expect(persisted.media.chapters).to.deep.equal([])
    expect(persisted.media.audioFiles.filter((track) => track.duration > 0)).to.have.length(1)
  })

  it('并发准备不同音轨时保留各自缓存，地址变化后重新探测', async () => {
    const files = await multipleFiles()
    const probe = sinon.stub(remoteAudio, 'probe').callsFake(async () => validProbe())
    const item = await BookScanner.scanNewBookLibraryItem(scanData(files), library.settings, new ScanLogger())
    await Promise.all(files.map((file) => trackPlayback.ensureTrack(item.id, getTrackId(file))))
    let persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(persisted.media.duration).to.equal(90)
    expect(persisted.media.audioFiles.every((track) => track.duration === 30)).to.equal(true)
    await fs.writeFile(file.metadata.path, 'https://example.com/changed.m4a')
    probe.resolves(validProbe(50))
    await trackPlayback.ensureTrack(item.id, getTrackId(file))
    persisted = await Database.libraryItemModel.getExpandedById(item.id)
    expect(probe.callCount).to.equal(4)
    expect(persisted.media.duration).to.equal(110)
  })

  it('按集进度入库后能续播，不因听完中间一集而标记整本完成', async () => {
    const files = await multipleFiles()
    const probe = sinon.stub(remoteAudio, 'probe').resolves(validProbe())
    let item = await BookScanner.scanNewBookLibraryItem(scanData(files), library.settings, new ScanLogger())
    const user = await Database.userModel.create({ username: '测试用户', type: 'root' })
    user.mediaProgresses = []
    sinon.stub(user, 'toJSONForPublic').returns({})
    const manager = new PlaybackSessionManager()
    const device = { id: '测试设备' }
    const options = { supportsTrackPlayback: true, supportedMimeTypes: ['audio/mp4'], trackId: getTrackId(files[1]) }
    let session = await manager.startSession(user, device, item, null, options)
    expect(session.audioTracks).to.have.length(1)
    expect(session.trackPlayback.index).to.equal(1)
    expect(session.audioTracks[0].startOffset).to.equal(0)
    expect(probe.calledOnceWithExactly(files[1].metadata.path)).to.equal(true)
    await manager.syncSession(user, session, { currentTime: 12, timeListened: 0 })
    const progress = await Database.mediaProgressModel.findOne({ where: { userId: user.id } })
    expect(progress.extraData.trackProgress.currentTime).to.equal(12)
    expect(progress.duration).to.equal(0)
    user.mediaProgresses = [progress]
    item = await Database.libraryItemModel.getExpandedById(item.id)
    session = await manager.startSession(user, device, item, null, { supportsTrackPlayback: true, supportedMimeTypes: ['audio/mp4'] })
    expect(session.currentTime).to.equal(12)
    expect(session.trackPlayback.trackId).to.equal(getTrackId(files[1]))
    await manager.syncSession(user, session, { currentTime: 30, timeListened: 0, finishedTrack: true })
    expect(user.getMediaProgress(item.media.id).isFinished).to.equal(false)
    session = await manager.startSession(user, device, item, null, { ...options, trackId: getTrackId(files[2]) })
    await manager.syncSession(user, session, { currentTime: 30, timeListened: 0, finishedTrack: true })
    expect(user.getMediaProgress(item.media.id).isFinished).to.equal(true)
    expect(user.getMediaProgress(item.media.id).getOldMediaProgress().progress).to.equal(1)
  })

  it('按集书签在相同秒数分别保存、更新及删除', async () => {
    const user = await Database.userModel.create({ username: '书签用户', type: 'root' })
    user.bookmarks = []
    await user.createBookmark('书籍', 10, '第一处', '第一集')
    await user.createBookmark('书籍', 10, '第二处', '第二集')
    expect(user.bookmarks).to.have.length(2)
    await user.updateBookmark('书籍', 10, '已更新', '第二集')
    await user.removeBookmark('书籍', 10, '第一集')
    expect(user.bookmarks).to.have.length(1)
    expect(user.bookmarks[0].title).to.equal('已更新')
  })

  it('较早的慢速选集请求不会关闭后来已创建的会话', async () => {
    const files = await multipleFiles()
    let resolveFirst
    const firstProbe = new Promise((resolve) => { resolveFirst = resolve })
    const probe = sinon.stub(remoteAudio, 'probe').callsFake((path) => path === file.metadata.path ? firstProbe : Promise.resolve(validProbe()))
    const item = await BookScanner.scanNewBookLibraryItem(scanData(files), library.settings, new ScanLogger())
    const user = { id: '用户', getMediaProgress: () => null, toJSONForPublic: () => ({}) }
    const manager = new PlaybackSessionManager()
    const options = { supportsTrackPlayback: true, supportedMimeTypes: ['audio/mp4'] }
    const first = manager.startSession(user, { id: '设备' }, item, null, { ...options, trackId: getTrackId(files[0]) }).catch((error) => error)
    while (!probe.called) await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await manager.startSession(user, { id: '设备' }, item, null, { ...options, trackId: getTrackId(files[1]) })
    resolveFirst(validProbe())
    expect((await first).status).to.equal(409)
    expect(manager.sessions.map((session) => session.id)).to.deep.equal([second.id])
  })

  it('后台补全继续处理其他音轨并提供失败计数', async () => {
    const files = await multipleFiles()
    sinon.stub(remoteAudio, 'probe').callsFake(async (path) => path === file.metadata.path ? { error: 'HTTP 403' } : validProbe())
    const item = await BookScanner.scanNewBookLibraryItem(scanData(files), library.settings, new ScanLogger())
    const job = trackPlayback.startProbeJob(item)
    while (job.status === 'running') await new Promise((resolve) => setTimeout(resolve, 10))
    expect(job.completed).to.equal(3)
    expect(job.failed).to.equal(1)
    expect(job.lastError).to.equal('HTTP 403')
    const updated = await Database.libraryItemModel.getExpandedById(item.id)
    expect(updated.media.audioFiles.filter((file) => file.duration > 0)).to.have.length(2)
  })
})
