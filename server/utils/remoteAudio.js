const fs = require('fs/promises')
const http = require('http')
const https = require('https')
const { isIP } = require('net')
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

function requestError(error, url) {
  const blockedAddress = /^Call to (.+) is blocked\.$/.exec(error.message || '')?.[1]
  if (blockedAddress && isIP(blockedAddress)) {
    return sourceError(`远程音频请求被内网过滤器拦截（${url.origin}），请将 ${url.hostname} 加入 SSRF_REQUEST_FILTER_WHITELIST，只填写主机或 IP，不含协议、端口和路径`)
  }
  if (error.status) return sourceError(`${error.message}（${url.origin}）`, error.status)
  const reasons = {
    ENOTFOUND: '无法解析来源主机',
    EAI_AGAIN: '来源主机的 DNS 解析暂时失败',
    ECONNREFUSED: '来源拒绝连接，请检查地址、端口及服务是否启动',
    EHOSTUNREACH: '无法到达来源主机，请检查容器网络和路由',
    ENETUNREACH: '无法到达来源网络，请检查容器网络和路由',
    ETIMEDOUT: '连接来源超时',
    ECONNRESET: '来源连接被重置',
    ERR_STREAM_PREMATURE_CLOSE: '来源在音频传输完成前关闭连接',
    CERT_HAS_EXPIRED: '来源 HTTPS 证书已过期',
    DEPTH_ZERO_SELF_SIGNED_CERT: '来源 HTTPS 证书不受信任',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证来源 HTTPS 证书',
    ERR_TLS_CERT_ALTNAME_INVALID: '来源 HTTPS 证书与主机名不匹配'
  }
  const reason = reasons[error.code]
  return sourceError(`远程音频请求失败（${url.origin}）：${reason ? `${reason}（${error.code}）` : '连接或传输异常，请检查容器到来源的网络'}`, error.code === 'ETIMEDOUT' ? 504 : 502)
}

function probeError(error) {
  if (error?.code === 'FFPROBE_TIMEOUT') return sourceError('远程音频探测超时（60 秒），请检查来源速度及范围读取支持', 504)
  if (error?.code === 'FFPROBE_OUTPUT_LIMIT') return sourceError('远程音频探测结果过大，超出读取限制')
  if (error?.code === 'ENOENT') return sourceError('无法启动 FFprobe，请检查安装及 FFPROBE_PATH 配置')
  return sourceError('FFprobe 无法识别远程音频，请检查来源是否返回完整音频及受支持的音频格式')
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
    }).catch((error) => { throw requestError(error, url) })

    if (![301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.remoteAudioOrigin = url.origin
      return response
    }
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
    if (![200, 206].includes(status)) {
      upstream.destroy()
      const reason = [401, 403].includes(status) ? 'OpenList 或网盘拒绝访问音频，请检查来源授权、下载代理及 STRM_USER_AGENT' : '音频来源请求失败，请检查文件是否存在及 OpenList 状态'
      throw sourceError(`${reason}（HTTP ${status}，${upstream.remoteAudioOrigin}）`)
    }
    if (/(?:text\/|json|mpegurl|dash\+xml)/i.test(contentType)) {
      upstream.destroy()
      throw sourceError(`音频来源返回了网页、文本、JSON 或播放列表，请检查是否为直接下载地址（${upstream.remoteAudioOrigin}）`)
    }
    if (upstream.headers['content-encoding'] && upstream.headers['content-encoding'] !== 'identity') {
      upstream.destroy()
      throw sourceError(`音频来源返回了压缩响应，无法保证范围读取正确，请检查下载代理配置（${upstream.remoteAudioOrigin}）`)
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
      let transferError
      const rememberError = (error) => {
        // 在管道关闭客户端之前记录来源故障，区别于探测器主动停止读取。
        if (!controller.signal.aborted) transferError = requestError(error, new URL(upstream.remoteAudioOrigin))
      }
      upstream.on('error', rememberError)
      try {
        await pipeline(upstream, res)
      } catch (error) {
        throw transferError || error
      } finally {
        upstream.removeListener('error', rememberError)
      }
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
    let proxyError
    server = http.createServer((req, res) => {
      if (req.url !== route) {
        res.writeHead(404)
        res.end()
        return
      }
      proxyUrl(req, res, url).catch((error) => {
        // 保留已脱敏的来源错误，避免被探测器的通用 HTTP 错误覆盖。
        if (error.status && !proxyError) proxyError = error
        sendError(res, error)
      })
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
    if (result.error) throw proxyError || probeError(result.error)
    if (!raw) {
      if (!result.audioStream || !Number.isFinite(result.duration) || result.duration <= 0) throw sourceError('远程音频没有有效的音轨或时长')
      result.remote = { mimeType: getMimeType(result.formatName), size: result.size }
      if (!result.remote.mimeType) throw sourceError('尚不支持此远程音频格式')
    }
    return result
  } catch (error) {
    const fileErrors = { ENOENT: 'STRM 文件不存在，请检查挂载路径', EACCES: '无法读取 STRM 文件，请检查文件权限', EPERM: '无法读取 STRM 文件，请检查文件权限' }
    return { error: error.status ? error.message : fileErrors[error.code] || '无法准备远程音频探测，请检查 STRM 文件及本地探测服务' }
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
