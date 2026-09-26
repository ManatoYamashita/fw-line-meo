// Playwright が起動する Chromium をローカルで差し替えるための共有ヘルパ。
//
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH にインストール済みの Chromium 系ブラウザ（Aside、Google Chrome
// など）の実行ファイルを指定すると、付属 Chromium の代わりにそれで E2E を起動する。付属 Chromium
// （Chrome for Testing）のダウンロードを省くためのもので、測る内容は変えない。
//
// CI ではこの変数を無視し、常に付属 Chromium を使う。CI の結果を、実行するマシンに入っている
// ブラウザの版に左右させないためである。
//
// 3 面の playwright.config.ts が同じ判定を共有する。複写にしなかったのは、CI で無視する条件を
// 1 箇所だけ直し忘れても誰も検出できないためである（viewport.ts と同じ理由）。
import type { LaunchOptions } from '@playwright/test';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * playwright.config.ts の `use` へ展開する起動設定を返す。
 *
 * 差し替えない場合は空のオブジェクトを返すので、`use: { ...chromiumLaunchOptions() }` と
 * 無条件に展開してよい。
 */
export function chromiumLaunchOptions(env: Env = process.env): { launchOptions?: LaunchOptions } {
  if (env.CI) return {};
  const executablePath = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (!executablePath) return {};
  return { launchOptions: { executablePath } };
}
