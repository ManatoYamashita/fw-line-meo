import { defineConfig, devices } from '@playwright/test';

// 店舗詳細（LIFF 面）の実描画 E2E（Issue #53）。
//
// この面は実ブラウザでは開けない。`liff.init` が LINE クライアント外を拒否し、ログイン状態が
// 無ければ access.line.me へ遷移するためである。したがって **`E2E_STUB_IDP=1` を立てた
// ビルドに対してのみ**このスイートは意味を持つ（`next.config.ts` が @line/liff を
// e2e/stubs/liff.ts へ差し替える）。env を立てずにビルドしたものへ当てると認証の壁で赤くなる。
// それは誤りではなく、差し替えが常時 on になっていないことの対照である。
//
// 詳細データは page.route() の固定 fixture で供給する。DB も LINE の検証エンドポイントも
// 起こさない（測りたいのは面の描画であって、データ取得経路ではない）。
//
// ポートは面ごとに分ける。reuseExistingServer は CI 以外で真であり、他アプリが同じポートを
// 占有していると**別アプリの画面を測って大量に赤くなる**（実測事故あり）。
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3120',
  },
  projects: [{ name: 'mobile-chromium', use: { ...devices['Pixel 5'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm start',
        url: 'http://127.0.0.1:3120/healthz',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { PORT: '3120' },
      },
});
