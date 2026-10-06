const Path = require('path')

function isStrmFile(file) {
  const path = typeof file === 'string' ? file : file?.metadata?.path || file?.metadata?.filename || ''
  return Path.extname(path).toLowerCase() === '.strm'
}

function hasStrmFiles(libraryItem) {
  return libraryItem.libraryFiles?.some(isStrmFile) || false
}

module.exports = { isStrmFile, hasStrmFiles }
