// レポートの postback 契約の試験（design.md「ReportPostbackCodec」・Requirements 2.3, 2.7）。
// - 3 種類のレポートが、店舗と頁の有無によらず符号化→復号で同じ値へ戻ること
// - 符号化の結果が LINE の postback data の上限 300 文字に収まり、超えるものは符号化しないこと
// - `rpt` 以外の action（オンボーディングと第2フェーズ）の data を受理しないこと
// - 導線の文言が要件 2.1 の文言そのものであること
import { describe, it, expect } from 'vitest';
import {
  REPORT_LABELS,
  decodeReportPostback,
  encodeReportPostback,
  isReportPostbackData,
  type ReportKind,
  type ReportRequest,
} from '../src/index.js';

// LINE Messaging API の postback data の上限（references/action-objects.md の Postback Action）。
const MAX_POSTBACK_DATA_LENGTH = 300;

const KINDS: readonly ReportKind[] = ['new_reviews', 'comparison', 'trend'];

// stores.id と同じ uuid の形の値（実在の店舗とは無関係）。
const STORE_ID = '3f2c9a4e-1b7d-4c8e-9a51-6d0e2f7b8c13';

// 受理しないことを確かめるときは、復号と判定の両方を見る。
function expectRejected(data: string): void {
  expect(decodeReportPostback(data)).toBeNull();
  expect(isReportPostbackData(data)).toBe(false);
}

describe('REPORT_LABELS', () => {
  it('導線の文言は要件 2.1 の 3 つの文言そのもの', () => {
    expect(REPORT_LABELS).toEqual({
      new_reviews: '新着口コミをみる',
      comparison: '競合店との比較をみる',
      trend: '直近の推移を見る',
    });
  });
});

describe('encodeReportPostback の形式', () => {
  it('メニューの区画が使う形（店舗も頁も持たない）は a=rpt&k=<種類> だけになる', () => {
    expect(encodeReportPostback({ kind: 'new_reviews', storeId: null, page: 0 })).toBe('a=rpt&k=nr');
    expect(encodeReportPostback({ kind: 'comparison', storeId: null, page: 0 })).toBe('a=rpt&k=cmp');
    expect(encodeReportPostback({ kind: 'trend', storeId: null, page: 0 })).toBe('a=rpt&k=tr');
  });

  it('店舗は &s=、頁は &p= として後ろに付く', () => {
    expect(encodeReportPostback({ kind: 'comparison', storeId: STORE_ID, page: 0 })).toBe(
      `a=rpt&k=cmp&s=${STORE_ID}`,
    );
    expect(encodeReportPostback({ kind: 'trend', storeId: null, page: 2 })).toBe('a=rpt&k=tr&p=2');
    expect(encodeReportPostback({ kind: 'new_reviews', storeId: STORE_ID, page: 1 })).toBe(
      `a=rpt&k=nr&s=${STORE_ID}&p=1`,
    );
  });
});

describe('符号化→復号の往復', () => {
  const requests: ReportRequest[] = KINDS.flatMap((kind): ReportRequest[] => [
    { kind, storeId: null, page: 0 },
    { kind, storeId: STORE_ID, page: 0 },
    { kind, storeId: null, page: 1 },
    { kind, storeId: STORE_ID, page: 99 },
    { kind, storeId: 'x'.repeat(64), page: 99 },
  ]);

  it.each(requests)('同じ値へ戻り、300 文字以内に収まる: %o', (request) => {
    const data = encodeReportPostback(request);
    expect(data.length).toBeLessThanOrEqual(MAX_POSTBACK_DATA_LENGTH);
    expect(decodeReportPostback(data)).toEqual(request);
    expect(isReportPostbackData(data)).toBe(true);
  });

  it.each(['a&k=cmp', 'x=y&a=select', '1+1 2', '100%', '店舗/1', '#?', 'a'])(
    '区切りに使う文字や非 ASCII を含む店舗 ID も往復する: %s',
    (storeId) => {
      const request: ReportRequest = { kind: 'new_reviews', storeId, page: 3 };
      expect(decodeReportPostback(encodeReportPostback(request))).toEqual(request);
    },
  );
});

describe('300 文字の上限', () => {
  // 'あ' は符号化で %E3%81%82 の 9 文字になる。'a=rpt&k=nr&s=' の 13 文字と合わせて、
  // 店舗 ID の文字数が上限（64）の内側のまま、ちょうど 300 文字と 301 文字の data を作る。
  const storeIdAtLimit = `${'あ'.repeat(31)}abcdefgh`;
  const storeIdOverLimit = `${'あ'.repeat(31)}abcdefghi`;

  it('ちょうど 300 文字になる要求は符号化し、往復する', () => {
    const request: ReportRequest = { kind: 'new_reviews', storeId: storeIdAtLimit, page: 0 };
    const data = encodeReportPostback(request);
    expect(data.length).toBe(MAX_POSTBACK_DATA_LENGTH);
    expect(decodeReportPostback(data)).toEqual(request);
  });

  it('301 文字になる要求は符号化せずに例外を投げる', () => {
    expect(storeIdOverLimit.length).toBeLessThanOrEqual(64);
    expect(() =>
      encodeReportPostback({ kind: 'new_reviews', storeId: storeIdOverLimit, page: 0 }),
    ).toThrow();
  });

  it('301 文字の data は、他の条件を満たしていても受理しない', () => {
    const data = `a=rpt&k=nr&s=${encodeURIComponent(storeIdOverLimit)}`;
    expect(data.length).toBe(MAX_POSTBACK_DATA_LENGTH + 1);
    expectRejected(data);
  });
});

describe('encodeReportPostback の前提条件', () => {
  it.each<[string, ReportRequest]>([
    ['空の店舗 ID', { kind: 'trend', storeId: '', page: 0 }],
    ['65 文字の店舗 ID', { kind: 'trend', storeId: 'x'.repeat(65), page: 0 }],
    ['対になっていないサロゲートを含む店舗 ID（往復できない）', { kind: 'trend', storeId: 'a\uD800', page: 0 }],
    ['負の頁', { kind: 'trend', storeId: null, page: -1 }],
    ['100 の頁', { kind: 'trend', storeId: null, page: 100 }],
    ['整数でない頁', { kind: 'trend', storeId: null, page: 1.5 }],
    ['NaN の頁', { kind: 'trend', storeId: null, page: Number.NaN }],
    ['未知の種類', { kind: 'unknown' as string as ReportKind, storeId: null, page: 0 }],
  ])('%s は符号化せずに例外を投げる', (_label, request) => {
    expect(() => encodeReportPostback(request)).toThrow();
  });
});

describe('rpt 以外の action を受理しない', () => {
  // オンボーディングの postback（line-webhook の src/onboarding/stages.ts の encodePostback の出力）。
  // 本パッケージはアプリを import しない（依存の向きは apps → package）ので、出力を文字列で写す。
  const ONBOARDING_DATA = ['a=select&i=0', 'a=select&i=9', 'a=confirm', 'a=restart', 'a=resume'];
  const ONBOARDING_ACTIONS = ['select', 'confirm', 'restart', 'resume'];
  // 第2フェーズの action（main にはまだ無い。名前だけを先に固定する）。
  const PHASE2_ACTIONS = ['g_post', 'g_reply', 'g_status'];

  it.each(ONBOARDING_DATA)('オンボーディングの data %s を受理しない', (data) => {
    expectRejected(data);
  });

  // action 以外の項目をレポートの形でそろえ、action だけで受理が決まることを確かめる。
  it.each([...ONBOARDING_ACTIONS, ...PHASE2_ACTIONS])(
    'a=%s は、レポートの他の項目がそろっていても受理しない',
    (action) => {
      for (const rest of ['', '&k=nr', '&k=cmp', '&k=tr', `&k=nr&s=${STORE_ID}&p=1`]) {
        expectRejected(`a=${action}${rest}`);
      }
    },
  );

  it.each(['RPT', 'Rpt', 'rpt ', ' rpt', 'rpt+', 'rpt2', 'rp', 'xrpt', ''])(
    'a の値は rpt との完全一致だけを受理する: "%s"',
    (action) => {
      expectRejected(`a=${action}&k=nr`);
    },
  );

  it('a の無い data を受理しない', () => {
    expectRejected('k=nr');
    expectRejected(`k=cmp&s=${STORE_ID}`);
  });

  it('a が 2 回ある data を受理しない（先頭の a だけを読む復号器と解釈を食い違わせない）', () => {
    expectRejected('a=rpt&a=select&k=nr');
    expectRejected('a=select&a=rpt&k=nr');
    expectRejected('a=rpt&a=rpt&k=nr');
  });
});

describe('壊れた data を受理しない', () => {
  it.each<[string, string]>([
    ['空文字', ''],
    ['種類なし', 'a=rpt'],
    ['未知の種類', 'a=rpt&k=xx'],
    ['種類の内部名', 'a=rpt&k=new_reviews'],
    ['種類の大文字', 'a=rpt&k=NR'],
    ['空の種類', 'a=rpt&k='],
    ['Object のプロトタイプ上の名前の種類', 'a=rpt&k=toString'],
    ['__proto__ の種類', 'a=rpt&k=__proto__'],
    ['種類が 2 回', 'a=rpt&k=nr&k=cmp'],
    ['空の店舗 ID', 'a=rpt&k=nr&s='],
    ['65 文字の店舗 ID', `a=rpt&k=nr&s=${'x'.repeat(65)}`],
    ['店舗 ID が 2 回', `a=rpt&k=nr&s=${STORE_ID}&s=${STORE_ID}`],
    ['空の頁', 'a=rpt&k=nr&p='],
    ['負の頁', 'a=rpt&k=nr&p=-1'],
    ['3 桁の頁', 'a=rpt&k=nr&p=100'],
    ['小数の頁', 'a=rpt&k=nr&p=1.5'],
    ['数字でない頁', 'a=rpt&k=nr&p=abc'],
    ['符号つきの頁', 'a=rpt&k=nr&p=%2B1'],
    ['全角数字の頁', 'a=rpt&k=nr&p=１'],
    ['頁が 2 回', 'a=rpt&k=nr&p=1&p=2'],
    ['未知の項目', 'a=rpt&k=nr&x=1'],
    ['オンボーディングの項目', 'a=rpt&k=nr&i=0'],
    ['JSON', JSON.stringify({ a: 'rpt', k: 'nr' })],
    ['別の形式', 'action=rpt&kind=nr'],
    ['ただの文字列', 'this is not a postback'],
  ])('%s は null', (_label, data) => {
    expectRejected(data);
  });

  it.each(['%', '%%', 'a=rpt&k=nr&s=%', 'a=rpt&k=nr&s=%E3%81', '\uD800', '&&&', '===', 'a=rpt&&k=nr=&'])(
    '例外を投げない: %s',
    (data) => {
      expect(() => decodeReportPostback(data)).not.toThrow();
      expect(() => isReportPostbackData(data)).not.toThrow();
    },
  );
});
