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
// 見出しの階層は「theme.css の @layer base が生 <h1>〜<h6> に与える既定」と「共通部品 Heading が
// レベルごとに与えるユーティリティ」の 2 箇所が別々に持っている。両者の一致は長らくコメントで
// 主張されていただけで検証が無く、実際に食い違っていた（ui-airbnb-foundation N2）。
// 実装そのものを import して照合するため、この表をテスト側に書き写さない。
import { DEFAULT_SIZE_BY_LEVEL, headingVariants } from '../src/components/heading';

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
 *
 * Preflight のリセットは `h1, h2, h3, h4, h5, h6 { … }` というセレクタリストなので除外する。
 *
 * **旧実装は正規表現で `h{level}` の直後に `{` を要求していたが、これは末尾レベルで破れる**
 * （Issue #60 の自己検証で検出）。`h1, …, h6 {` の `h6` は直後が ` {` で、直前が空白なので
 * 境界条件も満たしてしまい、Preflight のリセットを単独規則として拾っていた。先頭レベル（h1）は
 * 直後が `,` なので偶然通り、実利用側も `rules[rules.length - 1]` を採っていたため
 * 順序の偶然に守られて表面化していなかった。
 *
 * 「セレクタが `h{level}` そのものであること」は文字列の見た目では判定できないので、
 * 本ファイルの `rulesInLayer` / `mediaRulesInLayer` と同じく postcss の構文木で判定する。
 */
function standaloneHeadingRules(css: string, level: number): readonly { index: number; body: string }[] {
  const rules: { index: number; body: string }[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector.trim() !== `h${level}`) return;
    rules.push({
      // 実利用側が Preflight のリセットとの前後関係を見るため、元 CSS 上の位置を保つ。
      index: rule.source?.start?.offset ?? -1,
      body: rule.nodes.map((node) => node.toString()).join(';'),
    });
  });
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

/**
 * 生成 CSS に現れるカスタムプロパティの宣言表（`--name -> 値`）。
 *
 * 同名が複数回宣言された場合は後勝ちで畳む（カスケードと同じ向き）。
 * Tailwind の `@property` は `syntax` / `inherits` を宣言するだけで `--name: 値` を持たないため、
 * ここには入らない。
 */
function cssVariableMap(css: string): ReadonlyMap<string, string> {
  const variables = new Map<string, string>();
  postcss.parse(css).walkDecls((decl) => {
    if (decl.prop.startsWith('--')) variables.set(decl.prop, decl.value.trim());
  });
  return variables;
}

/**
 * `var(--x)` / `var(--x, フォールバック)` を宣言表で展開し、実値へ解決する。
 *
 * 括弧の深さを数えて対応する閉じ括弧を探す。単純な正規表現だと
 * `var(--tw-leading, var(--text-2xl--line-height))` のような入れ子で末尾まで飲み込み、
 * 内側の変数名を取り違える。未定義の変数はフォールバック側へ倒す。
 * 循環参照で止まらなくならないよう展開回数に上限を置く。
 */
function resolveCssValue(value: string, variables: ReadonlyMap<string, string>): string {
  let current = value.trim();
  for (let step = 0; step < 16; step += 1) {
    const start = current.indexOf('var(');
    if (start < 0) return current.trim();
    let depth = 0;
    let end = -1;
    for (let i = start + 3; i < current.length; i += 1) {
      if (current[i] === '(') depth += 1;
      else if (current[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) return current.trim();
    const inner = current.slice(start + 4, end);
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? '' : inner.slice(comma + 1).trim();
    current = current.slice(0, start) + (variables.get(name) ?? fallback) + current.slice(end + 1);
  }
  return current.trim();
}

/** 生成 CSS から、セレクタが `.{utility}` と完全一致する規則の宣言を集める。 */
function utilityDeclarations(css: string, utility: string): Readonly<Record<string, string>> {
  const declarations: Record<string, string> = {};
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector.trim() !== `.${utility}`) return;
    Object.assign(declarations, declarationsOf(rule));
  });
  return declarations;
}

/**
 * 見出しの見え方を決める 3 プロパティ。
 *
 * `font-size` だけでは足りない。Preflight は `font-size` と `font-weight` の両方を潰すし、
 * 行間は既存のどのガードも見ていなかった（実際に base 側 1.3 と部品側 1.25 が食い違っていた）。
 */
const HEADING_VISUAL_PROPERTIES = ['font-size', 'font-weight', 'line-height'] as const;

/** 生成 CSS の `h{level}` 単独規則から、見え方 3 プロパティを実値で取り出す。 */
function headingBaseVisual(
  css: string,
  level: number,
  variables: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> {
  const declarations: Record<string, string> = {};
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector.trim() !== `h${level}`) return;
    Object.assign(declarations, declarationsOf(rule));
  });
  const visual: Record<string, string> = {};
  for (const property of HEADING_VISUAL_PROPERTIES) {
    const raw = declarations[property];
    if (raw !== undefined) visual[property] = resolveCssValue(raw, variables);
  }
  return visual;
}

/**
 * 共通部品 Heading がレベル n へ与えるユーティリティ群から、見え方 3 プロパティを実値で組み立てる。
 *
 * ユーティリティの実値は**実コンパイル結果から引く**。Tailwind 既定の行間や太さの数値を
 * このファイルへ書き写すと、Tailwind 側が値を変えたときに気づけない写しになる。
 * クラスは記述順に後勝ちで畳む（`text-2xl` の行間を `leading-tight` が上書きする関係を再現する）。
 */
function headingComponentVisual(
  css: string,
  level: 1 | 2 | 3 | 4 | 5 | 6,
  variables: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> {
  const utilities = headingVariants({ size: DEFAULT_SIZE_BY_LEVEL[level] })
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const visual: Record<string, string> = {};
  for (const utility of utilities) {
    const declarations = utilityDeclarations(css, utility);
    for (const property of HEADING_VISUAL_PROPERTIES) {
      const raw = declarations[property];
      if (raw !== undefined) visual[property] = resolveCssValue(raw, variables);
    }
  }
  return visual;
}

/**
 * 抽出器の自己検証（Issue #60）。
 *
 * 本ファイルには「対照実験」（`@source` を外すと消える／`@source inline` で強制すると生成される）は
 * あるが、**抽出器そのものの入出力を固定する fixture が無い**ものが残っていた。対照実験は
 * 「ガード全体が空振りしていない」ことしか言えず、抽出器が位置や形状に依存して取りこぼしても、
 * たまたま別の経路で赤くなれば緑に見えてしまう。
 */
describe('抽出器の自己検証（Issue #60）', () => {
  describe('standaloneHeadingRules', () => {
    it('Preflight のセレクタリストを拾わず、単独規則だけを返す', () => {
      // 実装コメントが主張している中核の性質。**末尾レベル（h6）で確かめる**のが要点で、
      // 先頭レベル（h1）は直後が `,` なので、境界が壊れていても偶然通る。
      const css = 'h1, h2, h3, h4, h5, h6 {\n  font-size: inherit;\n}\nh6 {\n  font-size: 1rem;\n}\n';
      const rules = standaloneHeadingRules(css, 6);
      expect(rules).toHaveLength(1);
      expect(rules[0]?.body).toContain('1rem');
    });

    it('先頭位置の規則も拾う（位置依存で漏らさない）', () => {
      expect(standaloneHeadingRules('h3{color:red}', 3)).toHaveLength(1);
    });

    it('クラス名や別レベルを拾わない', () => {
      expect(standaloneHeadingRules('.h3 { color: red }', 3)).toEqual([]);
      expect(standaloneHeadingRules('h33 { color: red }', 3)).toEqual([]);
      expect(standaloneHeadingRules('h4 { color: red }', 3)).toEqual([]);
    });

    it('複数の規則をすべて出現順に返す', () => {
      const rules = standaloneHeadingRules('h2 { a: 1 }\nh2 { b: 2 }\n', 2);
      expect(rules.map((r) => r.body.trim())).toEqual(['a: 1', 'b: 2']);
    });
  });

  describe('hasUtilityRule', () => {
    it('単独のユーティリティ規則を検出する（先頭位置を含む）', () => {
      expect(hasUtilityRule('.bg-primary { color: red }', 'bg-primary')).toBe(true);
      expect(hasUtilityRule('a{}\n.bg-primary{color:red}', 'bg-primary')).toBe(true);
    });

    it('接頭辞が一致する別ユーティリティを拾わない', () => {
      // `.bg-primary-hover` があるだけで `.bg-primary` が生成されたと誤報しない。
      expect(hasUtilityRule('.bg-primary-hover { color: red }', 'bg-primary')).toBe(false);
    });

    it('複合セレクタの一部としての出現を拾わない', () => {
      // `.hover\:bg-primary:hover` のような形は「単独のユーティリティ規則」ではない。
      expect(hasUtilityRule('.foo.bg-primary { color: red }', 'bg-primary')).toBe(false);
    });

    it('セレクタに含まれる特殊文字をエスケープして扱う', () => {
      // Tailwind の生成 CSS は `.focus-visible\:ring-3` のようにコロンを含む。
      expect(hasUtilityRule('.focus-visible\\:ring-3 { outline: none }', 'focus-visible\\:ring-3')).toBe(
        true,
      );
    });
  });

  describe('rulesInLayer', () => {
    it('指定レイヤ内の完全一致セレクタだけを返す', () => {
      const css = '@layer base { :focus-visible { outline: 1px } }';
      expect(rulesInLayer(css, 'base', ':focus-visible')).toHaveLength(1);
    });

    it('レイヤ外の同一セレクタは拾わない（mediaRulesInLayer と同水準の性質）', () => {
      // **本ファイルで自己検証を持っていたのは mediaRulesInLayer だけだった。**
      // レイヤ所属を見る点は同型なのに、こちらは固定されていなかった。
      const css = ':focus-visible { outline: 1px }\n@layer utilities { :focus-visible { outline: 2px } }';
      expect(rulesInLayer(css, 'base', ':focus-visible')).toEqual([]);
    });

    it('セレクタの部分一致では拾わない（完全一致を要求する）', () => {
      const css = '@layer base { .a:focus-visible { outline: 1px } }';
      expect(rulesInLayer(css, 'base', ':focus-visible')).toEqual([]);
    });

    it('入れ子の at-rule 内にある規則も拾う', () => {
      const css = '@layer base { @media (min-width: 1px) { :focus-visible { outline: 1px } } }';
      expect(rulesInLayer(css, 'base', ':focus-visible')).toHaveLength(1);
    });
  });
});

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

/**
 * ダークモードが導入されていないことの機械検証（Requirements 6.6 / 5.7 の前提）。
 *
 * コントラスト検証ガード（contrast-usage.test.ts）は `dark:` を含む色指定を検出対象から
 * 外している。要件 5.7 はこの除外を「Where ダークモード配色が導入されていない」という
 * 条件節のもとでのみ許しており、前提が崩れれば除外は正当性を失う——それどころか、
 * 未整備のダーク配色を**ガードが隠す**側へ反転する。theme.css の無効化宣言が消えれば
 * 部品に現存する `dark:*` が一斉に有効化されるが、除外があるため CI は緑のまま通る。
 *
 * 以下はその前提そのものを固定する。除外を書いた場所（contrast-usage.test.ts）からは
 * 本ブロックを参照している。
 */
describe('ダークモードが導入されていない（Requirements 6.6 / 5.7 の前提）', () => {
  /**
   * `dark:` を `.dark` 祖先セレクタへ再定義している宣言。
   * Tailwind v4 の既定は `@media (prefers-color-scheme: dark)` であり、この宣言が
   * 無ければ OS 設定だけでダーク配色が有効になる。
   */
  const DARK_VARIANT_DECLARATION = /@custom-variant\s+dark\s*\(\s*&:is\(\.dark\s+\*\)\s*\)\s*;/;

  /**
   * 「`.dark` 祖先クラスを要素へ付与している」痕跡。
   *
   * `dark` が**単独の語**として現れる箇所を探す。`className="dark"` や
   * `classList.add('dark')` は捕らえ、`dark:bg-input/30` のようなバリアント接頭辞や
   * `darker` のような別語は捕らえない（直後が `:` や英字なら一致しない）。
   * 走査はスクリプトのみを対象とする。スタイルシートはセレクタを**定義**するだけで
   * 付与はしないため、theme.css の宣言自身を誤検出しない。
   */
  const DARK_CLASS_APPLICATION = /(?:^|[\s"'`({[,])dark(?:[\s"'`)}\],;]|$)/;

  /** 付与の有無を調べる対象。UI パッケージのソースと、それを使う 3 面すべて。 */
  const applicationScanRoots: readonly string[] = [uiSrcDir, ...APPS.map((app) => app.dir)];

  const scriptFiles = applicationScanRoots.flatMap((root) =>
    collectAppSourceFiles(root).filter((file) => !file.endsWith('.css')),
  );

  it('theme.css が dark バリアントを .dark 祖先へ再定義している', () => {
    const themeCss = readFileSync(join(uiSrcDir, 'theme.css'), 'utf8');
    expect(
      DARK_VARIANT_DECLARATION.test(themeCss),
      'theme.css の dark バリアント無効化宣言が見つかりません。これが無いと OS が ' +
        'ダークの端末で部品の dark:* が一斉に有効化されますが、コントラスト検証ガードは ' +
        'それらを検出対象から外しているため CI は緑のまま通ります（要件 6.6 / 5.7 の前提）',
    ).toBe(true);
  });

  it('宣言の検出パターンが空振りしていない（宣言を除いた入力では一致しない）', () => {
    // 上の検証が「どんな入力でも真」になっていないことの対照。
    const themeCss = readFileSync(join(uiSrcDir, 'theme.css'), 'utf8');
    expect(
      DARK_VARIANT_DECLARATION.test(themeCss.replace(DARK_VARIANT_DECLARATION, '')),
      '宣言を取り除いても検出パターンが一致します。検出方法が壊れています',
    ).toBe(false);
  });

  it('走査対象のソースを読めている（空振り緑の防止）', () => {
    expect(
      scriptFiles.length,
      'スクリプトソースが 1 件も見つかりません。付与箇所の検証は対象ゼロでは何も守れません',
    ).toBeGreaterThan(0);
  });

  it('.dark 祖先クラスを付与している箇所が存在しない', () => {
    const offenders = scriptFiles.filter((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .some((line) => DARK_CLASS_APPLICATION.test(line)),
    );
    expect(
      offenders,
      `.dark 祖先クラスを付与している箇所があります: ${offenders.join(' / ')}。` +
        'ダークモードを導入するなら、コントラスト検証ガードの dark: 除外を外し、' +
        'ダーク下地での実効コントラストを検証してください（要件 5.7）',
    ).toEqual([]);
  });

  it('付与の検出器が実際の付与を捕らえ、バリアント接頭辞は捕らえない', () => {
    // 上の検証が「何も検出できないから緑」になっていないことの対照。
    for (const applied of [
      '<html lang="ja" className="dark">',
      "document.documentElement.classList.add('dark')",
      'el.classList.toggle("dark", enabled)',
    ]) {
      expect(DARK_CLASS_APPLICATION.test(applied), `付与を見逃しています: ${applied}`).toBe(true);
    }
    for (const notApplied of [
      'className="dark:bg-input/30 dark:border-input"',
      'const darker = value < threshold',
      "if (rawToken.includes('dark:')) continue;",
    ]) {
      expect(
        DARK_CLASS_APPLICATION.test(notApplied),
        `付与でないものを誤検出しています: ${notApplied}`,
      ).toBe(false);
    }
  });
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

    // 見出しの階層は 2 箇所が別々に持っている。theme.css の `@layer base` が生 <h1>〜<h6> へ与える
    // 既定と、共通部品 Heading がレベルごとに与えるユーティリティである。**この 2 つの一致を
    // 検証するものが 1 本も無かった**ため、実際に食い違ったまま両方が緑で通っていた
    // （base 側 h1 の行間 1.3 に対し部品側は leading-tight = 1.25 等）。
    //
    // 食い違いの実害は「同じ見出しレベルなのに、素のタグで書いたか部品で書いたかで見え方が変わる」
    // ことである。#48 が是正した「見出しが本文と同じ大きさで描かれる」と同じく、
    // **画面を目視するまで誰も気づけない**種類の劣化にあたる。
    it.each(HEADING_LEVELS)(
      'h%i の既定と共通部品 Heading の描画が寸法・太さ・行間で一致する',
      (level) => {
        const variables = cssVariableMap(compiled);
        const base = headingBaseVisual(compiled, level, variables);
        const component = headingComponentVisual(compiled, level, variables);

        // 解決に失敗した値（var( が残る・空）を「一致」と読み違えないための前提確認。
        for (const [source, visual] of [
          ['@layer base', base],
          ['Heading 部品', component],
        ] as const) {
          for (const property of HEADING_VISUAL_PROPERTIES) {
            const value = visual[property];
            expect(value, `${source} の h${level} に ${property} がありません`).toBeDefined();
            expect(value, `${source} の h${level} の ${property} を実値へ解決できていません`).not.toMatch(
              /var\(|^$/,
            );
          }
        }

        expect(
          component,
          `h${level} の見え方が @layer base と Heading 部品で食い違っています。` +
            'どちらか一方だけを変えると、同じ見出しレベルが書き方によって別の大きさで描かれます',
        ).toEqual(base);
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
        media.walkDecls((decl) => {
          declared.add(decl.prop);
        });
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
        media.walkDecls((decl) => {
          declared.add(decl.prop);
        });
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

  /**
   * ダークモードの無効化が、実際にコンパイルされた CSS で成立していることの証明
   * （Requirements 6.6 / 5.7 の前提）。
   *
   * 宣言が theme.css にあることは前段の describe が固定している。ここでは「宣言が実際に
   * 効いて、部品の dark:* が OS 設定ではなく祖先クラスに閉じ込められているか」を、
   * アプリ自身のツールチェーンで生成した CSS に対して確かめる。
   */
  describe('7. ダークモードの無効化（Requirements 6.6 / 5.7 の前提）', () => {
    const globalsCss = readFileSync(globalsCssPath, 'utf8');
    /** Tailwind v4 の既定。宣言が無ければ dark:* はこの形へ展開される。 */
    const PREFERS_DARK = 'prefers-color-scheme: dark';
    /** 無効化宣言が効いているときの形。`.dark` 祖先が無い限り適用されない。 */
    const DARK_ANCESTOR = ':is(.dark *)';

    let compiled = '';
    let compiledWithDefaultDarkVariant = '';

    beforeAll(async () => {
      compiled = await compileWithAppToolchain(app, globalsCss);
      // 否定系用: 後勝ちで既定のメディアクエリ形へ戻し、「無効化しなかった場合」を再現する。
      compiledWithDefaultDarkVariant = await compileWithAppToolchain(
        app,
        `${globalsCss}\n@custom-variant dark (@media (${PREFERS_DARK}));\n`,
      );
    });

    it('OS のダーク設定だけで有効になる規則が生成されない', () => {
      expect(
        compiled.includes(PREFERS_DARK),
        `生成 CSS に ${PREFERS_DARK} が現れています。部品の dark:* が OS 設定だけで ` +
          '有効になり、未整備のダーク配色が利用者に出ます。しかもコントラスト検証ガードは ' +
          'dark: を検出対象から外しているため、この破綻は静的検証では捕捉できません',
      ).toBe(false);
    });

    it('dark:* が祖先クラス依存の形で生成されている（無効化が空振りでない証明）', () => {
      // 前の検証は「dark:* が 1 つも生成されていない」場合にも緑になる。部品に現存する
      // dark:* が実際に生成され、かつ祖先クラスに閉じ込められていることをここで固定する。
      expect(
        compiled.includes(DARK_ANCESTOR),
        `生成 CSS に ${DARK_ANCESTOR} が現れません。dark:* が 1 つも生成されていない場合、` +
          '前の検証は対象ゼロで緑になり何も守っていません',
      ).toBe(true);
    });

    it('既定のバリアント定義へ戻すと OS 設定で有効になる（検出が空振りでない証明）', () => {
      // 上の 2 つが「そもそも検出できないから緑」になっていないことの対照。
      expect(
        compiledWithDefaultDarkVariant.includes(PREFERS_DARK),
        `既定のバリアント定義へ戻しても ${PREFERS_DARK} を検出できません。検出方法が壊れています`,
      ).toBe(true);
      expect(
        compiledWithDefaultDarkVariant.includes(DARK_ANCESTOR),
        `既定のバリアント定義へ戻したのに ${DARK_ANCESTOR} が残っています。` +
          '上書きが効いておらず、対照実験が成立していません',
      ).toBe(false);
    });
  });
});
