// デザイントークン公開 API の形状検証（Requirements 1.1, 1.3）。
// - 単一定義箇所（本パッケージ）から全トークンカテゴリを import できること
// - 意味役割ごとに 1 トークン（1 つの文字列値）が対応すること
// - LINE 用セットが現行 Flex Message の 5 色と同一値であること
// 注: WCAG AA コントラストの網羅的検証はタスク 1.2 の責務（本テストは形状のみ）。
import { describe, it, expect } from 'vitest';
import {
  colors,
  lineColors,
  typography,
  spacing,
  radius,
  shadow,
} from '../src/index.js';

const HEX_COLOR = /^#[0-9A-F]{6}$/;
const REM_VALUE = /^\d+(\.\d+)?rem$/;

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
  // 値は LINE Flex の現行描画色と同一（見た目不変が不変条件）。
  // muted は delivery-job（日次サマリー配信）の現行 #aaaaaa を意味役割化したもの。
  // Flex の色指定は大小を区別しないため、大文字表記でも描画結果は現行と同一。
  it('LINE Flex の現行色を意味役割名で保持し値が現行と同一である', () => {
    expect(lineColors).toEqual({
      headline: '#1DB446',
      body: '#333333',
      description: '#666666',
      caption: '#888888',
      successBackground: '#F0FBF4',
      action: '#1DB446',
      muted: '#AAAAAA',
    });
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
