// 変化があった日の通知の判定と組立（line-on-demand-report の design.md「NotificationPolicy」・
// Requirements 1.1〜1.6, 8.1）。
//
// 入力は Issue #255 の正規化（@fwlm/db/daily-summary の normalizeSummaryRatings）を通した当日と前日の行である。
// 未評価の店（評価 0 の既存データを含む）は正規化の側だけが扱い、ここでは規則を持たない。正規化で自店の
// 順位が null になった行、評価を持つ競合がいない行（母数 1）は、比較可能でない行として読むだけでよい。
//
// DB にも LINE にも触れない純関数で、記録（ログ）も出さない。送るかどうかを決めた後の予約・照合・push・
// 記録は配信ジョブの編成（index.ts）が行う。
//
// Flex の型は、旧来の日次カード（flex.ts）の局所的な型を使わずにここで持つ。日次カードは撤去する予定で、
// 通知が要る形はそれより狭い（本文の 2 つの文と帰属表示だけで、ボタンを持たない）。
// 鍵の名前は references/flex-message.md と、鍵の集合を @line/bot-sdk の生成型へ照合している
// line-webhook の line/flex-types.ts と同じにしている。

import type { DailySummaryStatus } from '@fwlm/db';
import { lineColors, lineLayout } from '@fwlm/design-tokens';
import { REPORT_LABELS } from '@fwlm/line-report';

// --- 判定 --------------------------------------------------------------------------

/** 比較可能かの判定に使う列（前日の行はこれだけを読む）。 */
export interface NotificationSubject {
  readonly status: DailySummaryStatus;
  readonly rank: number | null;
  readonly rank_total: number | null;
}

/**
 * 当日の行のうち、判定に使う列。
 *
 * 当日の行の rank_prev（Go が当日の競合集合で前日の値を計算し直したもの）は、あえて持たない。
 * オーナーが前日のレポートで見た順位と食い違いうるため、順位変動は前日の行の rank と比べる。
 */
export interface NotificationToday extends NotificationSubject {
  readonly review_count_prev: number | null;
  readonly new_review_count: number;
}

/** 通知で知らせる変化。成り立たなかった変化は null。 */
export interface NotifiedChanges {
  readonly newReviewCount: number | null;
  readonly rank: { readonly from: number; readonly to: number } | null;
}

export type NotificationDecision =
  | { readonly kind: 'notify'; readonly changes: NotifiedChanges }
  | { readonly kind: 'skip'; readonly reason: 'no_change' | 'not_comparable' };

/**
 * 競合比較可能か（要件の用語）。取得失敗でなく、自店の順位が値を持ち、順位母数が 2 以上であること。
 *
 * 競合なし（no_competitors）の行は 1 店中 1 位、評価を持つ競合がいない行は正規化の後で母数 1、
 * 自店が未評価の行は正規化で順位が null になるので、どれも比較可能でない。
 */
export function isComparable(subject: NotificationSubject): boolean {
  return subject.status !== 'failed' && subject.rank !== null && subject.rank_total !== null && subject.rank_total >= 2;
}

/**
 * 当日と前日の行から、通知を送るかどうかと知らせる変化を決める。
 *
 * 1. 当日が比較可能でなければ送らない（not_comparable・1.5）
 * 2. 新着: review_count_prev が値を持ち、new_review_count が 1 以上（1.1）。review_count_prev が値を持つのは、
 *    前日の自店のスナップショットがあり、前日の集計が取得失敗でない日である。新着口コミのレポートも同じ列で
 *    前日の集計の有無を判定するので（4.8）、通知とレポートで新着の有無が食い違わない
 * 3. 順位変動: 前日の行があって比較可能で、前日の行の rank と当日の rank が異なる（1.2）。起点と終点はこの
 *    2 つの値で、オーナーが前日と当日のレポートで見る順位と一致する。自店が前日に未評価なら、正規化で前日の
 *    順位が null になって比較可能でなくなり、変動にならない
 * 4. 2 と 3 のどちらも成り立たなければ送らない（no_change・1.4）。両方なら 1 通にまとめる（1.3）
 */
export function decideNotification(
  today: NotificationToday,
  yesterday: NotificationSubject | null,
): NotificationDecision {
  // rank の null 検査は isComparable が済ませているが、型を number へ絞るために重ねて書く。
  if (!isComparable(today) || today.rank === null) {
    return { kind: 'skip', reason: 'not_comparable' };
  }

  const newReviewCount =
    today.review_count_prev !== null && today.new_review_count >= 1 ? today.new_review_count : null;

  // 当日の行の rank_prev は使わない（NotificationToday が持たない列である）。
  const rank =
    yesterday !== null && isComparable(yesterday) && yesterday.rank !== null && yesterday.rank !== today.rank
      ? { from: yesterday.rank, to: today.rank }
      : null;

  if (newReviewCount === null && rank === null) {
    return { kind: 'skip', reason: 'no_change' };
  }
  return { kind: 'notify', changes: { newReviewCount, rank } };
}

// --- Flex の型（通知が使う形だけ） ----------------------------------------------------

export interface NotificationFlexText {
  readonly type: 'text';
  readonly text: string;
  readonly size: string;
  readonly color: string;
  readonly wrap: boolean;
  readonly align?: 'start' | 'center' | 'end';
}

/** 部品は text だけに限る。ボタンや操作を置かない（誘導先はリッチメニュー）ことを型でも表す。 */
export interface NotificationFlexBox {
  readonly type: 'box';
  readonly layout: 'vertical';
  readonly spacing: string;
  readonly paddingAll: string;
  readonly contents: readonly NotificationFlexText[];
}

export interface NotificationFlexBubble {
  readonly type: 'bubble';
  readonly size: string;
  readonly styles: { readonly footer: { readonly separator: boolean } };
  readonly body: NotificationFlexBox;
  readonly footer: NotificationFlexBox;
}

/** LINE へ push する Flex のメッセージ（messages 配列の 1 要素）。 */
export interface FlexMessagePayload {
  readonly type: 'flex';
  readonly altText: string;
  readonly contents: NotificationFlexBubble;
}

// --- 上限 --------------------------------------------------------------------------

/**
 * バブルの JSON の大きさの上限（バイト）。
 *
 * LINE は上限を「30 KB」とだけ書く（references/flex-message.md の Limits）。30,000 と 30,720 のどちらかは
 * 書かれていないので、小さい方を採る（レポートの組立と同じ読み）。
 */
export const FLEX_BUBBLE_MAX_BYTES = 30_000;

/** altText の上限（UTF-16 の単位。references/flex-message.md の Limits）。 */
export const ALT_TEXT_MAX_LENGTH = 400;

/** バブルが大きさの上限を超えたときに投げる。 */
export class FlexBubbleTooLargeError extends Error {
  readonly sizeBytes: number;
  readonly limitBytes: number;

  constructor(sizeBytes: number, limitBytes: number) {
    super(`Flex bubble size ${sizeBytes} bytes exceeds limit ${limitBytes} bytes`);
    this.name = 'FlexBubbleTooLargeError';
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

// --- 文言 --------------------------------------------------------------------------

/** Google Maps の帰属表示の文言。Places API のポリシーは「Google Maps」の改変・改行・翻訳を禁じる（8.1）。 */
const ATTRIBUTION_TEXT = 'データ提供: Google Maps';

const ALT_TEXT_ATTRIBUTION = `（${ATTRIBUTION_TEXT}）`;

/** 省略したことを示す記号。 */
const ELLIPSIS = '…';

// 書記素（利用者が 1 文字と見る単位）に分ける。altText の店舗名を縮めるとき、絵文字の連結や
// サロゲートの組を途中で割らないため。
const graphemeSegmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/** 組立の前提（呼出元の誤り）を確かめる。何を知らせるのか分からない通知を送らない。 */
function assertBuildable(storeName: string, changes: NotifiedChanges): void {
  if (storeName.length === 0) {
    throw new Error('buildChangeNotification: storeName must not be empty');
  }
  if (changes.newReviewCount === null && changes.rank === null) {
    throw new Error('buildChangeNotification: changes must contain at least one change');
  }
  if (changes.newReviewCount !== null && !isPositiveInteger(changes.newReviewCount)) {
    throw new Error('buildChangeNotification: newReviewCount must be a positive integer');
  }
  if (changes.rank !== null) {
    const { from, to } = changes.rank;
    if (!isPositiveInteger(from) || !isPositiveInteger(to) || from === to) {
      throw new Error('buildChangeNotification: rank must be two different positive integers');
    }
  }
}

/**
 * 1 文目: 店舗名と、成り立った変化。店舗名は「」で括り、省略しない（3.8）。
 * 順位は数が小さいほど上位なので、数が減れば「上がりました」と書く。
 */
function changeSentence(storeName: string, changes: NotifiedChanges): string {
  const rankClause =
    changes.rank === null
      ? null
      : `近隣での順位が${changes.rank.from}位から${changes.rank.to}位に${
          changes.rank.to < changes.rank.from ? '上がりました' : '下がりました'
        }。`;

  if (changes.newReviewCount !== null && rankClause !== null) {
    return `「${storeName}」で新着口コミが${changes.newReviewCount}件あり、${rankClause}`;
  }
  if (changes.newReviewCount !== null) {
    return `「${storeName}」で新着口コミが${changes.newReviewCount}件ありました。`;
  }
  return `「${storeName}」の${rankClause}`;
}

/**
 * 2 文目: 変化を確かめられるメニューの導線。導線の語はリッチメニューのラベル（REPORT_LABELS）をそのまま
 * 引用し、オーナーが通知の語でメニューの区画を探せるようにする。新着は新着口コミのレポート、順位は
 * 競合店との比較のレポートで確かめられる。
 */
function menuSentence(changes: NotifiedChanges): string {
  const labels = [
    ...(changes.newReviewCount !== null ? [REPORT_LABELS.new_reviews] : []),
    ...(changes.rank !== null ? [REPORT_LABELS.comparison] : []),
  ];
  return `メニューの${labels.map((label) => `「${label}」`).join('')}からご確認いただけます。`;
}

/**
 * altText。本文の 2 文の後に帰属表示を付ける（altText はトークの一覧や通知でバブルの代わりに出るので、
 * バブルと同じく帰属表示を持たせる）。上限を超えるときは店舗名だけを書記素の境目で縮め、変化・導線・
 * 帰属表示は切らない。長さは LINE の数え方（UTF-16 の単位）で数える。
 */
function buildAltText(storeName: string, changes: NotifiedChanges): string {
  const compose = (name: string): string =>
    `${changeSentence(name, changes)}${menuSentence(changes)}${ALT_TEXT_ATTRIBUTION}`;

  const full = compose(storeName);
  if (full.length <= ALT_TEXT_MAX_LENGTH) {
    return full;
  }

  // 店舗名の外の部分は、数字の桁を含めても 100 単位ほどに収まるので、店舗名の枠は正の値になる。
  const nameBudget = ALT_TEXT_MAX_LENGTH - (full.length - storeName.length) - ELLIPSIS.length;
  let kept = '';
  for (const { segment } of graphemeSegmenter.segment(storeName)) {
    if (kept.length + segment.length > nameBudget) {
      break;
    }
    kept += segment;
  }
  return compose(`${kept}${ELLIPSIS}`);
}

/**
 * 帰属表示の text 部品（8.1）。レポートの帰属表示と同じ書式にする。
 *
 * - 大きさは lineLayout.attributionSize（ポリシーが定める 12〜16sp の範囲のピクセル値）、色は
 *   lineColors.attribution（ポリシーが定める 3 色の 1 つ）を使う。caption と muted はどちらもポリシーの外にある
 * - 折り返さず、footer の中で 1 行を占めさせる。大きさを変える指定（adjustMode）は持たない
 */
function attributionText(): NotificationFlexText {
  return {
    type: 'text',
    text: ATTRIBUTION_TEXT,
    size: lineLayout.attributionSize,
    color: lineColors.attribution,
    wrap: false,
    align: 'center',
  };
}

/**
 * 変化を知らせる通知の Flex を組み立てる（1.6・8.1）。
 *
 * - 本文: 店舗名と変化の 1 文と、メニューの該当導線から確認できる旨の 1 文。1 文目を本文の段、2 文目を
 *   説明文の段で描き、主従を分ける。店舗名は省略せず折り返す
 * - footer: 帰属表示だけを置き、footer の上に線を引いて本文から切り離す（レポートと同じ）
 * - ボタンは置かない（誘導先はリッチメニュー）。毎日の定期配信を約束する語も使わない
 * - 組み立てたバブルが 30KB を超えたら FlexBubbleTooLargeError を投げる。上限に届くのは店舗名が
 *   極端に長いときだけで、壊れたメッセージを送らないために組立の失敗として呼出元へ返す
 * - changes に変化が 1 つも無いなど、判定（decideNotification）が作らない値は呼出元の誤りとして例外にする
 */
export function buildChangeNotification(storeName: string, changes: NotifiedChanges): FlexMessagePayload {
  assertBuildable(storeName, changes);

  const bubble: NotificationFlexBubble = {
    type: 'bubble',
    size: lineLayout.bubbleSize,
    styles: { footer: { separator: true } },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: lineLayout.itemGap,
      paddingAll: lineLayout.blockPadding,
      contents: [
        {
          type: 'text',
          text: changeSentence(storeName, changes),
          size: lineLayout.bodySize,
          color: lineColors.body,
          wrap: true,
        },
        {
          type: 'text',
          text: menuSentence(changes),
          size: lineLayout.descriptionSize,
          color: lineColors.description,
          wrap: true,
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: lineLayout.itemGap,
      paddingAll: lineLayout.blockPadding,
      contents: [attributionText()],
    },
  };

  // 送る JSON と同じく JSON.stringify で直した文字列の UTF-8 のバイト数で数える（仮名や漢字は 3 バイト）。
  const sizeBytes = new TextEncoder().encode(JSON.stringify(bubble)).byteLength;
  if (sizeBytes > FLEX_BUBBLE_MAX_BYTES) {
    throw new FlexBubbleTooLargeError(sizeBytes, FLEX_BUBBLE_MAX_BYTES);
  }

  return { type: 'flex', altText: buildAltText(storeName, changes), contents: bubble };
}
