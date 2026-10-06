const pending = new Map()

async function withBookAudioLock(id, action) {
  const previous = pending.get(id) || Promise.resolve()
  const current = previous.catch(() => {}).then(action)
  pending.set(id, current)
  try {
    return await current
  } finally {
    if (pending.get(id) === current) pending.delete(id)
  }
}

module.exports = withBookAudioLock
