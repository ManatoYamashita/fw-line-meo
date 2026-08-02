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
import postcss, { type AtRule, type Rule } from 'postcss';
import { describe, it, expect, beforeAll } from 'vitest';
// アプリ定義とコンパイル手続きは support/compile-app-css.ts が単一の情報源として持つ
// （ui-token-collision タスク 1.1 で切り出し。base をアプリディレクトリへ固定する条件を
// 二重管理にしないため。同モジュール冒頭のコメント参照）。
import { APPS, compileWithAppToolchain, componentsDir, uiSrcDir } from './support/compile-app-css';

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

/** 見出しレベル（h1〜h6）。 */
const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

/**
 * 生成 CSS から「単独セレクタの h{level} 規則」を全て取り出す。
 * Preflight のリセットは `h1, h2, h3, h4, h5, h6 { … }` というセレクタリストのため、
 * `h1` の直後に `{` を要求する本パターンには一致しない（後段の上書き規則だけを取れる）。
 */
function standaloneHeadingRules(css: string, level: number): readonly { index: number; body: string }[] {
  const pattern = new RegExp(`(?:^|[\\s,}])(h${level}\\s*\\{([^}]*)\\})`, 'g');
  const rules: { index: number; body: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    rules.push({ index: match.index, body: match[2] ?? '' });
  }
  return rules;
}

/** 生成 CSS に「単独のユーティリティ規則」として現れるかを判定する（`.bg-primary { … }`）。 */
function hasUtilityRule(css: string, utility: string): boolean {
  const escaped = utility.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,}])\\.${escaped}\\s*\\{`).test(css);
}

/**
 * 指定のカスケードレイヤ直下から、セレクタが完全一致する規則を全て取り出す（Issue #49）。
 *
 * 本ファイルの他の検査は全て文字列正規表現だが、ここだけ postcss の AST を使う。
 * 生成 CSS には `.focus-visible\:ring-3:focus-visible` のような **`:focus-visible` を含む複合
 * セレクタが大量に出現する**ため、正規表現では「グローバルな `:focus-visible` の既定規則」だけを
 * 取り出すのが脆い。また本欠陥の本質は「どのカスケードレイヤに属するか」であり、
 * レイヤ所属は文字列上の出現位置では判定できない（`@layer` の順序宣言が優先順位を決めるため）。
 * postcss は既に本ファイルで import 済みで、追加依存は発生しない。
 */
function rulesInLayer(css: string, layerName: string, selector: string): readonly Rule[] {
  const matches: Rule[] = [];
  postcss.parse(css).walkAtRules('layer', (atRule) => {
    if (atRule.params !== layerName) return;
    atRule.walkRules((rule) => {
      if (rule.selector.trim() === selector) matches.push(rule);
    });
  });
  return matches;
}

/**
 * 指定のカスケードレイヤ内から、条件が一致する `@media` 規則を全て取り出す（ui-a11y-gaps）。
 *
 * 動き抑制の本質は「どのレイヤに属するか」である。生成 CSS 冒頭の
 * `@layer theme, base, components, utilities` により base は utilities に負けるが、
 * **`!important` 宣言ではレイヤの優先順位が逆転する**（CSS Cascade Layers 仕様）。
 * したがって「base に居ること」と「important であること」の両方が動作条件になる。
 * 文字列上の出現位置ではレイヤ所属を判定できないため、`rulesInLayer` と同じく AST を辿る。
 */
function mediaRulesInLayer(
  css: string,
  layerName: string,
  conditionPattern: RegExp,
): readonly AtRule[] {
  const matches: AtRule[] = [];
  postcss.parse(css).walkAtRules('layer', (layerRule) => {
    if (layerRule.params !== layerName) return;
    layerRule.walkAtRules('media', (mediaRule) => {
      if (conditionPattern.test(mediaRule.params)) matches.push(mediaRule);
    });
  });
  return matches;
}

/**
 * 動き低減設定下で抑制するプロパティ（ui-a11y-gaps design「動きの 2 区分」）。
 *
 * 抑制するのは動きの **経過** だけである。`transition-property` や `transform` のような
 * **到達状態**を触ると、押下時の沈み込みのような「動きではなく状態」まで消えて要件 1.4 を破る。
 */
const MOTION_SUPPRESSED_PROPERTIES = [
  'animation-duration',
  'animation-iteration-count',
  'transition-duration',
] as const;

/**
 * 抑制ブロックに現れてはならないプロパティ。
 * 到達状態を抑制対象へ紛れ込ませた瞬間に赤化させる（要件 1.4 の CSS 側の防波堤）。
 *
 * `translate` / `scale` / `rotate` を落としてはならない: Tailwind v4 の `translate-y-px` 等は
 * `transform` ではなく **独立したこれらのプロパティ**へ出力される（生成 CSS で確認済み）。
 * `transform` だけを禁止対象にすると、実際に使われている経路が素通りする。
 */
const MOTION_FORBIDDEN_PROPERTIES = [
  'transition-property',
  'animation-name',
  'transform',
  'translate',
  'scale',
  'rotate',
] as const;

/** 規則の宣言を `prop -> value` のオブジェクトへ畳む。 */
function declarationsOf(rule: Rule): Readonly<Record<string, string>> {
  const declarations: Record<string, string> = {};
  rule.walkDecls((decl) => {
    declarations[decl.prop] = decl.value;
  });
  return declarations;
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

    // Tailwind の Preflight は `h1,h2,h3,h4,h5,h6 { font-size: inherit; font-weight: inherit }` を
    // 敷くため、theme.css が既定を戻さないと **見出しが本文と同一サイズ・同一ウェイトで描画される**
    // （ブラウザ標準描画より視覚階層が劣化する）。しかも CSS は無言でカスケードするため、
    // 画面を目視するまで誰も気づけない。ここでは「Preflight より後段に h1〜h6 の既定が生成され、
    // トークン由来のサイズを持つ」ことを実コンパイル結果で固定する（Requirements 3.1）。
    it('見出し既定（h1〜h6）が Preflight のリセットより後段に生成される（Requirements 3.1）', () => {
      const preflightResetIndex = compiled.search(
        /h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{[^}]*font-size:\s*inherit/,
      );
      expect(
        preflightResetIndex,
        'Preflight の見出しリセットが見つかりません（Tailwind の前提が変わっています）',
      ).toBeGreaterThanOrEqual(0);

      for (const level of HEADING_LEVELS) {
        const rules = standaloneHeadingRules(compiled, level);
        expect(
          rules.length,
          `h${level} の既定規則が生成 CSS にありません（Preflight のリセットが残り、` +
            '見出しが本文と同じ描画になります）',
        ).toBeGreaterThan(0);

        const effective = rules[rules.length - 1]!;
        expect(
          effective.index,
          `h${level} の既定が Preflight のリセットより前にあるため上書きできていません`,
        ).toBeGreaterThan(preflightResetIndex);
        // サイズはトークン（--text-*）由来であること（生の px/rem 直書きを許さない）。
        expect(effective.body, `h${level} の font-size がトークン参照ではありません`).toMatch(
          /font-size:\s*var\(--text-[a-z0-9]+\)/,
        );
        expect(effective.body, `h${level} の font-weight が指定されていません`).toMatch(
          /font-weight:\s*\d+/,
        );
      }
    });

    it('見出しのサイズ階層が h1 → h6 で単調に小さくなる（Requirements 3.1）', () => {
      // トークン名（--text-2xl 等）を theme.css の @theme 定義値へ引き当てて実寸で比較する。
      const themeCss = readFileSync(join(uiSrcDir, 'theme.css'), 'utf8');
      const sizes = HEADING_LEVELS.map((level) => {
        const rules = standaloneHeadingRules(compiled, level);
        const body = rules[rules.length - 1]?.body ?? '';
        const tokenName = /font-size:\s*var\((--text-[a-z0-9]+)\)/.exec(body)?.[1] ?? '';
        const remValue = new RegExp(`${tokenName}:\\s*([0-9.]+)rem`).exec(themeCss)?.[1];
        expect(remValue, `${tokenName} が theme.css の @theme に定義されていません`).toBeDefined();
        return Number.parseFloat(remValue ?? '0');
      });

      for (let i = 1; i < sizes.length; i += 1) {
        expect(
          sizes[i]!,
          `h${i + 1}(${sizes[i]}rem) が h${i}(${sizes[i - 1]}rem) 以上のサイズになっています`,
        ).toBeLessThan(sizes[i - 1]!);
      }
    });

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

  // 5. フォーカス指標（Issue #49 / Requirements 5.3）
  //
  // theme.css は `@layer base` にグローバルな `:focus-visible { outline: 2px solid var(--ring) }` を
  // 「アクセシビリティ既定」として宣言している。ところが PR #46/#47 でベンダリングした部品は
  // 全て base class に `outline-none` を持っており、これは `@layer utilities` に生成される。
  // 生成 CSS 冒頭の `@layer theme, base, components, utilities;` がレイヤの優先順位を固定するため、
  // **詳細度に関係なく utilities が base に勝ち**、既定は「それが守るべき部品の上でだけ」無効化されていた。
  // 残るフォーカス指標は `ring-ring/50`（白背景 2.08:1）と、destructive では
  // `border-destructive/40`（1.93:1）まで弱められており、SC 1.4.11 の 3:1 を満たしていなかった。
  //
  // 是正方針は「フォーカス指標を theme.css の base outline に一本化する」。部品は focus を自前定義せず、
  // 全要素・全 variant・アプリの生 HTML が同一の指標で統一される。本ブロックはその状態を機械固定する。
  describe('5. フォーカス指標が base レイヤの outline に一本化されている（Issue #49 / Requirements 5.3）', () => {
    const globalsCss = readFileSync(globalsCssPath, 'utf8');
    let compiled = '';
    let compiledWithForcedOutlineNone = '';

    beforeAll(async () => {
      compiled = await compileWithAppToolchain(app, globalsCss);
      // 否定系用: Tailwind v4 の `@source inline(...)` でユーティリティの生成を強制する。
      compiledWithForcedOutlineNone = await compileWithAppToolchain(
        app,
        `${globalsCss}\n@source inline("outline-none");\n`,
      );
    });

    it('グローバル :focus-visible の既定が base レイヤに生成される', () => {
      const rules = rulesInLayer(compiled, 'base', ':focus-visible');
      expect(
        rules.length,
        'base レイヤにグローバルな :focus-visible の既定がありません（theme.css の宣言が失われています）',
      ).toBeGreaterThan(0);
    });

    it('その outline が無効化されておらず、色がトークン var(--ring) 由来である', () => {
      const rule = rulesInLayer(compiled, 'base', ':focus-visible').at(-1);
      expect(rule, 'base レイヤの :focus-visible 規則が取得できません').toBeDefined();
      const declarations = declarationsOf(rule!);
      const outline = declarations['outline'] ?? '';
      expect(outline, ':focus-visible に outline 宣言がありません').not.toBe('');
      expect(outline, `outline が無効化されています: ${outline}`).not.toMatch(/\bnone\b/);
      // 色は必ずトークン参照であること（生の hex 直書きを許さない。見出し検証と同じ流儀）。
      expect(outline, `outline の色がトークン参照ではありません: ${outline}`).toMatch(
        /var\(--ring\)/,
      );
    });

    it('.outline-none が生成されない（base の既定を打ち消す部品が存在しない証明）', () => {
      // これが本 Issue の根本原因を直接封じる検証。Tailwind は「使われたユーティリティ」しか
      // 生成しないため、`.outline-none` が生成 CSS に出ない＝ @source が走査する @fwlm/ui にも
      // アプリ自身のソースにも `outline-none` が存在しない、という意味になる。
      expect(
        hasUtilityRule(compiled, 'outline-none'),
        '.outline-none が生成されています。いずれかの部品またはアプリが base レイヤの ' +
          ':focus-visible 既定を打ち消しており、その要素ではフォーカスが不可視になります',
      ).toBe(false);
    });

    it('@source inline で強制すると .outline-none は生成される（検出が空振りでないことの証明）', () => {
      // 上の検証が「そもそも .outline-none を検出できないから緑」になっていないことを示す対照。
      expect(
        hasUtilityRule(compiledWithForcedOutlineNone, 'outline-none'),
        '@source inline で強制しても .outline-none を検出できません。検出方法が壊れています',
      ).toBe(true);
    });
  });

  // 6. 動き低減設定下の抑制（Issue #52 / ui-a11y-gaps Requirements 1.1, 1.2, 5.1）
  //
  // 無限に回り続けるアニメーションは前庭障害・光過敏のある利用者にとって実害となるが、
  // 抑制が壊れても **画面は正常に見える**。実害を受けるのは動き低減設定を有効にしている
  // 利用者だけで、開発者の画面には何も起きない。したがって「無言の失敗」を機械で捕まえる。
  //
  // 守るべき条件は 2 つあり、どちらか一方でも欠けると抑制は無言で効かなくなる:
  //   (a) 規則が `@layer base` に属すること
  //   (b) 宣言が `!important` を伴うこと
  // (b) が要るのは、生成 CSS 冒頭の `@layer theme, base, components, utilities` により
  // base が utilities（`animate-spin` / `transition-*` の出力先）に **詳細度と無関係に負ける**
  // ためである（Issue #49 の原因と同じ構造）。`!important` 宣言に限りレイヤ順は逆転する。
  describe('6. 動き低減の抑制が base レイヤに important 付きで生成される（Requirements 5.1）', () => {
    const globalsCss = readFileSync(globalsCssPath, 'utf8');
    const REDUCED_MOTION = /prefers-reduced-motion\s*:\s*reduce/;
    let compiled = '';

    beforeAll(async () => {
      compiled = await compileWithAppToolchain(app, globalsCss);
    });

    it('抽出器の自己検証: base レイヤ外の同条件メディアクエリは拾わない', () => {
      // 「レイヤ所属を見ている」ことの証明。これが無いと、抑制が別レイヤへ移動しても
      // 文字列としては存在するため緑のまま通ってしまう。
      const fixture = [
        '@layer theme, base, components, utilities;',
        '@media (prefers-reduced-motion: reduce){ .outside{ animation-duration: 0s } }',
        '@layer utilities{ @media (prefers-reduced-motion: reduce){ .wrong-layer{ animation-duration: 0s } } }',
        '@layer base{ @media (prefers-reduced-motion: reduce){ *{ animation-duration: 0.01ms !important } } }',
      ].join('\n');
      expect(
        mediaRulesInLayer(fixture, 'base', REDUCED_MOTION).length,
        'base レイヤ内の 1 件だけを取り出せていません（レイヤ所属の判定が効いていない）',
      ).toBe(1);
      expect(mediaRulesInLayer(fixture, 'utilities', REDUCED_MOTION).length).toBe(1);
    });

    it('動き低減の抑制ブロックが base レイヤに存在する', () => {
      expect(
        mediaRulesInLayer(compiled, 'base', REDUCED_MOTION).length,
        'base レイヤに prefers-reduced-motion の抑制ブロックがありません。' +
          '動き低減設定を有効にしている利用者に対して、無限アニメーションと状態遷移が' +
          'そのまま再生されます（画面上は正常に見えるため目視では気づけません）',
      ).toBeGreaterThan(0);
    });

    it('抑制対象のプロパティが揃っている（経過のみを止める）', () => {
      const declared = new Set<string>();
      for (const media of mediaRulesInLayer(compiled, 'base', REDUCED_MOTION)) {
        media.walkDecls((decl) => declared.add(decl.prop));
      }
      for (const property of MOTION_SUPPRESSED_PROPERTIES) {
        expect(
          declared.has(property),
          `抑制ブロックに ${property} がありません（宣言されているのは ${[...declared].join(', ') || '（無し）'}）`,
        ).toBe(true);
      }
    });

    it('到達状態を決めるプロパティを抑制していない（Requirements 1.4）', () => {
      const declared = new Set<string>();
      for (const media of mediaRulesInLayer(compiled, 'base', REDUCED_MOTION)) {
        media.walkDecls((decl) => declared.add(decl.prop));
      }
      for (const property of MOTION_FORBIDDEN_PROPERTIES) {
        expect(
          declared.has(property),
          `抑制ブロックが ${property} を宣言しています。これは動きの「経過」ではなく` +
            '「到達状態」であり、抑制すると押下フィードバックのような状態表現まで失われます',
        ).toBe(false);
      }
    });

    it('全ての抑制宣言が important を伴う（レイヤ順の逆転がこれに依存する）', () => {
      const weak: string[] = [];
      for (const media of mediaRulesInLayer(compiled, 'base', REDUCED_MOTION)) {
        media.walkDecls((decl) => {
          if (!decl.important) weak.push(`${decl.prop}: ${decl.value}`);
        });
      }
      expect(
        weak,
        `important を伴わない抑制宣言があります: ${weak.join(' / ')}。` +
          'base レイヤの規則は @layer utilities の animate-* / transition-* に詳細度と無関係に' +
          '負けるため、important が無いと抑制は一切効きません（無言で機能しなくなります）',
      ).toEqual([]);
    });
  });
});
