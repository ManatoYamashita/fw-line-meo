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
      'brandSubtle',
      'primary',
      'primaryForeground',
      'text',
      'textMuted',
      'background',
      'destructive',
      'destructiveForeground',
      'border',
    ] as const;
    expect(Object.keys(colors).sort()).toEqual([...roles].sort());
    for (const role of roles) {
      expect(colors[role]).toMatch(HEX_COLOR);
    }
  });

  it('brand（装飾用）と primary（アクション用）は分離されている', () => {
    expect(colors.brand).toBe('#1DB446');
    expect(colors.primary).not.toBe(colors.brand);
  });

  it('brandSubtle は現行の淡緑背景を保持する', () => {
    expect(colors.brandSubtle).toBe('#F0FBF4');
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
  it('spacing は xs〜xl の rem 階層を定義する', () => {
    const keys = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
    expect(Object.keys(spacing).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(spacing[key]).toMatch(REM_VALUE);
    }
  });

  it('radius は sm/md/lg/full を定義する', () => {
    const keys = ['sm', 'md', 'lg', 'full'] as const;
    expect(Object.keys(radius).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(radius[key]).not.toBe('');
    }
  });

  it('shadow は sm/md/lg の box-shadow 値を定義する', () => {
    const keys = ['sm', 'md', 'lg'] as const;
    expect(Object.keys(shadow).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(shadow[key]).toContain('px');
    }
  });
});
