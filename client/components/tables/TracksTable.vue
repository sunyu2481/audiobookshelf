<template>
  <div class="w-full my-2">
    <p v-if="hasRemoteAudio" class="text-sm text-gray-400 mb-2">按集播放时获取音频信息；未播放音轨的时长可能尚未获取。</p>
    <div v-if="hasRemoteAudio && userIsAdmin" class="flex flex-wrap gap-2 items-center mb-2 text-sm">
      <ui-btn small :disabled="probeJob.status === 'running'" @click="startProbe(false)">补全远程信息</ui-btn>
      <ui-btn small :disabled="probeJob.status === 'running'" @click="startProbe(true)">重新获取远程信息</ui-btn>
      <span v-if="probeJob.total">{{ probeJob.status === 'running' ? '后台获取中' : probeJob.status === 'cancelled' ? '已取消' : '已完成' }}：{{ probeJob.completed }} / {{ probeJob.total }}，失败 {{ probeJob.failed }}</span>
      <ui-btn v-if="probeJob.status === 'running'" small @click="cancelProbe">取消</ui-btn>
      <span v-if="probeJob.lastError" class="text-warning">{{ probeJob.lastError }}</span>
    </div>
    <div class="w-full bg-primary px-4 md:px-6 py-2 flex items-center cursor-pointer" @click.stop="clickBar">
      <p class="pr-2 md:pr-4">{{ title }}</p>
      <div class="h-5 md:h-7 w-5 md:w-7 rounded-full bg-white/10 flex items-center justify-center">
        <span class="text-sm font-mono">{{ tracks.length }}</span>
      </div>
      <div class="grow" />
      <ui-btn v-if="userIsAdmin" small :color="showFullPath ? 'bg-gray-600' : 'bg-primary'" class="mr-2 hidden md:block" @click.stop="toggleFullPath">{{ $strings.ButtonFullPath }}</ui-btn>
      <nuxt-link v-if="userCanUpdate && !isFile" :to="`/audiobook/${libraryItemId}/edit`" class="mr-2 md:mr-4" @mousedown.prevent>
        <ui-btn small color="bg-primary">{{ $strings.ButtonManageTracks }}</ui-btn>
      </nuxt-link>
      <div class="cursor-pointer h-10 w-10 rounded-full hover:bg-black-400 flex justify-center items-center duration-500" :class="showTracks ? 'transform rotate-180' : ''">
        <span class="material-symbols text-4xl">&#xe313;</span>
      </div>
    </div>
    <transition name="slide">
      <div class="w-full" v-show="showTracks">
        <table class="text-sm tracksTable">
          <tr>
            <th class="w-10">#</th>
            <th class="text-left">{{ $strings.LabelFilename }}</th>
            <th v-if="!showFullPath" class="text-left w-20 hidden lg:table-cell">{{ $strings.LabelCodec }}</th>
            <th v-if="!showFullPath" class="text-left w-20 hidden xl:table-cell">{{ $strings.LabelBitrate }}</th>
            <th class="text-left w-20 hidden md:table-cell">{{ $strings.LabelSize }}</th>
            <th class="text-left w-20 hidden sm:table-cell">{{ $strings.LabelDuration }}</th>
            <th class="text-center w-16"></th>
          </tr>
          <template v-for="track in tracks">
            <tables-audio-tracks-table-row :key="track.index" :track="track" :library-item-id="libraryItemId" :showFullPath="showFullPath" :can-select-track="hasRemoteAudio" @showMore="showMore" />
          </template>
        </table>
      </div>
    </transition>

    <modals-audio-file-data-modal v-model="showAudioFileDataModal" :library-item-id="libraryItemId" :audio-file="selectedAudioFile" />
  </div>
</template>

<script>
export default {
  props: {
    title: {
      type: String,
      default: 'Audio Tracks'
    },
    tracks: {
      type: Array,
      default: () => []
    },
    libraryItemId: String,
    isFile: Boolean
  },
  data() {
    return {
      showTracks: false,
      showFullPath: false,
      selectedAudioFile: null,
      showAudioFileDataModal: false,
      probeJob: { status: 'idle' },
      probeTimer: null
    }
  },
  computed: {
    hasRemoteAudio() {
      return this.tracks.some((track) => track.metadata?.ext?.toLowerCase() === '.strm')
    },
    userCanDownload() {
      return this.$store.getters['user/getUserCanDownload']
    },
    userCanUpdate() {
      return this.$store.getters['user/getUserCanUpdate']
    },
    userCanDelete() {
      return this.$store.getters['user/getUserCanDelete']
    },
    userIsAdmin() {
      return this.$store.getters['user/getIsAdminOrUp']
    }
  },
  methods: {
    async startProbe(force) {
      try {
        this.probeJob = await this.$axios.$post(`/api/items/${this.libraryItemId}/strm/probe`, { force })
        this.pollProbe()
      } catch (error) {
        this.$toast.error(typeof error.response?.data === 'string' ? error.response.data : '无法启动远程信息获取')
      }
    },
    async cancelProbe() {
      this.probeJob = await this.$axios.$delete(`/api/items/${this.libraryItemId}/strm/probe`).catch(() => this.probeJob)
    },
    async pollProbe() {
      clearTimeout(this.probeTimer)
      this.probeJob = await this.$axios.$get(`/api/items/${this.libraryItemId}/strm/probe`, { progress: false }).catch(() => this.probeJob)
      if (!this._isBeingDestroyed && !this._isDestroyed && this.probeJob.status === 'running') this.probeTimer = setTimeout(() => this.pollProbe(), 3000)
    },
    toggleFullPath() {
      this.showFullPath = !this.showFullPath
      localStorage.setItem('showFullPath', this.showFullPath ? 1 : 0)
    },
    clickBar() {
      this.showTracks = !this.showTracks
    },
    showMore(audioFile) {
      this.selectedAudioFile = audioFile
      this.showAudioFileDataModal = true
    }
  },
  mounted() {
    if (this.hasRemoteAudio && this.userIsAdmin) this.pollProbe()
    if (this.userIsAdmin) {
      this.showFullPath = !!Number(localStorage.getItem('showFullPath') || 0)
    }
  },
  beforeDestroy() {
    clearTimeout(this.probeTimer)
  }
}
</script>
