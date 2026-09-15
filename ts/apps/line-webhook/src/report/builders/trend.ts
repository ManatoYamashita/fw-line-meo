// 直近の推移のレポート（design.md「Report builders（表示）」の TrendBuilder・
// Requirements 6.1–6.8, 8.3, 8.4, 8.5）。
//
// 最新の対象日（最新の日次集計の summary_date）を終点に、直近 7 暦日を日付の昇順に並べ、日ごとに次の 4 つへ分ける。
// - 比較可能: 競合比較可能な日（isComparableRow）。順位・評価・口コミ総数を出す
// - 比較不能: 取得には成功したが競合比較可能でない日（競合なし・評価を持つ競合なし・自店が未評価）。
//   順位を「—」にし、評価（未評価の日は「評価なし」）と口コミ総数を出す（6.8）
// - 取得失敗: 自店のデータを取得できなかった日。値を出さず「取得失敗」とする
// - 行なし: 日次集計が無い日（バッチが動かなかった日・登録前・30 日の窓の外）。値を出さず「データなし」とする
// 行の無い日と取得失敗の日を、前後の日の値で埋めない（6.4・8.4）。
//
// 本文は、上から次の順に並べる。
// - 期間の要約 1 行: 取得できた日（比較可能・比較不能の日）の最初と最後を端に、評価と口コミ総数の変化を出す。
//   順位の変化は、両端がどちらも比較可能なときだけ、順位母数を添えて出す。取得できた日が 2 日に満たなければ、
//   要約の代わりに、推移を判断するにはデータが不足している旨を出す（6.5）
// - 最新の日が取得失敗なら、その日付を添えた注記（取得失敗の案内と同じ語り・7.2）
// - 日付・順位・評価・口コミ数の表（6.2・6.3）。比較不能の日があれば、表の下に「—」の意味を添える
// footer には、詳細画面の 30 日の推移への導線（LIFF URL に店舗のヒントを付けたもの）と帰属表示を置く（6.6・8.1）。
//
// 評価のない店の扱いは Issue #255 の正規化（呼出元が normalizeReadRow で通す）と、`@fwlm/db/daily-summary` の
// 整形と文言だけで決める（8.5）。7 日の日付の列挙は Date.UTC と getUTC* だけで行い、実行環境の TZ に依存させない。

import { formatRatingLabel } from '@fwlm/db/daily-summary';
import { lineColors, lineLayout } from '@fwlm/design-tokens';
import type { LineMessage } from '../../line/client.js';
import type {
  FlexBoxComponent,
  FlexBoxContent,
  FlexButtonComponent,
  FlexTextComponent,
} from '../../line/flex-types.js';
import {
  buildReportBubble,
  formatDataDate,
  formatPeriod,
  isComparableRow,
  toReportMessage,
  type NormalizedReadRow,
  type ReportContext,
} from '../format.js';

/** 推移のレポートが並べる暦日の数（6.1）。 */
export const TREND_DAYS = 7;

/**
 * 要約を出すのに要る、取得できた日（有効な日次集計・6.5）の数。1 日だけでは変化を示せない。
 * 取得できた日は、比較可能な日と比較不能の日である（比較不能の日も評価と口コミ総数を持つ・6.8）。
 */
const MIN_VALID_DAYS = 2;

/** 推移の 1 日。比較不能・取得失敗・行なしの日は順位を持たない（6.4・6.8）。 */
export type TrendDay =
  | {
      readonly date: string;
      readonly kind: 'comparable';
      readonly rank: number;
      readonly rankTotal: number;
      readonly rating: string | null;
      readonly reviewCount: number | null;
    }
  | { readonly date: string; readonly kind: 'not_comparable'; readonly rating: string | null; readonly reviewCount: number | null }
  | { readonly date: string; readonly kind: 'failed' }
  | { readonly date: string; readonly kind: 'missing' };

type ComparableDay = Extract<TrendDay, { readonly kind: 'comparable' }>;

/** 取得できた日（有効な日次集計）。取得失敗の日と行の無い日は含めない。 */
type ValidDay = Extract<TrendDay, { readonly kind: 'comparable' | 'not_comparable' }>;

const TABLE_HEADINGS = ['日付', '順位', '評価', 'クチコミ数'] as const;
const MISSING_LABEL = 'データなし';
const FAILED_LABEL = '取得失敗';

/** 取得済みの値に無い欄の表記（8.4）。値を推測して埋めない。 */
const MISSING_VALUE = '—';

const INSUFFICIENT_NOTE = '取得できた日が2日分に満たないため、推移を判断するにはデータが不足しています。';
const NOT_COMPARABLE_NOTE = `順位が「${MISSING_VALUE}」の日は、競合店と比較できないため順位がありません。`;

/** 詳細画面への導線の文言。button の label は 40 文字まで（references/action-objects.md）。 */
const DETAIL_LINK_LABEL = '30日の推移を詳細画面で見る';

/** 詳細画面（store-detail）が表示対象のヒントとして読むクエリの名前。 */
const STORE_HINT_PARAM = 'storeId';

// --- 暦日 --------------------------------------------------------------------------
//
// データ対象日は日本時間の暦日の文字列 'YYYY-MM-DD' で届く。暦日を UTC の 0 時の時刻値に置いて数える。
// UTC には夏時間が無いので、1 日はいつも 24 時間であり、実行環境の TZ にも左右されない。

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 'YYYY-MM-DD' を、その暦日の UTC の 0 時の時刻値にする。暦日として正しくない値は例外にする。 */
function toUtcDay(date: string): number {
  const match = DATE_PATTERN.exec(date);
  if (match === null) {
    throw new Error(`invalid calendar date: ${JSON.stringify(date)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // 2 月 30 日のような値は Date.UTC が翌月へ繰り上げるので、組み立て直した暦日が元と一致するかで判定する。
  const time = Date.UTC(year, month - 1, day);
  const check = new Date(time);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`invalid calendar date: ${JSON.stringify(date)}`);
  }
  return time;
}

function fromUtcDay(time: number): string {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

// --- 日の分類 ----------------------------------------------------------------------

function classifyRow(date: string, row: NormalizedReadRow): TrendDay {
  if (row.status === 'failed') {
    return { date, kind: 'failed' };
  }
  if (isComparableRow(row) && row.rank !== null && row.rank_total !== null) {
    return {
      date,
      kind: 'comparable',
      rank: row.rank,
      rankTotal: row.rank_total,
      rating: row.rating,
      reviewCount: row.review_count,
    };
  }
  return { date, kind: 'not_comparable', rating: row.rating, reviewCount: row.review_count };
}

/**
 * 終点 endDate を含む days 暦日（endDate の days-1 日前から endDate まで）を、日付の昇順に分類する（6.1・6.3）。
 *
 * - endDate は最新の日次集計の summary_date である（今日や基準日ではない）。基準日から見た 30 日の窓の外の行は
 *   読み出し（listDailySummariesEndingAt）が返さないので、窓の外の日は「行なし」になる（6.7）
 * - 行は正規化済み（normalizeReadRow）であること。範囲の外の行は使わない。同じ日の行が複数あれば最初の行を使う
 *   （summary_date は店舗ごとに一意なので、通常は起こらない）
 * - 行の無い日は、前後の日の値を持ち込まずに「行なし」とする（6.4）
 * - endDate が暦日として正しくない値、days が 1 以上の整数でない値は、呼出元の誤りなので例外にする
 */
export function classifyTrendDays(endDate: string, rows: readonly NormalizedReadRow[], days: number): TrendDay[] {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`classifyTrendDays: days must be a positive integer, got ${days}`);
  }
  const end = toUtcDay(endDate);
  const rowsByDate = new Map<string, NormalizedReadRow>();
  for (const row of rows) {
    if (!rowsByDate.has(row.summary_date)) {
      rowsByDate.set(row.summary_date, row);
    }
  }

  const result: TrendDay[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = fromUtcDay(end - offset * DAY_MS);
    const row = rowsByDate.get(date);
    result.push(row === undefined ? { date, kind: 'missing' } : classifyRow(date, row));
  }
  return result;
}

// --- 詳細画面への導線 --------------------------------------------------------------

// uri アクションの uri は 1000 文字まで（references/action-objects.md）。
const URI_ACTION_MAX_LENGTH = 1000;
// RFC 3986 の文字（非予約文字・予約文字・百分率符号）だけでできた https の URL。LINE は URL が UTF-8 で
// 百分率符号化されていることを求めるので、空白・非 ASCII・逆斜線を含む値は使わない。
const HTTPS_URL_PATTERN = /^https:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
// 「%」の後に 16 進の 2 桁が続かない（百分率符号化として壊れている）。
const BROKEN_PERCENT_ENCODING = /%(?![0-9A-Fa-f]{2})/;

/**
 * value が uri アクションに使える https の絶対 URL なら、そのまま返す。使えなければ null を返す。
 *
 * LINE は部品の URL が 1 つでも不適合だとメッセージ全体を拒否するので、不適合な値は導線ごと落とす。
 * 規則は新着口コミのレポートの URL の検証と同じである（スキームの無い形・http・ホストを持たない値・
 * 利用者情報を含む値・上限を超える値を使わない。値を書き換えて救うことはしない）。
 */
function toHttpsUri(value: string): string | null {
  if (value.length > URI_ACTION_MAX_LENGTH || !HTTPS_URL_PATTERN.test(value) || BROKEN_PERCENT_ENCODING.test(value)) {
    return null;
  }
  const parsed = URL.parse(value);
  if (parsed === null || parsed.protocol !== 'https:' || parsed.hostname === '') {
    return null;
  }
  // 書かれたとおりの位置にホストがあること（`https:///…` のように解釈で補われた形と、利用者情報を除く）。
  return value.startsWith(`https://${parsed.host}`) ? value : null;
}

/**
 * 詳細画面（LIFF）の URL に、表示する店舗のヒント `?storeId=` を付ける（6.6）。
 *
 * - 既存のクエリは残し、`storeId` は 1 つに置き換える（store-detail は重複したヒントの最初の値を採るので、
 *   既存の値を残すと別の店舗を指しうる）。店舗 ID は符号化し、クエリを分断させない
 * - store-detail は、ヒントを認可済みの店舗の集合の内側でだけ解釈する。ヒントが届かなくても、単一店舗の
 *   オーナーには正しい店舗が、複数店舗のオーナーには選択画面が表示される（誤った店舗は表示されない）
 * - LIFF URL が https の絶対 URL でないとき（設定の誤り）は空文字を返す。buildTrendReport は空文字を
 *   使えない URL として扱い、導線を置かずにレポートを返す（不適合な uri で Reply 全体を拒否させない）
 * - 空の店舗 ID は呼出元の誤りなので例外にする
 */
export function storeDetailUrlFor(liffStoreDetailUrl: string, storeId: string): string {
  if (storeId === '') {
    throw new Error('storeDetailUrlFor: storeId must not be empty');
  }
  if (toHttpsUri(liffStoreDetailUrl) === null) {
    return '';
  }
  const url = new URL(liffStoreDetailUrl);
  url.searchParams.set(STORE_HINT_PARAM, storeId);
  return toHttpsUri(url.href) ?? '';
}

function buildDetailButton(uri: string): FlexButtonComponent {
  // 詳細画面への主導線は、旧来の日次カードとオンボーディング完了のバブルと同じ段と色にそろえる。
  return {
    type: 'button',
    style: 'primary',
    color: lineColors.action,
    height: lineLayout.actionHeight,
    action: { type: 'uri', label: DETAIL_LINK_LABEL, uri },
  };
}

// --- 値の表記 ----------------------------------------------------------------------

/** 比較可能な日の順位を、順位母数を添えて `5店中3位` と書く（表と要約で同じ表記にする）。 */
function formatRank(day: ComparableDay): string {
  return `${day.rankTotal}店中${day.rank}位`;
}

function isReviewCount(value: number | null): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** 口コミ総数を `N件` と書く。0 以上の整数でなければ「—」にする（値を補わない・8.4）。 */
function formatReviewCount(value: number | null): string {
  return isReviewCount(value) ? `${value}件` : MISSING_VALUE;
}

/** 口コミ総数の変化を `+5件`・`-2件`・`±0件` と書く。どちらかの値が読めなければ「—」にする。 */
function formatReviewCountChange(from: number | null, to: number | null): string {
  if (!isReviewCount(from) || !isReviewCount(to)) {
    return MISSING_VALUE;
  }
  const diff = to - from;
  if (diff === 0) {
    return '±0件';
  }
  return diff > 0 ? `+${diff}件` : `${diff}件`;
}

// --- 要約と注記 --------------------------------------------------------------------

interface TrendSummary {
  readonly first: ValidDay;
  readonly last: ValidDay;
}

function isValidDay(day: TrendDay): day is ValidDay {
  return day.kind === 'comparable' || day.kind === 'not_comparable';
}

/**
 * 要約の端。取得できた日の最初と最後である。取得できた日が 2 日に満たなければ null（6.5）。
 * 取得失敗の日と行の無い日は値を持たないので、端にしない（値を補わない・8.4）。
 */
function summaryOf(days: readonly TrendDay[]): TrendSummary | null {
  const valid = days.filter(isValidDay);
  const first = valid[0];
  const last = valid.at(-1);
  if (valid.length < MIN_VALID_DAYS || first === undefined || last === undefined) {
    return null;
  }
  return { first, last };
}

/**
 * 端の間の変化。評価（`★4.1→★4.2`・未評価の日は「評価なし」）と口コミ総数の差分は常に出す。
 *
 * 順位の変化は、両端がどちらも比較可能なときだけ出す（design.md の TrendBuilder）。片方でも比較不能なら、
 * 比べる順位が片側に無い。順位には表と同じく順位母数を添える（`5店中3位→4店中2位`）。母数は日によって
 * 変わる（競合の増減や、評価のない店を母数から除く正規化）ので、「3位→2位」だけでは上がったと読み違えうる。
 */
function summaryChanges({ first, last }: TrendSummary): string {
  const rank = first.kind === 'comparable' && last.kind === 'comparable' ? `${formatRank(first)}→${formatRank(last)}、` : '';
  return (
    rank +
    `${formatRatingLabel(first.rating)}→${formatRatingLabel(last.rating)}、` +
    `クチコミ数 ${formatReviewCountChange(first.reviewCount, last.reviewCount)}`
  );
}

/**
 * 期間の要約 1 行。端の日付を先頭に置く（期間の端が取得できなかった日なら、要約の端は期間の端と異なるため）。
 * 増減は色でなく矢印と符号で示す（docs/design/design-language.md §7.7）。
 */
function buildSummaryText(summary: TrendSummary): FlexTextComponent {
  return {
    type: 'text',
    text: `${formatDataDate(summary.first.date)}〜${formatDataDate(summary.last.date)}：${summaryChanges(summary)}`,
    weight: 'bold',
    size: lineLayout.bodySize,
    color: lineColors.body,
    wrap: true,
  };
}

/** 要約の代わりや、最新の取得失敗を知らせる文。本文の色で描く。 */
function statusText(text: string): FlexTextComponent {
  return { type: 'text', text, size: lineLayout.descriptionSize, color: lineColors.body, wrap: true };
}

/** 表に添える補足の注記。 */
function noteText(text: string): FlexTextComponent {
  return { type: 'text', text, size: lineLayout.descriptionSize, color: lineColors.description, wrap: true };
}

function latestFailedNote(date: string): string {
  return `最新のデータ（${formatDataDate(date)}分）を取得できませんでした。次のデータの更新の後に、もう一度ご確認ください。`;
}

// --- 表 ----------------------------------------------------------------------------
//
// 4 列を同じ幅で並べる。数値の列は右に寄せる（docs/design/design-language.md §7.2）。
// 値の欄は折り返しを許す。折り返さない text は幅を超えると省略記号で切られ、数字が欠けて読まれうる。

const VALUE_COLUMNS = TABLE_HEADINGS.length - 1;

function buildHeadingRow(): FlexBoxComponent {
  return {
    type: 'box',
    layout: 'horizontal',
    spacing: lineLayout.itemGap,
    contents: TABLE_HEADINGS.map(
      (text, index): FlexTextComponent => ({
        type: 'text',
        text,
        size: lineLayout.noteSize,
        color: lineColors.description,
        flex: 1,
        ...(index === 0 ? {} : { align: 'end' }),
      }),
    ),
  };
}

function valueCell(text: string): FlexTextComponent {
  return { type: 'text', text, size: lineLayout.descriptionSize, color: lineColors.body, flex: 1, align: 'end', wrap: true };
}

/** 値を持たない日（取得失敗・行なし）の欄。値の 3 列をまとめて 1 つの表記にし、数字を 1 つも置かない。 */
function statusCell(text: string): FlexTextComponent {
  return {
    type: 'text',
    text,
    size: lineLayout.descriptionSize,
    color: lineColors.description,
    flex: VALUE_COLUMNS,
    align: 'center',
  };
}

/** 日付の右に並べる欄。値は、その日の分類が持つものだけを使う（8.4）。 */
function dayCells(day: TrendDay): FlexTextComponent[] {
  switch (day.kind) {
    case 'comparable':
      return [
        valueCell(formatRank(day)),
        valueCell(formatRatingLabel(day.rating)),
        valueCell(formatReviewCount(day.reviewCount)),
      ];
    case 'not_comparable':
      // 順位の欄は「—」にする（6.8）。順位を持たないことを、欄を消さずに示す。
      return [valueCell(MISSING_VALUE), valueCell(formatRatingLabel(day.rating)), valueCell(formatReviewCount(day.reviewCount))];
    case 'failed':
      return [statusCell(FAILED_LABEL)];
    case 'missing':
      return [statusCell(MISSING_LABEL)];
  }
}

function buildDayRow(day: TrendDay): FlexBoxComponent {
  const date: FlexTextComponent = {
    type: 'text',
    text: formatDataDate(day.date),
    size: lineLayout.descriptionSize,
    color: lineColors.body,
    flex: 1,
  };
  return { type: 'box', layout: 'horizontal', spacing: lineLayout.itemGap, contents: [date, ...dayCells(day)] };
}

function buildTable(days: readonly TrendDay[]): FlexBoxComponent {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: lineLayout.itemGap,
    contents: [buildHeadingRow(), ...days.map(buildDayRow)],
  };
}

// --- レポート ----------------------------------------------------------------------

function altTextFor(ctx: ReportContext, start: string, end: string, days: number, summary: TrendSummary | null): string {
  const head = `${ctx.storeName}（${formatPeriod(start, end)}）`;
  return summary === null ? `${head}: 直近${days}日の推移` : `${head}: ${summaryChanges(summary)}`;
}

/**
 * 直近の推移のレポート（6.1）。見出しに店舗名と対象期間、footer に詳細画面への導線と帰属表示を置く
 * （6.2・6.6・8.1・8.3）。
 *
 * - days は classifyTrendDays の結果（日付の昇順）である。空の入力と昇順でない入力は例外にする
 * - latestFailed は最新の日次集計が取得失敗かどうかで、最新の日（days の最後）の分類と一致しなければ例外にする。
 *   食い違ったまま組み立てると、値を示す最新の行の上に「取得できませんでした」を出してしまう
 * - detailUrl は storeDetailUrlFor の結果である。uri アクションに使えない値（空文字を含む）なら導線を置かない
 *
 * 大きさは上限に届かない構成である（7 行の表と数行の文）。それでも超えるとき（極端に長い店舗名など）は
 * toReportMessage が FlexBubbleTooLargeError を投げる。
 */
export function buildTrendReport(
  ctx: ReportContext,
  days: readonly TrendDay[],
  latestFailed: boolean,
  detailUrl: string,
): LineMessage {
  const first = days[0];
  const last = days.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error('buildTrendReport: days must not be empty');
  }
  for (let index = 1; index < days.length; index += 1) {
    const previous = days[index - 1];
    const current = days[index];
    if (previous !== undefined && current !== undefined && previous.date >= current.date) {
      throw new Error('buildTrendReport: days must be in ascending order of date');
    }
  }
  if (latestFailed !== (last.kind === 'failed')) {
    throw new Error('buildTrendReport: latestFailed must match the classification of the latest day');
  }

  const summary = summaryOf(days);
  const body: FlexBoxContent[] = [
    summary === null ? statusText(INSUFFICIENT_NOTE) : buildSummaryText(summary),
    ...(latestFailed ? [statusText(latestFailedNote(last.date))] : []),
    buildTable(days),
    ...(days.some((day) => day.kind === 'not_comparable') ? [noteText(NOT_COMPARABLE_NOTE)] : []),
  ];
  const detailUri = toHttpsUri(detailUrl);
  const bubble = buildReportBubble({
    ctx,
    span: { kind: 'period', start: first.date, end: last.date },
    body,
    footerContents: detailUri === null ? [] : [buildDetailButton(detailUri)],
  });
  return toReportMessage(altTextFor(ctx, first.date, last.date, days.length, summary), bubble);
}
