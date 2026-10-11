import { describe, it, expect } from 'vitest';
import {
  ACTIVE_TARGET_LIMITS,
  OWNER_TARGET_CATEGORY_CODES,
  OWNER_TOGGLEABLE_CATEGORY_CODES,
  TARGET_LABEL_ERROR_MESSAGES,
  TARGET_LABEL_MAX_LENGTH,
  canonicalizeForEvaluativePolicy,
  hasEvaluativeTargetLabel,
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

  describe('評価・おすすめ・再訪の言葉を含む名前は登録できない（PR #443 のレビュー対応）', () => {
    it.each([
      ['絶品新鮮刺身盛り'],
      ['絶品で新鮮な刺身の味が良かったです。また来たいし、おすすめです'],
      ['極上カルビ'],
      ['店長おすすめ盛り合わせ'],
      ['ｵｽｽﾒ串盛り'],
      ['リピート確定唐揚げ'],
      ['また食べたい餃子'],
      ['とってもジューシー唐揚げ'],
      ['一度は食べてほしいカレー'],
    ])('%s', (label) => {
      expect(hasEvaluativeTargetLabel(label)).toBe(true);
      expect(normalizeTargetLabel(label)).toEqual({ ok: false, error: 'LABEL_EVALUATIVE' });
    });

    it.each([
      ['だし巻き玉子'],
      ['出汁巻き玉子'],
      ['刺身盛り合わせ'],
      ['焼き鳥5種盛り'],
      ['名物もつ煮'],
      ['自家製レモンサワー'],
      ['濃厚担々麺'],
      ['季節の天ぷら'],
      ['新鮮野菜のサラダ'],
      ['またぎ鍋'],
      ['大根サラダ'],
      ['生ビール（中）'],
    ])('通常の名前は通す: %s', (label) => {
      expect(hasEvaluativeTargetLabel(label)).toBe(false);
      expect(normalizeTargetLabel(label)).toEqual({ ok: true, value: label });
    });

    it('案内は直し方（料理名・ドリンク名だけにする）を伝える', () => {
      expect(TARGET_LABEL_ERROR_MESSAGES.LABEL_EVALUATIVE).toContain('料理名・ドリンク名だけを入力してください');
    });
  });
});

// 見えない文字・語中の空白で評価語の判定をすり抜けさせない（PR #443 の追加レビュー）。判定は専用の形
// （canonicalizeForEvaluativePolicy）で行い、保存する名前の表示（「焼き鳥 5種盛り」の空白）は変えない。
describe('評価語の判定用の形（canonicalizeForEvaluativePolicy）', () => {
  it('NFKC → 空白（全角を含む）・表示されない文字（ゼロ幅・異体字セレクタ・ソフトハイフン）を除く', () => {
    expect(canonicalizeForEvaluativePolicy('絶 品')).toBe('絶品');
    expect(canonicalizeForEvaluativePolicy('絶　品')).toBe('絶品');
    expect(canonicalizeForEvaluativePolicy('絶​品')).toBe('絶品');
    expect(canonicalizeForEvaluativePolicy('絶‍品')).toBe('絶品');
    expect(canonicalizeForEvaluativePolicy('絶️品')).toBe('絶品');
    expect(canonicalizeForEvaluativePolicy('絶­品')).toBe('絶品');
    expect(canonicalizeForEvaluativePolicy('ｵｽｽﾒ')).toBe('オススメ');
  });

  it.each([
    ['絶​品刺身'],
    ['お​すすめ盛り'],
    ['また​来たい盛り'],
    ['絶 品刺身'],
    ['お すすめ盛り'],
    ['絶️品刺身'],
    ['ｵｽｽﾒ串盛り'],
  ])('すり抜けの形も LABEL_EVALUATIVE: %j', (label) => {
    expect(hasEvaluativeTargetLabel(label)).toBe(true);
    expect(normalizeTargetLabel(label)).toEqual({ ok: false, error: 'LABEL_EVALUATIVE' });
  });

  it.each([['自家製レモンサワー'], ['出汁巻き玉子'], ['濃厚担々麺'], ['焼き鳥 5種盛り'], ['季節の　天ぷら'], ['Craft Beer IPA'], ['生ビール（中）']])(
    '通常の名前は通し、空白は保存する名前に残す: %s',
    (label) => {
      expect(hasEvaluativeTargetLabel(label)).toBe(false);
      expect(normalizeTargetLabel(label)).toEqual({ ok: true, value: label });
    },
  );
});

describe('書式文字（Unicode の Cf）は名前に使えない', () => {
  it.each([
    ['刺身​盛り'],
    ['刺身‎盛り'],
    ['刺身­盛り'],
    ['刺身﻿盛り'],
    ['刺身⁠盛り'],
  ])('%j → LABEL_INVALID_CHARACTER', (label) => {
    expect(normalizeTargetLabel(label)).toEqual({ ok: false, error: 'LABEL_INVALID_CHARACTER' });
  });

  it('絵文字の異体字セレクタ・絵文字どうしのゼロ幅接合子は通す（普通の名前を壊さない）', () => {
    for (const label of ['☕️ブレンド', '🍣盛り合わせ', '👨‍🍳おまかせコース', '❤️‍🔥激辛ラーメン']) {
      expect(normalizeTargetLabel(label), label).toEqual({ ok: true, value: label });
    }
  });

  it('絵文字に挟まれていないゼロ幅接合子は止める', () => {
    expect(normalizeTargetLabel('刺身‍盛り')).toEqual({ ok: false, error: 'LABEL_INVALID_CHARACTER' });
    expect(normalizeTargetLabel('🍣‍盛り')).toEqual({ ok: false, error: 'LABEL_INVALID_CHARACTER' });
  });
});
