import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],
  envDir: '../../',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@tutor/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    host: true, // 监听 0.0.0.0，手机在同一局域网扫码可直接访问
    // 允许通过公网隧道域名（trycloudflare 等）访问；否则 Vite 会以 403 Blocked request 拒绝
    allowedHosts: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8849',
        changeOrigin: true,
      },
    },
  },
  // 构建产物预览：手机经公网隧道访问此服务，只加载打包后的少量文件，比 dev 的 96 个模块快得多
  preview: {
    host: true,
    allowedHosts: true,
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://localhost:8849',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
