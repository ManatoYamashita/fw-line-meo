// Web 意味役割カラーペアの WCAG AA コントラスト機械検証（Requirements 5.2 /
// design.md Testing Strategy Unit 1「colors.test.ts」）。
// - WCAG 2.1 の相対輝度とコントラスト比の定義を依存ゼロで自前実装し、Web 面のテキスト
//   前景/背景ペア全てが通常文字の AA 基準（4.5:1 以上）を満たすことを数値で assert する。
// - 対象外: brand・brandSubtle・border（装飾・面塗り・非テキスト用途）と lineColors
//   （LINE Flex Message は Web コンテンツではないため AA 検証対象外）。
// - primary の具体 hex はこのテストを通ることをもって確定値とする。
import { describe, it, expect } from 'vitest';
import { colors } from '../src/index.js';

/** '#RRGGBB'（6桁大文字 hex）を 0..255 の RGB 3成分へ変換する。 */
function hexToRgb(hex: string): [number, number, number] {
  if (!/^#[0-9A-F]{6}$/.test(hex)) {
    throw new Error(`6桁 hex リテラルではありません: ${hex}`);
  }
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * WCAG 2.1 定義の相対輝度。
 * sRGB 各成分を 0..1 化し、しきい値 0.03928 以下は /12.92、超は ((c+0.055)/1.055)^2.4 で
 * 線形化したうえで 0.2126R + 0.7152G + 0.0722B の加重和を取る。
 * 参照: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 */
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG 2.1 定義のコントラスト比 (L1 + 0.05) / (L2 + 0.05)（L1 は明るい方の輝度）。
 * 参照: https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */
function contrastRatio(colorA: string, colorB: string): number {
  const luminanceA = relativeLuminance(colorA);
  const luminanceB = relativeLuminance(colorB);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

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
  { foreground: 'destructiveForeground', background: 'destructive' },
];

/** AA 検証の対象外とする意味役割（装飾・面塗り・非テキスト用途）。 */
const NON_TEXT_ROLES: readonly (keyof typeof colors)[] = [
  'brand',
  'brandSubtle',
  'border',
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
