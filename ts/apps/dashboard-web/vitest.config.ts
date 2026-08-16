import { defineConfig } from 'vitest/config';

// dashboard-web はユニット（api クライアント・ルートハンドラ）とコンポーネント（auth-context / login 画面）
// のテストを持つ。survey-web と同規約で、jsdom が必要なテストはファイル先頭の
// `// @vitest-environment jsdom` ディレクティブで個別指定する（既定は node 環境・E2E は無い）。
export default defineConfig({
  test: {},
});
