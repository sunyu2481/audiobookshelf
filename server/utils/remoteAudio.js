const fs = require('fs/promises')
const http = require('http')
const https = require('https')
const { randomUUID } = require('crypto')
const { pipeline } = require('stream/promises')
const ssrfFilter = require('ssrf-req-filter')
const prober = require('./prober')
const { AudioMimeType } = require('./constants')

const MAX_STRM_BYTES = 16384
const REQUEST_TIMEOUT = 30000
const PROBE_TIMEOUT = 60000
const MAX_REDIRECTS = 5
const probeQueue = []
let activeProbes = 0

function sourceError(message, status = 502) {
  return Object.assign(new Error(message), { status })
}

function validateUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw sourceError('音频来源地址无效', 422)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\u0000-\u0020\u007f]/.test(value)) {
    throw sourceError('音频来源必须是无内嵌账号密码的 HTTP 或 HTTPS 地址', 422)
  }
  return url
}

function parseStrm(content) {
  const lines = content.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length !== 1) throw sourceError('STRM 文件必须只包含一条音频地址', 422)
  return validateUrl(lines[0]).href
}

async function readStrm(path) {
  const file = await fs.open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_STRM_BYTES) throw sourceError('STRM 文件过大或不是普通文件', 422)
    const buffer = Buffer.alloc(MAX_STRM_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_STRM_BYTES) throw sourceError('STRM 文件过大', 422)
    let content
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
    } catch {
      throw sourceError('STRM 文件必须使用 UTF-8 编码', 422)
    }
    return parseStrm(content)
  } finally {
    await file.close()
  }
}

// 每次跳转重新建立受保护的连接，不向网盘转发项目的登录凭据。
async function openRemote(urlString, { method = 'GET', headers = {}, signal, timeout = REQUEST_TIMEOUT } = {}) {
  let url = validateUrl(urlString)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http
      const agent = global.DisableSsrfRequestFilter?.(url.href) ? new transport.Agent() : ssrfFilter(url.href)
      let request
      let timer
      try {
        request = transport.request(url, { method, agent, signal, headers }, (res) => {
          clearTimeout(timer)
          resolve(res)
        })
        const abort = () => request.destroy(sourceError('远程音频请求超时', 504))
        timer = setTimeout(abort, timeout)
        request.setTimeout(timeout, abort)
        request.on('error', reject)
        request.on('close', () => {
          clearTimeout(timer)
          agent.destroy()
        })
        request.end()
      } catch (error) {
        clearTimeout(timer)
        agent.destroy()
        reject(error)
      }
    })

    if (![301, 302, 303, 307, 308].includes(response.statusCode)) return response
    response.destroy()
    if (redirects === MAX_REDIRECTS || !response.headers.location) throw sourceError('远程音频重定向次数过多或缺少目标地址')
    url = validateUrl(new URL(response.headers.location, url).href)
  }
}

// 同时供播放接口和探测用的本地入口使用，保持字节位置与上游一致。
async function proxyUrl(req, res, url, mimeType = null) {
  if (res.destroyed) return
  const controller = new AbortController()
  const cancel = () => controller.abort()
  res.on('close', cancel)
  try {
    if (!['GET', 'HEAD'].includes(req.method)) throw sourceError('不支持的音频请求方法', 405)
    const headers = { 'accept-encoding': 'identity', 'user-agent': process.env.STRM_USER_AGENT || 'audiobookshelf' }
    for (const name of ['range', 'if-range']) {
      if (req.headers[name]) headers[name] = req.headers[name]
    }
    const upstream = await openRemote(url, { method: req.method, headers, signal: controller.signal })
    const status = upstream.statusCode
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (status === 416) {
      if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range'])
      upstream.destroy()
      res.writeHead(416)
      res.end()
      return
    }
    const contentType = upstream.headers['content-type'] || ''
    if (![200, 206].includes(status) || /(?:text\/|json|mpegurl|dash\+xml)/i.test(contentType) || (upstream.headers['content-encoding'] && upstream.headers['content-encoding'] !== 'identity')) {
      upstream.destroy()
      throw sourceError([401, 403].includes(status) ? 'OpenList 或网盘拒绝访问音频，请检查来源授权' : '音频来源未返回可播放的音频文件')
    }
    for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      if (upstream.headers[name]) res.setHeader(name, upstream.headers[name])
    }
    res.setHeader('Content-Type', /^multipart\/byteranges/i.test(contentType) ? contentType : mimeType || contentType || 'application/octet-stream')
    res.statusCode = status
    if (req.method === 'HEAD') {
      upstream.destroy()
      res.end()
    } else {
      await pipeline(upstream, res)
    }
  } finally {
    controller.abort()
    res.removeListener('close', cancel)
  }
}

function sendError(res, error) {
  if (res.destroyed) return
  if (res.headersSent) return res.destroy()
  for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) res.removeHeader(name)
  // 不返回上游错误正文或异常对象，避免暴露签名地址和请求凭据。
  res.statusCode = error.status || (error.code === 'ENOENT' ? 404 : 502)
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'private, no-store')
  res.end(error.status ? error.message : '无法读取远程音频，请检查来源地址、网络及内网白名单')
}

async function serve(req, res, audioFile) {
  try {
    const url = await readStrm(typeof audioFile === 'string' ? audioFile : audioFile.metadata.path)
    await proxyUrl(req, res, url, audioFile?.remote?.mimeType || audioFile?.mimeType)
  } catch (error) {
    sendError(res, error)
  }
}

function getMimeType(formatName) {
  const formats = (formatName || '').split(',')
  if (formats.includes('wav')) return 'audio/wav'
  const names = { mov: 'MP4', asf: 'WMA', matroska: 'MKA', wav: 'WAV', amr: 'AWB' }
  for (const format of formats) {
    const mimeType = AudioMimeType[names[format] || format.toUpperCase()]
    if (mimeType) return mimeType
  }
  return null
}

async function probe(path, raw = false) {
  if (activeProbes >= 2) await new Promise((resolve) => probeQueue.push(resolve))
  else activeProbes++
  let server
  try {
    const url = await readStrm(path)
    const route = `/${randomUUID()}`
    server = http.createServer((req, res) => {
      if (req.url !== route) {
        res.writeHead(404)
        res.end()
        return
      }
      proxyUrl(req, res, url).catch((error) => sendError(res, error))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const options = {
      timeout: PROBE_TIMEOUT,
      // 限定为音频容器，禁止播放列表触发探测进程自行访问其他地址。
      inputOptions: ['-protocol_whitelist', 'http,tcp', '-format_whitelist', 'mov,mp3,flac,ogg,aac,asf,aiff,wav,matroska,amr,caf,mpeg']
    }
    const probeUrl = `http://127.0.0.1:${server.address().port}${route}`
    const result = raw ? await prober.rawProbe(probeUrl, options) : await prober.probe(probeUrl, false, options)
    if (result.error) throw sourceError('远程音频探测失败，请检查来源地址、网络、内网白名单及音频格式')
    if (!raw) {
      if (!result.audioStream || !Number.isFinite(result.duration) || result.duration <= 0) throw sourceError('远程音频没有有效的音轨或时长')
      result.remote = { mimeType: getMimeType(result.formatName), size: result.size }
      if (!result.remote.mimeType) throw sourceError('尚不支持此远程音频格式')
    }
    return result
  } catch (error) {
    return { error: error.status ? error.message : '远程音频探测失败，请检查来源地址、网络及内网白名单' }
  } finally {
    if (server) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    const next = probeQueue.shift()
    if (next) next()
    else activeProbes--
  }
}

module.exports = { parseStrm, readStrm, openRemote, serve, probe }
