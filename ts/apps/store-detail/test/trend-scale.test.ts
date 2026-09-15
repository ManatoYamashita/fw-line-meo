// store-detail-trend-dashboard task 2.2（Issue #265）: 指標ごとの縦軸と、描画の幾何を決める純関数
// （lib/trend-scale.ts）を検証する。
//
// 軸の規則は research.md の決定 D3、印の規則は決定 D4 のとおりである。
// - 順位は 1 位を上端に置く反転軸にし、下端は期間内の最大順位と当日の母数の大きい方（最低でも 2）にする。
// - 評価は 0.5 単位の範囲で、幅は 1.0 以上、範囲は 1.0〜5.0 の中に収める。
// - クチコミ数は整数の切りのよい目盛りで、下端は 0 で止める。
// - 横の位置は公称の始点から数えた暦日の番号で決め、線分は暦日で連続し、ともに値がある日だけで作る。
// - 印は端点と孤立点に置き、期間が 10 日以下なら全点に置く。
//
// 期待する範囲・目盛り・日付は、実装と同じ計算で作らずリテラルで書く。同じ計算で期待値を作ると、
// 計算の誤りが両側で打ち消し合って検査が緑のまま素通りするためである。横の位置だけは、設計が定める式
// （日の番号 ÷ (期間の日数 − 1) × 100）で書く。
//
// このファイルは node 環境で走る（DOM を使わない）。
import { describe, expect, it } from 'vitest';

import type { StoreDetailTrendPoint } from '../lib/data';
import {
  ALL_MARKERS_MAX_DAYS,
  buildGeometry,
  scaleFor,
  type AxisScale,
  type ChartGeometry,
  type PlotPoint,
} from '../lib/trend-scale';
import {
  TREND_METRICS,
  TREND_PERIODS,
  metricExtent,
  metricValue,
  selectTrendWindow,
  type MetricExtent,
  type TrendMetric,
  type TrendPeriodDays,
  type TrendWindow,
} from '../lib/trend-view';

// --- テスト用の点と窓 --------------------------------------------------------------------

/** 既定では 3 指標とも値を持つ点。上書きした項目だけが変わる。 */
function point(
  capturedOn: string,
  values: Partial<Omit<StoreDetailTrendPoint, 'capturedOn'>> = {},
): StoreDetailTrendPoint {
  return { capturedOn, rank: 3, rating: '4.3', reviewCount: 120, ...values };
}

/** 1 つの指標にだけ値を置いた点。評価は応答と同じ小数 1 桁の文字列にする。 */
function valuePoint(capturedOn: string, metric: TrendMetric, value: number | null): StoreDetailTrendPoint {
  switch (metric) {
    case 'rank':
      return point(capturedOn, { rank: value });
    case 'rating':
      return point(capturedOn, { rating: value === null ? null : value.toFixed(1) });
    case 'reviewCount':
      return point(capturedOn, { reviewCount: value });
  }
}

/** 2026 年 8 月の日付（入力を作るためだけに使う）。 */
function augustDate(day: number): string {
  return `2026-08-${String(day).padStart(2, '0')}`;
}

/** 8 月 1 日から 1 日 1 つずつ値を置いた推移。null は値の無い日（最大 31 日）。 */
function augustSeries(metric: TrendMetric, values: readonly (number | null)[]): StoreDetailTrendPoint[] {
  return values.map((value, i) => valuePoint(augustDate(i + 1), metric, value));
}

function mustWindow(trend: readonly StoreDetailTrendPoint[], periodDays: TrendPeriodDays): TrendWindow {
  const window = selectTrendWindow(trend, periodDays);
  if (window === null) {
    throw new Error('窓が null になりました（日付を解釈できる点があるはずです）');
  }
  return window;
}

/** 値の並びから、実際の窓（30 日）を通して指標の範囲を作る。 */
function extentOf(metric: TrendMetric, values: readonly (number | null)[]): MetricExtent {
  return metricExtent(mustWindow(augustSeries(metric, values), 30), metric);
}

/** 値の並びから軸を作り、null でないことを確かめてから返す。 */
function mustScale(metric: TrendMetric, values: readonly (number | null)[], rankTotal: number | null = null): AxisScale {
  const scale = scaleFor(extentOf(metric, values), { rankTotal });
  if (scale === null) {
    throw new Error(`${metric} の軸が null になりました（値があるはずです）`);
  }
  return scale;
}

interface Drawn {
  readonly window: TrendWindow;
  readonly scale: AxisScale;
  readonly geometry: ChartGeometry;
}

/** 推移から窓・軸・幾何を作り、どれも null でないことを確かめてから返す。 */
function draw(
  trend: readonly StoreDetailTrendPoint[],
  periodDays: TrendPeriodDays,
  metric: TrendMetric,
  rankTotal: number | null = null,
): Drawn {
  const window = mustWindow(trend, periodDays);
  const scale = scaleFor(metricExtent(window, metric), { rankTotal });
  if (scale === null) {
    throw new Error(`${metric} の軸が null になりました（値があるはずです）`);
  }
  const geometry = buildGeometry(window, metric, scale);
  if (geometry === null) {
    throw new Error(`${metric} の幾何が null になりました（値があるはずです）`);
  }
  return { window, scale, geometry };
}

function segmentDates(geometry: ChartGeometry): readonly (readonly string[])[] {
  return geometry.segments.map((segment) => segment.map((p) => p.date));
}

function markerDates(geometry: ChartGeometry): readonly string[] {
  return geometry.markers.map((p) => p.date);
}

/** 幾何が描くすべての点（線分・印・端点）。 */
function allPlotted(geometry: ChartGeometry): readonly PlotPoint[] {
  return [...geometry.segments.flat(), ...geometry.markers, geometry.end];
}

/** 数の並びが、それぞれ近い値であることを確かめる（浮動小数点の誤差を許す）。 */
function expectCloseAll(actual: readonly number[], expected: readonly number[], label = ''): void {
  expect(actual, label).toHaveLength(expected.length);
  expected.forEach((value, i) => {
    expect(actual[i], `${label}[${i}]`).toBeCloseTo(value, 9);
  });
}

/** 期間の日数が N のとき、日の番号 i の横の位置（設計の式）。 */
function xAt(index: number, periodDays: TrendPeriodDays): number {
  return (index / (periodDays - 1)) * 100;
}

// --- 縦軸: 共通 ------------------------------------------------------------------------

describe('scaleFor: 指標ごとの縦軸（要件 1.2）', () => {
  it('値が 1 件も無い指標では null を返す（グラフの代わりに文言を出す）', () => {
    const window = mustWindow([point('2026-09-12', { rank: null, rating: null, reviewCount: null })], 7);

    for (const metric of TREND_METRICS) {
      expect(scaleFor(metricExtent(window, metric), { rankTotal: 6 }), metric).toBeNull();
    }
  });

  it('同じ推移でも、指標ごとにその指標の値だけから別の軸を作る', () => {
    const trend = [
      point('2026-09-11', { rank: 2, rating: '4.1', reviewCount: 100 }),
      point('2026-09-12', { rank: 5, rating: '4.4', reviewCount: 130 }),
    ];
    const window = mustWindow(trend, 7);

    expect(scaleFor(metricExtent(window, 'rank'), { rankTotal: null })).toEqual({
      lo: 1,
      hi: 5,
      inverted: true,
      ticks: [1, 2, 3, 4, 5],
    });
    expect(scaleFor(metricExtent(window, 'rating'), { rankTotal: null })).toEqual({
      lo: 4,
      hi: 5,
      inverted: false,
      ticks: [4, 4.5, 5],
    });
    expect(scaleFor(metricExtent(window, 'reviewCount'), { rankTotal: null })).toEqual({
      lo: 100,
      hi: 130,
      inverted: false,
      ticks: [100, 110, 120, 130],
    });
  });

  it('値が有限でない範囲は、値が無いものとして null を返す（無限大や NaN を軸に持ち込まない）', () => {
    const endless = { date: '2026-09-13', value: Number.POSITIVE_INFINITY };
    const finite = { date: '2026-09-12', value: 3 };
    for (const metric of TREND_METRICS) {
      const extent: MetricExtent = { metric, first: finite, last: endless, best: endless, worst: finite, recordedDays: 2 };
      expect(scaleFor(extent, { rankTotal: null }), metric).toBeNull();
    }
  });
});

// --- 縦軸: 順位 ------------------------------------------------------------------------

describe('scaleFor: 順位の軸（要件 1.3）', () => {
  it('1 位を上端に置く反転軸になる', () => {
    const scale = mustScale('rank', [2, 3, 4], 6);

    expect(scale.inverted).toBe(true);
    expect(scale.lo).toBe(1);
    expect(scale.ticks[0]).toBe(1);
  });

  it('下端は、当日の母数が期間内の最大順位より大きければ母数になる', () => {
    expect(mustScale('rank', [2, 3, 4], 6).hi).toBe(6);
  });

  it('下端は、期間内の最大順位が当日の母数より大きければ最大順位になる', () => {
    const scale = mustScale('rank', [2, 8, 3], 6);

    expect(scale.hi).toBe(8);
    expect(scale.ticks.at(-1)).toBe(8);
  });

  it('母数が無い（null）ときは、期間内の最大順位だけで下端を決める', () => {
    expect(mustScale('rank', [2, 4, 3], null)).toEqual({ lo: 1, hi: 4, inverted: true, ticks: [1, 2, 3, 4] });
  });

  it('母数が有限の数でないときも、母数が無いものとして扱う', () => {
    for (const rankTotal of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(mustScale('rank', [2, 4, 3], rankTotal).hi, String(rankTotal)).toBe(4);
    }
  });

  it('下端は最低でも 2 にする（全日 1 位でも、母数が 1 以下でも）', () => {
    expect(mustScale('rank', [1, 1, 1], null)).toEqual({ lo: 1, hi: 2, inverted: true, ticks: [1, 2] });
    expect(mustScale('rank', [1], 1)).toEqual({ lo: 1, hi: 2, inverted: true, ticks: [1, 2] });
    expect(mustScale('rank', [1], 0)).toEqual({ lo: 1, hi: 2, inverted: true, ticks: [1, 2] });
  });

  it.each<{ readonly hi: number; readonly ticks: readonly number[] }>([
    { hi: 2, ticks: [1, 2] },
    { hi: 3, ticks: [1, 2, 3] },
    { hi: 5, ticks: [1, 2, 3, 4, 5] },
    // 間隔 2。中間の目盛りは間隔の倍数（2・4）で、1 位からではなく 0 から数える。
    { hi: 6, ticks: [1, 2, 4, 6] },
    // 下端との差 1 は間隔 2 の半分ちょうどなので、「半分未満」には当たらず残す。
    { hi: 7, ticks: [1, 2, 4, 6, 7] },
    // 間隔 5。10 は下端 11 との差 1 が間隔の半分（2.5）未満なので落とす。
    { hi: 11, ticks: [1, 5, 11] },
    { hi: 12, ticks: [1, 5, 12] },
    // 10 は下端 13 との差 3 が 2.5 以上なので残す。
    { hi: 13, ticks: [1, 5, 10, 13] },
    { hi: 20, ticks: [1, 5, 10, 15, 20] },
  ])('下端 $hi 位の目盛りは $ticks（1 と下端を含み、下端に近すぎる中間の目盛りを落とす）', ({ hi, ticks }) => {
    const scale = mustScale('rank', [1, 2], hi);

    expect(scale.hi).toBe(hi);
    expect(scale.ticks).toEqual(ticks);
  });

  it('目盛りはすべて整数で、1 から下端まで昇順に並ぶ', () => {
    for (let total = 2; total <= 60; total += 1) {
      const { ticks, hi } = mustScale('rank', [1], total);
      expect(ticks[0], String(total)).toBe(1);
      expect(ticks.at(-1), String(total)).toBe(hi);
      for (let i = 1; i < ticks.length; i += 1) {
        expect(Number.isInteger(ticks[i]), `${total}: ${ticks.join(',')}`).toBe(true);
        expect(ticks[i] ?? 0, `${total}: ${ticks.join(',')}`).toBeGreaterThan(ticks[i - 1] ?? 0);
      }
      // 目盛りは 1 と下端を含めて 6 つまで。間隔は（下端 − 1）÷ 間隔 ≤ 4 で選ぶので中間は 4 つまでで、
      // 1 と下端を加えた区間は最大 5 つになる。
      expect(ticks.length, `${total}: ${ticks.join(',')}`).toBeLessThanOrEqual(6);
    }
  });
});

// --- 縦軸: 評価 ------------------------------------------------------------------------

describe('scaleFor: 評価の軸（要件 1.4）', () => {
  it('上が大きい値の、反転しない軸になる', () => {
    expect(mustScale('rating', [3.2, 4.6]).inverted).toBe(false);
  });

  it('範囲を 0.5 単位へ外側に丸める（幅が 1.0 以上なら広げない）', () => {
    expect(mustScale('rating', [3.6, 4.4])).toEqual({ lo: 3.5, hi: 4.5, inverted: false, ticks: [3.5, 4, 4.5] });
    expect(mustScale('rating', [3.2, 4.6])).toEqual({
      lo: 3,
      hi: 5,
      inverted: false,
      ticks: [3, 3.5, 4, 4.5, 5],
    });
  });

  it('幅が 1.0 未満なら、値の中央を保って幅 1.0 へ広げる（小数第 1 位の変化を縦幅いっぱいに誇張しない）', () => {
    // 全日 4.0 なら、4.0 を中央に置く。
    expect(mustScale('rating', [4, 4, 4])).toEqual({ lo: 3.5, hi: 4.5, inverted: false, ticks: [3.5, 4, 4.5] });
    expect(mustScale('rating', [2, 2])).toEqual({ lo: 1.5, hi: 2.5, inverted: false, ticks: [1.5, 2, 2.5] });
    // 4.3 と 4.4 の変化は、幅 1.0 の軸の 1 割にとどまる。
    expect(mustScale('rating', [4.3, 4.4, 4.3])).toEqual({ lo: 4, hi: 5, inverted: false, ticks: [4, 4.5, 5] });
  });

  it('上端に張りつく値（4.9〜5.0）でも、範囲を 5.0 の上へ広げず、下へ平行移動して幅 1.0 を保つ', () => {
    expect(mustScale('rating', [4.9, 5.0])).toEqual({ lo: 4, hi: 5, inverted: false, ticks: [4, 4.5, 5] });
    expect(mustScale('rating', [5.0, 5.0])).toEqual({ lo: 4, hi: 5, inverted: false, ticks: [4, 4.5, 5] });
  });

  it('下端に張りつく値（1.0）でも、範囲を 1.0 の下へ広げず、上へ平行移動して幅 1.0 を保つ', () => {
    expect(mustScale('rating', [1.0, 1.0])).toEqual({ lo: 1, hi: 2, inverted: false, ticks: [1, 1.5, 2] });
    expect(mustScale('rating', [1.0, 1.2])).toEqual({ lo: 1, hi: 2, inverted: false, ticks: [1, 1.5, 2] });
  });

  it('目盛りの間隔は、幅 2.0 以下なら 0.5、2.0 を超えるなら 1.0 になる', () => {
    // 幅 2.0 ちょうどは 0.5 刻み。
    expect(mustScale('rating', [3.0, 5.0]).ticks).toEqual([3, 3.5, 4, 4.5, 5]);
    // 幅 3.0 は 1.0 刻み。
    expect(mustScale('rating', [2.1, 4.8])).toEqual({ lo: 2, hi: 5, inverted: false, ticks: [2, 3, 4, 5] });
    // 0.5 単位の範囲（2.5〜5.0）が幅 2.0 を超えるときは、1.0 刻みの目盛りが両端に来るよう 1.0 単位へ丸める。
    expect(mustScale('rating', [2.6, 4.8])).toEqual({ lo: 2, hi: 5, inverted: false, ticks: [2, 3, 4, 5] });
    expect(mustScale('rating', [1.0, 5.0])).toEqual({ lo: 1, hi: 5, inverted: false, ticks: [1, 2, 3, 4, 5] });
  });

  it('1.0〜5.0 の 0.1 刻みのすべての組で、範囲は 1.0〜5.0 に収まり、幅 1.0 以上で値を含み、目盛りが両端に来る', () => {
    let checked = 0;
    for (let low = 10; low <= 50; low += 1) {
      for (let high = low; high <= 50; high += 1) {
        const min = low / 10;
        const max = high / 10;
        const label = `${min}〜${max}`;
        const scale = mustScale('rating', [min, max]);

        expect(scale.lo, label).toBeGreaterThanOrEqual(1);
        expect(scale.hi, label).toBeLessThanOrEqual(5);
        expect(scale.hi - scale.lo, label).toBeGreaterThanOrEqual(1);
        expect(scale.lo, label).toBeLessThanOrEqual(min);
        expect(scale.hi, label).toBeGreaterThanOrEqual(max);
        // 範囲は 0.5 単位。
        expect(Number.isInteger(scale.lo * 2) && Number.isInteger(scale.hi * 2), label).toBe(true);
        // 値の幅が 0.5 以下なら、軸の幅はちょうど 1.0（それ以上に広げて変化を小さく見せもしない）。
        if (high - low <= 5) {
          expect(scale.hi - scale.lo, label).toBe(1);
        }
        // 目盛りは下端から上端まで等間隔（幅 2.0 以下は 0.5、超えると 1.0）。
        const step = scale.hi - scale.lo <= 2 ? 0.5 : 1;
        expect(scale.ticks[0], label).toBe(scale.lo);
        expect(scale.ticks.at(-1), label).toBe(scale.hi);
        expect(scale.ticks, label).toHaveLength((scale.hi - scale.lo) / step + 1);
        checked += 1;
      }
    }
    // 0.1 刻みの組（41 × 42 ÷ 2）をすべて回ったこと（ループの空振り対策）。
    expect(checked).toBe(861);
  });
});

// --- 縦軸: クチコミ数 ------------------------------------------------------------------------

describe('scaleFor: クチコミ数の軸（要件 1.5）', () => {
  it('上が大きい値の、反転しない軸になる', () => {
    expect(mustScale('reviewCount', [100, 130]).inverted).toBe(false);
  });

  it('全日 0 件でも負の目盛りを出さず、範囲は 0〜1 になる', () => {
    expect(mustScale('reviewCount', [0, 0, 0])).toEqual({ lo: 0, hi: 1, inverted: false, ticks: [0, 1] });
    expect(mustScale('reviewCount', [0])).toEqual({ lo: 0, hi: 1, inverted: false, ticks: [0, 1] });
  });

  it('値が全部同じなら、上下に 1 間隔ずつ広げる（下端は 0 で止める）', () => {
    expect(mustScale('reviewCount', [120, 120])).toEqual({
      lo: 119,
      hi: 121,
      inverted: false,
      ticks: [119, 120, 121],
    });
    expect(mustScale('reviewCount', [1, 1])).toEqual({ lo: 0, hi: 2, inverted: false, ticks: [0, 1, 2] });
  });

  it('間隔は 1・2・5 × 10 の累乗から、区間が 4 つ以下になる最小のものを選び、範囲をその倍数に丸める', () => {
    expect(mustScale('reviewCount', [0, 3]).ticks).toEqual([0, 1, 2, 3]);
    expect(mustScale('reviewCount', [0, 1]).ticks).toEqual([0, 1]);
    expect(mustScale('reviewCount', [5, 12])).toEqual({ lo: 4, hi: 12, inverted: false, ticks: [4, 6, 8, 10, 12] });
    expect(mustScale('reviewCount', [0, 7])).toEqual({ lo: 0, hi: 8, inverted: false, ticks: [0, 2, 4, 6, 8] });
    expect(mustScale('reviewCount', [1200, 1403])).toEqual({
      lo: 1200,
      hi: 1500,
      inverted: false,
      ticks: [1200, 1300, 1400, 1500],
    });
  });

  it('桁が大きいときも、目盛りは整数の切りのよい値になる', () => {
    expect(mustScale('reviewCount', [12000, 12900])).toEqual({
      lo: 12000,
      hi: 13000,
      inverted: false,
      ticks: [12000, 12500, 13000],
    });
  });

  it('さまざまな範囲で、目盛りは 0 以上の整数・等間隔・区間 4 つ以下で、範囲は値を含む', () => {
    const samples = [0, 1, 2, 3, 7, 9, 10, 11, 49, 99, 100, 101, 250, 1234, 5000, 99999];
    const niceSteps = new Set([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]);
    let checked = 0;
    for (const min of samples) {
      for (const max of samples.filter((value) => value >= min)) {
        const label = `${min}〜${max}`;
        const { lo, hi, ticks } = mustScale('reviewCount', [min, max]);

        expect(lo, label).toBeGreaterThanOrEqual(0);
        expect(lo, label).toBeLessThanOrEqual(min);
        expect(hi, label).toBeGreaterThanOrEqual(max);
        expect(hi, label).toBeGreaterThan(lo);
        expect(ticks[0], label).toBe(lo);
        expect(ticks.at(-1), label).toBe(hi);
        expect(ticks.length - 1, label).toBeLessThanOrEqual(4);
        const step = (ticks[1] ?? 0) - (ticks[0] ?? 0);
        expect(niceSteps.has(step), `${label}: 間隔 ${step}`).toBe(true);
        ticks.forEach((tick, i) => {
          expect(Number.isInteger(tick), `${label}: ${ticks.join(',')}`).toBe(true);
          expect(tick, `${label}: ${ticks.join(',')}`).toBe(lo + step * i);
        });
        checked += 1;
      }
    }
    expect(checked).toBe(136);
  });
});

// --- 幾何: 横の位置と縦の位置 ------------------------------------------------------------------

describe('buildGeometry: 横の位置と縦の位置', () => {
  it('横の位置は公称の始点から数えた暦日の番号で決まり、期間を切り替えると変わる', () => {
    const trend = [point('2026-09-12'), point('2026-09-13')];

    const week = draw(trend, 7, 'rank').geometry;
    const month = draw(trend, 30, 'rank').geometry;

    // 記録は 2 日しか無いが、始点は公称の始点（7 日なら 9 月 7 日、30 日なら 8 月 15 日）。
    expectCloseAll(week.segments.flat().map((p) => p.x), [xAt(5, 7), 100]);
    expectCloseAll(month.segments.flat().map((p) => p.x), [xAt(28, 30), 100]);
    expectCloseAll(week.markers.map((p) => p.x), [xAt(5, 7)]);
    expect(week.end.x).toBe(100);
    expect(month.end.x).toBe(100);
    expect(week.spanDays).toBe(7);
    expect(month.spanDays).toBe(30);
  });

  it('月をまたぐ窓でも、横の位置は暦日で数える', () => {
    const dates = ['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];

    const { geometry } = draw(dates.map((date) => point(date)), 7, 'rank');

    expect(segmentDates(geometry)).toEqual([dates]);
    expectCloseAll(
      geometry.segments.flat().map((p) => p.x),
      [0, 1, 2, 3, 4, 5, 6].map((i) => xAt(i, 7)),
    );
  });

  it('順位は 1 位を上端（y = 0）、軸の下端の順位を下端（y = 100）に描く', () => {
    const trend = [
      point('2026-09-11', { rank: 1 }),
      point('2026-09-12', { rank: 4 }),
      point('2026-09-13', { rank: 6 }),
    ];

    const { geometry } = draw(trend, 7, 'rank', 6);

    // 上位ほど上（y が小さい）。
    expectCloseAll(geometry.segments.flat().map((p) => p.y), [0, 60, 100]);
  });

  it('評価とクチコミ数は、大きい値ほど上に描く', () => {
    const rating = draw(
      [point('2026-09-12', { rating: '4.0' }), point('2026-09-13', { rating: '4.5' })],
      7,
      'rating',
    ).geometry;
    const reviews = draw(
      [point('2026-09-12', { reviewCount: 100 }), point('2026-09-13', { reviewCount: 130 })],
      7,
      'reviewCount',
    ).geometry;

    // 評価の軸は 4.0〜5.0、クチコミ数の軸は 100〜130。
    expectCloseAll(rating.segments.flat().map((p) => p.y), [100, 50]);
    expectCloseAll(reviews.segments.flat().map((p) => p.y), [100, 0]);
  });

  it('目盛りの縦の位置は軸の向きに従う（順位は 1 位が上端、評価は下端の値が下端）', () => {
    const rank = draw([point('2026-09-12', { rank: 2 }), point('2026-09-13', { rank: 3 })], 7, 'rank', 6).geometry;
    const rating = draw([point('2026-09-13', { rating: '4.3' })], 7, 'rating').geometry;

    expect(rank.ticks.map((tick) => tick.value)).toEqual([1, 2, 4, 6]);
    expectCloseAll(rank.ticks.map((tick) => tick.y), [0, 20, 60, 100]);
    expect(rating.ticks.map((tick) => tick.value)).toEqual([4, 4.5, 5]);
    expectCloseAll(rating.ticks.map((tick) => tick.y), [100, 50, 0]);
  });

  it('描く点は、指標の値と記録日をそのまま持つ', () => {
    const { geometry } = draw([point('2026-09-12', { rating: '4.1' }), point('2026-09-13', { rating: '4.4' })], 7, 'rating');

    expect(geometry.segments.flat().map((p) => [p.date, p.value])).toEqual([
      ['2026-09-12', 4.1],
      ['2026-09-13', 4.4],
    ]);
  });
});

// --- 幾何: 線分 ------------------------------------------------------------------------

describe('buildGeometry: 線分（要件 1.6・1.7・1.8・1.9）', () => {
  it('値の無い日で線を途切れさせ、その日を 0 や前後の値で補わない', () => {
    const trend = [
      point('2026-09-07', { rank: 3 }),
      point('2026-09-08', { rank: 4 }),
      point('2026-09-09', { rank: null }),
      point('2026-09-10', { rank: 2 }),
      point('2026-09-11', { rank: 2 }),
      point('2026-09-12', { rank: 3 }),
      point('2026-09-13', { rank: 5 }),
    ];

    const { geometry } = draw(trend, 7, 'rank', 6);

    expect(segmentDates(geometry)).toEqual([
      ['2026-09-07', '2026-09-08'],
      ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'],
    ]);
    expect(allPlotted(geometry).map((p) => p.date)).not.toContain('2026-09-09');
  });

  it('暦日が欠けた日を挟む 2 点を線で結ばない', () => {
    const trend = [
      point('2026-09-07', { rank: 3 }),
      point('2026-09-08', { rank: 4 }),
      // 9 月 9 日の記録が無い
      point('2026-09-10', { rank: 2 }),
      point('2026-09-11', { rank: 2 }),
      point('2026-09-12', { rank: 3 }),
      point('2026-09-13', { rank: 5 }),
    ];

    const { geometry } = draw(trend, 7, 'rank', 6);

    expect(segmentDates(geometry)).toEqual([
      ['2026-09-07', '2026-09-08'],
      ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'],
    ]);
  });

  it('30 日の窓で、何日も欠けた区間を挟む 2 点も線で結ばない', () => {
    const trend = [
      ...[15, 16, 17, 18, 19, 20].map((day) => point(augustDate(day))),
      // 8 月 21 日〜24 日の記録が無い
      ...[25, 26, 27, 28, 29, 30, 31].map((day) => point(augustDate(day))),
      ...['2026-09-01', '2026-09-02'].map((date) => point(date)),
    ];

    const { geometry } = draw(trend, 30, 'rank');

    expect(segmentDates(geometry)).toEqual([
      ['2026-08-15', '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20'],
      ['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02'],
    ]);
  });

  it('評価 0 の日は値の無い日として線を切り、評価 0 の点を描かない（要件 8.4）', () => {
    const trend = [
      point('2026-09-10', { rating: '4.2' }),
      point('2026-09-11', { rating: '4.3' }),
      point('2026-09-12', { rating: '0.0' }),
      point('2026-09-13', { rating: '4.4' }),
    ];

    const { geometry, scale } = draw(trend, 7, 'rating');

    expect(segmentDates(geometry)).toEqual([['2026-09-10', '2026-09-11']]);
    expect(allPlotted(geometry).map((p) => p.date)).not.toContain('2026-09-12');
    expect(allPlotted(geometry).map((p) => p.value)).not.toContain(0);
    // 0 を値として数えれば、軸の下端は 1.0 まで下がる。
    expect(scale.lo).toBe(4);
  });

  it('線分の各点は、前の点の翌日にあり、1 本の線分は 2 点以上になる', () => {
    const trend = [
      point('2026-09-07', { reviewCount: 10 }),
      point('2026-09-08', { reviewCount: null }),
      point('2026-09-09', { reviewCount: 11 }),
      point('2026-09-10', { reviewCount: 12 }),
      point('2026-09-12', { reviewCount: 14 }),
      point('2026-09-13', { reviewCount: 15 }),
    ];

    const { geometry } = draw(trend, 7, 'reviewCount');

    expect(geometry.segments).toHaveLength(2);
    for (const segment of geometry.segments) {
      expect(segment.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < segment.length; i += 1) {
        expect((segment[i]?.x ?? 0) - (segment[i - 1]?.x ?? 0)).toBeCloseTo(xAt(1, 7), 9);
      }
    }
  });

  it('値のある日が 1 日だけなら、その点を端点として描き、線を描かない', () => {
    for (const period of TREND_PERIODS) {
      const trend = [
        point('2026-09-11', { rank: null }),
        point('2026-09-12', { rank: 4 }),
        point('2026-09-13', { rank: null }),
      ];

      const { geometry } = draw(trend, period, 'rank');

      expect(geometry.segments, String(period)).toEqual([]);
      expect(geometry.markers, String(period)).toEqual([]);
      expect(geometry.end.date, String(period)).toBe('2026-09-12');
      expect(geometry.end.value, String(period)).toBe(4);
    }
  });

  it('推移の記録が 1 日だけでも、その点を端点として描き、線を描かない', () => {
    const { geometry } = draw([point('2026-09-13', { reviewCount: 88 })], 30, 'reviewCount');

    expect(geometry.segments).toEqual([]);
    expect(geometry.markers).toEqual([]);
    expect(geometry.end).toMatchObject({ date: '2026-09-13', value: 88, x: 100 });
  });
});

// --- 幾何: 印と端点 ------------------------------------------------------------------------

describe('buildGeometry: 印と端点（要件 1.6・1.14）', () => {
  it('全点に印を置く日数の上限は 10 日である', () => {
    expect(ALL_MARKERS_MAX_DAYS).toBe(10);
  });

  it('同じ推移で、7 日の窓では全点に、30 日の窓では端点と孤立点だけに印を置く', () => {
    // 8 月 1 日〜30 日の 30 日、欠けも値の無い日も無い推移。
    const trend = augustSeries(
      'rank',
      Array.from({ length: 30 }, (_, i) => 1 + (i % 5)),
    );

    const week = draw(trend, 7, 'rank', 6).geometry;
    const month = draw(trend, 30, 'rank', 6).geometry;

    // 7 日: 端点（8 月 30 日）を除く 6 日すべてに印を置く。
    expect(markerDates(week)).toEqual(['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29']);
    expect(week.end.date).toBe('2026-08-30');
    // 30 日: 途切れが無いので孤立点は無く、印は端点だけになる。
    expect(markerDates(month)).toEqual([]);
    expect(month.end.date).toBe('2026-08-30');
    // 画面に描かれる点の数（印と端点）が、7 日と 30 日で変わる。
    expect(week.markers.length + 1).toBe(7);
    expect(month.markers.length + 1).toBe(1);
  });

  it('30 日の窓で、前後どちらとも線で結ばれない値（孤立点）に印を置く', () => {
    // 8 月 1 日: 値あり（翌日は値なし）→ 孤立
    // 8 月 3 日: 値あり（前日は値なし、翌日は記録なし）→ 孤立
    // 8 月 5〜6 日: 線分
    // 8 月 8〜29 日: 線分（端点は 8 月 29 日。8 月 30 日は値なし）
    const values: (number | null)[] = Array.from({ length: 30 }, () => 3);
    values[1] = null; // 8 月 2 日
    values[6] = null; // 8 月 7 日
    values[29] = null; // 8 月 30 日
    const trend = augustSeries('rank', values).filter((p) => p.capturedOn !== augustDate(4));

    const { geometry } = draw(trend, 30, 'rank');

    expect(markerDates(geometry)).toEqual(['2026-08-01', '2026-08-03']);
    expect(segmentDates(geometry).map((segment) => [segment[0], segment.at(-1), segment.length])).toEqual([
      ['2026-08-05', '2026-08-06', 2],
      ['2026-08-08', '2026-08-29', 22],
    ]);
    expect(geometry.end.date).toBe('2026-08-29');
  });

  it('端点が孤立しているときも、端点は印に重ねず end だけに置く', () => {
    const trend = [
      ...[5, 6, 7].map((day) => point(augustDate(day), { rank: 2 })),
      point(augustDate(8), { rank: null }),
      point(augustDate(9), { rank: 4 }),
    ];

    const { geometry } = draw(trend, 30, 'rank');

    expect(segmentDates(geometry)).toEqual([['2026-08-05', '2026-08-06', '2026-08-07']]);
    expect(markerDates(geometry)).toEqual([]);
    expect(geometry.end).toMatchObject({ date: '2026-08-09', value: 4, x: 100 });
  });

  it('7 日の窓では、値の無い日を除くすべての記録日に印か端点がある', () => {
    const trend = [
      point('2026-09-07', { rating: '4.1' }),
      point('2026-09-08', { rating: null }),
      point('2026-09-09', { rating: '4.2' }),
      point('2026-09-11', { rating: '4.2' }),
      point('2026-09-12', { rating: '4.3' }),
      point('2026-09-13', { rating: null }),
    ];

    const { geometry } = draw(trend, 7, 'rating');

    expect(markerDates(geometry)).toEqual(['2026-09-07', '2026-09-09', '2026-09-11']);
    expect(geometry.end.date).toBe('2026-09-12');
  });

  it('端点は期間内の最新の値で、現在値（metricExtent の last）と同じ日と値になる', () => {
    // 終点（9 月 13 日）は評価が無いので、端点は値のある最後の日になる。
    const trend = [
      point('2026-09-11', { rating: '4.2' }),
      point('2026-09-12', { rating: '4.4' }),
      point('2026-09-13', { rating: null }),
    ];

    const { window, geometry } = draw(trend, 7, 'rating');
    const last = metricExtent(window, 'rating').last;

    expect(geometry.end.date).toBe('2026-09-12');
    expect(last).toEqual({ date: geometry.end.date, value: geometry.end.value });
    expect(markerDates(geometry)).not.toContain(geometry.end.date);
  });
});

// --- 幾何: 退化した入力 ------------------------------------------------------------------------

describe('buildGeometry: 退化した入力', () => {
  const anyScale: AxisScale = { lo: 1, hi: 5, inverted: false, ticks: [1, 5] };

  it('窓の中に指標の値が 1 件も無ければ null を返す', () => {
    const window = mustWindow([point('2026-09-12', { rating: null }), point('2026-09-13', { rating: null })], 7);

    expect(buildGeometry(window, 'rating', anyScale)).toBeNull();
  });

  it('窓の外の日付・解釈できない日付の点は描かず、座標は 0〜100 に収まる（窓の事前条件が崩れた場合）', () => {
    const window: TrendWindow = {
      periodDays: 7,
      points: [
        point('2026-09-05', { rating: '4.0' }), // 始点より前
        point('2026-02-30', { rating: '4.0' }), // 存在しない日
        point('2026-09-12', { rating: '4.2' }),
        point('2026-09-13', { rating: '4.4' }),
        point('2026-09-20', { rating: '4.0' }), // 終点より後
      ],
      startDate: '2026-09-07',
      endDate: '2026-09-13',
    };

    const geometry = buildGeometry(window, 'rating', anyScale);
    if (geometry === null) {
      throw new Error('窓の中に値があるのに幾何が null になりました');
    }

    expect([...new Set(allPlotted(geometry).map((p) => p.date))].sort()).toEqual(['2026-09-12', '2026-09-13']);
    expect(segmentDates(geometry)).toEqual([['2026-09-12', '2026-09-13']]);
    expect(geometry.end.date).toBe('2026-09-13');
    for (const p of allPlotted(geometry)) {
      expect(p.x, p.date).toBeGreaterThanOrEqual(0);
      expect(p.x, p.date).toBeLessThanOrEqual(100);
    }
  });

  it('始点の日付を解釈できない窓では null を返す', () => {
    const window: TrendWindow = { periodDays: 7, points: [point('2026-09-13')], startDate: 'bad', endDate: '2026-09-13' };

    expect(buildGeometry(window, 'rank', anyScale)).toBeNull();
  });

  it('評価と順位が定義域の外にあっても、縦の位置は 0〜100 に収まる', () => {
    const high = draw([point('2026-09-12', { rating: '4.5' }), point('2026-09-13', { rating: '5.5' })], 7, 'rating');
    const low = draw([point('2026-09-12', { rating: '0.5' }), point('2026-09-13', { rating: '1.5' })], 7, 'rating');
    const rank = draw([point('2026-09-12', { rank: 0 }), point('2026-09-13', { rank: 2 })], 7, 'rank');
    // 両側に外れた値があると、上下の平行移動を続けて行っても範囲が 1.0〜5.0 に収まらない。
    const both = draw([point('2026-09-12', { rating: '0.5' }), point('2026-09-13', { rating: '5.5' })], 7, 'rating');

    // 評価の軸は 1.0〜5.0 の外へ広げないので、外の値は端に寄せて描く。
    expect(high.scale.hi).toBe(5);
    expect(low.scale.lo).toBe(1);
    expect(both.scale).toEqual({ lo: 1, hi: 5, inverted: false, ticks: [1, 2, 3, 4, 5] });
    for (const { geometry } of [high, low, rank, both]) {
      for (const p of allPlotted(geometry)) {
        expect(p.y, `${p.date} ${p.value}`).toBeGreaterThanOrEqual(0);
        expect(p.y, `${p.date} ${p.value}`).toBeLessThanOrEqual(100);
      }
    }
    expect(high.geometry.end.y).toBe(0);
    expect(low.geometry.segments.flat()[0]?.y).toBe(100);
  });
});

// --- タイムゾーン ------------------------------------------------------------------------

describe('buildGeometry: 実行環境のタイムゾーン', () => {
  it('タイムゾーンが UTC から離れていても、横の位置と線分は変わらない', () => {
    // CI の実行環境は UTC なので、ローカル時刻で日数を数える誤りは、UTC のまま走らせても緑になる。
    // テストの中でタイムゾーンを切り替え、切り替わったことを確かめてから、同じ結果になることを見る。
    //
    // trend-scale は日付の差（日の番号）しか使わないので、UTC との差が一定の地域では、ローカル時刻で
    // 数える誤りが差の中で打ち消し合い、この検査は緑のまま素通りする。誤りが表に出るのは、範囲の中で
    // UTC との差が変わる（夏時間の切り替えをまたぐ）地域だけである。そこで範囲は、米国の夏時間が終わる日
    // （2026-11-01）をまたがせた。ローカル時刻で数えると、この日は 25 時間になり、日の番号が整数でなくなる。
    // この前提が崩れていないこと（範囲の中で UTC との差が変わる地域が 1 つ以上あること）も、下で確かめる。
    const dates = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
    const trend = dates.map((date) => point(date));
    const zonesWithShift: string[] = [];
    const originalZone = process.env.TZ;
    try {
      for (const zone of ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
        process.env.TZ = zone;
        // 範囲の各日の、ローカルの 0 時における UTC との差（分）。ローカル時刻で日数を数える誤りが読むのは
        // ローカルの 0 時なので、同じ時刻で測る（UTC の 0 時で測ると、東側の地域では、範囲の最終日に来る
        // 切り替えを「差が変わる」と数えても、日の番号は整数のままで、検出力が無いのに前提が通ってしまう）。
        const offsets = new Set(
          dates.map((date) => {
            const [year = Number.NaN, month = Number.NaN, day = Number.NaN] = date.split('-').map(Number);
            return new Date(year, month - 1, day).getTimezoneOffset();
          }),
        );
        // 切り替えが効いていなければ、この検査は UTC のまま走り、何も確かめない。
        expect(offsets.has(0), `${zone}: ${[...offsets].join(',')}`).toBe(false);
        if (offsets.size > 1) {
          zonesWithShift.push(zone);
        }

        const { geometry } = draw(trend, 7, 'rank');

        expect(segmentDates(geometry), zone).toEqual([dates]);
        expectCloseAll(
          geometry.segments.flat().map((p) => p.x),
          [0, 1, 2, 3, 4, 5, 6].map((i) => xAt(i, 7)),
          zone,
        );
      }
      // 検出力の前提: 範囲の中で UTC との差が変わる地域が 1 つ以上ある。日付の範囲を変えたり、夏時間の
      // ある地域を外したりしてこれが 0 になると、ローカル時刻で数える誤りを捕まえられなくなる。
      expect(zonesWithShift.length, `範囲の中で UTC との差が変わる地域: ${zonesWithShift.join(',') || 'なし'}`).toBeGreaterThanOrEqual(1);
    } finally {
      if (originalZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalZone;
      }
    }
  });
});

// --- 不変条件 ------------------------------------------------------------------------

describe('buildGeometry: 不変条件（すべての座標は 0〜100・値の無い点を描かない・端点は現在値）', () => {
  /** 再現できる擬似乱数（mulberry32）。種を固定するので、失敗したときに同じ入力を作り直せる。 */
  function randomOf(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 8 月 15 日〜9 月 13 日の 30 日から、記録の欠け・値の無い日を混ぜた推移を作る。 */
  function randomTrend(random: () => number): StoreDetailTrendPoint[] {
    const dates = [
      ...Array.from({ length: 17 }, (_, i) => augustDate(i + 15)),
      ...Array.from({ length: 13 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`),
    ];
    const pick = <T>(value: T): T | null => (random() < 0.25 ? null : value);
    return dates
      .filter(() => random() >= 0.2)
      .map((capturedOn) => ({
        capturedOn,
        rank: pick(1 + Math.floor(random() * 8)),
        rating: pick((1 + Math.floor(random() * 41) / 10).toFixed(1)),
        reviewCount: pick(Math.floor(random() * (random() < 0.5 ? 5 : 3000))),
      }));
  }

  it('擬似乱数で作った推移のすべてで、不変条件が成り立つ', () => {
    const random = randomOf(265);
    let drawn = 0;
    let isolated = 0;
    for (let round = 0; round < 300; round += 1) {
      const trend = randomTrend(random);
      const rankTotal = random() < 0.3 ? null : 1 + Math.floor(random() * 8);
      for (const period of TREND_PERIODS) {
        const window = selectTrendWindow(trend, period);
        if (window === null) {
          continue;
        }
        for (const metric of TREND_METRICS) {
          const label = `round ${round} / ${period} 日 / ${metric}`;
          const extent = metricExtent(window, metric);
          const scale = scaleFor(extent, { rankTotal });
          if (extent.recordedDays === 0) {
            expect(scale, label).toBeNull();
            continue;
          }
          if (scale === null) {
            throw new Error(`${label}: 値があるのに軸が null`);
          }
          const geometry = buildGeometry(window, metric, scale);
          if (geometry === null) {
            throw new Error(`${label}: 値があるのに幾何が null`);
          }
          drawn += 1;

          // 軸は値をすべて含み、目盛りは軸の中にある。
          expect(scale.lo, label).toBeLessThan(scale.hi);
          expect(scale.inverted, label).toBe(metric === 'rank');
          for (const tick of scale.ticks) {
            expect(tick, label).toBeGreaterThanOrEqual(scale.lo);
            expect(tick, label).toBeLessThanOrEqual(scale.hi);
          }

          // すべての座標は 0〜100。
          const plotted = allPlotted(geometry);
          for (const p of plotted) {
            expect(p.x, `${label} ${p.date}`).toBeGreaterThanOrEqual(0);
            expect(p.x, `${label} ${p.date}`).toBeLessThanOrEqual(100);
            expect(p.y, `${label} ${p.date}`).toBeGreaterThanOrEqual(0);
            expect(p.y, `${label} ${p.date}`).toBeLessThanOrEqual(100);
            expect(p.value, `${label} ${p.date}`).toBeGreaterThanOrEqual(scale.lo);
            expect(p.value, `${label} ${p.date}`).toBeLessThanOrEqual(scale.hi);
          }
          for (const tick of geometry.ticks) {
            expect(tick.y, label).toBeGreaterThanOrEqual(0);
            expect(tick.y, label).toBeLessThanOrEqual(100);
          }
          expect(geometry.ticks.map((tick) => tick.value), label).toEqual(scale.ticks);

          // 値のある日はすべて描かれ、値の無い日はどこにも現れない。
          const valued = window.points.filter((p) => metricValue(p, metric) !== null).map((p) => p.capturedOn);
          expect([...new Set(plotted.map((p) => p.date))].sort(), label).toEqual([...valued].sort());

          // 線分は 2 点以上で、隣り合う点は 1 日ずつ離れている。
          for (const segment of geometry.segments) {
            expect(segment.length, label).toBeGreaterThanOrEqual(2);
            for (let i = 1; i < segment.length; i += 1) {
              expect((segment[i]?.x ?? 0) - (segment[i - 1]?.x ?? 0), label).toBeCloseTo(xAt(1, period), 9);
            }
          }

          // 端点は現在値と同じ日と値で、印に重ねない。
          expect({ date: geometry.end.date, value: geometry.end.value }, label).toEqual(extent.last);
          expect(markerDates(geometry), label).not.toContain(geometry.end.date);

          // 印: 10 日以下なら端点以外の全点、それより長ければ線分に属さない点（孤立点）だけ。
          const inSegments = new Set(geometry.segments.flat().map((p) => p.date));
          const expectedMarkers = valued.filter(
            (date) => date !== geometry.end.date && (period <= 10 || !inSegments.has(date)),
          );
          expect(markerDates(geometry), label).toEqual(expectedMarkers);
          expect(geometry.spanDays, label).toBe(period);
          if (period > 10) {
            isolated += geometry.markers.length;
          }
        }
      }
    }
    // 検査が空振りしていないこと（描いた幾何と、30 日の窓の孤立点が十分な数ある）。
    expect(drawn).toBeGreaterThan(1500);
    expect(isolated).toBeGreaterThan(100);
  });
});
