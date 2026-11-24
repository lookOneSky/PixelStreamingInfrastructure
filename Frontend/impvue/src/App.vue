<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElButton, ElInput } from 'element-plus'
import 'element-plus/theme-chalk/base.css'
import 'element-plus/theme-chalk/el-button.css'
import 'element-plus/theme-chalk/el-input.css'
import { Config, Logger, LogLevel, PixelStreaming } from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.8'
import { Application, PixelStreamingApplicationStyle, UIElementCreationMode } from '@epicgames-ps/lib-pixelstreamingfrontend-ui-ue5.8'

const playerHost = ref<HTMLElement>()
const message = ref('')
const canSend = ref(false)
let stream: PixelStreaming | undefined

onMounted(() => {
  Logger.InitLogging(LogLevel.Disabled, false)
  const styles = new PixelStreamingApplicationStyle()
  styles.applyStyleSheet()

  const config = new Config({
    useUrlParams: true,
    initialSettings: {
      ss: location.protocol === 'https:' ? `wss://${location.host}` : `ws://${location.hostname}:6888`,
      AutoConnect: true,
      AutoPlayVideo: true,
      TimeoutIfIdle: false,
      HoveringMouse: true,
      FakeMouseWithTouches: true,
      MatchViewportRes: true,
      UseModalForTextInput: true,
      PreferredCodec: 'H264'
    }
  })

  stream = new PixelStreaming(config)
  const application = new Application({
    stream,
    onColorModeChanged: isLightMode => styles.setColorMode(isLightMode),
    statsPanelConfig: { isEnabled: false, visibilityButtonConfig: { creationMode: UIElementCreationMode.Disable } },
    xrControlsConfig: { creationMode: UIElementCreationMode.Disable }
  })
  playerHost.value?.appendChild(application.rootElement)
  stream.addEventListener('dataChannelOpen', ({ data }) => {
    if (data.label !== 'recv-datachannel') canSend.value = true
  })
  stream.addEventListener('dataChannelClose', ({ data }) => {
    if (data.label !== 'recv-datachannel') canSend.value = false
  })
  stream.addEventListener('webRtcDisconnected', () => { canSend.value = false })
})

onBeforeUnmount(() => stream?.disconnect())

function sendMessageToUE() {
  if (message.value.trim() && stream?.emitUIInteraction(message.value)) {
    message.value = ''
  }
}
</script>

<template>
  <div class="pixel-streaming-container">
    <header class="app-header">
      <h1 class="app-title">虚幻引擎像素流送 - Vue实现</h1>
    </header>

    <main class="main-content">
      <div ref="playerHost" class="streaming-view"></div>
    </main>

    <form class="controls" @submit.prevent="sendMessageToUE" @keydown.stop @keyup.stop @keypress.stop>
      <label for="ue-message">发送给 UE</label>
      <el-input id="ue-message" v-model="message" placeholder="输入消息" />
      <el-button native-type="submit" :disabled="!canSend || !message.trim()">发送</el-button>
    </form>

    <footer class="app-footer">
      <p>© 2025 像素流送Demo</p>
    </footer>
  </div>
</template>

<style lang="scss" scoped>
.pixel-streaming-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.app-header {
  height: 60px;
  background: rgba(33, 32, 29, 0.95);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  padding: 0 20px;
  z-index: 10;

  .app-title {
    color: var(--primary-color);
    font-size: 20px;
    font-weight: 600;
    letter-spacing: 2px;
  }
}

.main-content {
  flex: 1;
  display: flex;
  position: relative;
  overflow: hidden;
}

.streaming-view {
  flex: 1;
  position: relative;
  background-color: #000;
}

.controls {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 20px;

  label {
    white-space: nowrap;
  }
}

.app-footer {
  height: 40px;
  background: rgba(33, 32, 29, 0.95);
  border-top: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #888;
  font-size: 12px;
}
</style>
