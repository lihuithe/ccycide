/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri 约定：固定端口，不清屏，便于 Rust 侧输出可见
// `--mode web` 构建 Web 版（见 src/backend/index.ts 的 isWebTarget）：这里直接注入，不依赖被 .gitignore 忽略的 .env 文件
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: mode === 'web' ? { 'import.meta.env.VITE_TARGET': JSON.stringify('web') } : {},
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}));
