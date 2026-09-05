import { defineConfig, devices } from '@playwright/test';

// 管理ダッシュボードの実描画 E2E（Issue #53）。
//
// この面は実ブラウザでは開けない。build-arg 未注入なら getAuth() が auth/invalid-api-key を
// 投げて `loading` から動かず、注入済みでも未ログインなら /login へ送られ、唯一の操作が
// Google の実ポップアップを開く。したがって **`E2E_STUB_IDP=1` を立てたビルドに対してのみ**
// このスイートは意味を持つ（next.config.ts が firebase/auth を e2e/stubs へ差し替える）。
// env を立てずにビルドしたものへ当てると認証の壁で赤くなる。それは誤りではなく、差し替えが
// 常時 on になっていないことの対照である。
//
// 一覧データは page.route() の固定 fixture で供給する。dashboard-api も DB も起こさない。
// **API のベース URL は面自身と別オリジンでなければならない**（同一オリジンだと `/stores` への
// 文書要求まで横取りしてしまい、ページ遷移そのものが壊れる）。ビルド時に
// NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3199 を渡す前提であり、食い違えば取得が失敗して
// 描画の前提 assert が落ちる（fail-closed）。
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3110',
  },
  projects: [{ name: 'mobile-chromium', use: { ...devices['Pixel 5'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm start',
        url: 'http://127.0.0.1:3110/healthz',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { PORT: '3110' },
      },
});
