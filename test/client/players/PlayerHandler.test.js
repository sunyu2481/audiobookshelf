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
})
