// Web 意味役割カラーペアの WCAG AA コントラスト機械検証（Requirements 5.2 /
// design.md Testing Strategy Unit 1「colors.test.ts」）。
// - WCAG 2.1 の相対輝度とコントラスト比の定義を依存ゼロで自前実装し、Web 面のテキスト
//   前景/背景ペア全てが通常文字の AA 基準（4.5:1 以上）を満たすことを数値で assert する。
// - 対象外: brand・brandSubtle・border・borderInteractive（装飾・面塗り・非テキスト用途）と
//   lineColors（LINE Flex Message は Web コンテンツではないため AA 検証対象外）。
// - primary の具体 hex はこのテストを通ることをもって確定値とする。
import { describe, it, expect } from 'vitest';
import { colors, compositeOver, contrastRatio } from '../src/index.js';

/** 通常文字の WCAG 2.1 AA 基準（Requirements 5.2）。 */
const AA_NORMAL_TEXT_RATIO = 4.5;

/** Web 面でテキスト描画に使う前景/背景の全ペア（意味役割名で列挙）。 */
const AA_TEXT_PAIRS: ReadonlyArray<{
  foreground: keyof typeof colors;
  background: keyof typeof colors;
}> = [
  { foreground: 'text', background: 'background' },
  { foreground: 'textMuted', background: 'background' },
  { foreground: 'primaryForeground', background: 'primary' },
  // hover 状態のテキストも WCAG 1.4.3 の対象。通常時に AA を満たしていても hover で割る事故
  // （Issue #50 の bg-primary/80）を再発させないため、hover 面も同じ基準で検証する。
  { foreground: 'primaryForeground', background: 'primaryHover' },
  { foreground: 'destructiveForeground', background: 'destructive' },
];

/** AA 検証の対象外とする意味役割（装飾・面塗り・非テキスト用途）。 */
const NON_TEXT_ROLES: readonly (keyof typeof colors)[] = [
  'brand',
  'brandSubtle',
  'border',
  // 識別用の枠色。テキスト前景としては使わないため AA_TEXT_PAIRS には入れない。
  // SC 1.4.11 の 3:1 は「隣接する背景」との関係で決まるが、トークン単体は何に隣接するかを
  // 知らないため、比の assert は使用箇所側のガード（ui/test/contrast-usage.test.ts）が担う。
  // ここで 3:1 を二重に主張すると、片方の変更が他方へ伝わらない二重管理になる（design.md D7）。
  'borderInteractive',
];

describe('コントラスト計算ヘルパ（既知値による自己検証）', () => {
  it('黒/白は 21:1・同色は 1:1 を返す', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('前景/背景の順序に依存しない（対称）', () => {
    expect(contrastRatio('#333333', '#FFFFFF')).toBe(
      contrastRatio('#FFFFFF', '#333333'),
    );
  });

  it('ブランド緑 #1DB446 と白は約 2.74:1（AA 非準拠の既知値）と計算される', () => {
    expect(contrastRatio('#1DB446', '#FFFFFF')).toBeCloseTo(2.74, 2);
  });
});

describe('アルファ合成ヘルパ compositeOver（既知値による自己検証・Issue #50）', () => {
  it('alpha=1 は前景そのもの・alpha=0 は背景そのものを返す', () => {
    expect(compositeOver('#15803D', '#FFFFFF', 1)).toBe('#15803D');
    expect(compositeOver('#15803D', '#FFFFFF', 0)).toBe('#FFFFFF');
  });

  it('黒を白に 50% 合成すると中間灰になる', () => {
    expect(compositeOver('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });

  it('6桁大文字 hex を返す（contrastRatio へそのまま渡せる形式）', () => {
    expect(compositeOver('#DC2626', '#FFFFFF', 0.1)).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('alpha=1 の合成結果は元の色とコントラスト比が一致する（既存ヘルパとの接続確認）', () => {
    expect(contrastRatio(compositeOver('#333333', '#FFFFFF', 1), '#FFFFFF')).toBe(
      contrastRatio('#333333', '#FFFFFF'),
    );
  });

  it('0..1 の範囲外の alpha は拒否する', () => {
    expect(() => compositeOver('#000000', '#FFFFFF', 1.5)).toThrow();
    expect(() => compositeOver('#000000', '#FFFFFF', -0.1)).toThrow();
  });
});

describe('colors（Web 意味役割）の WCAG AA コントラスト（Requirements 5.2）', () => {
  for (const pair of AA_TEXT_PAIRS) {
    it(`${pair.foreground} / ${pair.background} は ${AA_NORMAL_TEXT_RATIO}:1 以上`, () => {
      const ratio = contrastRatio(colors[pair.foreground], colors[pair.background]);
      expect(
        ratio,
        `${pair.foreground}(${colors[pair.foreground]}) on ` +
          `${pair.background}(${colors[pair.background]}) → ${ratio.toFixed(3)}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_RATIO);
    });
  }

  it('全ての意味役割が AA 検証ペアか対象外リストのいずれかに分類されている', () => {
    // 新しい色役割を追加したら、テキスト用途なら AA_TEXT_PAIRS へ、
    // 装飾・非テキスト用途なら NON_TEXT_ROLES へ必ず分類させるための網羅ガード。
    const classified = new Set<string>(NON_TEXT_ROLES);
    for (const pair of AA_TEXT_PAIRS) {
      classified.add(pair.foreground);
      classified.add(pair.background);
    }
    expect([...classified].sort()).toEqual(Object.keys(colors).sort());
  });
});

// 識別用（フォーム入力部品・対話的部品の輪郭）と装飾用（区切り線・カード罫線・情報コンテナ
// 外枠）の枠色は別の意味役割である。両者が同値に潰れていると、識別用だけを濃くすることが
// 構造的に不可能になる（本 spec 以前の実態: --input が装飾用の枠色を参照していた）。
// 値の分離をここで不変条件として固定し、将来「片方に合わせて」統合されることを防ぐ
// （design.md「色役割定義」State Management の不変条件 / Testing Strategy Unit 1）。
describe('枠色の意味役割分離の不変条件（Requirements 4.1, 6.1）', () => {
  it('識別用の枠色役割が値の単一情報源に存在する', () => {
    expect(
      colors.borderInteractive,
      'colors.borderInteractive が未定義です（識別用の枠色役割が単一情報源にありません）',
    ).toBeDefined();
  });

  it('識別用の枠色は装飾用の枠色と異なる値を持つ', () => {
    expect(
      colors.borderInteractive,
      `識別用と装飾用が同値です（borderInteractive: ${colors.borderInteractive} / ` +
        `border: ${colors.border}）。同値では識別用だけを濃くできません。`,
    ).not.toBe(colors.border);
  });
});
