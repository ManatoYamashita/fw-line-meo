// theme.css ↔ @fwlm/design-tokens の同値検証（theme-sync）。
// design.md「@fwlm/ui — theme.css」Responsibilities & Constraints /
// Testing Strategy Unit 2「theme-sync.test.ts」/ Requirements 1.1, 1.2, 5.3。
//
// 設計方針: theme.css と design-tokens の同期は codegen を作らず「手動同期 ＋ 機械検証」で固める。
// 本テストは theme.css に現れる全 hex 値が @fwlm/design-tokens の値集合に含まれること
// （theme.css の hex ⊆ design-tokens の hex）を assert する。design-tokens に定義の無い色を
// theme.css へ足すと即座に赤になる（RED を保証）。
//
// 注: 影トークンは rgba を避け 8 桁アルファ hex（#0000000D 等）で表現されるため、hex 抽出の
// 正規表現は 3〜8 桁を対象にする。
//
// 注意（集合包含だけでは不十分な理由）: hex の集合包含は「役割の取り違え」も「同期漏れ」も
// 検出できない。例えば `--color-text` へ `--color-text-muted` の値を誤って割り当てても、
// design-tokens 側で `colors.text` を変えて theme.css を同期し忘れても、同じ hex が別の役割の
// 値として集合に残っている限り緑のままになる。よって下段の「役割対応表による厳密一致」検証を
// 併せて持つ（集合包含は shadow のアルファ hex 等、対応表の対象外を拾う網として残す）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { colors, lineColors, shadow, type ColorTokens } from '@fwlm/design-tokens';

/** 3〜8 桁の hex カラーリテラル（影の 8 桁アルファ hex を含む）を大文字化して抽出する。 */
const HEX_PATTERN = /#[0-9a-fA-F]{3,8}/g;

function extractHexes(source: string): readonly string[] {
  return (source.match(HEX_PATTERN) ?? []).map((hex) => hex.toUpperCase());
}

/** design-tokens 側の全 hex 値集合（colors / lineColors / shadow の値から抽出）。 */
function buildTokenHexSet(): ReadonlySet<string> {
  const tokenValues: readonly string[] = [
    ...Object.values(colors),
    ...Object.values(lineColors),
    ...Object.values(shadow),
  ];
  const set = new Set<string>();
  for (const value of tokenValues) {
    for (const hex of extractHexes(value)) {
      set.add(hex);
    }
  }
  return set;
}

const themeCssPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'theme.css');
const themeCss = readFileSync(themeCssPath, 'utf8');
const themeHexes = extractHexes(themeCss);
const tokenHexSet = buildTokenHexSet();

describe('theme-sync: theme.css の全 hex ⊆ design-tokens 値集合（Requirements 1.1, 1.2）', () => {
  it('design-tokens 値集合が hex を含む（照合基盤の自己検証）', () => {
    expect(tokenHexSet.size).toBeGreaterThan(0);
  });

  it('theme.css は hex カラーを 1 つ以上含む（空ファイルでの空振り緑を防ぐ）', () => {
    expect(themeHexes.length).toBeGreaterThan(0);
  });

  it('theme.css の全 hex が design-tokens の値集合に含まれる', () => {
    const undefinedHexes = [...new Set(themeHexes)].filter((hex) => !tokenHexSet.has(hex));
    expect(
      undefinedHexes,
      `design-tokens に定義の無い色が theme.css に混入しています: ${undefinedHexes.join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * `@theme { … }`（`@theme inline` ではない方）のブロック本文を取り出す。
 * ブロック内に入れ子の波括弧は無いが、将来の変化に耐えるよう深さを数えて対応括弧を探す。
 */
function extractThemeBlock(css: string): string {
  // `@theme inline {` に一致しないよう、`@theme` の直後は空白＋`{` のみを許す。
  const header = /@theme[ \t]*\{/.exec(css);
  if (header === null) {
    throw new Error('theme.css に @theme ブロックが見つかりません');
  }
  const start = css.indexOf('{', header.index);
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + 1, i);
    }
  }
  throw new Error('theme.css の @theme ブロックが閉じられていません');
}

/** ブロック本文から `--name: <値>;` の値部分を取り出す（最初の宣言のみ）。 */
function declarationIn(block: string, cssVariable: string): string | undefined {
  // 変数名の直後に `:` を要求するため、`--color-text` が `--color-text-muted` に誤一致しない。
  const pattern = new RegExp(`(?:^|[;{\\s])${cssVariable}\\s*:\\s*([^;]+);`);
  return pattern.exec(block)?.[1]?.trim();
}

/**
 * 意味役割 ↔ `@theme` の CSS 変数の対応表（Requirements 1.1, 1.3）。
 *
 * ここが本テストの中核。集合包含では「役割の取り違え」を検出できないため、
 * ColorTokens の全キーについて「どの CSS 変数と同値であるべきか」を明示的に固定し、
 * 宣言値と厳密一致（大文字化して比較）することを assert する。
 * 新しい色役割を design-tokens へ追加したら、必ずこの表にも追記させる
 * （下段の網羅ガードが未追記を検出する）。
 */
const COLOR_ROLE_TO_CSS_VARIABLE: Readonly<Record<keyof ColorTokens, string>> = {
  brand: '--color-brand',
  brandSubtle: '--color-brand-subtle',
  primary: '--color-primary',
  primaryHover: '--color-primary-hover',
  primaryForeground: '--color-primary-foreground',
  text: '--color-text',
  textMuted: '--color-text-muted',
  background: '--color-background',
  destructive: '--color-destructive',
  destructiveForeground: '--color-destructive-foreground',
  border: '--color-border',
  // 識別用の枠色。装飾用（--color-border）とは別変数として宣言し、:root の意味論変数が
  // それぞれ別の役割を指せるようにする。この 2 つが同じ変数へ潰れると、識別用だけを濃くする
  // ことが構造的に不可能になる（design.md「意味論変数割当」State Management）。
  borderInteractive: '--color-border-interactive',
};

describe('theme-sync: 意味役割 ↔ @theme 変数の厳密一致（Requirements 1.1, 1.3）', () => {
  const themeBlock = extractThemeBlock(themeCss);

  it('ColorTokens の全キーが役割対応表に存在する（新規役割の取りこぼし防止）', () => {
    // 色役割を追加したら必ず theme.css への対応付けを宣言させるための網羅ガード
    // （design-tokens/test/colors.test.ts の分類ガードと同じ流儀）。
    expect(Object.keys(COLOR_ROLE_TO_CSS_VARIABLE).sort()).toEqual(Object.keys(colors).sort());
  });

  for (const [role, cssVariable] of Object.entries(COLOR_ROLE_TO_CSS_VARIABLE) as [
    keyof ColorTokens,
    string,
  ][]) {
    it(`${cssVariable} は colors.${role}（${colors[role]}）と同値`, () => {
      const declared = declarationIn(themeBlock, cssVariable);
      expect(
        declared,
        `${cssVariable} が theme.css の @theme ブロックに定義されていません`,
      ).toBeDefined();
      expect(
        declared?.toUpperCase(),
        `${cssVariable} の値が colors.${role} と一致しません` +
          `（theme.css: ${declared} / design-tokens: ${colors[role]}）`,
      ).toBe(colors[role].toUpperCase());
    });
  }

  it('@theme の全 --color-* 変数が役割対応表で説明されている（役割外の色の混入防止）', () => {
    // 対応表に無い `--color-*` を theme.css へ足すと、design-tokens に同じ hex が
    // 別役割で存在する限り集合包含テストは緑のまま通ってしまう。ここで塞ぐ。
    const declaredColorVariables = [...themeBlock.matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map(
      (match) => match[1],
    );
    const mapped = new Set(Object.values(COLOR_ROLE_TO_CSS_VARIABLE));
    const unmapped = declaredColorVariables.filter((name) => !mapped.has(name ?? ''));
    expect(
      unmapped,
      `役割対応表に無い色変数が @theme に定義されています: ${unmapped.join(', ')}`,
    ).toEqual([]);
  });
});

// 成功通知（Alert の success 変種）用の意味論変数の契約（タスク 6.2 / Requirements 2.1, 5.2）。
// ブランド緑 #1DB446 は白背景の通常文字で 2.74:1 と WCAG AA（4.5:1）に届かないため、
// 成功色の「文字色」にはブランド緑ではなく AA 準拠の primary（#15803D・約 5.02:1）を割り当てる。
// この対応付けが崩れると、成功メッセージだけが AA 非準拠に戻る（回帰しやすい判断のため機械固定する）。
describe('success 意味論変数の AA 準拠参照（Requirements 2.1, 5.2）', () => {
  /** `--name: <値>;` の値部分を取り出す（最初の宣言のみ）。 */
  function declarationValue(name: string): string | undefined {
    const match = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(themeCss);
    return match?.[1]?.trim();
  }

  it('--success が定義され、AA 準拠の primary を参照する（brand は参照しない）', () => {
    const value = declarationValue('success');
    expect(value, '--success が theme.css に定義されていません').toBeDefined();
    expect(value).toContain('var(--color-primary)');
    expect(value).not.toContain('var(--color-brand)');
  });

  it('--color-success が公開され、text-success ユーティリティが生成される', () => {
    // @theme inline へ公開しないと Tailwind は text-success を「静かに生成しない」
    // （design.md Error Handling の既知の落とし穴）。
    const value = declarationValue('color-success');
    expect(value, '--color-success が @theme inline に公開されていません').toBeDefined();
    expect(value).toContain('var(--success)');
  });
});
