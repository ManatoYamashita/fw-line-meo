// Web 3 面（survey-web / store-detail / dashboard-web）から `@fwlm/ui` が
// 「追加実装なしで利用できる」ことの恒久検証（タスク 6.3 / Requirements 2.2）。
//
// design.md「@fwlm/ui — components」Implementation Notes および Error Handling が最重要リスクとして
// 挙げるとおり、各アプリの `@source "<相対>/packages/ui/src"` が壊れても **ビルドは成功したまま**
// ユーティリティだけが静かに生成されなくなる（画面が無装飾に戻るまで誰も気づけない）。
// 本テストはその「静かな破壊」を機械検出するために、次の 4 層を各アプリについて検証する。
//
//   1. 依存関係    — アプリが `@fwlm/ui: workspace:*` と Tailwind ツールチェーンを持つ
//   2. 解決可能性  — `@fwlm/ui/components/<部品>` が exports 経由で実ファイルへ解決される
//   3. 配線        — globals.css の 3 点セット（tailwindcss → theme.css → @source）が規定順にあり、
//                    `@source` が本パッケージの src ディレクトリを実際に指している
//   4. 生成        — アプリ自身の Tailwind で globals.css をコンパイルすると、
//                    `@fwlm/ui` の部品にしか現れないユーティリティが生成 CSS に出現する
//
// 4 は `next build` と同じ経路（アプリの `@tailwindcss/postcss` を base=アプリディレクトリで実行）を
// 再現するため、ビルド成果物（.next/）に依存せずに「生成されること」そのものを証明できる。
// さらに各アプリについて `@source` を除いた複製をコンパイルする否定系も実行し、
// 「@source が効いているからこそ生成されている」ことまで固定する（テストの空振り緑を防ぐ）。
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss, { type AcceptedPlugin } from 'postcss';
import { describe, it, expect, beforeAll } from 'vitest';

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiSrcDir = join(uiRoot, 'src');
const componentsDir = join(uiSrcDir, 'components');
/** pnpm ワークスペースのルート（ts/）。 */
const workspaceRoot = resolve(uiRoot, '..', '..');

interface AppUnderTest {
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
const APPS: readonly AppUnderTest[] = [
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

/**
 * 代表部品と、その部品にしか現れないユーティリティクラス。
 * 「アプリ自身のソースには存在しない」ことを別途 assert することで、生成 CSS 中の出現が
 * `@source` 経由の `@fwlm/ui` 走査に由来すると言い切れる状態にする。
 */
const REPRESENTATIVE_UTILITIES: readonly { readonly componentFile: string; readonly utility: string }[] = [
  { componentFile: 'button.tsx', utility: 'bg-primary' },
  { componentFile: 'card.tsx', utility: 'bg-card' },
  { componentFile: 'textarea.tsx', utility: 'field-sizing-content' },
  { componentFile: 'spinner.tsx', utility: 'animate-spin' },
];

/** アプリ自身の layout が使う基本クラス。コンパイル自体が健全であることの対照に使う。 */
const APP_OWN_UTILITY = 'bg-background';

/** 生成 CSS に「単独のユーティリティ規則」として現れるかを判定する（`.bg-primary { … }`）。 */
function hasUtilityRule(css: string, utility: string): boolean {
  const escaped = utility.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,}])\\.${escaped}\\s*\\{`).test(css);
}

/** node_modules / ビルド成果物を除いたアプリ自身のソースを列挙する。 */
function collectAppSourceFiles(dir: string): readonly string[] {
  const skipped = new Set(['node_modules', 'dist']);
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // ドット始まり（.next / .turbo など）とビルド成果物・依存は走査対象外。
    if (entry.name.startsWith('.') || skipped.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectAppSourceFiles(full));
    } else if (/\.(tsx?|jsx?|mjs|css)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * アプリ自身の Tailwind ツールチェーンで globals.css をコンパイルする。
 *
 * `next build` はアプリディレクトリを cwd として `@tailwindcss/postcss` を実行し、
 * プラグインはその cwd を自動ソース検出の起点（base）にする。ここでも base をアプリディレクトリへ
 * 明示することで同じ条件を再現する（base を取り違えるとリポジトリ全体が自動検出され、
 * `@source` が無くても部品が拾えてしまい検証が空振りする）。
 */
async function compileWithAppToolchain(app: AppUnderTest, cssSource: string): Promise<string> {
  const appRequire = createRequire(join(app.dir, 'noop.cjs'));
  const pluginPath = appRequire.resolve('@tailwindcss/postcss');
  const pluginModule = (await import(pathToFileURL(pluginPath).href)) as {
    default: (options: { base: string; optimize: boolean }) => AcceptedPlugin;
  };
  const plugin = pluginModule.default({ base: app.dir, optimize: false });
  const result = await postcss([plugin]).process(cssSource, {
    from: join(app.dir, app.globalsCssRelative),
  });
  return result.css;
}

describe('代表部品のユーティリティは @fwlm/ui のみに由来する（検証前提の自己確認）', () => {
  it.each(REPRESENTATIVE_UTILITIES)(
    '$utility は $componentFile に存在する',
    ({ componentFile, utility }) => {
      const source = readFileSync(join(componentsDir, componentFile), 'utf8');
      expect(
        source.includes(utility),
        `${componentFile} が ${utility} を使わなくなりました。代表クラスの選び直しが必要です`,
      ).toBe(true);
    },
  );
});

describe.each(APPS)('$packageName から @fwlm/ui を追加実装なしで利用できる（Requirements 2.2）', (app) => {
  const globalsCssPath = join(app.dir, app.globalsCssRelative);

  describe('1. 依存関係', () => {
    const manifest = JSON.parse(readFileSync(join(app.dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    it('@fwlm/ui を workspace 依存として持つ', () => {
      expect(manifest.dependencies?.['@fwlm/ui']).toBe('workspace:*');
    });

    it('Tailwind ツールチェーン（tailwindcss / @tailwindcss/postcss）と PostCSS 設定を持つ', () => {
      expect(manifest.devDependencies?.['tailwindcss']).toBeDefined();
      expect(manifest.devDependencies?.['@tailwindcss/postcss']).toBeDefined();
      expect(existsSync(join(app.dir, 'postcss.config.mjs'))).toBe(true);
    });
  });

  describe('2. 解決可能性（exports 経由で部品ソースへ到達できる）', () => {
    const appRequire = createRequire(join(app.dir, 'noop.cjs'));

    it.each(REPRESENTATIVE_UTILITIES)('$componentFile を exports 経由で解決できる', ({ componentFile }) => {
      const specifier = `@fwlm/ui/components/${componentFile.replace(/\.tsx$/, '')}`;
      const resolved = realpathSync(appRequire.resolve(specifier));
      expect(resolved).toBe(realpathSync(join(componentsDir, componentFile)));
    });

    it('theme.css を exports 経由で解決できる', () => {
      expect(realpathSync(appRequire.resolve('@fwlm/ui/theme.css'))).toBe(
        realpathSync(join(uiSrcDir, 'theme.css')),
      );
    });
  });

  describe('3. 配線（globals.css の 3 点セットと @source の指し先）', () => {
    const globalsCss = readFileSync(globalsCssPath, 'utf8');

    it('tailwindcss → @fwlm/ui/theme.css → @source の順で記述されている', () => {
      const tailwindImport = globalsCss.indexOf('@import "tailwindcss"');
      const themeImport = globalsCss.indexOf('@import "@fwlm/ui/theme.css"');
      const sourceDirective = globalsCss.search(/@source\s+"/);

      expect(tailwindImport, '@import "tailwindcss" がありません').toBeGreaterThanOrEqual(0);
      expect(themeImport, '@import "@fwlm/ui/theme.css" がありません').toBeGreaterThan(tailwindImport);
      expect(sourceDirective, '@source ディレクティブがありません').toBeGreaterThan(themeImport);
    });

    it('@source が @fwlm/ui の src ディレクトリを指す（相対深度の誤りを検出する）', () => {
      const match = /@source\s+"([^"]+)"/.exec(globalsCss);
      expect(match, '@source ディレクティブを解析できません').not.toBeNull();

      const sourcePath = match?.[1] ?? '';
      const resolved = resolve(dirname(globalsCssPath), sourcePath);
      expect(
        existsSync(resolved),
        `@source "${sourcePath}" の解決先 ${resolved} が存在しません（相対深度の誤り）`,
      ).toBe(true);
      expect(realpathSync(resolved)).toBe(realpathSync(uiSrcDir));
    });
  });

  describe('4. 生成（部品のユーティリティが実際に CSS へ出力される）', () => {
    const globalsCss = readFileSync(globalsCssPath, 'utf8');
    let compiled = '';
    let compiledWithoutSource = '';

    beforeAll(async () => {
      compiled = await compileWithAppToolchain(app, globalsCss);
      compiledWithoutSource = await compileWithAppToolchain(
        app,
        globalsCss.replace(/@source\s+"[^"]*"\s*;/, ''),
      );
    });

    it(`アプリ自身のクラス（.${APP_OWN_UTILITY}）が生成される（コンパイル健全性の対照）`, () => {
      expect(hasUtilityRule(compiled, APP_OWN_UTILITY)).toBe(true);
    });

    it.each(REPRESENTATIVE_UTILITIES)(
      '$componentFile のユーティリティ .$utility が生成される',
      ({ utility }) => {
        expect(
          hasUtilityRule(compiled, utility),
          `.${utility} が生成されていません。@source による @fwlm/ui の走査が効いていない可能性があります`,
        ).toBe(true);
      },
    );

    it.each(REPRESENTATIVE_UTILITIES)(
      '.$utility はアプリ自身のソースには存在しない（生成が @source 由来である担保）',
      ({ utility }) => {
        const offenders = collectAppSourceFiles(app.dir).filter((file) =>
          readFileSync(file, 'utf8').includes(utility),
        );
        expect(
          offenders,
          `${utility} がアプリ自身のソースにも存在するため、生成の由来を @source に帰属できません`,
        ).toEqual([]);
      },
    );

    it('@source を外すと部品のユーティリティが消える（ガードが空振りしていないことの証明）', () => {
      // ここが落ちる場合、@source 無しでも部品が拾えている＝本テストの 4 層目が意味を失っている。
      // Tailwind の自動ソース検出の仕様変更などが疑われるため、検証方法の見直しが必要。
      expect(hasUtilityRule(compiledWithoutSource, APP_OWN_UTILITY)).toBe(true);
      for (const { utility } of REPRESENTATIVE_UTILITIES) {
        expect(
          hasUtilityRule(compiledWithoutSource, utility),
          `@source 無しでも .${utility} が生成されました。@source 検証が空振りしています`,
        ).toBe(false);
      }
    });
  });
});
