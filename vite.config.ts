import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string };

function safeExec(command: string, fallback: string): string {
  try {
    return execSync(command, { encoding: 'utf-8' }).trim();
  } catch {
    return fallback;
  }
}

const buildHash = safeExec('git rev-parse --short HEAD', 'unknown');
const buildDate = new Date().toISOString().slice(0, 10);

// ビルド成果物は dist/index.html 1ファイル（JS/WASM/Worker をすべて内包）
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  worker: { format: 'iife' },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_HASH__: JSON.stringify(buildHash),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 10_000,
  },
});
