const { expect } = require('chai')
const fs = require('fs/promises')
const os = require('os')
const Path = require('path')
const http = require('http')
const express = require('express')
const { spawnSync } = require('child_process')
const sinon = require('sinon')
const AudioFileScanner = require('../../../server/scanner/AudioFileScanner')
const LibraryItemScanData = require('../../../server/scanner/LibraryItemScanData')
const LibraryFile = require('../../../server/objects/files/LibraryFile')
const AudioFile = require('../../../server/objects/files/AudioFile')
const Book = require('../../../server/models/Book')
const Logger = require('../../../server/Logger')
const remoteAudio = require('../../../server/utils/remoteAudio')
const ffprobeProcess = require('../../../server/libs/nodeFfprobe')
const scanUtils = require('../../../server/utils/scandir')

describe('STRM 扫描与真实音频探测', function () {
  this.timeout(15000)
  let directory, server, sourceUrl, previousFilter, requests
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'

  before(async function () {
    if (spawnSync(ffmpeg, ['-version']).status !== 0 || spawnSync(ffprobe, ['-version']).status !== 0) this.skip()
    directory = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-strm-audio-'))
    for (const [filename, duration] of [['audio.m4a', '3'], ['audio.mp3', '2']]) {
      const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', duration, Path.join(directory, filename)])
      expect(result.status, result.stderr?.toString()).to.equal(0)
    }
    requests = []
    const app = express()
    app.use((req, res, next) => { requests.push(req.headers); next() })
    app.get('/d/:filename', (req, res) => res.redirect(`/media/${req.params.filename}?temporary=signature`))
    app.get('/forbidden', (req, res) => res.status(403).send('隐藏的上游错误正文'))
    app.get('/invalid', (req, res) => res.type('audio/mp4').send('这不是音频文件'))
    app.get('/truncated', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': 100000 })
      res.write('来源只发送了部分数据')
      setTimeout(() => res.destroy(), 20)
    })
    app.get('/hang', () => {})
    app.get('/media/:filename', (req, res) => res.sendFile(Path.join(directory, req.params.filename)))
    server = http.createServer(app)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    sourceUrl = `http://127.0.0.1:${server.address().port}`
  })

  beforeEach(() => {
    previousFilter = global.DisableSsrfRequestFilter
    global.DisableSsrfRequestFilter = (url) => new URL(url).hostname === '127.0.0.1'
    sinon.stub(Logger, 'error')
  })

  afterEach(() => {
    sinon.restore()
    global.DisableSsrfRequestFilter = previousFilter
  })

  after(async () => {
    if (server) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    if (directory) await fs.rm(directory, { recursive: true, force: true })
  })

  async function libraryFile(filename, source = 'audio.m4a') {
    const path = Path.join(directory, filename)
    await fs.writeFile(path, `${sourceUrl}/d/${source}\n`)
    const file = new LibraryFile()
    await file.setDataFromPath(path, filename)
    return file
  }

  it('扫描纯引用目录和根目录文件，识别大小写扩展名', async () => {
    const files = ['单本.STRM', '作者/书名/001.strm', '作者/书名/002.mp3'].map((path) => ({ name: Path.basename(path), reldirpath: Path.dirname(path) === '.' ? '' : Path.dirname(path), extension: Path.extname(path), deep: path.split('/').length - 1 }))
    expect(scanUtils.groupFileItemsIntoLibraryItemDirs('book', files, true)).to.deep.equal({ '单本.STRM': '单本.STRM', '作者/书名': ['001.strm', '002.mp3'] })
    expect(scanUtils.checkFilepathIsAudioFile('书名/001.STRM')).to.equal(true)
    const file = await libraryFile('001.STRM')
    expect(file.fileType).to.equal('audio')
    const data = new LibraryItemScanData({ libraryFiles: [file] })
    data.libraryFilesAdded = [file]
    data.libraryFilesModified = [{ old: file, new: file }]
    data.libraryFilesRemoved = [file]
    expect(data.audioLibraryFiles).to.have.length(1)
    expect(data.audioLibraryFilesAdded).to.have.length(1)
    expect(data.audioLibraryFilesModified).to.have.length(1)
    expect(data.checkAudioFileRemoved({ metadata: { path: file.metadata.path } })).to.equal(true)
  })

  it('通过重定向探测 M4A 与 MP3，保留本地身份并生成正确的多音轨时间轴', async () => {
    const firstFile = await libraryFile('001.strm')
    const secondFile = await libraryFile('002.strm', 'audio.mp3')
    const first = await AudioFileScanner.scan('book', firstFile, { title: '书名' }, { probeRemote: true })
    const second = await AudioFileScanner.scan('book', secondFile, { title: '书名' }, { probeRemote: true })
    expect(first.error).to.equal(null)
    expect(first.mimeType).to.equal('audio/mp4')
    expect(first.duration).to.be.closeTo(3, 0.1)
    expect(first.metadata.path).to.equal(firstFile.metadata.path)
    expect(first.metadata.size).to.equal(firstFile.metadata.size)
    expect(first.ino).to.equal(firstFile.ino)
    expect(first.remote.size).to.equal((await fs.stat(Path.join(directory, 'audio.m4a'))).size)
    expect(second.mimeType).to.equal('audio/mpeg')
    expect(second.duration).to.be.closeTo(2, 0.1)
    const ordered = AudioFileScanner.runSmartTrackOrder('书名', [second, first]).map((file) => JSON.parse(JSON.stringify(file)))
    const tracks = Book.prototype.getTracklist.call({ includedAudioFiles: ordered }, 'book-id')
    expect(tracks[0].metadata.filename).to.equal('001.strm')
    expect(tracks[0].startOffset).to.equal(0)
    expect(tracks[1].startOffset).to.equal(first.duration)
    expect(tracks[1].contentUrl).to.equal(`/api/items/book-id/file/${second.ino}`)
    expect(requests.some((headers) => headers.range)).to.equal(true)
    expect(JSON.stringify(ordered)).not.to.contain(sourceUrl)
  })

  it('默认扫描只校验本地引用，不向音频来源发送请求', async () => {
    const file = await libraryFile('快速扫描.strm')
    const before = requests.length
    const result = await AudioFileScanner.scan('book', file, {})
    expect(result.error).to.equal(null)
    expect(result.duration).to.equal(null)
    expect(result.remote.probeStatus).to.equal('pending')
    expect(requests).to.have.length(before)
  })

  it('探测失败保留待重试音轨，恢复后更新时长和媒体类型', async () => {
    const file = await libraryFile('003.strm')
    const probeStub = sinon.stub(remoteAudio, 'probe').resolves({ error: '来源暂时不可用' })
    const pending = await AudioFileScanner.scan('book', file, {}, { probeRemote: true })
    expect(pending.error).to.equal('来源暂时不可用')
    expect(pending.duration).to.equal(null)
    expect(pending.metadata.path).to.equal(file.metadata.path)
    probeStub.restore()
    const recovered = await AudioFileScanner.scan('book', file, {}, { probeRemote: true })
    const persisted = new AudioFile(JSON.parse(JSON.stringify(pending)))
    expect(persisted.updateFromScan(recovered)).to.equal(true)
    expect(persisted.error).to.equal(null)
    expect(persisted.mimeType).to.equal('audio/mp4')
    expect(persisted.clone().remote).to.deep.equal(recovered.remote)
    expect(persisted.duration).to.be.closeTo(3, 0.1)
  })

  it('普通本地音频仍使用本地探测流程', async () => {
    const file = new LibraryFile()
    await file.setDataFromPath(Path.join(directory, 'audio.mp3'), 'audio.mp3')
    const spy = sinon.spy(remoteAudio, 'probe')
    const audioFile = await AudioFileScanner.scan('book', file, {}, { probeRemote: true })
    expect(audioFile.error).to.equal(null)
    expect(audioFile.mimeType).to.equal('audio/mpeg')
    expect(audioFile.duration).to.be.closeTo(2, 0.1)
    expect(audioFile.toJSON()).not.to.have.property('remote')
    expect(spy.called).to.equal(false)
  })

  it('真实探测失败时保留内网拦截和 HTTP 状态，区别于无效音频', async () => {
    const file = await libraryFile('诊断.strm')
    global.DisableSsrfRequestFilter = undefined
    const blocked = await AudioFileScanner.scan('book', file, {}, { probeRemote: true })
    expect(blocked.error).to.contain('内网过滤器拦截').and.to.contain('SSRF_REQUEST_FILTER_WHITELIST')
    global.DisableSsrfRequestFilter = () => true
    await fs.writeFile(file.metadata.path, `${sourceUrl}/forbidden?secret=token`)
    const forbidden = await AudioFileScanner.scan('book', file, {}, { probeRemote: true })
    expect(forbidden.error).to.contain('HTTP 403').and.not.to.contain('secret').and.not.to.contain('隐藏的')
    await fs.writeFile(file.metadata.path, `${sourceUrl}/invalid`)
    expect((await remoteAudio.probe(file.metadata.path)).error).to.contain('FFprobe 无法识别')
    await fs.writeFile(file.metadata.path, `${sourceUrl}/truncated`)
    expect((await remoteAudio.probe(file.metadata.path)).error).to.contain('ECONNRESET')
  })

  it('探测进程超时携带可识别的错误代码', async () => {
    try {
      await ffprobeProcess(`${sourceUrl}/hang`, { timeout: 100 })
      expect.fail('探测应超时')
    } catch (error) {
      expect(error.code).to.equal('FFPROBE_TIMEOUT')
    }
  })
})
