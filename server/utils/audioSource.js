const Path = require('path')
const { createHash } = require('crypto')

function isStrmFile(file) {
  const path = typeof file === 'string' ? file : file?.metadata?.path || file?.metadata?.filename || ''
  return Path.extname(path).toLowerCase() === '.strm'
}

function hasStrmFiles(libraryItem) {
  return libraryItem.libraryFiles?.some(isStrmFile) || false
}

function getTrackId(file) {
  return createHash('sha256').update(file.metadata.relPath || file.metadata.filename || file.metadata.path).digest('hex')
}

function hasCompleteTimeline(files) {
  return files.every((file) => Number.isFinite(file.duration) && file.duration > 0 && (!isStrmFile(file) || file.remote?.probeStatus !== 'pending'))
}

module.exports = { isStrmFile, hasStrmFiles, getTrackId, hasCompleteTimeline }
