import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks: {
          'pixel-streaming': [
            '@epicgames-ps/lib-pixelstreamingfrontend-ue5.8',
            '@epicgames-ps/lib-pixelstreamingfrontend-ui-ue5.8'
          ]
        }
      }
    }
  }
});
