import { describe, it, expect } from 'vitest';

import {
  FORBIDDEN_TERMS,
  FORBIDDEN_TERM_GROUPS,
  POSTER_CAUTION,
  POSTER_HOWTO,
  POSTER_INVITATION,
  PROHIBITED_EXAMPLES,
  forbiddenTermsIn,
} from '../src/lib/qr-poster-text';

// 店頭掲示の文言（Issue #179・Requirement 7）。
//
// **検査は両方向で持つ。** 「配る文言に禁止語が無い」だけでは、検出器（FORBIDDEN_TERMS）が
// 壊れて 0 件を返している状態と区別が付かない。不可の例が実際に禁止語を含むことを対にして
// 初めて意味を持つ。同じ形の先例は `db/test/check_no_optional_capabilities.sh`（能力の不在を
// 検査しつつ、走査対象が 0 件なら赤くする）である。

describe('掲示文言: 製品が配る文言', () => {
  it('依頼文と案内文に禁止語が 1 つも含まれない', () => {
    expect(forbiddenTermsIn(POSTER_INVITATION), '依頼文に禁止語があります').toEqual([]);
    expect(forbiddenTermsIn(POSTER_HOWTO), '案内文に禁止語があります').toEqual([]);
  });

  it('依頼文は内容を指定せず、募る形に留まっている', () => {
    // 評価の高低にも、書く内容にも触れない。触れた瞬間に「内容に影響を与えた」側へ倒れる。
    expect(POSTER_INVITATION).not.toMatch(/評価|口コミ|レビュー|星/);
    // 何を求めているかは伝わる必要がある（空振りの assert にしない）。
    expect(POSTER_INVITATION).toContain('ご感想');
  });

  it('文言はすべて日本語で提供する（Requirement 5.5）', () => {
    const japanese = /[぀-ゟ゠-ヿ一-鿿]/;
    for (const text of [POSTER_INVITATION, POSTER_HOWTO, POSTER_CAUTION]) {
      expect(text, `日本語を含まない文言: ${text}`).toMatch(japanese);
    }
  });
});

describe('掲示文言: 不可の例（検出器が空振りしていないことの対照）', () => {
  it('不可の例はすべて禁止語を 1 つ以上含む', () => {
    for (const example of PROHIBITED_EXAMPLES) {
      expect(
        forbiddenTermsIn(example.text),
        `不可の例が禁止語を 1 つも含みません（検出器が空振りしています）: ${example.text}`,
      ).not.toEqual([]);
    }
  });

  it('不可の例には理由が付き、理由が空でない', () => {
    for (const example of PROHIBITED_EXAMPLES) {
      expect(example.reason.trim().length, `理由が空です: ${example.text}`).toBeGreaterThan(0);
    }
  });

  it('禁止語の 4 群がいずれも 1 つ以上の不可の例で発火する', () => {
    // 群を足したのに例を足し忘れると、その条項は「名前だけあって誰も見ていない」状態になる。
    for (const group of FORBIDDEN_TERM_GROUPS) {
      const fired = PROHIBITED_EXAMPLES.some((example) =>
        group.terms.some((term) => example.text.includes(term)),
      );
      expect(fired, `この条項に対応する不可の例がありません: ${group.clause}`).toBe(true);
    }
  });

  it('禁止語の一覧は群の平坦化と一致し、空でない', () => {
    expect(FORBIDDEN_TERMS.length, '禁止語が 0 件です').toBeGreaterThan(0);
    expect([...FORBIDDEN_TERMS]).toEqual(FORBIDDEN_TERM_GROUPS.flatMap((g) => [...g.terms]));
  });
});

describe('掲示文言: forbiddenTermsIn', () => {
  it('含まれる語だけを返す', () => {
    expect(forbiddenTermsIn('星5でお願いします')).toContain('星5');
    expect(forbiddenTermsIn('ご感想をお聞かせください')).toEqual([]);
  });
});
