const { expect } = require('chai')
const { getTrackId } = require('../../../server/utils/audioSource')
const { selectPosition, progressPayload } = require('../../../server/utils/trackPlayback')

describe('按集播放的位置与完成状态', () => {
  const tracks = [1, 2, 3].map((index) => ({ duration: 60, metadata: { relPath: `${index}.strm`, filename: `${index}.strm`, path: `/books/${index}.strm` } }))

  it('把旧整本进度转换为音轨及集内时间，不改变原进度', () => {
    const progress = { currentTime: 85, isFinished: false }
    expect(selectPosition(tracks, progress, {})).to.deep.equal({ trackId: getTrackId(tracks[1]), currentTime: 25 })
    expect(progress.currentTime).to.equal(85)
  })

  it('前面时长未知时仍能直接选集及按集续播，不猜测旧进度', () => {
    const pending = tracks.map((track) => ({ ...track, duration: null }))
    const position = { trackId: getTrackId(tracks[2]), currentTime: 12 }
    expect(selectPosition(pending, { extraData: { trackProgress: position } }, {})).to.deep.equal(position)
    expect(selectPosition(pending, null, { trackId: position.trackId, trackTime: 12 })).to.deep.equal(position)
    expect(() => selectPosition(pending, { currentTime: 85 }, {})).to.throw('原进度已保留')
    expect(() => selectPosition(pending, null, { startTime: 85 })).to.throw('尚不能')
  })

  it('拒绝无效时间及已移除的音轨', () => {
    expect(() => selectPosition(tracks, null, { trackId: '不存在' })).to.throw('不存在')
    for (const trackTime of [-1, NaN, Infinity, '12']) expect(() => selectPosition(tracks, null, { trackId: getTrackId(tracks[0]), trackTime })).to.throw('无效')
    expect(() => selectPosition(tracks, { extraData: { trackProgress: { trackId: '旧文件', currentTime: 12 } } }, {})).to.throw('移除或改名')
  })

  it('只有最后一集的结束事件能标记整本完成，不使用单集百分比', () => {
    const item = { media: { includedAudioFiles: tracks } }
    expect(progressPayload(item, { trackId: getTrackId(tracks[1]) }, 60, true).isFinished).to.equal(false)
    expect(progressPayload(item, { trackId: getTrackId(tracks[2]) }, 60, false).isFinished).to.equal(false)
    expect(progressPayload(item, { trackId: getTrackId(tracks[2]) }, 60, true).isFinished).to.equal(true)
    const payload = progressPayload(item, { trackId: getTrackId(tracks[1]) }, 12)
    expect(payload.currentTime).to.equal(72)
    expect(payload.trackProgress.currentTime).to.equal(12)
  })
})
