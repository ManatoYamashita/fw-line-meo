import { describe, it, expect } from 'vitest';
import { normalizeInviteCodeInput } from '../../src/onboarding/invite-code-input.js';

// 招待コード待ちのテキストを照合の前に揃える純粋関数のテスト。
// 発行側の文字集合（dashboard-api の invite-code-gen.ts の INVITE_CODE_ALPHABET）は、line-webhook が dashboard-api に
// 依存しない（アプリ間で import しない）ため、同じ文字列をここに置く。発行側の定数を変えたら、ここも揃えること。
const ISSUED_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

describe('normalizeInviteCodeInput', () => {
  it.each([
    ['前後の半角空白', '  ABCD2345  '],
    ['末尾の改行（コピーで付く）', 'ABCD2345\n'],
    ['末尾の CRLF', 'ABCD2345\r\n'],
    ['前後の全角スペース（U+3000）', '\u3000ABCD2345\u3000'],
    ['前後の NBSP（U+00A0）', '\u00A0ABCD2345\u00A0'],
    ['小文字', 'abcd2345'],
    ['全角英数', 'ＡＢＣＤ２３４５'],
    ['全角の小文字', 'ａｂｃｄ２３４５'],
    ['混在（前後の空白・改行・全角・小文字）', ' \u3000ａbＣd２3４5\r\n'],
  ])('%s → 正準形 ABCD2345', (_label, input) => {
    expect(normalizeInviteCodeInput(input)).toBe('ABCD2345');
  });

  it('正準形（発行形式）の入力は変えない', () => {
    expect(normalizeInviteCodeInput('ABCD2345')).toBe('ABCD2345');
    expect(normalizeInviteCodeInput('ZZZZ9999')).toBe('ZZZZ9999');
  });

  it('発行側の文字集合の全文字が不変である', () => {
    for (const ch of ISSUED_ALPHABET) {
      expect(normalizeInviteCodeInput(ch)).toBe(ch);
    }
    expect(normalizeInviteCodeInput(ISSUED_ALPHABET)).toBe(ISSUED_ALPHABET);
  });

  it('冪等である（f(f(x)) === f(x)）', () => {
    const inputs = [' abcd2345\n', 'ＡＢＣＤ２３４５', '\u3000x y\u3000', 'ABCD2345', '', 'a\u200Bb'];
    for (const input of inputs) {
      const once = normalizeInviteCodeInput(input);
      expect(normalizeInviteCodeInput(once)).toBe(once);
    }
  });

  it('中間の空白は除かない（前後だけを除く）', () => {
    expect(normalizeInviteCodeInput('ABCD 2345')).toBe('ABCD 2345');
  });

  it('ゼロ幅スペース（U+200B）は除かない（空白ではないので trim の対象外。仕様として固定する）', () => {
    expect(normalizeInviteCodeInput('ABCD2345\u200B')).toBe('ABCD2345\u200B');
    expect(normalizeInviteCodeInput('\u200Babcd2345')).toBe('\u200BABCD2345');
  });
});
