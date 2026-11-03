import { chromiumLaunchOptions } from '@fwlm/e2e-support/browser';
import { defineConfig, devices } from '@playwright/test';

// 客向けフローの E2E。DB・seed・Gemini モック（NODE_OPTIONS=--import e2e/mock-gemini.mjs）は
// 外から env で供給する。CI は ts-ci の e2e ジョブ、ローカルは `bash scripts/run-e2e-local.sh --only survey`
// が用意して流す（Issue #257）。**このディレクトリで `playwright test` を素で打たないこと。**
// .env.local（gitignore 済み）の開発用 DB と実の Gemini キーで動いてしまう。
// 外部で起動済みなら E2E_BASE_URL を指定して webServer を無効化できる。
//
// 全店公開（SURVEY_FORCE_STRUCTURED=1・Issue #441）は、同じビルドを env だけ変えて別ポートで起動し、
// e2e/global-rollout.spec.ts だけをそちらへ流す。フラグは起動時に決まるので、1 つのサーバーでは
// 「フラグ無しの legacy」と「全店公開」の両方を確かめられない。E2E_BASE_URL を使うときは、
// E2E_GLOBAL_ROLLOUT_BASE_URL も渡したときだけ全店公開のプロジェクトを流す。
const external = Boolean(process.env.E2E_BASE_URL);
const globalRolloutBaseURL = process.env.E2E_GLOBAL_ROLLOUT_BASE_URL ?? (external ? undefined : 'http://127.0.0.1:3101');
const GLOBAL_ROLLOUT_SPEC = /global-rollout\.spec\.ts/;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100',
    ...chromiumLaunchOptions(),
  },
  projects: [
    { name: 'mobile-chromium', testIgnore: GLOBAL_ROLLOUT_SPEC, use: { ...devices['Pixel 5'] } },
    ...(globalRolloutBaseURL
      ? [{
          name: 'mobile-chromium-global-rollout',
          testMatch: GLOBAL_ROLLOUT_SPEC,
          use: { ...devices['Pixel 5'], baseURL: globalRolloutBaseURL },
        }]
      : []),
  ],
  webServer: external
    ? undefined
    : [
        {
          command: 'pnpm start',
          url: 'http://127.0.0.1:3100/health',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: { PORT: '3100' },
        },
        {
          command: 'pnpm start',
          url: 'http://127.0.0.1:3101/health',
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: { PORT: '3101', SURVEY_FORCE_STRUCTURED: '1' },
        },
      ],
});
