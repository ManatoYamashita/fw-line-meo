// 推移グラフの縦軸と描画の幾何（store-detail-trend-dashboard task 2.2・Issue #265）。
//
// 縦軸は指標ごとに 1 本だけ持ち、1 つの軸に 2 つ以上の指標を載せない（要件 1.2。同 spec の research.md の
// 決定 D3、docs/design/design-language.md §7.18）。
// - 順位: 1 位を上端に置く反転軸。下端は、期間内の最大順位と当日の母数の大きい方（最低でも 2）。
//   目盛りは 1 と下端を必ず含み、間を切りのよい間隔の倍数で埋め、下端に近すぎる中間の目盛りは落とす。
// - 評価: 0.5 単位の範囲。幅が 1.0 未満なら中央を保って 1.0 へ広げ、1.0〜5.0 の中へ平行移動する。
//   小数第 1 位の変化を縦幅いっぱいに誇張しないため、軸の幅は星 1 つ分より狭くしない。
// - クチコミ数: 1・2・5 × 10 の累乗の間隔で、目盛りはすべて整数。下端は 0 で止める。
//
// 描画の幾何は、描画領域に対する百分率（0〜100、y は上端が 0）で返す。線の層は viewBox 0〜100 の SVG に、
// 点の層は viewBox を持たない SVG に、目盛りと日付は HTML の百分率の位置に置く（決定 D2）。
// - 横の位置は、窓の公称の始点から数えた暦日の番号で決める。記録が期間の日数に満たない店でも、横軸は
//   公称の期間に固定され、記録の無い区間は空白として見える。
// - 線分は、暦日で連続し、ともに値がある点の並びだけで作る。値の無い日（評価 0 を含む・要件 8.4）と
//   記録の無い日は、0 や前後の値で補わずに線を切る（要件 1.7・1.8）。
// - 印は、端点（期間内の最新の値）と孤立点（前後どちらとも結ばれない値）に置く。期間が
//   ALL_MARKERS_MAX_DAYS 日以下なら、すべての値に置く（決定 D4・要件 1.6・1.14）。
//
// 日付は 'YYYY-MM-DD' を Date.UTC で日数に直して数える。実行環境のタイムゾーンに依存しない。
//
// このモジュールはクライアントに同梱される（ts/eslint.config.js の store-detail のブロック）。依存は
// `./trend-view` だけにし、React・DOM・`@fwlm/db` の値に依存しない。

import { metricValue, type MetricExtent, type TrendMetric, type TrendWindow } from './trend-view';

// --- 縦軸 ------------------------------------------------------------------------------

export interface AxisScale {
  readonly lo: number;
  readonly hi: number;
  /** true なら lo を上端に描く（順位）。 */
  readonly inverted: boolean;
  /** 目盛りの値（lo から hi へ昇順）。 */
  readonly ticks: readonly number[];
}

/**
 * 順位とクチコミ数の間隔を選ぶときの、「範囲 ÷ 間隔」の上限。320px 幅の固定高の描画領域で、目盛りの文字が
 * 重ならない数にする。
 * - クチコミ数: 範囲を間隔の倍数へ丸めるので、これが目盛りの区間の数の上限そのものになる。
 * - 順位: （下端 − 1）÷ 間隔 の上限である。中間の目盛りは 0 から数えた間隔の倍数で、そこへ 1 と下端を
 *   加えるので、目盛りの区間は最大 5 つになる（下端 9 位なら 1・2・4・6・8・9 位）。
 */
const MAX_INTERVALS = 4;
/** 切りのよい間隔の仮数（1・2・5 × 10 の累乗）。 */
const NICE_FACTORS = [1, 2, 5] as const;

/** 評価の範囲の定義域と、軸の最小の幅（星 1 つ分）。 */
const RATING_MIN = 1;
const RATING_MAX = 5;
const RATING_MIN_SPAN = 1;
/** 評価の目盛りを 0.5 刻みにする幅の上限。これを超えると 1.0 刻みにする。 */
const RATING_FINE_SPAN_MAX = 2;
/** 評価の計算で使う半単位（0.5 を 1 とする整数）の、星 1 つあたりの数。 */
const HALVES_PER_STAR = 2;

/** 順位の軸の下端の最小値（1 位だけの軸は範囲を持てないため）。 */
const RANK_MIN_BOTTOM = 2;

/**
 * 1・2・5 × 10 の累乗の間隔のうち、`fits` を満たす最小のものを返す。間隔は 1 以上（目盛りを整数にする）。
 * 入力が有限なら必ず見つかる。念のため、累乗が有限でなくなったら探索を打ち切る。
 */
function niceStep(fits: (step: number) => boolean): number {
  let step = 1;
  for (let magnitude = 1; Number.isFinite(magnitude); magnitude *= 10) {
    for (const factor of NICE_FACTORS) {
      step = factor * magnitude;
      if (fits(step)) {
        return step;
      }
    }
  }
  return step;
}

/** 下端から上端まで、間隔ごとの目盛りを並べる（下端と上端は間隔の倍数である前提）。 */
function evenTicks(lo: number, hi: number, step: number): number[] {
  const ticks: number[] = [];
  for (let index = 0; lo + step * index <= hi; index += 1) {
    ticks.push(lo + step * index);
  }
  return ticks;
}

/**
 * 順位の軸。上端は 1 位に固定し、下端は期間内の最大順位と母数の大きい方（最低でも 2）にする。
 *
 * 目盛りは 1 と下端を必ず含む。間隔は、（下端 − 1）÷ 間隔 が MAX_INTERVALS 以下になる最小の切りのよい
 * 値にし、間をその倍数で埋める（1 位から数えるのではなく 0 から数えるので、間隔 5 なら 5・10・15 位に
 * なる）。そこへ 1 と下端を加えるので、目盛りの区間は最大 5 つになる。下端との差が間隔の半分未満の
 * 中間の目盛りは、下端の目盛りと文字が重なるので落とす。
 */
function rankScale(worstRank: number, rankTotal: number | null): AxisScale {
  const total = rankTotal !== null && Number.isFinite(rankTotal) ? rankTotal : 0;
  const hi = Math.ceil(Math.max(worstRank, total, RANK_MIN_BOTTOM));
  const lo = 1;
  const step = niceStep((candidate) => (hi - lo) / candidate <= MAX_INTERVALS);

  const middle: number[] = [];
  for (let tick = step; tick < hi; tick += step) {
    if (tick > lo && hi - tick >= step / 2) {
      middle.push(tick);
    }
  }
  return { lo, hi, inverted: true, ticks: [lo, ...middle, hi] };
}

/**
 * 評価の軸。計算は 0.5 を 1 とする整数（半単位）で行い、浮動小数点の誤差を目盛りに持ち込まない。
 *
 * 1. 値の範囲を 0.5 単位へ外側に丸める。
 * 2. 幅が 1.0 未満なら、値の中央を保って幅 1.0 へ広げる。0.5 単位に揃えるため、下端は中央 − 0.5 に
 *    最も近い 0.5 の倍数にする（値は必ず範囲に入る）。
 * 3. 1.0〜5.0 の中へ平行移動する（上端に張りつく 4.9〜5.0 は 4.0〜5.0 になる）。
 * 4. 幅が 2.0 以下なら 0.5 刻み、超えるなら 1.0 刻みにする。1.0 刻みのときは、目盛りが両端に来るよう
 *    範囲を 1.0 単位へ外側に丸める（1.0 と 5.0 は整数なので、丸めても定義域の外へ出ない）。
 */
function ratingScale(min: number, max: number): AxisScale {
  const floorHalves = RATING_MIN * HALVES_PER_STAR;
  const ceilHalves = RATING_MAX * HALVES_PER_STAR;
  const minSpanHalves = RATING_MIN_SPAN * HALVES_PER_STAR;

  let lo = Math.floor(min * HALVES_PER_STAR);
  let hi = Math.ceil(max * HALVES_PER_STAR);
  if (hi - lo < minSpanHalves) {
    // (min + max) / 2 − 0.5 を半単位で表すと min + max − 1 になる。
    lo = Math.round(min + max - RATING_MIN_SPAN);
    hi = lo + minSpanHalves;
  }
  if (lo < floorHalves) {
    hi += floorHalves - lo;
    lo = floorHalves;
  }
  if (hi > ceilHalves) {
    lo -= hi - ceilHalves;
    hi = ceilHalves;
  }
  // 値が定義域の外にあると、平行移動の後も下端が 1.0 を割りうる。定義域の外へは広げない（要件 1.4）。
  lo = Math.max(lo, floorHalves);

  const stepHalves = hi - lo <= RATING_FINE_SPAN_MAX * HALVES_PER_STAR ? 1 : HALVES_PER_STAR;
  lo = Math.floor(lo / stepHalves) * stepHalves;
  hi = Math.ceil(hi / stepHalves) * stepHalves;

  return {
    lo: lo / HALVES_PER_STAR,
    hi: hi / HALVES_PER_STAR,
    inverted: false,
    ticks: evenTicks(lo, hi, stepHalves).map((halves) => halves / HALVES_PER_STAR),
  };
}

/**
 * クチコミ数の軸。間隔は 1・2・5 × 10 の累乗から、範囲をその倍数へ丸めたときに区間が 4 つ以下になる
 * 最小のものを選ぶ。値がすべて同じなら上下に 1 間隔ずつ広げ、下端は 0 で止める（件数は負にならない。
 * 全日 0 件の店は 0〜1 になる）。
 */
function reviewCountScale(min: number, max: number): AxisScale {
  const step = niceStep((candidate) => Math.ceil(max / candidate) - Math.floor(min / candidate) <= MAX_INTERVALS);
  let lo = Math.floor(min / step) * step;
  let hi = Math.ceil(max / step) * step;
  if (lo === hi) {
    lo -= step;
    hi += step;
  }
  lo = Math.max(lo, 0);
  return { lo, hi, inverted: false, ticks: evenTicks(lo, hi, step) };
}

/**
 * 指標の範囲から縦軸を決める。値が 1 件も無ければ null（グラフの代わりに文言を出す・要件 1.10）。
 *
 * 範囲の最小と最大は、最良と最悪の値から取る（どちらが大きいかは指標によって違うので、向きに依らず
 * 小さい方と大きい方を取る）。値が有限でなければ、値が無いものとして null を返す（無限大や NaN を
 * 軸の端や目盛りに持ち込まない）。
 */
export function scaleFor(
  extent: MetricExtent,
  context: { readonly rankTotal: number | null },
): AxisScale | null {
  const { best, worst } = extent;
  if (best === null || worst === null || !Number.isFinite(best.value) || !Number.isFinite(worst.value)) {
    return null;
  }
  const min = Math.min(best.value, worst.value);
  const max = Math.max(best.value, worst.value);

  switch (extent.metric) {
    case 'rank':
      return rankScale(max, context.rankTotal);
    case 'rating':
      return ratingScale(min, max);
    case 'reviewCount':
      return reviewCountScale(min, max);
  }
}

// --- 描画の幾何 --------------------------------------------------------------------------

/** x・y は描画領域に対する百分率（0〜100、y は上端が 0）。 */
export interface PlotPoint {
  readonly date: string;
  readonly value: number;
  readonly x: number;
  readonly y: number;
}

/**
 * すべての値に印を置く期間の日数の上限。320px 幅の描画領域（約 190px）で、10 日（区間 9）なら点の間隔が
 * 約 21px になり、印（8px）と端点の輪（2px）を置いても隙間が残る（決定 D4）。
 */
export const ALL_MARKERS_MAX_DAYS = 10;

export interface ChartGeometry {
  /** 線分（暦日で連続し、ともに値がある 2 点以上の並び）。 */
  readonly segments: readonly (readonly PlotPoint[])[];
  /** 印を置く点。端点は含めない（端点は end として、地色の輪を付けて描く）。 */
  readonly markers: readonly PlotPoint[];
  /** 端点（期間内で値のある最も新しい点。現在値と同じ日と値）。 */
  readonly end: PlotPoint;
  readonly ticks: readonly { readonly value: number; readonly y: number }[];
  /** 横軸の日数（= 窓の期間の日数）。 */
  readonly spanDays: number;
}

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 'YYYY-MM-DD' を、1970-01-01 からの日数に直す。解釈できなければ null。
 *
 * trend-view の窓と同じ規則で読む（形式が合っていても、存在しない日付は null）。窓の点は、窓を
 * 切り出す時点で解釈できる日付だけに絞られている。
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

/** 百分率を 0〜100 に収める。軸の外の値（定義域の外の評価など）は端に寄せて描く。 */
function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** 値の縦の位置。反転軸（順位）は lo が上端、そうでなければ hi が上端。 */
function yOf(scale: AxisScale, value: number): number {
  const fromTop = scale.inverted ? value - scale.lo : scale.hi - value;
  return clampPercent((fromTop / (scale.hi - scale.lo)) * 100);
}

interface IndexedPoint {
  /** 公称の始点から数えた暦日の番号（0 から periodDays − 1）。 */
  readonly day: number;
  readonly plot: PlotPoint;
}

/**
 * 窓の点を、描画領域の百分率座標へ写す。窓の中に指標の値が 1 件も無ければ null。
 *
 * 窓の点は capturedOn の昇順である（trend-view の前提）。端点は値のある最後の点で、metricExtent の
 * last（現在値）と同じ点になる。窓の事前条件が崩れて、公称の期間の外の日付や解釈できない日付の点が
 * 入っていても、それらは描かない（座標を 0〜100 の外へ出さない）。
 */
export function buildGeometry(window: TrendWindow, metric: TrendMetric, scale: AxisScale): ChartGeometry | null {
  const start = dayNumber(window.startDate);
  if (start === null) {
    return null;
  }
  const lastDay = window.periodDays - 1;

  const plotted: IndexedPoint[] = [];
  for (const point of window.points) {
    const value = metricValue(point, metric);
    const days = dayNumber(point.capturedOn);
    if (value === null || days === null) {
      continue;
    }
    const day = days - start;
    if (day < 0 || day > lastDay) {
      continue;
    }
    plotted.push({
      day,
      plot: { date: point.capturedOn, value, x: (day / lastDay) * 100, y: yOf(scale, value) },
    });
  }

  const end = plotted.at(-1);
  if (end === undefined) {
    return null;
  }

  // 暦日で連続する値の並び（翌日に値がある間だけ伸びる）。値の無い日と記録の無い日で切れる。
  const runs: IndexedPoint[][] = [];
  for (const entry of plotted) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (run !== undefined && previous !== undefined && entry.day - previous.day === 1) {
      run.push(entry);
    } else {
      runs.push([entry]);
    }
  }

  const markAll = window.periodDays <= ALL_MARKERS_MAX_DAYS;
  const markers = runs
    .filter((run) => markAll || run.length === 1)
    .flat()
    .filter((entry) => entry !== end)
    .map((entry) => entry.plot);

  return {
    segments: runs.filter((run) => run.length >= 2).map((run) => run.map((entry) => entry.plot)),
    markers,
    end: end.plot,
    ticks: scale.ticks.map((value) => ({ value, y: yOf(scale, value) })),
    spanDays: window.periodDays,
  };
}
