import { defineConfig, configDefaults } from 'vitest/config';

// store-detail はユニット/コンポーネントテストと DB テストを持つ。Playwright E2E
// （e2e/*.spec.ts）は除外する（survey-web と同規約・Issue #53 で e2e を新設した）。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
