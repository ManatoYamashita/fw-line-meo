import { describe, it, expect } from 'vitest';
import { encodePostback, decodePostback, type PostbackAction } from '../../src/onboarding/stages.js';

// design.md「OnboardingStages」/ research.md「Decision 5」準拠のテスト。
// Requirement 1.3, 4.5, 4.6: postback data の符号化/復号を単一情報源化し、
// 全遷移（select_candidate/confirm/restart/resume）で往復可能・300文字以内・
// 不正 data は例外を投げず null を返すことを保証する。

const MAX_POSTBACK_DATA_LENGTH = 300;

describe('encodePostback / decodePostback 往復', () => {
  const cases: PostbackAction[] = [
    { kind: 'select_candidate', index: 0 },
    { kind: 'select_candidate', index: 1 },
    { kind: 'select_candidate', index: 9 },
    { kind: 'select_candidate', index: 123456 },
    { kind: 'confirm' },
    { kind: 'restart' },
    { kind: 'resume' },
  ];

  it.each(cases)('全 PostbackAction バリアントで符号化→復号が往復する: %o', (action) => {
    const encoded = encodePostback(action);
    expect(decodePostback(encoded)).toEqual(action);
  });

  it.each(cases)('符号化結果は LINE の postback data 上限 300 文字以内: %o', (action) => {
    const encoded = encodePostback(action);
    expect(encoded.length).toBeLessThanOrEqual(MAX_POSTBACK_DATA_LENGTH);
  });

  it('select_candidate は index=0 でも往復する（falsy 値の取りこぼし防止）', () => {
    const encoded = encodePostback({ kind: 'select_candidate', index: 0 });
    const decoded = decodePostback(encoded);
    expect(decoded).toEqual({ kind: 'select_candidate', index: 0 });
  });

  it('select_candidate は大きな index でも 300 文字以内かつ往復する', () => {
    const largeIndex = Number.MAX_SAFE_INTEGER;
    const encoded = encodePostback({ kind: 'select_candidate', index: largeIndex });
    expect(encoded.length).toBeLessThanOrEqual(MAX_POSTBACK_DATA_LENGTH);
    expect(decodePostback(encoded)).toEqual({ kind: 'select_candidate', index: largeIndex });
  });

  it('研究文書 Decision 5 の符号化形式（a=select&i=<index>）に一致する', () => {
    expect(encodePostback({ kind: 'select_candidate', index: 3 })).toBe('a=select&i=3');
    expect(encodePostback({ kind: 'confirm' })).toBe('a=confirm');
    expect(encodePostback({ kind: 'restart' })).toBe('a=restart');
    expect(encodePostback({ kind: 'resume' })).toBe('a=resume');
  });
});

describe('decodePostback の不正入力ハンドリング', () => {
  it('空文字列は null を返す（例外を投げない）', () => {
    expect(decodePostback('')).toBeNull();
  });

  it('ランダムな文字列は null を返す', () => {
    expect(decodePostback('this is not a postback at all !!')).toBeNull();
  });

  it('JSON 形式（誤った符号化スキーム）は null を返す', () => {
    expect(decodePostback(JSON.stringify({ kind: 'confirm' }))).toBeNull();
    expect(decodePostback(JSON.stringify({ kind: 'select_candidate', index: 3 }))).toBeNull();
  });

  it('全く別の符号化スキームの文字列は null を返す', () => {
    expect(decodePostback('kind=select_candidate&index=3')).toBeNull();
    expect(decodePostback('action:confirm')).toBeNull();
  });

  it('未知の action キーは null を返す', () => {
    expect(decodePostback('a=unknown')).toBeNull();
  });

  it('select_candidate で index が欠落している場合は null を返す', () => {
    expect(decodePostback('a=select')).toBeNull();
    expect(decodePostback('a=select&i=')).toBeNull();
  });

  it('select_candidate で index が数値でない場合は null を返す', () => {
    expect(decodePostback('a=select&i=abc')).toBeNull();
    expect(decodePostback('a=select&i=3.5')).toBeNull();
    expect(decodePostback('a=select&i=-1')).toBeNull();
  });

  it('300 文字を超える data は null を返す', () => {
    const oversized = `a=select&i=${'1'.repeat(400)}`;
    expect(oversized.length).toBeGreaterThan(MAX_POSTBACK_DATA_LENGTH);
    expect(decodePostback(oversized)).toBeNull();
  });
});
