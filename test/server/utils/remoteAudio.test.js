const { expect } = require('chai')
const fs = require('fs/promises')
const os = require('os')
const Path = require('path')
const http = require('http')
const express = require('express')
const sinon = require('sinon')
const remoteAudio = require('../../../server/utils/remoteAudio')
const prober = require('../../../server/utils/prober')

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('远程音频代理', () => {
  let directory, source, gateway, sourceUrl, gatewayUrl, strmPath, previousFilter, upstreamRequests
  const audio = Buffer.from('0123456789abcdef')

  beforeEach(async () => {
    previousFilter = global.DisableSsrfRequestFilter
    global.DisableSsrfRequestFilter = (url) => new URL(url).hostname === '127.0.0.1'
    directory = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-strm-'))
    strmPath = Path.join(directory, '001.strm')
    upstreamRequests = []
    const app = express()
    app.use((req, res) => {
      upstreamRequests.push({ url: req.url, headers: req.headers, method: req.method })
      if (req.path === '/redirect') return res.redirect('/音频%20一.m4a?sign=private')
      if (req.path === '/blocked') return res.redirect(`http://localhost:${source.address().port}/audio.m4a`)
      if (req.path === '/loop') return res.redirect('/loop')
      if (req.path === '/forbidden') return res.status(403).send('不能泄漏的上游错误和签名')
      if (req.path === '/missing') return res.status(404).send('不能泄漏的上游路径')
      if (req.path === '/html') return res.send('<html>登录页面</html>')
      if (req.path === '/compressed') return res.set('Content-Encoding', 'gzip').end(audio)
      res.setHeader('Content-Type', 'audio/mp4')
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('ETag', '"v1"')
      res.setHeader('Set-Cookie', 'upstream-secret=value')
      if (req.headers.range) {
        if (req.headers.range === 'bytes=100-') return res.status(416).set('Content-Range', `bytes */${audio.length}`).end()
        res.status(206).set('Content-Range', `bytes 2-5/${audio.length}`)
        return res.end(audio.subarray(2, 6))
      }
      res.setHeader('Content-Length', audio.length)
      res.end(audio)
    })
    source = http.createServer(app)
    sourceUrl = await listen(source)
    await fs.writeFile(strmPath, `${sourceUrl}/audio.m4a`)
    gateway = http.createServer((req, res) => remoteAudio.serve(req, res, { metadata: { path: strmPath }, remote: { mimeType: 'audio/mp4' } }))
    gatewayUrl = await listen(gateway)
  })

  afterEach(async () => {
    sinon.restore()
    global.DisableSsrfRequestFilter = previousFilter
    for (const server of [gateway, source]) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('保留地址编码、查询参数并接受字节序标记和空行', () => {
    const url = `${sourceUrl}/d/quark/%E5%A4%A7%E9%81%93%20001.m4a?sign=a%2Bb`
    expect(remoteAudio.parseStrm(`\uFEFF\r\n ${url}\r\n`)).to.equal(url)
    for (const value of ['', 'file:///etc/passwd', 'ftp://example.com/a.mp3', 'https://user:pass@example.com/a.mp3', 'https://example.com/a\nhttps://example.com/b']) {
      expect(() => remoteAudio.parseStrm(value)).to.throw()
    }
  })

  it('拒绝超大引用文件', async () => {
    await fs.writeFile(strmPath, 'a'.repeat(16385))
    const result = await request(gatewayUrl)
    expect(result.status).to.equal(422)
    expect(upstreamRequests).to.have.length(0)
  })

  it('拒绝无效的 UTF-8 编码', async () => {
    await fs.writeFile(strmPath, Buffer.from([0xff, 0xfe]))
    expect((await request(gatewayUrl)).status).to.equal(422)
    expect(upstreamRequests).to.have.length(0)
  })

  it('返回真实音频并且每次请求重新读取引用文件', async () => {
    const first = await request(gatewayUrl)
    expect(first.status).to.equal(200)
    expect(first.body.equals(audio)).to.equal(true)
    expect(first.headers['content-type']).to.equal('audio/mp4')
    expect(first.headers['set-cookie']).to.equal(undefined)
    expect(first.headers['cache-control']).to.contain('no-store')
    await fs.writeFile(strmPath, `${sourceUrl}/updated.m4a`)
    await request(gatewayUrl)
    expect(upstreamRequests[1].url).to.equal('/updated.m4a')
  })

  it('经过跳转后保留范围请求，不转发项目令牌和浏览器凭据', async () => {
    await fs.writeFile(strmPath, `${sourceUrl}/redirect`)
    const result = await request(gatewayUrl, { headers: { Range: 'bytes=2-5', 'If-Range': '"v1"', Authorization: 'Bearer project-secret', Cookie: 'project-secret', Referer: 'https://project.example/' } })
    expect(result.status).to.equal(206)
    expect(result.body.toString()).to.equal('2345')
    expect(result.headers['content-range']).to.equal('bytes 2-5/16')
    expect(upstreamRequests).to.have.length(2)
    expect(upstreamRequests[1].url).to.equal('/%E9%9F%B3%E9%A2%91%20%E4%B8%80.m4a?sign=private')
    for (const req of upstreamRequests) {
      expect(req.headers.range).to.equal('bytes=2-5')
      expect(req.headers['if-range']).to.equal('"v1"')
      expect(req.headers['accept-encoding']).to.equal('identity')
      expect(req.headers.authorization).to.equal(undefined)
      expect(req.headers.cookie).to.equal(undefined)
      expect(req.headers.referer).to.equal(undefined)
    }
  })

  it('支持头部请求和超出文件范围的请求', async () => {
    const head = await request(gatewayUrl, { method: 'HEAD' })
    expect(head.status).to.equal(200)
    expect(head.headers['content-length']).to.equal('16')
    expect(head.body.length).to.equal(0)
    expect(upstreamRequests[0].method).to.equal('HEAD')
    const range = await request(gatewayUrl, { headers: { Range: 'bytes=100-' } })
    expect(range.status).to.equal(416)
    expect(range.headers['content-range']).to.equal('bytes */16')
  })

  it('没有白名单时阻止内网访问，跳转后重新检查目标', async () => {
    global.DisableSsrfRequestFilter = undefined
    expect((await request(gatewayUrl)).status).to.equal(502)
    expect(upstreamRequests).to.have.length(0)
    global.DisableSsrfRequestFilter = (url) => new URL(url).hostname === '127.0.0.1'
    await fs.writeFile(strmPath, `${sourceUrl}/blocked`)
    expect((await request(gatewayUrl)).status).to.equal(502)
    expect(upstreamRequests).to.have.length(1)
  })

  it('拒绝重定向循环、上游鉴权错误和登录页面，隐藏上游错误内容', async () => {
    for (const path of ['/loop', '/forbidden', '/html']) {
      await fs.writeFile(strmPath, `${sourceUrl}${path}`)
      const result = await request(gatewayUrl)
      expect(result.status).to.equal(502)
      expect(result.body.toString()).not.to.contain('不能泄漏')
      expect(result.body.toString()).not.to.contain('<html>')
    }
  })

  it('没有响应的上游会超时', async () => {
    source.removeAllListeners('request')
    source.on('request', () => {})
    try {
      await remoteAudio.openRemote(`${sourceUrl}/hang`, { timeout: 40 })
      throw new Error('请求应当超时')
    } catch (error) {
      expect(error.status).to.equal(504)
    }
  })

  it('客户端停止读取时取消上游传输', async () => {
    source.removeAllListeners('request')
    let closed
    const upstreamClosed = new Promise((resolve) => { closed = resolve })
    source.on('request', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mp4' })
      const timer = setInterval(() => res.write(audio), 10)
      res.on('close', () => {
        clearInterval(timer)
        closed()
      })
    })
    await new Promise((resolve, reject) => {
      const req = http.get(gatewayUrl, (res) => {
        res.once('data', () => {
          req.destroy()
          resolve()
        })
      })
      req.on('error', reject)
    })
    await upstreamClosed
  })

  it('探测只通过临时本地入口读取音频，并在完成后关闭入口', async () => {
    let probeUrl
    sinon.stub(prober, 'probe').callsFake(async (url, verbose, options) => {
      probeUrl = url
      expect(new URL(url).hostname).to.equal('127.0.0.1')
      expect(options.timeout).to.be.greaterThan(0)
      expect(options.inputOptions).to.include('-format_whitelist')
      const result = await request(url, { headers: { Range: 'bytes=2-5' } })
      expect(result.body.toString()).to.equal('2345')
      return { duration: 5, audioStream: {}, formatName: 'mov,mp4,m4a,3gp,3g2,mj2', size: 16 }
    })
    const result = await remoteAudio.probe(strmPath)
    expect(result.remote).to.deep.equal({ mimeType: 'audio/mp4', size: 16 })
    try {
      await request(probeUrl)
      throw new Error('探测入口应已关闭')
    } catch (error) {
      expect(['ECONNREFUSED', 'ECONNRESET']).to.include(error.code)
    }
  })

  it('探测保留来源错误及跳转后的主机，不泄漏来源路径、签名和响应正文', async () => {
    const probeStub = sinon.stub(prober, 'probe').callsFake(async (url) => {
      await request(url)
      return { error: 'HTTP 错误，附带不应输出的签名 sign=secret' }
    })
    sinon.stub(prober, 'rawProbe').callsFake((url) => probeStub(url))
    for (const raw of [false, true]) {
      for (const [path, message, host] of [
        ['/blocked', '内网过滤器拦截', 'localhost'],
        ['/forbidden', 'HTTP 403', sourceUrl],
        ['/missing', 'HTTP 404', sourceUrl],
        ['/html', '网页、文本、JSON', sourceUrl],
        ['/compressed', '压缩响应', sourceUrl]
      ]) {
        await fs.writeFile(strmPath, `${sourceUrl}${path}?sign=secret`)
        const result = await remoteAudio.probe(strmPath, raw)
        expect(result.error).to.contain(message).and.to.contain(host)
        expect(result.error).not.to.contain('sign=').and.not.to.contain('不能泄漏').and.not.to.contain('<html>').and.not.to.contain(path)
      }
    }
  })

  it('未配置白名单时提示应放行的主机及配置格式', async () => {
    global.DisableSsrfRequestFilter = undefined
    sinon.stub(prober, 'probe').callsFake(async (url) => {
      await request(url)
      return { error: 'HTTP 错误' }
    })
    const result = await remoteAudio.probe(strmPath)
    expect(result.error).to.contain('127.0.0.1').and.to.contain('SSRF_REQUEST_FILTER_WHITELIST').and.to.contain('不含协议、端口和路径')
    expect(upstreamRequests).to.have.length(0)
  })

  it('连接拒绝与 DNS 失败保留安全的错误代码，不输出原始异常', async () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      const stub = sinon.stub(http, 'request').throws(Object.assign(new Error('签名地址 http://example.com/private?secret=token'), { code }))
      try {
        await remoteAudio.openRemote(`${sourceUrl}/private?secret=token`)
        expect.fail('请求应失败')
      } catch (error) {
        expect(error.message).to.contain(code).and.to.contain(sourceUrl)
        expect(error.message).not.to.contain('private').and.not.to.contain('secret').and.not.to.contain('token')
      } finally {
        stub.restore()
      }
    }
  })

  it('区分探测超时、缺少程序和无法识别的音频，隐藏探测器原始异常', async () => {
    const stub = sinon.stub(prober, 'probe')
    for (const [error, message] of [
      [{ code: 'FFPROBE_TIMEOUT' }, '探测超时'],
      [{ code: 'FFPROBE_OUTPUT_LIMIT' }, '探测结果过大'],
      [{ code: 'ENOENT' }, '无法启动 FFprobe'],
      ['无法识别 http://example.com/audio?secret=token', 'FFprobe 无法识别']
    ]) {
      stub.resolves({ error })
      const result = await remoteAudio.probe(strmPath)
      expect(result.error).to.contain(message).and.not.to.contain('secret').and.not.to.contain('example.com')
    }
  })

  it('STRM 文件不存在时提示挂载路径，区别于缺少探测程序', async () => {
    await fs.unlink(strmPath)
    expect((await remoteAudio.probe(strmPath)).error).to.contain('STRM 文件不存在')
  })
})
