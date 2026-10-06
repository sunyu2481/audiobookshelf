//
// node-ffprobe modified for audiobookshelf
// SOURCE: https://github.com/ListenerApproved/node-ffprobe
//

const spawn = require('child_process').spawn

module.exports = (function () {
  function doProbe(file, options = {}) {
    return new Promise((resolve, reject) => {
      let proc = spawn(module.exports.FFPROBE_PATH || 'ffprobe', ['-hide_banner', '-loglevel', 'fatal', '-show_error', '-show_format', '-show_streams', '-show_programs', '-show_chapters', '-show_private_data', '-print_format', 'json', ...(options.inputOptions || []), file])
      let probeData = []
      let errData = []
      let outputBytes = 0
      const timer = options.timeout
        ? setTimeout(() => {
            proc.kill('SIGKILL')
            reject(Object.assign(new Error('音频探测超时'), { code: 'FFPROBE_TIMEOUT' }))
          }, options.timeout)
        : null

      proc.stdout.setEncoding('utf8')
      proc.stderr.setEncoding('utf8')

      proc.stdout.on('data', function (data) {
        outputBytes += Buffer.byteLength(data)
        if (options.timeout && outputBytes > 8 * 1024 * 1024) {
          proc.kill('SIGKILL')
          reject(Object.assign(new Error('音频探测结果过大'), { code: 'FFPROBE_OUTPUT_LIMIT' }))
          return
        }
        probeData.push(data)
      })
      proc.stderr.on('data', function (data) {
        if (!options.timeout) errData.push(data)
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      proc.on('close', () => {
        clearTimeout(timer)
        try {
          resolve(JSON.parse(probeData.join('')))
        } catch (err) {
          reject(err)
        }
      })
    })
  }

  return doProbe
})()
