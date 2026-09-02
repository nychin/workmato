import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  publicDir: resolve(__dirname, 'static'),
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    // 多页面入口共用任务领域模块；Electron 的 file:// 页面以 type="module" 加载构建产物。
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.html'),
        taskflow: resolve(__dirname, 'src/renderer/taskflow.html'),
        settings: resolve(__dirname, 'src/renderer/settings.html'),
      },
      output: {
        format: 'es',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      allow: [resolve(__dirname, 'static'), resolve(__dirname, 'src')],
    },
  },
});
