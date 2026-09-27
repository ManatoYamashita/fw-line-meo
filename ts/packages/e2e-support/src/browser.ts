// Playwright が起動する Chromium をローカルで差し替えるための共有ヘルパ。
//
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH にインストール済みの Chromium 系ブラウザ（Aside、Google Chrome
// など）の実行ファイルを指定すると、付属 Chromium の代わりにそれで E2E を起動する。付属 Chromium
// （Chrome for Testing）のダウンロードを省くためのもので、測る内容は変えない。
//
// CI ではこの変数を無視し、常に付属 Chromium を使う。CI の結果を、実行するマシンに入っている
// ブラウザの版に左右させないためである。
//
// 差し替えるときは `--disable-gpu` を渡し、付属 Chromium（headless shell）と同じソフトウェア描画に
// 揃える。差し替えたブラウザは既定で GPU（SwiftShader）で描き、同じ状態を描き直すたびに濃淡や罫線の
// 色が 1/255 だけ揺れる。画素差で測る検査（dashboard-web の mobile-layout.spec.ts の R3）は
// 「同じ状態の 2 枚が一致する」ことを前提にしているため、差し替えたときだけ散発的に落ちた
// （Issue #378 の実測: Aside で 11〜18%・`--disable-gpu` で 0/100・付属 Chromium で 0/340）。
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
  return { launchOptions: { executablePath, args: ['--disable-gpu'] } };
}
