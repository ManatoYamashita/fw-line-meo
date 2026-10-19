import { typography } from '@fwlm/design-tokens';
import { describe, expect, it } from 'vitest';

import { cn } from '../src/lib/utils';

// 文字サイズのトークンの段はすべて、cn の競合解決で「文字サイズ」として扱われなければならない。
// 名前付きの段を足したのに cn へ教えないと、色のクラスと並べたときに段が黙って落ちる。
describe('cn は文字サイズのトークンの段を文字サイズとして解決する', () => {
  for (const step of Object.keys(typography.scale)) {
    it(`text-${step} は色のクラスと共存し、別の文字サイズとは後勝ちで競合する`, () => {
      expect(cn(`text-${step}`, 'text-muted-foreground')).toBe(`text-${step} text-muted-foreground`);
      const other = step === 'xs' ? 'text-sm' : 'text-xs';
      expect(cn(other, `text-${step}`)).toBe(`text-${step}`);
      expect(cn(`text-${step}`, other)).toBe(other);
    });
  }
});
