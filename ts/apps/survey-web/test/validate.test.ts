import { describe, it, expect } from 'vitest';
import { validateSurveyAnswer } from '../src/lib/validate';

const ALLOWED = ['taste', 'service', 'volume', 'atmosphere', 'price', 'cleanliness'] as const;

describe('validateSurveyAnswer', () => {
  it('星のみで有効（aspects 空・comment 無し）', () => {
    const res = validateSurveyAnswer({ star: 5 }, ALLOWED);
    expect(res).toEqual({ ok: true, value: { star: 5, aspectCodes: [] } });
  });

  it('星＋aspects＋comment で有効', () => {
    const res = validateSurveyAnswer(
      { star: 4, aspectCodes: ['taste', 'service'], comment: 'おいしい' },
      ALLOWED,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.aspectCodes).toEqual(['taste', 'service']);
      expect(res.value.comment).toBe('おいしい');
    }
  });

  it('星欠落は REQUIRED', () => {
    const res = validateSurveyAnswer({ aspectCodes: [] }, ALLOWED);
    expect(res).toEqual({ ok: false, error: [{ field: 'star', code: 'REQUIRED' }] });
  });

  it('星が範囲外/非整数/文字列は OUT_OF_RANGE', () => {
    for (const bad of [0, 6, 3.5, '5']) {
      const res = validateSurveyAnswer({ star: bad }, ALLOWED);
      expect(res).toEqual({ ok: false, error: [{ field: 'star', code: 'OUT_OF_RANGE' }] });
    }
  });

  it('未知の aspect code は UNKNOWN_CODE', () => {
    const res = validateSurveyAnswer({ star: 5, aspectCodes: ['taste', '__nope__'] }, ALLOWED);
    expect(res).toEqual({ ok: false, error: [{ field: 'aspectCodes', code: 'UNKNOWN_CODE' }] });
  });

  it('aspectCodes が配列でないと INVALID', () => {
    const res = validateSurveyAnswer({ star: 5, aspectCodes: 'taste' }, ALLOWED);
    expect(res).toEqual({ ok: false, error: [{ field: 'aspectCodes', code: 'INVALID' }] });
  });

  it('comment 200 文字は有効・201 文字は TOO_LONG', () => {
    const ok200 = validateSurveyAnswer({ star: 5, comment: 'あ'.repeat(200) }, ALLOWED);
    expect(ok200.ok).toBe(true);
    const bad201 = validateSurveyAnswer({ star: 5, comment: 'あ'.repeat(201) }, ALLOWED);
    expect(bad201).toEqual({ ok: false, error: [{ field: 'comment', code: 'TOO_LONG' }] });
  });

  it('空文字 comment は未回答扱い（result に含めない）', () => {
    const res = validateSurveyAnswer({ star: 5, comment: '' }, ALLOWED);
    expect(res).toEqual({ ok: true, value: { star: 5, aspectCodes: [] } });
  });

  it('複数フィールドのエラーを全件収集する', () => {
    const res = validateSurveyAnswer({ comment: 'あ'.repeat(201) }, ALLOWED);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContainEqual({ field: 'star', code: 'REQUIRED' });
      expect(res.error).toContainEqual({ field: 'comment', code: 'TOO_LONG' });
    }
  });

  it('オブジェクトでない入力は star REQUIRED に落ちる', () => {
    const res = validateSurveyAnswer(null, ALLOWED);
    expect(res).toEqual({ ok: false, error: [{ field: 'star', code: 'REQUIRED' }] });
  });
});
