import { describe, it, expect } from 'vitest';
import {
  ACTIVE_TARGET_LIMITS,
  OWNER_TARGET_CATEGORY_CODES,
  OWNER_TOGGLEABLE_CATEGORY_CODES,
  TARGET_LABEL_ERROR_MESSAGES,
  TARGET_LABEL_MAX_LENGTH,
  isOwnerTargetCategoryCode,
  isOwnerToggleableCategoryCode,
  normalizeTargetLabel,
} from '../src/survey-settings-rules.js';

// アンケート設定の入力規則（Issue #437）。値の正典はこのモジュール 1 箇所で、サーバーと画面が共有する。

describe('survey settings rules', () => {
  it('Issue #437 の初期値: 料理 10 件・ドリンク 10 件・40 文字・予約・来店だけを切り替えられる', () => {
    expect(ACTIVE_TARGET_LIMITS).toEqual({ food: 10, drink: 10 });
    expect(OWNER_TARGET_CATEGORY_CODES).toEqual(['food', 'drink']);
    expect(TARGET_LABEL_MAX_LENGTH).toBe(40);
    expect(OWNER_TOGGLEABLE_CATEGORY_CODES).toEqual(['reservation_visit']);
  });

  it('料理・ドリンクだけが Target を持て、予約・来店だけが表示を切り替えられる', () => {
    expect(['food', 'drink', 'price', 'reservation_visit', '', 1, null].map(isOwnerTargetCategoryCode)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(['reservation_visit', 'food', 'atmosphere', undefined].map(isOwnerToggleableCategoryCode)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it('前後の空白（全角を含む）を除き、NFC へ正規化して返す', () => {
    expect(normalizeTargetLabel('  刺身盛り合わせ　')).toEqual({ ok: true, value: '刺身盛り合わせ' });
    // 「が」を「か」＋濁点（結合文字）で書いても、同じ名前として保存する。
    expect(normalizeTargetLabel('か\u3099ら揚げ')).toEqual({ ok: true, value: 'がら揚げ' });
  });

  it('文字数はコードポイントで数える（絵文字 1 つは 1 文字）', () => {
    expect(normalizeTargetLabel('🍣'.repeat(TARGET_LABEL_MAX_LENGTH))).toMatchObject({ ok: true });
    expect(normalizeTargetLabel('🍣'.repeat(TARGET_LABEL_MAX_LENGTH + 1))).toEqual({
      ok: false,
      error: 'LABEL_TOO_LONG',
    });
  });

  it('空・改行・制御文字・区切り文字・壊れた文字・文字列以外を拒否する', () => {
    const cases: [unknown, string][] = [
      ['', 'LABEL_EMPTY'],
      ['　', 'LABEL_EMPTY'],
      ['刺身\n盛り', 'LABEL_MULTILINE'],
      ['刺身\r\n盛り', 'LABEL_MULTILINE'],
      ['刺身\u2028盛り', 'LABEL_MULTILINE'],
      ['刺身\t盛り', 'LABEL_INVALID_CHARACTER'],
      ['刺身\u0000盛り', 'LABEL_INVALID_CHARACTER'],
      ['刺身\u007f盛り', 'LABEL_INVALID_CHARACTER'],
      ['刺身\uDC00', 'LABEL_INVALID_CHARACTER'],
      // UTF-8 以外で送られて読めなかった文字（置換文字）。文字化けしたまま登録しない。
      ['\uFFFDh\uFFFDg', 'LABEL_INVALID_CHARACTER'],
      [undefined, 'LABEL_INVALID'],
      [['刺身'], 'LABEL_INVALID'],
    ];
    for (const [raw, error] of cases) {
      expect(normalizeTargetLabel(raw), JSON.stringify(raw)).toEqual({ ok: false, error });
    }
  });

  it('HTML として解釈しない（そのまま文字として通す）', () => {
    expect(normalizeTargetLabel('<script>alert(1)</script>')).toEqual({
      ok: true,
      value: '<script>alert(1)</script>',
    });
  });

  it('誤りごとに、何を直せばよいかの日本語の案内を持つ', () => {
    expect(TARGET_LABEL_ERROR_MESSAGES.LABEL_TOO_LONG).toContain('40文字以内');
    for (const message of Object.values(TARGET_LABEL_ERROR_MESSAGES)) expect(message.length).toBeGreaterThan(0);
  });
});
