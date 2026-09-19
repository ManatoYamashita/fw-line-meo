// 推移の期間の窓と、そこから導く要約・現在値・説明文・表示整形（store-detail-trend-dashboard task 2.1・Issue #265）。
//
// グラフ・期間要約・推移の表・現在値の 4 つは、ここで 1 回だけ切り出した窓から導く
// （同 spec の research.md の決定 D1、docs/design/design-language.md §7.19）。表示ごとに期間を切り出すと、
// 境界の計算が重複し、どれか 1 つだけがずれた状態を利用者は食い違った数字として読む。
//
// 窓の定義は要件 2.4 の定義文のとおりで、「推移データの最新の記録日を終点とし、終点を含めて遡った
// 暦日の日数」である。
// - 終点は、日付を解釈できる最新の記録日とする。今日の日付は使わない（日次の取得が止まった日は
//   古い終点のまま描き、現在値に日付を添えて補う）。
// - 始点は公称の始点（終点 − 期間の日数 + 1）であり、窓の中で最初に記録された日ではない。
//   値のある最初の日は、期間要約と説明文の「最初の記録」にだけ使う。
// - 日付は 'YYYY-MM-DD' を Date.UTC で日数に直して比べる。実行環境のタイムゾーンに依存しない。
//   解釈できない日付の点は窓に含めないので、4 つの表示すべてから同時に外れる。
//
// 値の無い日は 0 ではなく「値なし」（null）として扱う（要件 8.4）。評価は numeric の文字列で届くので
// 数値に直し、数値として読めない値と 0 以下の値も「値なし」にする。評価の定義域は 1.0〜5.0 で、
// 0 は旧 Go が評価の無い店に書いていたゼロ値である（@fwlm/db/daily-summary の formatRatingLabel と
// 同じ規則）。
//
// このモジュールはクライアントに同梱される（ts/eslint.config.js の store-detail のブロック）。依存は
// `./contract` の型だけにし、React・DOM・`@fwlm/db` の値に依存しない。`./data` と `./liff-auth` は
// サーバー側のモジュールなので参照しない。

import type { StoreDetailResponse } from './contract';

/** 推移の 1 点。応答契約から型だけを取り出す（lib/data.ts の StoreDetailTrendPoint と同じ型）。 */
type StoreDetailTrendPoint = StoreDetailResponse['trend'][number];

// --- 期間と指標 ------------------------------------------------------------------------

export type TrendMetric = 'rank' | 'rating' | 'reviewCount';
export type TrendPeriodDays = 7 | 30;

/** 期間の選択肢。保持の上限（30 日）を超えない。選択肢の札はこの並びで描く。 */
export const TREND_PERIODS: readonly TrendPeriodDays[] = [7, 30];
/** 指標の選択肢。選択肢の札はこの並びで描く。 */
export const TREND_METRICS: readonly TrendMetric[] = ['rank', 'rating', 'reviewCount'];
/** 画面を開いたときの期間（要件 2.3）。 */
export const DEFAULT_PERIOD: TrendPeriodDays = 30;
/** 画面を開いたときの指標（要件 2.3）。 */
export const DEFAULT_METRIC: TrendMetric = 'rank';

/** 期間の選択肢のどれかと厳密に等しい値か。文字列の '7' などは受け付けない（型の強制変換をしない）。 */
export function isTrendPeriod(value: unknown): value is TrendPeriodDays {
  return TREND_PERIODS.some((period) => period === value);
}

/** 指標の選択肢のどれかと厳密に等しい値か。 */
export function isTrendMetric(value: unknown): value is TrendMetric {
  return TREND_METRICS.some((metric) => metric === value);
}

// --- 日付 ------------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 'YYYY-MM-DD' を、1970-01-01 からの日数に直す。解釈できなければ null。
 *
 * 形式が合っていても、存在しない日付（2 月 30 日・13 月など）は null にする。Date.UTC は範囲外の
 * 日を翌月へ繰り越すので、組み立てた日付を読み戻して元の年月日と一致するかで判定する。
 */
function dayNumber(date: string): number | null {
  const match = ISO_DATE.exec(date);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return time / MS_PER_DAY;
}

/** dayNumber の逆。日数から 'YYYY-MM-DD' を作る。 */
function isoDateOf(days: number): string {
  return new Date(days * MS_PER_DAY).toISOString().slice(0, 10);
}

// --- 窓 --------------------------------------------------------------------------------

export interface TrendWindow {
  readonly periodDays: TrendPeriodDays;
  /** 窓に含まれる点（capturedOn 昇順）。表の行はこれをそのまま描く。 */
  readonly points: readonly StoreDetailTrendPoint[];
  /** 公称の始点（endDate − periodDays + 1）。points の先頭とは限らない。 */
  readonly startDate: string;
  /** 終点 = 日付を解釈できる最新の記録日（points の末尾）。 */
  readonly endDate: string;
}

/**
 * 推移から、期間の窓を切り出す。日付を解釈できる点が 1 つも無ければ null（推移 0 件と同じ扱い）。
 *
 * 前提: trend は capturedOn の昇順である（lib/data.ts の `ORDER BY captured_on ASC`）。窓の点は
 * 元の並びのまま取り出し、並べ替えない。入力の配列は書き換えない。
 */
export function selectTrendWindow(
  trend: readonly StoreDetailTrendPoint[],
  periodDays: TrendPeriodDays,
): TrendWindow | null {
  const dated = trend.flatMap((point) => {
    const days = dayNumber(point.capturedOn);
    return days === null ? [] : [{ point, days }];
  });
  if (dated.length === 0) {
    return null;
  }

  // 終点は日付を解釈できる最新の記録日。並びの位置ではなく日付で決めるので、末尾の要素が解釈できない
  // 日付でも、並びが崩れていても、窓の点が終点を超えることは無い（事後条件）。
  const end = dated.reduce((latest, entry) => (entry.days > latest.days ? entry : latest));

  // 終点を含めて遡った暦日 periodDays 日（days > 終点 − periodDays）。終点は最新なので上限の判定は要らない。
  const points = dated.filter((entry) => entry.days > end.days - periodDays).map((entry) => entry.point);

  return {
    periodDays,
    points,
    startDate: isoDateOf(end.days - periodDays + 1),
    endDate: end.point.capturedOn,
  };
}

// --- 指標の値と範囲 --------------------------------------------------------------------------

export interface DatedValue {
  readonly date: string;
  readonly value: number;
}

export interface MetricExtent {
  readonly metric: TrendMetric;
  /** 値のある最初の日・最後の日（最後の日の値が現在値）。 */
  readonly first: DatedValue | null;
  readonly last: DatedValue | null;
  /** 良い側・悪い側の極値。順位は小さいほど良い。評価とクチコミ数は大きいほど良い。 */
  readonly best: DatedValue | null;
  readonly worst: DatedValue | null;
  readonly recordedDays: number;
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

/**
 * 1 点から、指標の値を取り出す。値が無い日は null（0 にしない・要件 8.4）。
 *
 * - 順位・クチコミ数: 数値をそのまま返す。クチコミ数の 0 件は値である。
 * - 評価: numeric の文字列を数値に直す。数値として読めない値と 0 以下の値は、評価の無い日として null。
 */
export function metricValue(point: StoreDetailTrendPoint, metric: TrendMetric): number | null {
  switch (metric) {
    case 'rank':
      return finiteOrNull(point.rank);
    case 'reviewCount':
      return finiteOrNull(point.reviewCount);
    case 'rating': {
      if (point.rating === null) {
        return null;
      }
      const value = Number(point.rating);
      return Number.isFinite(value) && value > 0 ? value : null;
    }
  }
}

interface ValuedPoint {
  readonly point: StoreDetailTrendPoint;
  readonly value: number;
}

/** 窓の点のうち、指標の値がある点だけを元の順で並べる。要約と範囲はどちらもこれだけを読む。 */
function valuedPoints(window: TrendWindow, metric: TrendMetric): readonly ValuedPoint[] {
  return window.points.flatMap((point) => {
    const value = metricValue(point, metric);
    return value === null ? [] : [{ point, value }];
  });
}

function datedValue(entry: ValuedPoint | undefined): DatedValue | null {
  return entry === undefined ? null : { date: entry.point.capturedOn, value: entry.value };
}

/** a が b より良い値か（順位は小さいほど良く、評価とクチコミ数は大きいほど良い）。 */
function isBetter(metric: TrendMetric, a: number, b: number): boolean {
  return metric === 'rank' ? a < b : a > b;
}

/**
 * 窓の中で、指標の値がある最初・最後・最良・最悪の日と値、値のある日数を導く。
 * 同じ値が複数日にあるときは、最良と最悪に最も新しい日を採る（今の状態に近い日を示すため）。
 */
export function metricExtent(window: TrendWindow, metric: TrendMetric): MetricExtent {
  const entries = valuedPoints(window, metric);

  let best: ValuedPoint | undefined;
  let worst: ValuedPoint | undefined;
  for (const entry of entries) {
    // 同値でも置き換える（窓は昇順なので、後から来た同値の日が「最も新しい日」になる）。
    if (best === undefined || !isBetter(metric, best.value, entry.value)) {
      best = entry;
    }
    if (worst === undefined || !isBetter(metric, entry.value, worst.value)) {
      worst = entry;
    }
  }

  return {
    metric,
    first: datedValue(entries[0]),
    last: datedValue(entries.at(-1)),
    best: datedValue(best),
    worst: datedValue(worst),
    recordedDays: entries.length,
  };
}

// --- 期間要約 --------------------------------------------------------------------------

/** 既存の「表示期間の変化」の 3 組。値が無い組は null（画面は「—」を出す）。 */
export interface WindowSummary {
  readonly rank: { readonly first: number; readonly last: number } | null;
  readonly rating: { readonly first: string; readonly last: string } | null;
  readonly reviewCountDiff: number | null;
}

/**
 * 「表示期間の変化」の 3 組を、指標ごとに値のある最初と最後の日から作る（要件 3.4・3.5）。
 *
 * 評価は、推移の表と同じ文字列（応答の numeric の文字列）のまま返す。値のある日の判定は metricValue と
 * 同じなので、要約・グラフの説明文・現在値が同じ日を指す。
 */
export function summarizeWindow(window: TrendWindow): WindowSummary {
  const rank = valuedPoints(window, 'rank');
  const rating = valuedPoints(window, 'rating');
  const reviewCount = valuedPoints(window, 'reviewCount');

  const rankFirst = rank[0];
  const rankLast = rank.at(-1);
  const ratingFirst = rating[0]?.point.rating;
  const ratingLast = rating.at(-1)?.point.rating;
  const reviewCountFirst = reviewCount[0];
  const reviewCountLast = reviewCount.at(-1);

  return {
    rank: rankFirst !== undefined && rankLast !== undefined ? { first: rankFirst.value, last: rankLast.value } : null,
    rating: ratingFirst != null && ratingLast != null ? { first: ratingFirst, last: ratingLast } : null,
    reviewCountDiff:
      reviewCountFirst !== undefined && reviewCountLast !== undefined
        ? reviewCountLast.value - reviewCountFirst.value
        : null,
  };
}

// --- 表示整形 --------------------------------------------------------------------------

/** 指標名（グラフの題と説明文に使う）。 */
export function metricName(metric: TrendMetric): string {
  switch (metric) {
    case 'rank':
      return '順位';
    case 'rating':
      return '評価';
    case 'reviewCount':
      return 'クチコミ数';
  }
}

/** 値の表示（最新値と説明文）。評価に「★」を付けないのは、既存の「★」付きの評価の文言と重ねないため。 */
export function formatMetricValue(metric: TrendMetric, value: number): string {
  switch (metric) {
    case 'rank':
      return `${value}位`;
    case 'rating':
      return value.toFixed(1);
    case 'reviewCount':
      return `${value}件`;
  }
}

/** 縦軸の目盛りの表示。クチコミ数は単位を付けず、数だけを示す。 */
export function formatTickValue(metric: TrendMetric, value: number): string {
  switch (metric) {
    case 'rank':
      return `${value}位`;
    case 'rating':
      return value.toFixed(1);
    case 'reviewCount':
      return String(value);
  }
}

/** 'YYYY-MM-DD' の月と日を数値で取り出す。解釈できなければ null。 */
function monthAndDay(date: string): { readonly month: number; readonly day: number } | null {
  if (dayNumber(date) === null) {
    return null;
  }
  const [, month, day] = date.split('-');
  return { month: Number(month), day: Number(day) };
}

/** 短い日付（'9/13'）。グラフの横軸と最新値に使う。解釈できない日付は書き換えずに返す。 */
export function formatShortDate(date: string): string {
  const parts = monthAndDay(date);
  return parts === null ? date : `${parts.month}/${parts.day}`;
}

/**
 * 読み上げ用の日付（'9月13日'）。説明文だけに使う。'9/13' は読み上げの環境によって分数や記号として
 * 読まれるため、説明文では月と日を文字で書く。
 */
function formatSpokenDate(date: string): string {
  const parts = monthAndDay(date);
  return parts === null ? date : `${parts.month}月${parts.day}日`;
}

/**
 * グラフの名前にする説明文（要件 5.1）。値が 1 件も無ければ、その期間にその指標の記録が無いことを述べる。
 *
 * 含めるもの（この順）: 指標名、公称の期間の始点と終点、値のある最初と最後の記録、最高と最低、
 * 現在値とその日付。最高と最低は、順位なら小さい順位を最高とする（MetricExtent の best と worst）。
 * 順位の軸の向き（上ほど上位）は見た目の説明なので、ここではなく figcaption が持つ。
 */
export function describeMetric(window: TrendWindow, extent: MetricExtent): string {
  const name = metricName(extent.metric);
  const period = `${formatSpokenDate(window.startDate)}から${formatSpokenDate(window.endDate)}まで`;
  const { first, last, best, worst } = extent;
  if (first === null || last === null || best === null || worst === null) {
    return `${name}の推移、${period}。この期間は${name}の記録がありません。`;
  }
  const format = (value: number): string => formatMetricValue(extent.metric, value);
  return [
    `${name}の推移、${period}。`,
    `最初の記録は${format(first.value)}、最後の記録は${format(last.value)}。`,
    `最高は${format(best.value)}、最低は${format(worst.value)}。`,
    `最新は${format(last.value)}（${formatSpokenDate(last.date)}）。`,
  ].join('');
}
