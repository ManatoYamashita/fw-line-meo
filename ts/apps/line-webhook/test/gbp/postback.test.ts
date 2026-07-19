import { describe, it, expect } from 'vitest';
import {
  encodeGbpPostback,
  decodeGbpPostback,
  isGbpPostbackData,
  type GbpPostbackAction,
} from '../../src/gbp/postback.js';
import { encodePostback, decodePostback } from '../../src/onboarding/stages.js';

// design.md「GbpPostback」準拠のテスト。
// Requirements 1.3（複数店舗の店舗選択）・3.3（投稿下書きの承認/再生成/修正）・
// 4.3（返信下書きの承認/再生成/修正）が要求する全 action の符号化/復号を
// 単一情報源化し、往復可能・300 文字以内・不正 data は例外を投げず null を
// 返すこと（既存 onboarding の規約踏襲）を保証する。

const MAX_POSTBACK_DATA_LENGTH = 300;
const STORE_ID = 'fcd00000-0000-0000-0000-0000000000a1';

// design.md が列挙する 12 action すべて（漏れがあれば往復テストが検出する）。
const ALL_ACTIONS: GbpPostbackAction[] = [
  { action: 'g_connect' },
  { action: 'g_pick_store', index: 0 },
  { action: 'g_pick_store', index: 9 },
  { action: 'g_status' },
  { action: 'g_disconnect', storeId: STORE_ID },
  { action: 'g_post' },
  { action: 'g_reply' },
  { action: 'g_pick_review', index: 0 },
  { action: 'g_pick_review', index: 4 },
  { action: 'g_approve' },
  { action: 'g_regen' },
  { action: 'g_revise' },
  { action: 'g_overwrite' },
  { action: 'g_cancel' },
];

describe('encodeGbpPostback / decodeGbpPostback 往復', () => {
  it.each(ALL_ACTIONS)('全 GbpPostbackAction バリアントで符号化→復号が往復する: %o', (action) => {
    const encoded = encodeGbpPostback(action);
    expect(decodeGbpPostback(encoded)).toEqual(action);
  });

  it.each(ALL_ACTIONS)('符号化結果は LINE の postback data 上限 300 文字以内: %o', (action) => {
    expect(encodeGbpPostback(action).length).toBeLessThanOrEqual(MAX_POSTBACK_DATA_LENGTH);
  });

  it('design.md が定める 12 種の action 名をすべて符号化できる', () => {
    const names = new Set(ALL_ACTIONS.map((a) => encodeGbpPostback(a).split('&')[0]));
    expect(names).toEqual(
      new Set([
        'a=g_connect',
        'a=g_pick_store',
        'a=g_status',
        'a=g_disconnect',
        'a=g_post',
        'a=g_reply',
        'a=g_pick_review',
        'a=g_approve',
        'a=g_regen',
        'a=g_revise',
        'a=g_overwrite',
        'a=g_cancel',
      ]),
    );
  });

  it('index=0 でも往復する（falsy 値の取りこぼし防止）', () => {
    expect(decodeGbpPostback(encodeGbpPostback({ action: 'g_pick_store', index: 0 }))).toEqual({
      action: 'g_pick_store',
      index: 0,
    });
    expect(decodeGbpPostback(encodeGbpPostback({ action: 'g_pick_review', index: 0 }))).toEqual({
      action: 'g_pick_review',
      index: 0,
    });
  });

  it('すべての符号化結果は URLSearchParams 形式で a= から始まる', () => {
    for (const action of ALL_ACTIONS) {
      const encoded = encodeGbpPostback(action);
      expect(encoded.startsWith('a=g_')).toBe(true);
      expect(new URLSearchParams(encoded).get('a')).toBe(action.action);
    }
  });
});

describe('decodeGbpPostback の安全側フォールバック', () => {
  it('未知の action は null', () => {
    expect(decodeGbpPostback('a=g_unknown')).toBeNull();
    expect(decodeGbpPostback('a=g_')).toBeNull();
    expect(decodeGbpPostback('a=')).toBeNull();
  });

  it('a パラメータ欠落は null', () => {
    expect(decodeGbpPostback('i=0')).toBeNull();
    expect(decodeGbpPostback('s=' + STORE_ID)).toBeNull();
    expect(decodeGbpPostback('')).toBeNull();
  });

  it('index を要求する action で i 欠落・不正値は null', () => {
    for (const name of ['g_pick_store', 'g_pick_review']) {
      expect(decodeGbpPostback(`a=${name}`)).toBeNull();
      expect(decodeGbpPostback(`a=${name}&i=`)).toBeNull();
      expect(decodeGbpPostback(`a=${name}&i=-1`)).toBeNull();
      expect(decodeGbpPostback(`a=${name}&i=1.5`)).toBeNull();
      expect(decodeGbpPostback(`a=${name}&i=abc`)).toBeNull();
      expect(decodeGbpPostback(`a=${name}&i=1e3`)).toBeNull();
      expect(decodeGbpPostback(`a=${name}&i=NaN`)).toBeNull();
      expect(decodeGbpPostback(`a=${name}&i=999999999999999999999`)).toBeNull();
    }
  });

  it('g_disconnect の s は UUID 形式でなければ null（形式検証のみ）', () => {
    expect(decodeGbpPostback('a=g_disconnect')).toBeNull();
    expect(decodeGbpPostback('a=g_disconnect&s=')).toBeNull();
    expect(decodeGbpPostback('a=g_disconnect&s=not-a-uuid')).toBeNull();
    expect(decodeGbpPostback(`a=g_disconnect&s=${STORE_ID}x`)).toBeNull();
    expect(decodeGbpPostback("a=g_disconnect&s=' OR 1=1--")).toBeNull();
  });

  it('g_disconnect は UUID 形式であれば他オーナーの storeId でも decode は成功する（所有検証は GbpFlows の責務）', () => {
    const foreign = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    expect(decodeGbpPostback(`a=g_disconnect&s=${foreign}`)).toEqual({
      action: 'g_disconnect',
      storeId: foreign,
    });
  });

  it('300 文字を超える data は null', () => {
    const overLimit = `a=g_disconnect&s=${STORE_ID}&x=${'y'.repeat(300)}`;
    expect(overLimit.length).toBeGreaterThan(MAX_POSTBACK_DATA_LENGTH);
    expect(decodeGbpPostback(overLimit)).toBeNull();
  });

  it('ちょうど 300 文字までは受理される（境界）', () => {
    const base = 'a=g_status&x=';
    const exact = base + 'y'.repeat(MAX_POSTBACK_DATA_LENGTH - base.length);
    expect(exact.length).toBe(MAX_POSTBACK_DATA_LENGTH);
    expect(decodeGbpPostback(exact)).toEqual({ action: 'g_status' });
  });

  it('非文字列・null/undefined でも例外を投げず null を返す', () => {
    const decode = decodeGbpPostback as unknown as (data: unknown) => GbpPostbackAction | null;
    expect(decode(undefined)).toBeNull();
    expect(decode(null)).toBeNull();
    expect(decode(42)).toBeNull();
    expect(decode({})).toBeNull();
  });
});

describe('onboarding postback との名前空間独立', () => {
  it('onboarding の action は GbpPostback として decode されない', () => {
    for (const data of ['a=select&i=0', 'a=confirm', 'a=restart', 'a=resume']) {
      expect(decodeGbpPostback(data)).toBeNull();
    }
  });

  it('GBP の action は onboarding として decode されない', () => {
    for (const action of ALL_ACTIONS) {
      expect(decodePostback(encodeGbpPostback(action))).toBeNull();
    }
  });

  it('onboarding の符号化結果は g_ プレフィックスを持たない', () => {
    const onboardingData = [
      encodePostback({ kind: 'select_candidate', index: 0 }),
      encodePostback({ kind: 'confirm' }),
      encodePostback({ kind: 'restart' }),
      encodePostback({ kind: 'resume' }),
    ];
    for (const data of onboardingData) {
      expect(isGbpPostbackData(data)).toBe(false);
    }
  });
});

describe('isGbpPostbackData（conversation.ts のディスパッチ分岐用）', () => {
  it('GBP 系の符号化結果はすべて true', () => {
    for (const action of ALL_ACTIONS) {
      expect(isGbpPostbackData(encodeGbpPostback(action))).toBe(true);
    }
  });

  it('a が g_ で始まれば未知 action でも true（GbpFlows 側で案内フォールバック）', () => {
    expect(isGbpPostbackData('a=g_unknown_future')).toBe(true);
  });

  it('a が g_ で始まらない・欠落・不正な data は false', () => {
    expect(isGbpPostbackData('a=confirm')).toBe(false);
    expect(isGbpPostbackData('a=select&i=0')).toBe(false);
    expect(isGbpPostbackData('i=0')).toBe(false);
    expect(isGbpPostbackData('')).toBe(false);
    expect(isGbpPostbackData('g_post')).toBe(false);
    expect(isGbpPostbackData(`a=g_status&x=${'y'.repeat(300)}`)).toBe(false);
  });

  it('非文字列でも例外を投げず false', () => {
    const check = isGbpPostbackData as unknown as (data: unknown) => boolean;
    expect(check(undefined)).toBe(false);
    expect(check(null)).toBe(false);
    expect(check(42)).toBe(false);
  });
});
