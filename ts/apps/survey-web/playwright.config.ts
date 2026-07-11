import { defineConfig, devices } from '@playwright/test';

// E2E は CI 実行を前提（ローカルは `playwright test --list` のサニティのみ）。
// webServer・DB・Gemini モック（NODE_OPTIONS=--import e2e/mock-gemini.mjs）は CI が env で供給する。
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
        url: 'http://127.0.0.1:3100/healthz',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { PORT: '3100' },
      },
});
