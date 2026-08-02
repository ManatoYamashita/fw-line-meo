// 各 Web アプリのツールチェーンで CSS をコンパイルする共有基盤（ui-token-collision タスク 1.1）。
//
// design.md「test/support/compile-app-css.ts」/ Requirements 1.3, 5.7。
//
// 本モジュールは app-integration.test.ts のローカル定義（アプリ定義とコンパイル手続き）を切り出した
// ものである。切り出しの理由は、ui-token-collision が新設するトークンスケール検証も
// **まったく同じ条件**でコンパイルする必要があるため。複製すると次の最も間違えやすい条件が
// 二重管理になる:
//
//   走査の起点（base）をアプリディレクトリへ固定すること。
//
// `next build` はアプリディレクトリを cwd として `@tailwindcss/postcss` を実行し、プラグインは
// その cwd を自動ソース検出の起点にする。base を既定（プロセスの cwd）のままにすると
// **リポジトリ全体が自動検出され、テストファイル内の文字列まで className として拾われる**。
// その状態では `@source` が無くても部品のユーティリティが生成されてしまい、検証が空振りする。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss, { type AcceptedPlugin } from 'postcss';

/** 本ファイルは test/support/ に置かれるため、パッケージルートは 2 階層上である。 */
const supportDir = dirname(fileURLToPath(import.meta.url));

/** `@fwlm/ui` パッケージのルート。 */
export const uiRoot = resolve(supportDir, '..', '..');

/** `@fwlm/ui` の src ディレクトリ（各アプリの `@source` が指すべき先）。 */
export const uiSrcDir = join(uiRoot, 'src');

/** ベンダリングした部品の置き場。 */
export const componentsDir = join(uiSrcDir, 'components');

/** pnpm ワークスペースのルート（ts/）。 */
export const workspaceRoot = resolve(uiRoot, '..', '..');

export interface AppUnderTest {
  /** package.json の name（エラーメッセージ用）。 */
  readonly packageName: string;
  /** アプリのルート（`next build` の cwd に相当）。 */
  readonly dir: string;
  /** アプリルートからの globals.css の相対パス（構成差＝@source の相対深度差の源）。 */
  readonly globalsCssRelative: string;
}

/**
 * 検証対象の 3 面。globals.css の位置がアプリ構成で異なる（survey-web / dashboard-web は
 * `src/app/`、store-detail は `app/` 直下）ため、`@source` の相対深度も 4 階層 / 3 階層と異なる。
 * その差分こそが壊れやすい箇所なので、相対パス文字列を直接比較せず「解決先が uiSrcDir と一致するか」で
 * 検証する（構成変更に追従しつつ、間違った深度は確実に落とす）。
 */
export const APPS: readonly AppUnderTest[] = [
  {
    packageName: '@fwlm/survey-web',
    dir: join(workspaceRoot, 'apps', 'survey-web'),
    globalsCssRelative: join('src', 'app', 'globals.css'),
  },
  {
    packageName: '@fwlm/store-detail',
    dir: join(workspaceRoot, 'apps', 'store-detail'),
    globalsCssRelative: join('app', 'globals.css'),
  },
  {
    packageName: '@fwlm/dashboard-web',
    dir: join(workspaceRoot, 'apps', 'dashboard-web'),
    globalsCssRelative: join('src', 'app', 'globals.css'),
  },
];

/** アプリの globals.css の絶対パス。 */
export function globalsCssPath(app: AppUnderTest): string {
  return join(app.dir, app.globalsCssRelative);
}

/** アプリの globals.css の中身。 */
export function readGlobalsCss(app: AppUnderTest): string {
  return readFileSync(globalsCssPath(app), 'utf8');
}

/**
 * アプリ自身の Tailwind ツールチェーンで globals.css をコンパイルする。
 *
 * base をアプリディレクトリへ明示することで `next build` と同じ条件を再現する
 * （冒頭のコメント参照。ここを取り違えると全 CSS 検証が静かに空振りする）。
 */
export async function compileWithAppToolchain(app: AppUnderTest, cssSource: string): Promise<string> {
  const appRequire = createRequire(join(app.dir, 'noop.cjs'));
  const pluginPath = appRequire.resolve('@tailwindcss/postcss');
  const pluginModule = (await import(pathToFileURL(pluginPath).href)) as {
    default: (options: { base: string; optimize: boolean }) => AcceptedPlugin;
  };
  const plugin = pluginModule.default({ base: app.dir, optimize: false });
  const result = await postcss([plugin]).process(cssSource, {
    from: globalsCssPath(app),
  });
  return result.css;
}

/**
 * 任意のクラスの生成を強制する `@source inline(...)` 宣言を作る。
 *
 * Tailwind は **ソースに現れないユーティリティも、参照されないテーマ変数も出力しない**。
 * 解決先を検査する側は、検査したいクラスを自分で出力させる必要がある
 * （実測: 本番と同じ入力では `--radius-sm` が生成 CSS に現れない）。
 */
export function inlineSourceDeclaration(probes: readonly string[]): string {
  return `@source inline("${probes.join(' ')}");\n`;
}

/**
 * アプリの globals.css に、指定クラスの生成を強制したうえでコンパイルする。
 * トークンスケールの照合はこの結果に対して行う。
 */
export async function compileWithProbes(
  app: AppUnderTest,
  probes: readonly string[],
): Promise<string> {
  return compileWithAppToolchain(app, `${readGlobalsCss(app)}\n${inlineSourceDeclaration(probes)}`);
}

/**
 * 素の Tailwind のみを基準線としてコンパイルする（プロジェクトの theme.css を読み込まない）。
 *
 * 「あるユーティリティが本来どのテーマ変数を読むのか」の基準を与える。プラグインの解決と base は
 * アプリ条件と同一にするため、差分に現れるのは theme.css の宣言の影響だけになる。
 */
export async function compileStockBaseline(
  app: AppUnderTest,
  probes: readonly string[],
): Promise<string> {
  return compileWithAppToolchain(
    app,
    `@import "tailwindcss";\n${inlineSourceDeclaration(probes)}`,
  );
}
