import LocalAudioPlayer from './LocalAudioPlayer'
import CastPlayer from './CastPlayer'
import AudioTrack from './AudioTrack'

export default class PlayerHandler {
  constructor(ctx) {
    this.ctx = ctx
    this.libraryItem = null
    this.episodeId = null
    this.displayTitle = null
    this.displayAuthor = null
    this.playWhenReady = false
    this.initialPlaybackRate = 1
    this.player = null
    this.playerState = 'IDLE'
    this.isHlsTranscode = false
    this.hasRemoteAudio = false
    this.currentSessionId = null
    this.trackPlayback = null
    this.sessionChapters = []
    this.requestedTrack = null
    this.prepareVersion = 0
    this.nextPreparedFor = null
    this.changingTrack = false
    this.trackEnded = false
    this.startTimeOverride = undefined // Used for starting playback at a specific time (i.e. clicking bookmark from library item page)
    this.startTime = 0

    this.failedProgressSyncs = 0
    this.lastSyncTime = 0
    this.listeningTimeSinceSync = 0

    this.playInterval = null
  }

  get isCasting() {
    return this.ctx.$store.state.globals.isCasting
  }
  get libraryItemId() {
    return this.libraryItem ? this.libraryItem.id : null
  }
  get isPlayingCastedItem() {
    return this.libraryItem && this.player instanceof CastPlayer
  }
  get isPlayingLocalItem() {
    return this.libraryItem && this.player instanceof LocalAudioPlayer
  }
  get playerPlaying() {
    return this.playerState === 'PLAYING'
  }
  get episode() {
    if (!this.episodeId) return null
    return this.libraryItem.media.episodes.find((ep) => ep.id === this.episodeId)
  }
  get jumpForwardAmount() {
    return this.ctx.$store.getters['user/getUserSetting']('jumpForwardAmount')
  }
  get jumpBackwardAmount() {
    return this.ctx.$store.getters['user/getUserSetting']('jumpBackwardAmount')
  }

  setSessionId(sessionId) {
    this.currentSessionId = sessionId
    this.ctx.$store.commit('setPlaybackSessionId', sessionId)
  }

  load(libraryItem, episodeId, playWhenReady, playbackRate, startTimeOverride = undefined, trackPosition = null) {
    if (this.currentSessionId) this.sendCloseSession()
    this.libraryItem = libraryItem
    this.trackPlayback = null
    this.requestedTrack = trackPosition
    this.lastSyncTime = 0
    this.listeningTimeSinceSync = 0

    this.episodeId = episodeId
    this.playWhenReady = playWhenReady
    this.initialPlaybackRate = playbackRate

    this.startTimeOverride = startTimeOverride == null || isNaN(startTimeOverride) ? undefined : Number(startTimeOverride)

    if (!this.player) this.switchPlayer(playWhenReady)
    else this.prepare()
  }

  switchPlayer(playWhenReady) {
    if (this.trackPlayback && this.player) {
      this.requestedTrack = { trackId: this.trackPlayback.trackId, trackTime: this.getCurrentTime() }
      this.sendProgressSync(this.getCurrentTime(), true)
    }
    if (this.isCasting && !(this.player instanceof CastPlayer)) {
      console.log('[PlayerHandler] Switching to cast player')

      this.stopPlayInterval()
      this.playerStateChange('LOADING')

      this.startTime = this.player ? this.player.getCurrentTime() : this.startTime
      if (this.player) {
        this.player.destroy()
      }
      this.player = new CastPlayer(this.ctx)
      this.setPlayerListeners()

      if (this.libraryItem) {
        // libraryItem was already loaded - prepare for cast
        this.playWhenReady = playWhenReady
        this.prepare()
      }
    } else if (!this.isCasting && !(this.player instanceof LocalAudioPlayer)) {
      console.log('[PlayerHandler] Switching to local player')

      this.stopPlayInterval()
      this.playerStateChange('LOADING')

      if (this.player) {
        this.player.destroy()
      }

      this.player = new LocalAudioPlayer(this.ctx)

      this.setPlayerListeners()

      if (this.libraryItem) {
        // libraryItem was already loaded - prepare for local play
        this.playWhenReady = playWhenReady
        this.prepare()
      }
    }
  }

  setPlayerListeners() {
    this.player.on('stateChange', this.playerStateChange.bind(this))
    this.player.on('timeupdate', this.playerTimeupdate.bind(this))
    this.player.on('buffertimeUpdate', this.playerBufferTimeUpdate.bind(this))
    this.player.on('error', this.playerError.bind(this))
    this.player.on('finished', this.playerFinished.bind(this))
  }

  playerError() {
    if (this.hasRemoteAudio) {
      this.stopPlayInterval()
      this.ctx.playerLoading = false
      this.ctx.setPlaying(false)
      this.ctx.$toast.error('远程音频播放失败，请检查 OpenList 地址、网络或音频格式')
      return
    }
    // Switch to HLS stream on error
    if (!this.isCasting && this.player instanceof LocalAudioPlayer) {
      console.log(`[PlayerHandler] Audio player error switching to HLS stream`)
      this.prepare(true)
    }
  }

  async playerFinished() {
    this.stopPlayInterval()
    const version = this.prepareVersion
    this.trackEnded = true

    var currentTime = this.player.getCurrentTime()
    this.ctx.setCurrentTime(currentTime)

    // TODO: Add listening time between last sync and now?
    await this.sendProgressSync(currentTime, true, !!this.trackPlayback)
    if (version !== this.prepareVersion) return

    if (this.trackPlayback) {
      if (this.ctx.sleepTimerSet && this.ctx.sleepTimerType === this.ctx.$constants.SleepTimerTypes.CHAPTER) {
        this.ctx.sleepTimerEnd()
        return
      }
      const next = this.trackPlayback.tracks[this.trackPlayback.index + 1]
      if (next) return this.selectTrack(next.id, 0, true)
    }

    this.ctx.mediaFinished(this.libraryItemId, this.episodeId)
  }

  playerStateChange(state) {
    console.log('[PlayerHandler] Player state change', state)
    this.playerState = state

    if (this.playerState === 'PLAYING') {
      this.setPlaybackRate(this.initialPlaybackRate)
      this.startPlayInterval()
    } else {
      this.stopPlayInterval()
    }

    if (this.player) {
      if (this.playerState === 'LOADED' || this.playerState === 'PLAYING') {
        this.ctx.setDuration(this.getDuration())
      }
      if (this.playerState !== 'LOADING') {
        this.ctx.setCurrentTime(this.player.getCurrentTime())
      }
    }

    this.ctx.setPlaying(this.playerState === 'PLAYING')
    this.ctx.playerLoading = this.playerState === 'LOADING'
  }

  playerTimeupdate(time) {
    this.ctx.setCurrentTime(time)
  }

  playerBufferTimeUpdate(buffertime) {
    this.ctx.setBufferTime(buffertime)
  }

  getDeviceId() {
    let deviceId = localStorage.getItem('absDeviceId')
    if (!deviceId) {
      deviceId = this.ctx.$randomId()
      localStorage.setItem('absDeviceId', deviceId)
    }
    return deviceId
  }

  async prepare(forceTranscode = false) {
    const version = ++this.prepareVersion
    const previousSessionId = this.currentSessionId
    this.stopPlayInterval()
    if (this.player?.pause) this.player.pause()
    this.ctx.playerLoading = true
    this.setSessionId(null) // Reset session

    const payload = {
      deviceInfo: {
        clientName: 'Abs Web',
        deviceId: this.getDeviceId()
      },
      supportedMimeTypes: this.player.playableMimeTypes,
      mediaPlayer: this.isCasting ? 'chromecast' : 'html5',
      forceTranscode,
      supportsTrackPlayback: true,
      ...(this.requestedTrack || (this.startTimeOverride !== undefined ? { startTime: this.startTimeOverride } : {})),
      forceDirectPlay: this.isCasting // TODO: add transcode support for chromecast
    }

    const path = this.episodeId ? `/api/items/${this.libraryItem.id}/play/${this.episodeId}` : `/api/items/${this.libraryItem.id}/play`
    const session = await this.ctx.$axios.$post(path, payload).catch((error) => {
      if (version !== this.prepareVersion) return
      if (previousSessionId && this.trackPlayback) this.setSessionId(previousSessionId)
      console.error('Failed to start stream', error)
      this.ctx.playerLoading = false
      this.ctx.setPlaying(false)
      const message = error.response?.data
      this.ctx.$toast.error(typeof message === 'string' ? message : '无法开始播放')
    })
    if (session && version !== this.prepareVersion) {
      await this.ctx.$axios.$post(`/api/session/${session.id}/close`).catch(() => {})
      return
    }
    if (session) this.prepareSession(session)
  }

  prepareOpenSession(session, playbackRate) {
    // Session opened on init socket
    if (!this.player) this.switchPlayer() // Must set player first for open sessions

    this.libraryItem = session.libraryItem
    this.playWhenReady = false
    this.initialPlaybackRate = playbackRate
    this.startTimeOverride = undefined
    this.lastSyncTime = 0
    this.listeningTimeSinceSync = 0

    this.prepareSession(session)
  }

  prepareSession(session) {
    this.trackEnded = false
    this.trackPlayback = session.trackPlayback || null
    this.sessionChapters = session.chapters || []
    this.requestedTrack = null
    this.hasRemoteAudio = session.audioTracks.some((track) => track.metadata?.ext?.toLowerCase() === '.strm')
    this.failedProgressSyncs = 0
    this.startTime = !this.trackPlayback && this.startTimeOverride !== undefined ? this.startTimeOverride : session.currentTime
    this.startTimeOverride = undefined
    this.lastSyncTime = 0
    this.listeningTimeSinceSync = 0
    this.setSessionId(session.id)
    this.displayTitle = session.displayTitle
    this.displayAuthor = session.displayAuthor

    console.log('[PlayerHandler] Preparing Session', session)

    var audioTracks = session.audioTracks.map((at) => new AudioTrack(at, session.id, this.ctx.$config.routerBasePath))

    this.ctx.playerLoading = true
    this.isHlsTranscode = true
    if (session.playMethod === this.ctx.$constants.PlayMethod.DIRECTPLAY) {
      this.isHlsTranscode = false
    }

    this.player.set(this.libraryItem, audioTracks, this.isHlsTranscode, this.startTime, this.playWhenReady)

    // browser media session api
    this.ctx.setMediaSession()
  }

  closePlayer() {
    console.log('[PlayerHandler] Close Player')
    this.sendCloseSession()
    this.resetPlayer()
  }

  resetPlayer() {
    this.prepareVersion++
    this.trackPlayback = null
    this.requestedTrack = null
    this.hasRemoteAudio = false
    if (this.player) {
      this.player.destroy()
    }
    this.player = null
    this.playerState = 'IDLE'
    this.libraryItem = null
    this.setSessionId(null)
    this.startTime = 0
    this.stopPlayInterval()
  }

  resetStream(startTime, streamId) {
    if (this.isHlsTranscode && this.currentSessionId === streamId) {
      this.player.resetStream(startTime)
    } else {
      console.warn('resetStream mismatch streamId', this.currentSessionId, streamId)
    }
  }

  /**
   * First sync happens after 20 seconds
   * subsequent syncs happen every 10 seconds
   */
  startPlayInterval() {
    clearInterval(this.playInterval)
    let lastTick = Date.now()
    this.playInterval = setInterval(() => {
      // Update UI
      if (!this.player) return
      const currentTime = this.player.getCurrentTime()
      this.ctx.setCurrentTime(currentTime)
      if (this.trackPlayback && this.getDuration() - currentTime < 30 && this.nextPreparedFor !== this.currentSessionId) {
        const sessionId = this.currentSessionId
        this.nextPreparedFor = sessionId
        this.ctx.$axios.$post(`/api/session/${sessionId}/prepare-next`, {}, { progress: false, timeout: 70000 }).then((track) => {
          if (track?.id && this.currentSessionId === sessionId) {
            const next = this.trackPlayback.tracks.find((item) => item.id === track.id)
            if (next) Object.assign(next, track)
          }
        }).catch(() => {})
      }

      const exactTimeElapsed = (Date.now() - lastTick) / 1000
      lastTick = Date.now()
      this.listeningTimeSinceSync += exactTimeElapsed
      const TimeToWaitBeforeSync = this.lastSyncTime > 0 ? 10 : 20
      if (this.listeningTimeSinceSync >= TimeToWaitBeforeSync) {
        this.sendProgressSync(currentTime)
      }
    }, 1000)
  }

  sendCloseSession() {
    if (!this.currentSessionId) return Promise.resolve()
    let syncData = null
    if (this.player) {
      const listeningTimeToAdd = Math.max(0, Math.floor(this.listeningTimeSinceSync))
      // When opening player and quickly closing dont save progress
      if (listeningTimeToAdd > 20 || this.trackPlayback) {
        syncData = {
          timeListened: listeningTimeToAdd,
          currentTime: this.getCurrentTime(),
          ...(this.trackPlayback && this.trackEnded ? { finishedTrack: true } : {})
        }
      }
    }
    this.listeningTimeSinceSync = 0
    this.lastSyncTime = 0
    return this.ctx.$axios.$post(`/api/session/${this.currentSessionId}/close`, syncData, { timeout: 6000, progress: false }).catch((error) => {
      console.error('Failed to close session', error)
    })
  }

  sendProgressSync(currentTime, force = false, finishedTrack = this.trackEnded) {
    if (!this.currentSessionId) return Promise.resolve()
    const diffSinceLastSync = Math.abs(this.lastSyncTime - currentTime)
    if (!force && diffSinceLastSync < 1) return Promise.resolve()

    this.lastSyncTime = currentTime
    const listeningTimeToAdd = Math.max(0, Math.floor(this.listeningTimeSinceSync))
    const syncData = {
      timeListened: listeningTimeToAdd,
      currentTime,
      ...(this.trackPlayback ? { finishedTrack } : {})
    }

    this.listeningTimeSinceSync = 0
    return this.ctx.$axios
      .$post(`/api/session/${this.currentSessionId}/sync`, syncData, { timeout: 9000, progress: false })
      .then(() => {
        this.failedProgressSyncs = 0
      })
      .catch((error) => {
        console.error('Failed to update session progress', error)
        // After 4 failed sync attempts show an alert toast
        this.failedProgressSyncs++
        if (this.failedProgressSyncs >= 4) {
          this.ctx.showFailedProgressSyncs()
          this.failedProgressSyncs = 0
        }
      })
  }

  stopPlayInterval() {
    clearInterval(this.playInterval)
    this.playInterval = null
  }

  playPause() {
    if (this.player) this.player.playPause()
  }

  play() {
    if (this.player) this.player.play()
  }

  pause() {
    if (this.player) this.player.pause()
  }

  getCurrentTime() {
    return this.player ? this.player.getCurrentTime() : 0
  }

  getDuration() {
    return this.player ? this.player.getDuration() : 0
  }

  jumpBackward() {
    if (!this.player) return
    var currentTime = this.getCurrentTime()
    const jumpAmount = this.jumpBackwardAmount
    this.seek(Math.max(0, currentTime - jumpAmount))
  }

  jumpForward() {
    if (!this.player) return
    var currentTime = this.getCurrentTime()
    const jumpAmount = this.jumpForwardAmount
    this.seek(Math.min(currentTime + jumpAmount, this.getDuration()))
  }

  setVolume(volume) {
    if (!this.player) return
    this.player.setVolume(volume)
  }

  setPlaybackRate(playbackRate) {
    this.initialPlaybackRate = playbackRate // Might be loaded from settings before player is started
    if (!this.player) return
    this.player.setPlaybackRate(playbackRate)
  }

  seek(time, shouldSync = true) {
    if (!this.player) return
    this.trackEnded = false
    this.player.seek(time, this.playerPlaying)
    this.ctx.setCurrentTime(time)

    // Update progress if paused
    if (!this.playerPlaying && shouldSync) {
      this.sendProgressSync(time)
    }
  }

  async selectTrack(trackId, trackTime = 0, playWhenReady = true) {
    if (this.ctx.playerLoading || this.changingTrack) return
    this.changingTrack = true
    const version = this.prepareVersion
    try {
      this.pause()
      this.ctx.playerLoading = true
      await this.sendProgressSync(this.getCurrentTime(), true)
      if (version !== this.prepareVersion) return
      this.requestedTrack = { trackId, trackTime }
      this.playWhenReady = playWhenReady
      this.startTimeOverride = undefined
      await this.prepare()
    } finally {
      this.changingTrack = false
    }
  }

  async seekBookTime(time) {
    if (this.ctx.playerLoading || this.changingTrack) return
    this.changingTrack = true
    const version = this.prepareVersion
    try {
      this.pause()
      this.ctx.playerLoading = true
      await this.sendProgressSync(this.getCurrentTime(), true)
      if (version !== this.prepareVersion) return
      this.requestedTrack = null
      this.startTimeOverride = time
      this.playWhenReady = true
      await this.prepare()
    } finally {
      this.changingTrack = false
    }
  }
}
