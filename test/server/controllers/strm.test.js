const { expect } = require('chai')
const sinon = require('sinon')
const Database = require('../../../server/Database')
const LibraryItemController = require('../../../server/controllers/LibraryItemController')
const SessionController = require('../../../server/controllers/SessionController')
const ToolsController = require('../../../server/controllers/ToolsController')
const PlaybackSessionManager = require('../../../server/managers/PlaybackSessionManager')
const remoteAudio = require('../../../server/utils/remoteAudio')
const Logger = require('../../../server/Logger')
const { PlayMethod } = require('../../../server/utils/constants')
const StrmController = require('../../../server/controllers/StrmController')
const trackPlayback = require('../../../server/utils/trackPlayback')

describe('STRM 播放入口与能力限制', () => {
  let previousXAccel, previousMetadataPath, file, res

  beforeEach(() => {
    previousXAccel = global.XAccel
    previousMetadataPath = global.MetadataPath
    global.MetadataPath = '/tmp/abs-strm-tests'
    global.XAccel = '/internal'
    file = { ino: '1', index: 1, duration: 30, metadata: { path: '/books/001.strm', ext: '.strm', filename: '001.strm' }, remote: { mimeType: 'audio/mp4', size: 10000 }, mimeType: 'audio/mp4' }
    res = { status: sinon.stub().returnsThis(), send: sinon.stub().returnsThis(), sendStatus: sinon.stub(), sendFile: sinon.stub(), header: sinon.stub().returnsThis(), json: sinon.stub(), setHeader: sinon.stub() }
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'debug')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'warn')
  })

  afterEach(() => {
    sinon.restore()
    global.XAccel = previousXAccel
    global.MetadataPath = previousMetadataPath
  })

  it('文件播放接口通过代理返回远程音频，绕过本地加速发送', async () => {
    const serve = sinon.stub(remoteAudio, 'serve').resolves()
    const req = { libraryFile: file, libraryItem: { getAudioFileWithIno: () => file } }
    await LibraryItemController.getLibraryFile(req, res)
    expect(serve.calledOnceWithExactly(req, res, file)).to.equal(true)
    expect(res.sendFile.called).to.equal(false)
    expect(res.header.called).to.equal(false)
  })

  it('会话播放接口仅为有效会话和音轨调用代理', async () => {
    const serve = sinon.stub(remoteAudio, 'serve').resolves()
    sinon.stub(Database, 'userModel').get(() => ({ getUserById: async () => ({ username: '用户' }) }))
    const getSession = sinon.stub().returns({ userId: 'user-id', audioTracks: [file], playMethod: PlayMethod.DIRECTPLAY })
    const context = { playbackSessionManager: { getSession } }
    const req = { params: { id: 'session-id', index: '1' } }
    await SessionController.getTrack.call(context, req, res)
    expect(serve.calledOnceWithExactly(req, res, file)).to.equal(true)
    getSession.returns(null)
    await SessionController.getTrack.call(context, req, res)
    expect(res.sendStatus.calledWith(404)).to.equal(true)
    expect(serve.calledOnce).to.equal(true)
  })

  it('普通本地音轨仍通过原有文件接口发送', async () => {
    global.XAccel = null
    file.metadata.path = '/books/001.mp3'
    const serve = sinon.stub(remoteAudio, 'serve').resolves()
    await LibraryItemController.getLibraryFile({ libraryFile: file }, res)
    expect(serve.called).to.equal(false)
    expect(res.sendFile.calledWith('/books/001.mp3')).to.equal(true)
  })

  it('禁止下载引用文本，并保留原有下载权限检查', async () => {
    const req = { user: { canDownload: false, username: '用户' }, headers: {}, libraryFile: file, libraryItem: { libraryFiles: [file], media: { title: '书名' } } }
    await LibraryItemController.downloadLibraryFile(req, res)
    expect(res.sendStatus.calledWith(403)).to.equal(true)
    req.user.canDownload = true
    await LibraryItemController.downloadLibraryFile(req, res)
    expect(res.status.calledWith(409)).to.equal(true)
    expect(res.header.called).to.equal(false)
    await LibraryItemController.download(req, res)
    expect(res.status.alwaysCalledWith(409)).to.equal(true)
  })

  it('包含远程音轨的书籍不能合并或写入音频元数据', async () => {
    const req = { libraryItem: { libraryFiles: [file] } }
    await ToolsController.encodeM4b(req, res)
    await ToolsController.embedAudioFileMetadata(req, res)
    expect(res.status.callCount).to.equal(2)
    expect(res.status.alwaysCalledWith(409)).to.equal(true)
  })

  it('只有管理员能发起或取消整本后台补全', () => {
    const start = sinon.stub(trackPlayback, 'startProbeJob')
    const req = { user: { isAdminOrUp: false }, libraryItem: { mediaType: 'book', media: { includedAudioFiles: [file] } } }
    StrmController.start(req, res)
    StrmController.cancel(req, res)
    StrmController.status(req, res)
    expect(res.sendStatus.alwaysCalledWith(403)).to.equal(true)
    expect(start.called).to.equal(false)
  })

  it('预取只准备会话中紧邻的下一集，忽略请求中指定的其他音轨', async () => {
    const prepare = sinon.stub(trackPlayback, 'ensureTrack').resolves({})
    sinon.stub(trackPlayback, 'describe').returns({ tracks: [{ id: '下一集', duration: 30 }] })
    await StrmController.prepareNext({ body: { trackId: '其他书籍音轨' }, playbackSession: { libraryItemId: '书籍', trackPlayback: { index: 0, tracks: [{ id: '当前集' }, { id: '下一集' }] } } }, res)
    expect(prepare.calledOnceWithExactly('书籍', '下一集')).to.equal(true)
    expect(res.json.firstCall.args[0].id).to.equal('下一集')
  })

  function sessionInputs() {
    const user = { id: 'user-id', getMediaProgress: () => ({ currentTime: 12, isFinished: false }), toJSONForPublic: () => ({}) }
    const libraryItem = {
      id: 'book-id', libraryId: 'library-id', mediaType: 'book', getTrackList: () => [file],
      media: { id: 'media-id', title: '书名', checkCanDirectPlay: () => true, oldMetadataToJSON: () => ({}), getChapters: () => [], getPlaybackTitle: () => '书名', getPlaybackAuthor: () => '作者', getPlaybackDuration: () => 30 }
    }
    return { user, libraryItem, device: { id: 'device-id' } }
  }

  it('远程音轨使用原有直播放会话，继续从已保存的进度播放', async () => {
    const manager = new PlaybackSessionManager()
    const { user, libraryItem, device } = sessionInputs()
    const session = await manager.startSession(user, device, libraryItem, null, { supportedMimeTypes: ['audio/mp4'] })
    expect(session.playMethod).to.equal(PlayMethod.DIRECTPLAY)
    expect(session.currentTime).to.equal(12)
    expect(session.audioTracks[0]).to.equal(file)
    expect(session.stream).to.equal(null)
  })

  it('强制转码或未完成探测时返回明确错误，不启动转码也不关闭已有会话', async () => {
    const manager = new PlaybackSessionManager()
    const closeSession = sinon.stub(manager, 'closeSession')
    const { user, libraryItem, device } = sessionInputs()
    const existing = { id: 'existing', userId: user.id, deviceId: device.id }
    manager.sessions = [existing]
    for (const [options, expectedStatus] of [[{ forceTranscode: true }, 415], [{}, 422]]) {
      if (expectedStatus === 422) file.error = '探测失败'
      try {
        await manager.startSession(user, device, libraryItem, null, options)
        throw new Error('应当拒绝此播放请求')
      } catch (error) {
        expect(error.status).to.equal(expectedStatus)
      }
    }
    expect(closeSession.called).to.equal(false)
    expect(manager.sessions).to.deep.equal([existing])
  })
})
