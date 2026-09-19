// メニューの action 群がレポート 3 導線を持つかの判定の試験（design.md「ReportPostbackCodec」・Requirement 1.10）。
// delivery-job は、この判定が真のメニューをオーナーが見ているときに限り、メニューへ誘導する通知を送る。
// 1 導線でも欠けたメニューを「持つ」と判定すると、押しても答えの返らない導線へ誘導することになる。
import { describe, it, expect } from 'vitest';
import {
  encodeReportPostback,
  exposesAllReportActions,
  type ReportKind,
  type RichMenuActionLike,
} from '../src/index.js';

const KINDS: readonly ReportKind[] = ['new_reviews', 'comparison', 'trend'];

// stores.id と同じ uuid の形の値（実在の店舗とは無関係）。
const STORE_ID = '3f2c9a4e-1b7d-4c8e-9a51-6d0e2f7b8c13';

// メニューの区画が使う形（店舗も頁も持たない postback）。
function menuPostback(kind: ReportKind): RichMenuActionLike {
  return { type: 'postback', data: encodeReportPostback({ kind, storeId: null, page: 0 }) };
}

// 完了後メニュー（design.md「RichMenuDefinitions と RichMenuScripts」の区画表）の 5 区画の action。
// 下段の 2 区画は uri（詳細を見る）と message（ステータス確認）で、data を持たない。
const COMPLETED_MENU: readonly RichMenuActionLike[] = [
  menuPostback('new_reviews'),
  menuPostback('comparison'),
  menuPostback('trend'),
  { type: 'uri' },
  { type: 'message' },
];

// 指定した種類の区画だけを別の action に差し替える。
function replaceKind(kind: ReportKind, replacement: RichMenuActionLike): RichMenuActionLike[] {
  const target = menuPostback(kind).data;
  return COMPLETED_MENU.map((action) => (action.data === target ? replacement : action));
}

describe('exposesAllReportActions', () => {
  it('3 種類のレポートの区画がそろった完了後メニューは持つ', () => {
    expect(exposesAllReportActions(COMPLETED_MENU)).toBe(true);
  });

  it('区画の並び順によらない', () => {
    expect(exposesAllReportActions([...COMPLETED_MENU].reverse())).toBe(true);
  });

  it('同じ種類の区画が重なっていても、3 種類がそろっていれば持つ', () => {
    expect(exposesAllReportActions([...COMPLETED_MENU, menuPostback('trend')])).toBe(true);
  });

  // 第2フェーズで下段に「Google 連携」の区画を足す予定がある（design.md の区画表の注記）。
  // レポート以外の postback が混じっても、3 導線がそろっていれば判定は変わらないことを固定する。
  it.each(['a=g_status', 'a=resume'])(
    'レポート以外の postback（%s）の区画が混じっても、3 種類がそろっていれば持つ',
    (data) => {
      expect(exposesAllReportActions([...COMPLETED_MENU, { type: 'postback', data }])).toBe(true);
    },
  );

  it.each(KINDS)('%s の区画が 1 つ欠けたメニューは持たない', (kind) => {
    const target = menuPostback(kind).data;
    const actions = COMPLETED_MENU.filter((action) => action.data !== target);
    expect(actions).toHaveLength(COMPLETED_MENU.length - 1);
    expect(exposesAllReportActions(actions)).toBe(false);
  });

  it('1 種類の区画を 3 つ並べても持たない', () => {
    expect(exposesAllReportActions(KINDS.map(() => menuPostback('trend')))).toBe(false);
  });

  it('区画の無いメニューは持たない', () => {
    expect(exposesAllReportActions([])).toBe(false);
  });

  it('現行の完了後メニュー（ステータス確認の message の 1 区画）は持たない', () => {
    expect(exposesAllReportActions([{ type: 'message' }])).toBe(false);
  });

  it('オンボーディング用メニュー（再開の postback の 1 区画）は持たない', () => {
    expect(exposesAllReportActions([{ type: 'postback', data: 'a=resume' }])).toBe(false);
  });

  it.each(KINDS)('%s のレポートの data を postback 以外の action に載せても数えない', (kind) => {
    const data = encodeReportPostback({ kind, storeId: null, page: 0 });
    expect(exposesAllReportActions(replaceKind(kind, { type: 'message', data }))).toBe(false);
    expect(exposesAllReportActions(replaceKind(kind, { type: 'uri', data }))).toBe(false);
  });

  it.each(KINDS)('%s の区画が店舗つき・頁つきの postback なら数えない', (kind) => {
    const withStore = encodeReportPostback({ kind, storeId: STORE_ID, page: 0 });
    const withPage = encodeReportPostback({ kind, storeId: null, page: 1 });
    expect(exposesAllReportActions(replaceKind(kind, { type: 'postback', data: withStore }))).toBe(false);
    expect(exposesAllReportActions(replaceKind(kind, { type: 'postback', data: withPage }))).toBe(false);
  });

  it.each(KINDS)('%s の区画の postback が data を持たないか壊れていれば数えない', (kind) => {
    expect(exposesAllReportActions(replaceKind(kind, { type: 'postback' }))).toBe(false);
    expect(exposesAllReportActions(replaceKind(kind, { type: 'postback', data: 'a=rpt&k=xx' }))).toBe(false);
  });
});
