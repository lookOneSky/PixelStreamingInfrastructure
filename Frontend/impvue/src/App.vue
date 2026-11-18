<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { Config } from '@epicgames-ps/lib-pixelstreamingfrontend'
import { PixelStreamingApplicationStyle, PixelStreamingApplicationConfig } from '@epicgames-ps/lib-pixelstreamingfrontend-ui-vue'
import '@epicgames-ps/lib-pixelstreamingfrontend-ui-vue/dist/style.css'
import ControlPanel from './components/ControlPanel.vue'

// Pixel Streaming 配置
const pixelStreamingConfig = ref<PixelStreamingApplicationConfig>({
  initialSettings: {
    AutoConnect: true,
    AutoPlayVideo: true,
    SS: true,
    AFS: false,
    HoveringMouse: true,
    FakeMouseWithTouches: true,
    MatchViewportRes: true
  },
  customFrontendConfig: {
    enableSpsAutoPlay: true,
    forceAggregateUrlConfig: false,
    disableViewportMeta: false,
    enableLog: false,
    enableXrView: false,
    enableVirtualKeyboard: true,
    schemeOverride: "",
    signallingServerAddress: "",
    preferredCodec: "h264"
  }
})

// 像素流送样式
const pixelStreamingStyle = ref<PixelStreamingApplicationStyle>({
  showStats: false,
  allowConsoleCommands: true
})

// UE 连接URL
const ueStreamAddress = ref('ws://localhost:8888')

// 通信消息
const sendMessageToUE = (message: string) => {
  // 发送消息给UE
  console.log('发送消息到UE:', message)
  // 这里添加发送消息的实现
}

// 组件生命周期
onMounted(() => {
  console.log('像素流送组件挂载')
  window.addEventListener('resize', handleResize)
  handleResize()
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
})

// 处理窗口大小变化
const handleResize = () => {
  // 处理窗口大小变化
  console.log('窗口大小变化:', window.innerWidth, window.innerHeight)
}
</script>

<template>
  <div class="pixel-streaming-container">
    <header class="app-header">
      <h1 class="app-title">虚幻引擎像素流送 - Vue实现</h1>
    </header>

    <main class="main-content">
      <!-- 像素流送主视图 -->
      <div class="streaming-view">
        <PixelStreamingApplicationStyle
          v-bind="pixelStreamingStyle"
        >
          <PixelStreamingApplicationConfig
            v-bind="pixelStreamingConfig"
            :address="ueStreamAddress"
            @on-stream-loading="() => console.log('加载中...')"
            @on-play-stream-success="() => console.log('成功连接！')"
            @on-play-stream-fail="(error) => console.error('连接失败:', error)"
          />
        </PixelStreamingApplicationStyle>
      </div>

      <!-- 控制面板 -->
      <ControlPanel @send-message="sendMessageToUE" />
    </main>

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