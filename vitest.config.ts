import { defineConfig } from 'vitest/config';

// ユニットテスト用設定。ビルド用の vite.config.ts とは分離する
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
