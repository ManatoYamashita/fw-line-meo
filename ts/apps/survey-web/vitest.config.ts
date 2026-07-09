import { defineConfig, configDefaults } from 'vitest/config';

// vitest はユニット/コンポーネント/DB テストのみ。Playwright E2E（e2e/*.spec.ts）は除外する。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
