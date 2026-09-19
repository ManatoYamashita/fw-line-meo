// 新着口コミのレポート（design.md「Report builders（表示）」の NewReviewsBuilder・
// Requirements 4.1–4.8, 8.2, 8.3, 8.4, 8.6, 8.7）。
//
// 本文の構成は、前日の集計の有無と新着件数で決まる。
// - 前日の集計が無い（review_count_prev が null）: 新着の件数を判定できない旨だけを出す（4.8）。
//   新着は前日の集計から増えた口コミなので（4.7）、前日が無い日は件数も抜粋も出さず、
//   「新着口コミはありません」とも言わない
// - 前日の集計があり、新着が 0 件: 「新着口コミはありません」（4.6）
// - 新着が 1 件以上: 新着件数、表示できる口コミを最大 3 件、表示していない残りの件数（4.2–4.4）。
//   表示できる口コミが 1 件も無ければ、件数と表示できない旨を出す（4.5）
//
// 表示できる口コミは、Google Maps 上の URL（https の絶対 URL）と投稿者名を持つものである（8.2・8.7）。
// そうでない口コミは内容を出さず、件数にだけ数える。口コミは評価で絞らず、並べ替えもしない。
// 低評価の口コミだけを隠す見せ方はレビューゲーティングに当たるため、日次集計に入っている順のまま出す。
//
// LINE は、部品の URL が 1 つでも不適合だとメッセージ全体を拒否する（画像の url は https、uri アクションは
// http・https・line・tel。references/flex-message.md・action-objects.md）。Go は Places API の URL を
// 加工せずに保存するので、ここでは https の絶対 URL だけを部品に使い（format.ts の toFlexHttpsUrl）、
// 不適合な値は無いものとして扱う。
//
// 投稿日時は日本時間の `M月D日 HH:mm` で書く。時刻の計算は Date.UTC と getUTC*、日本時間への変換は
// 固定の +9 時間で行い、実行環境の TZ に依存させない。

import type { DailySummaryNewReview } from '@fwlm/db';
import {
  GOOGLE_MAPS_LINK_TEXT as SHARED_GOOGLE_MAPS_LINK_TEXT,
  REVIEW_AUTHOR_LINK_LABEL,
  REVIEW_EXCERPTS_UNAVAILABLE_TEXT,
  isDisplayableNewReview,
} from '@fwlm/db/daily-summary';
import { lineColors, lineLayout } from '@fwlm/design-tokens';
import type { LineMessage } from '../../line/client.js';
import type {
  FlexBoxComponent,
  FlexBoxContent,
  FlexBubbleContents,
  FlexTextComponent,
} from '../../line/flex-types.js';
import {
  IMAGE_URL_MAX_LENGTH,
  URI_ACTION_MAX_LENGTH,
  buildReportBubble,
  fitText,
  fitsFlexBubbleLimit,
  formatDataDate,
  toFlexHttpsUrl,
  toReportMessage,
  type NormalizedReadRow,
  type ReportContext,
} from '../format.js';

/** 内容を出す口コミの最大件数（4.3）。 */
export const MAX_DISPLAYED_REVIEWS = 3;

/** 口コミの本文の最大の文字数（コードポイント）。超えた分は切り、全文は Google Maps への導線から開く。 */
export const REVIEW_TEXT_MAX_LENGTH = 300;

/** 口コミの本文を折り返して表示する最大の行数。 */
export const REVIEW_TEXT_MAX_LINES = 4;

/**
 * 口コミを Google Maps 上で表示する導線の文言。LIFF の詳細画面と同じ語を使う
 * （`@fwlm/db/daily-summary` が持ち、両方の面が同じ定数を読む）。
 */
export const GOOGLE_MAPS_LINK_TEXT = SHARED_GOOGLE_MAPS_LINK_TEXT;

const NO_NEW_REVIEWS_TEXT = '新着口コミはありません。';
const UNDETERMINABLE_TEXT = '前日のデータが無いため、新着口コミの件数を判定できません。';
const EXCERPTS_UNAVAILABLE_TEXT = REVIEW_EXCERPTS_UNAVAILABLE_TEXT;

/** 取得済みの値に無い欄の表記（8.4）。値を推測して埋めない。 */
const MISSING_VALUE = '—';

// 投稿者名のリンクの label。Flex の button 以外の部品では表示されないが、40 文字以内でなければならない
// （references/action-objects.md の Label Specifications）。LIFF の詳細画面と同じ語を使う。
const AUTHOR_LINK_LABEL = REVIEW_AUTHOR_LINK_LABEL;

// 投稿者の画像の大きさ。名前の左に置く最小の段で、LINE のキーワードを使う（design.md の Report builders）。
const AUTHOR_PHOTO_SIZE = 'xxs';

// --- 表示できる口コミ ----------------------------------------------------------------

interface DisplayableReview {
  readonly review: DailySummaryNewReview;
  /** 検証済みの Google Maps 上の URL。 */
  readonly googleMapsUri: string;
}

function selectDisplayable(reviews: readonly DailySummaryNewReview[]): DisplayableReview[] {
  const selected: DisplayableReview[] = [];
  for (const review of reviews) {
    // 導線（8.7）と投稿者名（8.2）の両方を併記できる口コミだけが、内容を出せる。評価は見ない。
    // この判定は LIFF の詳細画面と同じものを使う（`@fwlm/db/daily-summary`・Issue #287）。
    if (!isDisplayableNewReview(review)) {
      continue;
    }
    // LINE 固有の上限（uri アクションの文字数）だけを、共有の判定の上へ重ねる。
    const googleMapsUri = toFlexHttpsUrl(review.googleMapsUri, URI_ACTION_MAX_LENGTH);
    if (googleMapsUri !== null) {
      selected.push({ review, googleMapsUri });
    }
  }
  return selected;
}

/**
 * 内容を表示できる口コミ（Google Maps 上の https の URL と投稿者名を持つもの）を、入力の順のまま返す。
 * 評価では絞らない。
 */
export function displayableReviews(reviews: readonly DailySummaryNewReview[]): DailySummaryNewReview[] {
  return selectDisplayable(reviews).map(({ review }) => review);
}

// --- 投稿日時と星 ------------------------------------------------------------------

// RFC 3339 の日時。時差（Z か ±HH:MM）を必須にする。時差の無い日時は実行環境の TZ で読まれてしまう。
// 秒の小数（Go は最大 9 桁で書く）は読み捨てる。
const PUBLISH_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;
const MINUTE_MS = 60_000;
const JST_OFFSET_MINUTES = 9 * 60;

function numberAt(match: RegExpExecArray, index: number): number {
  return Number(match[index]);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 投稿日時（RFC 3339）を日本時間の `M月D日 HH:mm` にする。読めない値は null を返す（呼出元は「—」を出す）。
 * 年は書かない（新着は前日の集計から後の口コミである）。
 */
export function formatPublishTimeJst(publishTime: string): string | null {
  const match = PUBLISH_TIME_PATTERN.exec(publishTime);
  if (match === null) {
    return null;
  }
  const year = numberAt(match, 1);
  const month = numberAt(match, 2);
  const day = numberAt(match, 3);
  const hour = numberAt(match, 4);
  const minute = numberAt(match, 5);
  const second = numberAt(match, 6);
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  // 書かれた日時を UTC の上の壁時計として置き、暦日として正しいかを組み立て直して確かめる
  // （2 月 30 日のような値は Date.UTC が翌月へ繰り上げる）。
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wallClock);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }

  let offsetMinutes = 0;
  const sign = match[7];
  if (sign !== undefined) {
    const offsetHour = numberAt(match, 8);
    const offsetMinute = numberAt(match, 9);
    if (offsetHour > 23 || offsetMinute > 59) {
      return null;
    }
    offsetMinutes = (sign === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }

  // 壁時計から時差を引くと UTC、そこへ +9 時間を足すと日本時間の壁時計になる。読み出しは getUTC* だけを使う。
  const jst = new Date(wallClock + (JST_OFFSET_MINUTES - offsetMinutes) * MINUTE_MS);
  return `${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日 ${pad2(jst.getUTCHours())}:${pad2(jst.getUTCMinutes())}`;
}

/** 口コミの星を 5 つの記号で書く（★★★★☆）。1〜5 の数でなければ「—」にする（値を補わない・8.4）。 */
function formatReviewStars(rating: number): string {
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 1 || rating > 5) {
    return MISSING_VALUE;
  }
  const filled = Math.round(rating);
  return `${'★'.repeat(filled)}${'☆'.repeat(5 - filled)}`;
}

// --- 部品 --------------------------------------------------------------------------

function statusText(text: string): FlexTextComponent {
  return { type: 'text', text, size: lineLayout.bodySize, color: lineColors.body, wrap: true };
}

function noteText(text: string): FlexTextComponent {
  return { type: 'text', text, size: lineLayout.descriptionSize, color: lineColors.description, wrap: true };
}

/**
 * 投稿者の段。名前（プロフィールの URL があればリンク）と投稿日時を縦に並べ、プロフィール画像の URL が
 * あれば、その左に 1:1 の小さな画像を置く（8.2・8.6）。
 */
function buildAuthorRow(review: DailySummaryNewReview): FlexBoxComponent {
  const authorUri = toFlexHttpsUrl(review.authorUri, URI_ACTION_MAX_LENGTH);
  const photoUri = toFlexHttpsUrl(review.authorPhotoUri, IMAGE_URL_MAX_LENGTH);
  const name: FlexTextComponent = {
    type: 'text',
    text: review.authorName,
    weight: 'bold',
    size: lineLayout.descriptionSize,
    color: lineColors.body,
    wrap: true,
    ...(authorUri === null ? {} : { action: { type: 'uri', label: AUTHOR_LINK_LABEL, uri: authorUri } }),
  };
  const publishedAt: FlexTextComponent = {
    type: 'text',
    text: formatPublishTimeJst(review.publishTime) ?? MISSING_VALUE,
    size: lineLayout.noteSize,
    color: lineColors.description,
  };

  if (photoUri === null) {
    return { type: 'box', layout: 'vertical', contents: [name, publishedAt] };
  }
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: lineLayout.itemGap,
    contents: [
      // flex 0 で画像の幅を大きさの指定どおりにし、残りの幅を名前と日時の段に渡す。
      { type: 'image', url: photoUri, size: AUTHOR_PHOTO_SIZE, aspectRatio: '1:1', aspectMode: 'cover', flex: 0 },
      { type: 'box', layout: 'vertical', flex: 1, contents: [name, publishedAt] },
    ],
  };
}

/**
 * 1 件の口コミ。投稿者の段・星・本文・「Google Maps で見る」を並べる。星の値で構成を変えない。
 * withTexts が false なら本文を置かない（30KB を超えたときの組み直し）。本文が空の口コミも本文を置かない
 * （空の text を LINE へ送らない）。
 */
function buildReviewBlock({ review, googleMapsUri }: DisplayableReview, withTexts: boolean): FlexBoxComponent {
  const text = withTexts && review.textExcerpt.trim() !== '' ? fitText(review.textExcerpt, REVIEW_TEXT_MAX_LENGTH) : null;
  const contents: FlexBoxContent[] = [
    buildAuthorRow(review),
    { type: 'text', text: formatReviewStars(review.rating), size: lineLayout.descriptionSize, color: lineColors.body },
  ];
  if (text !== null) {
    contents.push({
      type: 'text',
      text,
      size: lineLayout.descriptionSize,
      color: lineColors.body,
      wrap: true,
      maxLines: REVIEW_TEXT_MAX_LINES,
    });
  }
  contents.push({
    type: 'text',
    text: GOOGLE_MAPS_LINK_TEXT,
    size: lineLayout.descriptionSize,
    color: lineColors.action,
    action: { type: 'uri', label: GOOGLE_MAPS_LINK_TEXT, uri: googleMapsUri },
  });
  return { type: 'box', layout: 'vertical', spacing: lineLayout.itemGap, contents };
}

function buildBody(row: NormalizedReadRow, withTexts: boolean): FlexBoxContent[] {
  if (row.review_count_prev === null) {
    return [statusText(UNDETERMINABLE_TEXT)];
  }
  const count = row.new_review_count;
  if (count <= 0) {
    return [statusText(NO_NEW_REVIEWS_TEXT)];
  }

  // 新着件数を超えては出さない（件数と表示を食い違わせない）。どれを出すかは入力の順だけで決める。
  const shown = selectDisplayable(row.new_reviews).slice(0, Math.min(MAX_DISPLAYED_REVIEWS, count));
  const countLine: FlexTextComponent = {
    type: 'text',
    text: `新着口コミ ${count}件（前日比）`,
    weight: 'bold',
    size: lineLayout.bodySize,
    color: lineColors.body,
    wrap: true,
  };
  if (shown.length === 0) {
    return [countLine, noteText(EXCERPTS_UNAVAILABLE_TEXT)];
  }

  // 残りには、内容を出せない口コミ（Google Maps 上の URL が無いもの）も数える。
  const remaining = count - shown.length;
  return [
    countLine,
    ...shown.map((item) => buildReviewBlock(item, withTexts)),
    ...(remaining > 0 ? [noteText(`表示していない新着口コミがほかに${remaining}件あります。`)] : []),
  ];
}

function altTextFor(ctx: ReportContext, row: NormalizedReadRow): string {
  const head = `${ctx.storeName}（${formatDataDate(row.summary_date)}時点）`;
  if (row.review_count_prev === null) {
    return `${head}: 新着口コミの件数を判定できません`;
  }
  if (row.new_review_count <= 0) {
    return `${head}: 新着口コミはありません`;
  }
  return `${head}: 新着口コミ ${row.new_review_count}件`;
}

// --- レポート ----------------------------------------------------------------------

export interface NewReviewsBubbleOptions {
  /** 口コミの本文を置くか。30KB を超えたときの組み直しで false にする。 */
  readonly withTexts: boolean;
}

/** 新着口コミのバブル。見出しに店舗名とデータ対象日、footer に帰属表示を置く（4.2・8.1・8.3）。 */
export function buildNewReviewsBubble(
  ctx: ReportContext,
  row: NormalizedReadRow,
  options: NewReviewsBubbleOptions,
): FlexBubbleContents {
  return buildReportBubble({
    ctx,
    span: { kind: 'date', date: row.summary_date },
    body: buildBody(row, options.withTexts),
  });
}

/**
 * 新着口コミのレポート（4.1）。30KB を超えるときは、口コミの本文を落として組み直す（design.md の
 * Error Handling）。それでも超えるときは toReportMessage が FlexBubbleTooLargeError を投げる。
 */
export function buildNewReviewsReport(ctx: ReportContext, row: NormalizedReadRow): LineMessage {
  const full = buildNewReviewsBubble(ctx, row, { withTexts: true });
  const bubble = fitsFlexBubbleLimit(full) ? full : buildNewReviewsBubble(ctx, row, { withTexts: false });
  return toReportMessage(altTextFor(ctx, row), bubble);
}
