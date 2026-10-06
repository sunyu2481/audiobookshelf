const trackPlayback = require('../utils/trackPlayback')
const { isStrmFile } = require('../utils/audioSource')

function check(req, res, admin = false) {
  if (admin && !req.user.isAdminOrUp) {
    res.sendStatus(403)
    return false
  }
  if (req.libraryItem.mediaType !== 'book' || !req.libraryItem.media.includedAudioFiles.some(isStrmFile)) {
    res.status(422).send('此书籍没有 STRM 音轨')
    return false
  }
  return true
}

module.exports = {
  async prepareNext(req, res) {
    const session = req.playbackSession
    const next = session.trackPlayback?.tracks?.[session.trackPlayback.index + 1]
    if (!next) return res.sendStatus(204)
    try {
      const item = await trackPlayback.ensureTrack(session.libraryItemId, next.id)
      res.json(trackPlayback.describe(item, next.id).tracks.find((track) => track.id === next.id))
    } catch (error) {
      res.status(error.status || 502).send(error.status ? error.message : '下一集的信息暂时无法获取，可在切集时重试')
    }
  },
  start(req, res) {
    if (check(req, res, true)) res.status(202).json(trackPlayback.startProbeJob(req.libraryItem, req.body?.force === true))
  },
  status(req, res) {
    if (check(req, res, true)) res.json(trackPlayback.getProbeJob(req.libraryItem.id))
  },
  cancel(req, res) {
    if (check(req, res, true)) res.json(trackPlayback.cancelProbeJob(req.libraryItem.id))
  }
}
