import { defineConfig, configDefaults } from 'vitest/config';

// dashboard-web はユニット（api クライアント・ルートハンドラ）とコンポーネント（auth-context / login 画面）
// のテストを持つ。survey-web と同規約で、jsdom が必要なテストはファイル先頭の
// `// @vitest-environment jsdom` ディレクティブで個別指定する（既定は node 環境）。
// Playwright E2E（e2e/*.spec.ts）は除外する（Issue #53 で e2e を新設した）。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
