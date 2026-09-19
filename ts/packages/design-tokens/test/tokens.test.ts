// デザイントークン公開 API の形状検証（Requirements 1.1, 1.3）。
// - 単一定義箇所（本パッケージ）から全トークンカテゴリを import できること
// - 意味役割ごとに 1 トークン（1 つの文字列値）が対応すること
// - LINE 用セットの既存の役割が現行 Flex Message と同一値であること
// - LINE 面の帰属表示の書式が Places API ポリシーの細則の中にあること
// 注: WCAG AA コントラストの網羅的検証はタスク 1.2 の責務（本テストは形状のみ）。
import { describe, it, expect } from 'vitest';
import {
  colors,
  lineColors,
  lineLayout,
  typography,
  spacing,
  radius,
  shadow,
} from '../src/index.js';

const HEX_COLOR = /^#[0-9A-F]{6}$/;
const REM_VALUE = /^\d+(\.\d+)?rem$/;

/**
 * Google Maps のテキストの帰属表示に許される色（Places API ポリシー・2026-09-13 取得）。
 * 原文は "White, black (#1F1F1F), or gray (#5E5E5E)"。
 */
const ATTRIBUTION_POLICY_COLORS: readonly string[] = ['#FFFFFF', '#1F1F1F', '#5E5E5E'];

/** 同じく帰属表示の大きさの範囲（原文は最小 12sp・最大 16sp。両端を含む）。 */
const ATTRIBUTION_SIZE_RANGE = { min: 12, max: 16 } as const;

/** LINE Flex の text の size が受け取るピクセル指定（例: 12px）。 */
const PIXEL_VALUE = /^(\d+)px$/;

describe('colors（Web 意味役割）', () => {
  it('全ての意味役割が 1 つの hex リテラルを持つ', () => {
    const roles = [
      'brand',
      'primary',
      'primaryHover',
      'primaryForeground',
      'text',
      'textBody',
      'textMuted',
      'background',
      'surfaceSoft',
      'surfaceStrong',
      'success',
      'destructive',
      'destructiveForeground',
      'border',
      'borderInteractive',
    ] as const;
    expect(Object.keys(colors).sort()).toEqual([...roles].sort());
    for (const role of roles) {
      expect(colors[role]).toMatch(HEX_COLOR);
    }
  });

  it('brand（装飾用）と primary（アクション用）は分離されている', () => {
    // 意匠の出典のブランド色そのもの。白文字と約 3.52:1 で AA に届かないため装飾専用であり、
    // アクション色には出典の押下時の色を採る（colors.test.ts が両者の比を機械検証する）。
    expect(colors.brand).toBe('#FF385C');
    expect(colors.primary).not.toBe(colors.brand);
  });

  it('success（成功）は primary / destructive / brand のいずれとも別の値を持つ', () => {
    // 値を共有していると、アクション色の差し替えが成功通知の色を巻き込む。
    // 色相が変わっても輝度は変わらないため、コントラスト比を見るガードでは検出できない。
    expect(colors.success).not.toBe(colors.primary);
    expect(colors.success).not.toBe(colors.destructive);
    expect(colors.success).not.toBe(colors.brand);
  });
});

describe('lineColors（LINE Flex Message 用セット）', () => {
  // 帰属表示（attribution）を除く値は LINE Flex の現行描画色と同一（見た目不変が不変条件）。
  // muted は delivery-job（日次サマリー配信）の現行 #aaaaaa を意味役割化したもの。
  // Flex の色指定は大小を区別しないため、大文字表記でも描画結果は現行と同一。
  // 帰属表示の色は caption や muted をポリシーの色へ寄せるのではなく、役割ごと足している。
  // 寄せると帰属以外の補足まで見た目が変わるためである（値の根拠は下の「帰属表示の書式」）。
  it('既存の役割は現行色と同一の値のまま、帰属表示の色を役割として持つ', () => {
    expect(lineColors).toEqual({
      headline: '#1DB446',
      body: '#333333',
      description: '#666666',
      caption: '#888888',
      successBackground: '#F0FBF4',
      action: '#1DB446',
      muted: '#AAAAAA',
      attribution: '#5E5E5E',
    });
  });
});

describe('lineLayout（LINE Flex Message 用の寸法セット）', () => {
  // 値は LINE 独自のキーワードであり rem へ写像できない（src/line-layout.ts の冒頭を参照）。
  // 本テストが固定するのは「役割 → キーワード」の対応そのもので、
  // 「組み立てた Flex がこの値を実際に使っている」は消費側（delivery-job / line-webhook）の
  // 不変条件テストが assert する。両者は対でないと意味を持たない。
  // 帰属表示の大きさ（attributionSize）だけはキーワードではなくピクセル値である（下の「帰属表示の書式」）。
  it('全ての意味役割が値を 1 つ持ち、帰属表示の大きさだけがピクセル値である', () => {
    expect(lineLayout).toEqual({
      bubbleSize: 'kilo',
      blockPadding: 'lg',
      headerPaddingBottom: 'md',
      sectionGap: 'md',
      itemGap: 'sm',
      dividerMargin: 'lg',
      displaySize: 'xxl',
      titleSize: 'lg',
      bodySize: 'md',
      descriptionSize: 'sm',
      noteSize: 'xs',
      captionSize: 'xxs',
      attributionSize: '13px',
      actionHeight: 'md',
    });
  });

  it('群の内と外で間隔が異なり、区切り線はそれより大きい段を取る', () => {
    // 「セクション内 < セクション間 < 区切り線の前」の順序が崩れると、
    // 3 セクションが 1 枚の壁に見えるか、区切り線が節を閉じないかのどちらかになる。
    const order = ['none', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl'];
    const rank = (keyword: string): number => {
      const index = order.indexOf(keyword);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(rank(lineLayout.itemGap)).toBeLessThan(rank(lineLayout.sectionGap));
    expect(rank(lineLayout.sectionGap)).toBeLessThan(rank(lineLayout.dividerMargin));
  });
});

// Google Maps のテキストの帰属表示の細則（Places API ポリシー・Requirements 1.6, 8.1）。
// 上の同値検証は値を固定するだけで、差し替えた値が細則の中にあるかは見ない。ここでは
// 細則そのもの（色は 3 色のどれか・大きさは 12〜16 のピクセル値）を、ソースとは別に持つ
// 許容範囲で照合する。書体（Roboto）はトークンを持たないため、ここでは検証しない。ポリシーは
// 「Roboto（読み込みは任意）」とし、フォールバックに「product 内で既に使っている任意の sans serif か
// `Sans-Serif`」を明示的に許すので、書体を指定しないこと自体は逸脱にならない（#287）。
describe('帰属表示の書式（Places API ポリシー・Requirements 1.6, 8.1）', () => {
  it('色はポリシーが許す 3 色のどれかである', () => {
    // Flex の色指定は大小を区別しないので、大文字に揃えて照合する。
    expect(
      ATTRIBUTION_POLICY_COLORS,
      `lineColors.attribution(${lineColors.attribution}) はポリシーが許す色ではありません`,
    ).toContain(lineColors.attribution.toUpperCase());
  });

  it('大きさは 12〜16 の範囲のピクセル値である', () => {
    // キーワード（xxs 等）は LINE が実 px を公開していないため、範囲に入ることを確かめられない。
    const match = PIXEL_VALUE.exec(lineLayout.attributionSize);
    expect(
      match,
      `lineLayout.attributionSize(${lineLayout.attributionSize}) がピクセル値ではありません`,
    ).not.toBeNull();
    const px = Number(match?.[1]);
    expect(px).toBeGreaterThanOrEqual(ATTRIBUTION_SIZE_RANGE.min);
    expect(px).toBeLessThanOrEqual(ATTRIBUTION_SIZE_RANGE.max);
  });
});

describe('typography', () => {
  it('fontSans とサイズ階層（xs〜2xl・rem）を定義する', () => {
    expect(typography.fontSans).toContain('sans-serif');
    const sizes = ['xs', 'sm', 'base', 'lg', 'xl', '2xl'] as const;
    expect(Object.keys(typography.scale).sort()).toEqual([...sizes].sort());
    for (const size of sizes) {
      expect(typography.scale[size]).toMatch(REM_VALUE);
    }
  });
});

describe('spacing / radius / shadow', () => {
  it('spacing は意匠の出典の 9 段を rem で定義する', () => {
    // 出典の 9 段（2/4/8/12/16/24/32/48/64 px）。CSS へは出さず、Tailwind の数値スケールで
    // 指定する規約は維持する（@fwlm/ui の token-scales.test.ts が倍率を両方向で照合する）。
    const keys = ['xxs', 'xs', 'sm', 'md', 'base', 'lg', 'xl', 'xxl', 'section'] as const;
    expect(Object.keys(spacing).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(spacing[key]).toMatch(REM_VALUE);
    }
  });

  it('radius は sm/md/lg/xl/2xl/4xl/full を定義する', () => {
    // 2xl は Card と表の容器、4xl は Badge が使用する段。使われている段に対応するトークンが
    // 存在しないと「対応の無い値を描画に用いる」状態になる（ui-token-collision Requirements 3.3）。
    // 2xl は Tailwind 既定と恒等（1rem）であり、段の上書きではなく写しの追加である。
    const keys = ['sm', 'md', 'lg', 'xl', '2xl', '4xl', 'full'] as const;
    expect(Object.keys(radius).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(radius[key]).not.toBe('');
    }
  });

  it('shadow は 1 段（raised）だけを定義する', () => {
    // 意匠の出典は影を 1 段しか持たない。面の分離は 1px の輪郭と余白が担う。
    const keys = ['raised'] as const;
    expect(Object.keys(shadow).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(shadow[key]).toContain('px');
    }
  });
});
