const { expect } = require('chai')
const sinon = require('sinon')
const fs = require('fs')
const Path = require('path')
const vm = require('vm')
const ts = require('typescript')

describe('远程音频的网页播放错误处理', () => {
  let PlayerHandler, LocalAudioPlayer, ctx

  before(() => {
    LocalAudioPlayer = class {}
    const source = fs.readFileSync(Path.join(process.cwd(), 'client/players/PlayerHandler.js'), 'utf8')
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
    const exports = {}
    vm.runInNewContext(compiled.outputText, { exports, require: (name) => ({ default: name === './LocalAudioPlayer' ? LocalAudioPlayer : class {} }), console: { log() {}, error() {} }, clearInterval, setInterval }, { filename: 'PlayerHandler.js' })
    PlayerHandler = exports.default
  })

  beforeEach(() => {
    ctx = { $store: { state: { globals: { isCasting: false } }, commit: sinon.spy() }, $toast: { error: sinon.spy() }, $axios: { $post: sinon.stub() }, setPlaying: sinon.spy(), playerLoading: true }
  })

  afterEach(() => sinon.restore())

  it('远程播放失败停止加载并提示，不自动发起转码请求', () => {
    const handler = new PlayerHandler(ctx)
    handler.player = new LocalAudioPlayer()
    handler.hasRemoteAudio = true
    const prepare = sinon.stub(handler, 'prepare')
    handler.playerError()
    expect(prepare.called).to.equal(false)
    expect(ctx.playerLoading).to.equal(false)
    expect(ctx.setPlaying.calledWith(false)).to.equal(true)
    expect(ctx.$toast.error.calledOnce).to.equal(true)
  })

  it('本地音频播放失败仍使用现有转码回退', () => {
    const handler = new PlayerHandler(ctx)
    handler.player = new LocalAudioPlayer()
    const prepare = sinon.stub(handler, 'prepare')
    handler.playerError()
    expect(prepare.calledOnceWithExactly(true)).to.equal(true)
  })

  it('服务端拒绝播放时显示原因，不尝试读取不存在的会话', async () => {
    const handler = new PlayerHandler(ctx)
    handler.player = { playableMimeTypes: ['audio/mp4'] }
    handler.libraryItem = { id: 'book-id' }
    sinon.stub(handler, 'getDeviceId').returns('device-id')
    const prepareSession = sinon.stub(handler, 'prepareSession')
    ctx.$axios.$post.rejects({ response: { data: '远程音频尚未完成探测' } })
    await handler.prepare()
    expect(prepareSession.called).to.equal(false)
    expect(ctx.$toast.error.calledWith('远程音频尚未完成探测')).to.equal(true)
  })

  it('选集请求声明按集能力，携带文件标识和集内时间', async () => {
    const handler = new PlayerHandler(ctx)
    handler.player = { playableMimeTypes: ['audio/mp4'], pause: sinon.spy() }
    handler.libraryItem = { id: 'book-id' }
    handler.requestedTrack = { trackId: '第三集', trackTime: 12 }
    sinon.stub(handler, 'getDeviceId').returns('device-id')
    sinon.stub(handler, 'prepareSession')
    ctx.$axios.$post.resolves({ id: 'session-id' })
    await handler.prepare()
    const payload = ctx.$axios.$post.firstCall.args[1]
    expect(payload.supportsTrackPlayback).to.equal(true)
    expect(payload.trackId).to.equal('第三集')
    expect(payload.trackTime).to.equal(12)
  })

  it('当前集播放结束先保存集内位置，再请求下一集，不提前结束整本书', async () => {
    ctx.setCurrentTime = sinon.spy()
    ctx.mediaFinished = sinon.spy()
    const handler = new PlayerHandler(ctx)
    handler.player = { getCurrentTime: () => 30 }
    handler.trackPlayback = { index: 0, tracks: [{ id: '第一集' }, { id: '第二集' }] }
    const sync = sinon.stub(handler, 'sendProgressSync').resolves()
    const select = sinon.stub(handler, 'selectTrack').resolves()
    await handler.playerFinished()
    expect(sync.calledOnceWithExactly(30, true, true)).to.equal(true)
    expect(select.calledOnceWithExactly('第二集', 0, true)).to.equal(true)
    expect(ctx.mediaFinished.called).to.equal(false)
  })

  it('关闭按集播放器时，即使播放不足二十秒也保存位置', async () => {
    const handler = new PlayerHandler(ctx)
    handler.currentSessionId = 'session-id'
    handler.trackPlayback = { trackId: '第二集' }
    handler.player = { getCurrentTime: () => 12 }
    ctx.$axios.$post.resolves()
    await handler.sendCloseSession()
    expect(ctx.$axios.$post.firstCall.args[1]).to.deep.equal({ currentTime: 12, timeListened: 0 })
  })

  it('忽略较早请求迟到的响应，并关闭无用会话', async () => {
    const handler = new PlayerHandler(ctx)
    handler.player = { playableMimeTypes: [], pause() {} }
    handler.libraryItem = { id: 'book-id' }
    sinon.stub(handler, 'getDeviceId').returns('设备')
    const prepare = sinon.stub(handler, 'prepareSession')
    let resolveFirst
    ctx.$axios.$post.onFirstCall().returns(new Promise((resolve) => { resolveFirst = resolve }))
    ctx.$axios.$post.onSecondCall().resolves({ id: '新会话' })
    ctx.$axios.$post.onThirdCall().resolves()
    const first = handler.prepare()
    await handler.prepare()
    resolveFirst({ id: '旧会话' })
    await first
    expect(prepare.calledOnce).to.equal(true)
    expect(prepare.firstCall.args[0].id).to.equal('新会话')
    expect(ctx.$axios.$post.thirdCall.args[0]).to.equal('/api/session/旧会话/close')
  })

  it('最后一集结束后关闭播放器仍发送结束标记', async () => {
    ctx.setCurrentTime = sinon.spy()
    ctx.mediaFinished = sinon.spy()
    ctx.$axios.$post.resolves()
    const handler = new PlayerHandler(ctx)
    handler.currentSessionId = '会话'
    handler.player = { getCurrentTime: () => 30 }
    handler.trackPlayback = { index: 0, tracks: [{ id: '唯一一集' }] }
    await handler.playerFinished()
    await handler.sendCloseSession()
    expect(ctx.$axios.$post.secondCall.args[1].finishedTrack).to.equal(true)
  })
})
