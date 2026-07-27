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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { colors, lineColors, shadow } from '@fwlm/design-tokens';

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
