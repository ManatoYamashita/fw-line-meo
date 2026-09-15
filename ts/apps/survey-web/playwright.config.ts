import { defineConfig, devices } from '@playwright/test';

// 客向けフローの E2E。DB・seed・Gemini モック（NODE_OPTIONS=--import e2e/mock-gemini.mjs）は
// 外から env で供給する。CI は ts-ci の e2e ジョブ、ローカルは `bash scripts/run-e2e-local.sh --only survey`
// が用意して流す（Issue #257）。**このディレクトリで `playwright test` を素で打たないこと。**
// .env.local（gitignore 済み）の開発用 DB と実の Gemini キーで動いてしまう。
// 外部で起動済みなら E2E_BASE_URL を指定して webServer を無効化できる。
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100',
  },
  projects: [{ name: 'mobile-chromium', use: { ...devices['Pixel 5'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm start',
        url: 'http://127.0.0.1:3100/health',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { PORT: '3100' },
      },
});
