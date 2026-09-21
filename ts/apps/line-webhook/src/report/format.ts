// レポート共通の表示部品（design.md「Report builders（表示）」の ReportFormat・Requirements 3.8, 8.1, 8.3）。
//
// 3 つのレポート（新着口コミ・競合店との比較・直近の推移）のビルダーと、店舗の選択肢・案内が共有する
// 部品を 1 か所に置く。
// - 正規化済みの行の型と、競合比較可能の判定
// - データ対象日と対象期間の表記（`M月D日`）
// - 見出し（店舗名とデータの時点）と、同じバブルの footer に置く帰属表示
// - 30KB の検証と、altText を上限に収めた Flex のメッセージ
// - 文字数を数えて書記素の境目で切る道具（選択肢のラベル・displayText・altText が使う）
// - Flex の部品に使える https の URL の検証（新着口コミの導線・画像と、推移の詳細画面への導線が使う）
//
// どれも DB にも LINE にも触れない純関数で、記録（ログ）も出さない。

import type { DailySummaryReadRow } from '@fwlm/db';
import { normalizeSummaryRatings, type NormalizedSummaryRatings } from '@fwlm/db/daily-summary';
import { lineColors, lineLayout } from '@fwlm/design-tokens';
import {
  ATTRIBUTION_TEXT,
  attributionFooter,
  buildAttributionText,
  withAttributionAltText,
} from '../line/attribution.js';
import type { LineMessage } from '../line/client.js';
import type { FlexBoxComponent, FlexBoxContent, FlexBubbleContents } from '../line/flex-types.js';
import { ALT_TEXT_MAX_LENGTH, ELLIPSIS, codePointLength, fitText, splitGraphemes } from '../line/text.js';

// --- LINE 面の基本部品の再公開 --------------------------------------------------------
//
// 文字数の数え方（line/text.ts）と帰属表示（line/attribution.ts）は、レポートだけでなく
// オンボーディングの案内も使うため LINE 面の基本部品として line/ にある。レポートのビルダーは
// 表示部品を本モジュールから 1 か所で取るので、ここでそのまま再公開する。
export { ALT_TEXT_MAX_LENGTH, ELLIPSIS, codePointLength, fitText, splitGraphemes };
export { ATTRIBUTION_TEXT, attributionFooter, buildAttributionText };

// --- 行 ----------------------------------------------------------------------------

/** 組立の文脈。店舗名は省略しない全文である（3.3・3.9）。 */
export interface ReportContext {
  readonly storeName: string;
}

/** Issue #255 の正規化を通した日次集計の行。レポートのビルダーはこの形だけを受け取る。 */
export type NormalizedReadRow = Omit<DailySummaryReadRow, keyof NormalizedSummaryRatings> & NormalizedSummaryRatings;

/**
 * 読み出した行に Issue #255 の正規化（`@fwlm/db/daily-summary` の normalizeSummaryRatings）を通す。
 * 評価 0 の既存データを未評価として読み、順位母数を補正する規則は、正規化の側だけが持つ（8.5）。
 */
export function normalizeReadRow(row: DailySummaryReadRow): NormalizedReadRow {
  return { ...row, ...normalizeSummaryRatings(row) };
}

/**
 * 競合比較可能か（要件の用語）。正規化後の行で、取得失敗でなく、自店の順位が値を持ち、順位母数が 2 以上
 * であること（design.md の Report builders）。
 *
 * 競合なし（no_competitors）の行は 1 店中 1 位、評価を持つ競合がいない行は母数 1、自店が未評価の行は
 * 正規化で順位が null になるので、どれも比較可能でない。
 */
export function isComparableRow(row: Pick<NormalizedReadRow, 'status' | 'rank' | 'rank_total'>): boolean {
  return row.status !== 'failed' && row.rank !== null && row.rank_total !== null && row.rank_total >= 2;
}

// --- 日付 --------------------------------------------------------------------------
//
// データ対象日は日本時間の暦日の文字列 'YYYY-MM-DD' で届く。日次集計の summary_date は Go が日本時間の
// 当日で書き、レポート用の読み出しが to_char で文字列にしている（@fwlm/db の report-reads）。
// そのため表記は文字列の組み替えだけで決まり、時刻の変換をしない。暦日として正しいかの確認には
// Date.UTC と getUTC* だけを使うので、実行環境の TZ に依存しない。

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseCalendarDate(date: string): { readonly month: number; readonly day: number } {
  const match = DATE_PATTERN.exec(date);
  if (match === null) {
    throw new Error(`invalid calendar date: ${JSON.stringify(date)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // 2 月 30 日のような値は Date.UTC が翌月へ繰り上げるので、組み立て直した暦日が元と一致するかで判定する。
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new Error(`invalid calendar date: ${JSON.stringify(date)}`);
  }
  return { month, day };
}

/**
 * データ対象日 'YYYY-MM-DD' を `M月D日` と書く（先頭のゼロを付けない）。
 * 暦日として正しくない値は、呼出元の誤りなので例外にする（誤った日付を黙って表示しない）。
 */
export function formatDataDate(date: string): string {
  const { month, day } = parseCalendarDate(date);
  return `${month}月${day}日`;
}

/**
 * 対象期間を `M月D日〜M月D日` と書く。年は書かない（30 日を超える古いデータは表示しないので、
 * 年をまたいでも取り違えない）。始点が終点より後なら例外にする。
 */
export function formatPeriod(start: string, end: string): string {
  const from = formatDataDate(start);
  const to = formatDataDate(end);
  // 'YYYY-MM-DD' は文字列の順が暦日の順と一致する（どちらも暦日として正しいことは確かめた）。
  if (start > end) {
    throw new Error(`invalid period: ${JSON.stringify(start)} is after ${JSON.stringify(end)}`);
  }
  return `${from}〜${to}`;
}

/** 見出しに置くデータの時点。3 つのレポートのうち、推移だけが対象期間を持つ。 */
export type ReportDataSpan =
  | { readonly kind: 'date'; readonly date: string }
  | { readonly kind: 'period'; readonly start: string; readonly end: string };

/**
 * データ対象日を「M月D日時点のデータ」、対象期間を「M月D日〜M月D日のデータ」と書く。
 * 閲覧した時点のライブデータと読まれないよう、どのレポートも見出しでデータの時点を示す（8.3）。
 */
export function formatDataSpan(span: ReportDataSpan): string {
  return span.kind === 'date'
    ? `${formatDataDate(span.date)}時点のデータ`
    : `${formatPeriod(span.start, span.end)}のデータ`;
}

// --- 見出しと帰属表示 --------------------------------------------------------------

/**
 * レポートの見出し（bubble の header）。店舗名と、続けてデータ対象日（推移は対象期間）を置く（3.8・8.3）。
 *
 * 店舗名は省略せず、折り返して全文を見せる（3.3・3.9）。折り返さない text は、容器の幅を超えると
 * LINE が省略記号で切る。見出しの段はオンボーディングの各バブルの見出しと同じ（太字の bodySize）にする。
 * 下端の余白だけを詰め、見出しを直下の本文へ近づける（旧来の日次カードの見出しと同じ）。
 */
export function buildReportHeader(ctx: ReportContext, span: ReportDataSpan): FlexBoxComponent {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: lineLayout.itemGap,
    paddingAll: lineLayout.blockPadding,
    paddingBottom: lineLayout.headerPaddingBottom,
    contents: [
      { type: 'text', text: ctx.storeName, weight: 'bold', size: lineLayout.bodySize, wrap: true },
      {
        type: 'text',
        text: formatDataSpan(span),
        size: lineLayout.descriptionSize,
        color: lineColors.description,
        wrap: true,
      },
    ],
  };
}

// --- URL ---------------------------------------------------------------------------
//
// LINE は、部品の URL が 1 つでも不適合だとメッセージ全体を拒否する（画像の url は https、uri アクションは
// http・https・line・tel。references/flex-message.md・action-objects.md）。レポートは https の絶対 URL だけを
// 部品に使い、不適合な値は無いものとして扱う（呼出元が導線や画像ごと落とす）。

/** uri アクションの uri の上限の文字数（references/action-objects.md）。 */
export const URI_ACTION_MAX_LENGTH = 1000;

/** 画像の url の上限の文字数（references/flex-message.md）。 */
export const IMAGE_URL_MAX_LENGTH = 2000;

// RFC 3986 の文字（非予約文字・予約文字・百分率符号）だけでできた https の URL。LINE は URL が UTF-8 で
// 百分率符号化されていることを求めるので、空白・非 ASCII・逆斜線を含む値は使わない。
const HTTPS_URL_PATTERN = /^https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
// 「%」の後に 16 進の 2 桁が続かない（百分率符号化として壊れている）。
const BROKEN_PERCENT_ENCODING = /%(?![0-9A-Fa-f]{2})/;

/**
 * value が LINE の部品に使える https の絶対 URL なら、そのまま返す。使えなければ null を返す。
 *
 * スキームの無い `//…`、http、javascript: などは使わない。ホストを持たない値、利用者情報を含む値、
 * 上限（maxLength）を超える値も使わない。値を書き換えて救うことはしない（別の URL へ変わりうる）。
 *
 * null も受ける。「取得できていない」は jsonb の項目では undefined、列では NULL として届き、どちらも
 * 同じ扱いだからである（`@fwlm/db/daily-summary` の toHttpsUrl と揃える・Issue #303）。
 */
export function toFlexHttpsUrl(value: string | null | undefined, maxLength: number): string | null {
  if (
    value === undefined ||
    value === null ||
    value.length > maxLength ||
    !HTTPS_URL_PATTERN.test(value) ||
    BROKEN_PERCENT_ENCODING.test(value)
  ) {
    return null;
  }
  const parsed = URL.parse(value);
  if (parsed === null || parsed.protocol !== 'https:' || parsed.hostname === '') {
    return null;
  }
  // 書かれたとおりの位置にホストがあること（`https:///…` のように解釈で補われた形と、利用者情報を除く）。
  return value.startsWith(`https://${parsed.host}`) ? value : null;
}

// --- バブルとメッセージ ------------------------------------------------------------

export interface ReportBubbleParts {
  readonly ctx: ReportContext;
  readonly span: ReportDataSpan;
  /** 本文の部品。上から順に並べる。 */
  readonly body: readonly FlexBoxContent[];
  /** footer の部品。帰属表示の上に順に並べる。 */
  readonly footerContents?: readonly FlexBoxContent[];
}

/**
 * レポートのバブル。kilo の幅に、見出し（店舗名とデータの時点）・本文・帰属表示の footer を組む。
 * header・body・footer は同じ内側余白を宣言する（docs/design/design-language.md §7.14）。
 * footer の上に線を引き、帰属表示を本文から切り離す（旧来の日次カードと同じ）。
 */
export function buildReportBubble(parts: ReportBubbleParts): FlexBubbleContents {
  return {
    type: 'bubble',
    size: lineLayout.bubbleSize,
    styles: { footer: { separator: true } },
    header: buildReportHeader(parts.ctx, parts.span),
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: lineLayout.sectionGap,
      paddingAll: lineLayout.blockPadding,
      contents: parts.body,
    },
    footer: attributionFooter(parts.footerContents),
  };
}

/**
 * バブルの JSON の大きさの上限（バイト）。
 *
 * LINE は上限を「30 KB」とだけ書き、JSON に直した後の大きさで数える（references/flex-message.md の Limits）。
 * 30 KB が 30,000 と 30,720 のどちらかは書かれていないので、小さい方を採る。大きい方が正しかった場合に
 * 失うのは 720 バイトの余裕だけだが、逆の場合は LINE が Reply 全体を拒否し、オーナーに何も届かない。
 */
export const FLEX_BUBBLE_MAX_BYTES = 30_000;

/**
 * バブルの大きさ（バイト）。送る JSON と同じく JSON.stringify で直した文字列の UTF-8 のバイト数である
 * （line/client.ts の reply は messages を JSON.stringify して送る）。仮名や漢字は 1 文字 3 バイト、
 * BMP の外の文字は 4 バイトになるので、文字数では数えない。
 */
export function flexBubbleByteLength(bubble: FlexBubbleContents): number {
  return new TextEncoder().encode(JSON.stringify(bubble)).byteLength;
}

/** バブルが上限の中に収まるか。上限を超える構成を組み直すビルダーは、組み直す前にこれで確かめる。 */
export function fitsFlexBubbleLimit(bubble: FlexBubbleContents): boolean {
  return flexBubbleByteLength(bubble) <= FLEX_BUBBLE_MAX_BYTES;
}

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

/**
 * 組み立てたバブルを、Reply で送る Flex のメッセージにする。
 *
 * - バブルの大きさを検証し、上限を超えたら FlexBubbleTooLargeError を投げる。上限に届かない構成にするのは
 *   各ビルダーの責務である（design.md の Error Handling）
 * - altText には、渡した本文の末尾に帰属表示を付ける（line/attribution.ts の withAttributionAltText）
 * - 本文が空なら例外にする（何のメッセージか分からない altText を送らない）
 */
export function toReportMessage(altText: string, bubble: FlexBubbleContents): LineMessage {
  if (altText.length === 0) {
    throw new Error('toReportMessage: altText must not be empty');
  }
  const sizeBytes = flexBubbleByteLength(bubble);
  if (sizeBytes > FLEX_BUBBLE_MAX_BYTES) {
    throw new FlexBubbleTooLargeError(sizeBytes, FLEX_BUBBLE_MAX_BYTES);
  }
  return { type: 'flex', altText: withAttributionAltText(altText), contents: bubble };
}
