// 店舗の選択肢のメッセージ（design.md「Report builders（表示）」の StoreChoiceBuilder・
// Requirements 3.2, 3.6, 3.9, 3.10）。
//
// 本文は「どの店舗の〇〇を表示しますか」のテキストで、店舗ごとの postback をクイックリプライに並べる。
// 選択肢の頁（StoreChoicePage）は resolveTargetStore が認可済みの店舗の集合から切り出したもので、
// ここでは並べ方と文言だけを決める。帰属表示を付けない理由は notices.ts と同じで、確定後の店舗名を
// オーナーが確定した自店の識別情報として扱うためである（design.md「残るリスクと未決事項」の判断）。
// 確定前の検索結果を出す面（オンボーディングの候補）は帰属を持つ（Issue #287・line/messages.ts）。
//
// LINE の上限（1 つでも超えると Reply の要求そのものが 400 で拒否され、選択肢が 1 件も届かない）:
// - クイックリプライは 13 件まで（references/message-objects.md の Quick Reply）。1 頁 12 店と「ほかの店舗」
// - ラベルは 20 文字まで（references/action-objects.md）。stores.ts の labelStoreChoices が収める
// - displayText は 300 文字まで（references/action-objects.md の Postback Action）
// - postback の data は 300 文字まで（@fwlm/line-report の符号化が守る）

import { encodeReportPostback, type ReportKind } from '@fwlm/line-report';
import type { LineMessage } from '../../line/client.js';
import type { QuickReplyItem } from '../../line/flex-types.js';
import { fitText } from '../format.js';
import { STORE_CHOICE_PAGE_SIZE, labelStoreChoices, type StoreChoicePage } from '../stores.js';

/**
 * displayText の上限の文字数。LINE は書記素で数えるので、コードポイントで収めれば超えない（format.ts の fitText）。
 * stores.name は長さの制約が無い text なので、これを超える名前だけを切る。
 */
export const DISPLAY_TEXT_MAX_LENGTH = 300;

// 本文で呼ぶレポートの名前。メニューの導線の文言（@fwlm/line-report の REPORT_LABELS）の先頭と同じ語にする。
const REPORT_SUBJECTS: Readonly<Record<ReportKind, string>> = {
  new_reviews: '新着口コミ',
  comparison: '競合店との比較',
  trend: '直近の推移',
};

const INVALID_CHOICE_LINE = 'その店舗は選べません。';
const HOW_TO_CHOOSE_LINE = '下の店舗名から選んでください。';
const NEXT_PAGE_LABEL = 'ほかの店舗';

// @fwlm/line-report の符号化が受理する頁の上限（design.md の ReportPostbackCodec の前提条件は 0〜99）。
// 1 頁 12 店なので、「ほかの店舗」をたどって選べるのは 1200 店までである（3.10 の既知の限界）。
// 次の頁がこれを超えるときは「ほかの店舗」を出さない（符号化できない頁を送らない）。
const MAX_ENCODABLE_PAGE = 99;

/**
 * 店舗の選択肢のメッセージを組み立てる。
 *
 * - 本文は「どの店舗の〇〇を表示しますか？」と選び方の 2 行。無効な選択（invalid_choice）のときは
 *   「その店舗は選べません。」を先頭の行に置き、選択肢の項目は増やさない（3.6）
 * - 店舗ごとの項目のラベルは labelStoreChoices の省略したラベル、displayText は店舗名（3.9）
 * - 店舗の項目の postback は種類・店舗・表示した頁を運ぶ。頁を運ぶのは、選んだ店舗が選べなくなって
 *   いたとき（停止など）に、resolveTargetStore が同じ頁を再提示するため
 * - 次の頁があれば「ほかの店舗」（種類と次の頁だけを運ぶ postback）を最後に足す（3.10）
 *
 * 頁の店舗は 1〜12 店でなければならない。外れていれば、13 件の上限を超える選択肢を LINE へ送らないよう
 * 例外にする（呼出元の誤りである）。
 */
export function buildStoreChoiceMessage(
  kind: ReportKind,
  page: StoreChoicePage,
  reason: 'multiple' | 'invalid_choice',
): LineMessage {
  if (page.stores.length === 0 || page.stores.length > STORE_CHOICE_PAGE_SIZE) {
    throw new Error(
      `buildStoreChoiceMessage: a page must have 1-${STORE_CHOICE_PAGE_SIZE} stores (got ${page.stores.length})`,
    );
  }

  const items: QuickReplyItem[] = labelStoreChoices(page.stores).map(({ store, label }) => ({
    type: 'action',
    action: {
      type: 'postback',
      label,
      data: encodeReportPostback({ kind, storeId: store.id, page: page.pageIndex }),
      displayText: fitText(store.name, DISPLAY_TEXT_MAX_LENGTH),
    },
  }));

  if (page.nextPageIndex !== null && page.nextPageIndex <= MAX_ENCODABLE_PAGE) {
    items.push({
      type: 'action',
      action: {
        type: 'postback',
        label: NEXT_PAGE_LABEL,
        data: encodeReportPostback({ kind, storeId: null, page: page.nextPageIndex }),
        displayText: NEXT_PAGE_LABEL,
      },
    });
  }

  const lines = [
    ...(reason === 'invalid_choice' ? [INVALID_CHOICE_LINE] : []),
    `どの店舗の${REPORT_SUBJECTS[kind]}を表示しますか？`,
    HOW_TO_CHOOSE_LINE,
  ];

  return { type: 'text', text: lines.join('\n'), quickReply: { items } };
}
