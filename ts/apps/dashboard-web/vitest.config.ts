import { defineConfig } from 'vitest/config';

// dashboard-web は現状ユニット/ルートハンドラのテストのみ（E2E なし）。
// vitest 既定の include（**/*.test.ts）・node 環境で十分。
export default defineConfig({
  test: {},
});
