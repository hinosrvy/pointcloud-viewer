import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// ビルド成果物は dist/index.html 1ファイル（JS/WASM/Worker をすべて内包）
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  worker: { format: 'iife' },
  build: {
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 10_000,
  },
});
