<template>
  <tr>
    <td class="text-center">
      <p>{{ track.index }}</p>
    </td>
    <td class="font-sans"><button v-if="canSelectTrack" class="material-symbols align-middle mr-2" aria-label="播放此集" @click="$eventBus.$emit('play-item', { libraryItemId, trackId: track.id })">play_arrow</button>{{ showFullPath ? track.metadata.path : track.metadata.filename }}</td>
    <td v-if="!showFullPath" class="hidden lg:table-cell">
      {{ track.audioFile.codec || '' }}
    </td>
    <td v-if="!showFullPath" class="hidden xl:table-cell">
      {{ $bytesPretty(track.audioFile.bitRate || 0, 0) }}
    </td>
    <td class="hidden md:table-cell">
      {{ $bytesPretty(track.metadata.size) }}
    </td>
    <td class="hidden sm:table-cell">
      {{ track.duration ? $secondsToTimestamp(track.duration) : '待获取' }}
    </td>
    <td v-if="contextMenuItems.length" class="text-center">
      <ui-context-menu-dropdown :items="contextMenuItems" :menu-width="110" @action="contextMenuAction" />
    </td>
  </tr>
</template>

<script>
export default {
  props: {
    libraryItemId: String,
    showFullPath: Boolean,
    canSelectTrack: Boolean,
    track: {
      type: Object,
      default: () => {}
    }
  },
  data() {
    return {}
  },
  computed: {
    userToken() {
      return this.$store.getters['user/getToken']
    },
    userCanDownload() {
      return this.$store.getters['user/getUserCanDownload']
    },
    userCanDelete() {
      return this.$store.getters['user/getUserCanDelete']
    },
    userIsAdmin() {
      return this.$store.getters['user/getIsAdminOrUp']
    },
    contextMenuItems() {
      const items = []
      if (this.userCanDownload && this.track.metadata.ext.toLowerCase() !== '.strm') {
        items.push({
          text: this.$strings.LabelDownload,
          action: 'download'
        })
      }

      if (this.userCanDelete) {
        items.push({
          text: this.$strings.ButtonDelete,
          action: 'delete'
        })
      }

      if (this.userIsAdmin) {
        items.push({
          text: this.$strings.LabelMoreInfo,
          action: 'more'
        })
      }
      return items
    },
    downloadUrl() {
      return `${process.env.serverUrl}/api/items/${this.libraryItemId}/file/${this.track.audioFile.ino}/download?token=${this.userToken}`
    }
  },
  methods: {
    contextMenuAction({ action }) {
      if (action === 'delete') {
        this.deleteLibraryFile()
      } else if (action === 'download') {
        this.downloadLibraryFile()
      } else if (action === 'more') {
        this.$emit('showMore', this.track.audioFile)
      }
    },
    deleteLibraryFile() {
      const payload = {
        message: this.$strings.MessageConfirmDeleteFile,
        callback: (confirmed) => {
          if (confirmed) {
            this.$axios
              .$delete(`/api/items/${this.libraryItemId}/file/${this.track.audioFile.ino}`)
              .then(() => {
                this.$toast.success(this.$strings.ToastDeleteFileSuccess)
              })
              .catch((error) => {
                console.error('Failed to delete file', error)
                this.$toast.error(this.$strings.ToastDeleteFileFailed)
              })
          }
        },
        type: 'yesNo'
      }
      this.$store.commit('globals/setConfirmPrompt', payload)
    },
    downloadLibraryFile() {
      this.$downloadFile(this.downloadUrl, this.track.metadata.filename)
    }
  },
  mounted() {}
}
</script>
