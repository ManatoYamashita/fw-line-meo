// store-detail-trend-dashboard task 2.1（Issue #265）: 推移の窓・指標の値・期間要約・現在値・説明文・
// 表示整形の純関数（lib/trend-view.ts）を検証する。
//
// 窓は「推移データの最新の記録日を終点とし、終点を含めて遡った暦日の日数」（要件 2.4 の定義文）である。
// グラフ・期間要約・推移の表・現在値の 4 つは、この窓だけを入力にする（design.md の決定 D1）。
// 窓の境界の検査では、期待する日付を計算で作らずリテラルで書く。実装と同じ計算で期待値を作ると、
// 計算の誤りが両側で打ち消し合って検査が緑のまま素通りするためである。
//
// このファイルは node 環境で走る（DOM を使わない）。
import { describe, expect, it } from 'vitest';

import type { StoreDetailTrendPoint } from '../lib/data';
import {
  DEFAULT_METRIC,
  DEFAULT_PERIOD,
  TREND_METRICS,
  TREND_PERIODS,
  describeMetric,
  formatMetricValue,
  formatShortDate,
  formatTickValue,
  isTrendMetric,
  isTrendPeriod,
  metricExtent,
  metricName,
  metricValue,
  selectTrendWindow,
  summarizeWindow,
  summaryPeriodNote,
  type TrendMetric,
  type TrendPeriodDays,
  type TrendWindow,
} from '../lib/trend-view';

// --- テスト用の点 ----------------------------------------------------------------------

/** 既定では 3 指標とも値を持つ点。上書きした項目だけが変わる。 */
function point(
  capturedOn: string,
  values: Partial<Omit<StoreDetailTrendPoint, 'capturedOn'>> = {},
): StoreDetailTrendPoint {
  return { capturedOn, rank: 3, rating: '4.3', reviewCount: 120, ...values };
}

/** 3 指標とも値の無い点（評価の無い日は、順位も持たない形で届く）。 */
function emptyPoint(capturedOn: string): StoreDetailTrendPoint {
  return { capturedOn, rank: null, rating: null, reviewCount: null };
}

function datesOf(window: TrendWindow | null): readonly string[] {
  return window === null ? [] : window.points.map((p) => p.capturedOn);
}

/** 窓が null でないことを確かめてから返す（以降の assert を窓の中身へ集中させる）。 */
function mustWindow(trend: readonly StoreDetailTrendPoint[], periodDays: TrendPeriodDays): TrendWindow {
  const window = selectTrendWindow(trend, periodDays);
  if (window === null) {
    throw new Error('窓が null になりました（日付を解釈できる点があるはずです）');
  }
  return window;
}

/** e2e の固定データと同じ形の、8 月 1 日から count 日ぶん連続する推移（null を含まない）。 */
function augustTrend(count: number): StoreDetailTrendPoint[] {
  const points: StoreDetailTrendPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    points.push({
      capturedOn: `2026-08-${String(i + 1).padStart(2, '0')}`,
      rank: 3 + (i % 4),
      rating: (4.0 + (i % 10) / 10).toFixed(1),
      reviewCount: 1200 + i * 7,
    });
  }
  return points;
}

// --- 期間と指標の定数と型ガード -----------------------------------------------------------

describe('期間と指標の定数と型ガード', () => {
  it('期間は 7 日と 30 日の 2 つで、既定は 30 日である（要件 2.2・2.3）', () => {
    expect(TREND_PERIODS).toEqual([7, 30]);
    expect(DEFAULT_PERIOD).toBe(30);
    expect(TREND_PERIODS).toContain(DEFAULT_PERIOD);
  });

  it('指標は順位・評価・クチコミ数の 3 つで、既定は順位である（要件 2.1・2.3）', () => {
    expect(TREND_METRICS).toEqual(['rank', 'rating', 'reviewCount']);
    expect(DEFAULT_METRIC).toBe('rank');
    expect(TREND_METRICS).toContain(DEFAULT_METRIC);
  });

  it('isTrendPeriod は定数に含まれる数値だけを受け付ける', () => {
    for (const period of TREND_PERIODS) {
      expect(isTrendPeriod(period), String(period)).toBe(true);
    }
    // 選択肢の値が文字列で届いた場合や、定数に無い日数は受け付けない（型の強制変換をしない）。
    for (const value of ['7', '30', 14, 0, 31, Number.NaN, null, undefined, {}, [7]]) {
      expect(isTrendPeriod(value), JSON.stringify(value) ?? String(value)).toBe(false);
    }
  });

  it('isTrendMetric は定数に含まれる文字列だけを受け付ける', () => {
    for (const metric of TREND_METRICS) {
      expect(isTrendMetric(metric), metric).toBe(true);
    }
    for (const value of ['Rank', 'rating ', 'review_count', '', 0, null, undefined, {}]) {
      expect(isTrendMetric(value), JSON.stringify(value) ?? String(value)).toBe(false);
    }
  });
});

// --- 期間の窓 --------------------------------------------------------------------------

describe('selectTrendWindow: 期間の窓（要件 2.4）', () => {
  it('7 日の窓は、終点と 6 日前を含み、7 日前を含まない', () => {
    const trend = [
      point('2026-09-06'), // 7 日前: 外れる
      point('2026-09-07'), // 6 日前: 入る
      point('2026-09-08'),
      point('2026-09-09'),
      point('2026-09-10'),
      point('2026-09-11'),
      point('2026-09-12'),
      point('2026-09-13'), // 終点
    ];

    const window = mustWindow(trend, 7);

    expect(window.periodDays).toBe(7);
    expect(window.startDate).toBe('2026-09-07');
    expect(window.endDate).toBe('2026-09-13');
    expect(datesOf(window)).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
    ]);
  });

  it('30 日の窓は、終点と 29 日前を含み、30 日前を含まない', () => {
    const trend = [point('2026-08-14'), point('2026-08-15'), point('2026-09-13')];

    const window = mustWindow(trend, 30);

    expect(window.startDate).toBe('2026-08-15');
    expect(window.endDate).toBe('2026-09-13');
    expect(datesOf(window)).toEqual(['2026-08-15', '2026-09-13']);
  });

  it('暦日が欠けていても、窓の境界は記録の件数ではなく暦日で決まる', () => {
    const trend = [point('2026-09-01'), point('2026-09-05'), point('2026-09-09'), point('2026-09-13')];

    const window = mustWindow(trend, 7);

    // 件数で 7 つ遡るなら 4 点すべてが入る。暦日で数えるので 9 月 7 日より前は外れる。
    expect(datesOf(window)).toEqual(['2026-09-09', '2026-09-13']);
    // 始点は公称の始点であり、窓の中で最初に記録された日（9 月 9 日）ではない。
    expect(window.startDate).toBe('2026-09-07');
    expect(window.endDate).toBe('2026-09-13');
  });

  it('記録が期間の日数に満たないときも、始点は公称の始点になり、7 日と 30 日で始点が変わる', () => {
    const trend = [point('2026-09-12'), point('2026-09-13')];

    const week = mustWindow(trend, 7);
    const month = mustWindow(trend, 30);

    expect(datesOf(week)).toEqual(['2026-09-12', '2026-09-13']);
    expect(datesOf(month)).toEqual(['2026-09-12', '2026-09-13']);
    expect(week.startDate).toBe('2026-09-07');
    expect(month.startDate).toBe('2026-08-15');
  });

  it('月と年をまたぐ窓も暦日で数える', () => {
    const trend = [point('2026-12-27'), point('2026-12-28'), point('2026-12-31'), point('2027-01-03')];

    const window = mustWindow(trend, 7);

    expect(window.startDate).toBe('2026-12-28');
    expect(window.endDate).toBe('2027-01-03');
    expect(datesOf(window)).toEqual(['2026-12-28', '2026-12-31', '2027-01-03']);
  });

  it('うるう年の 2 月 29 日を 1 日として数える', () => {
    const trend = [point('2028-02-24'), point('2028-02-25'), point('2028-02-29'), point('2028-03-02')];

    const window = mustWindow(trend, 7);

    expect(window.startDate).toBe('2028-02-25');
    expect(datesOf(window)).toEqual(['2028-02-25', '2028-02-29', '2028-03-02']);
  });

  it('実行環境のタイムゾーンが UTC から離れていても、窓の境界と日付の表示は変わらない', () => {
    // CI の実行環境は UTC なので、ローカル時刻で日数を数える誤りは、UTC のまま走らせても緑になる。
    // テストの中でタイムゾーンを切り替え、切り替わったことを確かめてから、同じ結果になることを見る。
    // 範囲は、米国の夏時間が終わる日（2026-11-01）をまたぐ。
    const trend = [point('2026-10-29'), point('2026-10-30'), point('2026-11-01'), point('2026-11-05')];
    const originalZone = process.env.TZ;
    try {
      for (const zone of ['Asia/Tokyo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles']) {
        process.env.TZ = zone;
        // 切り替えが効いていなければ、この検査は UTC のまま走り、何も確かめない。
        expect(new Date(Date.UTC(2026, 9, 30)).getTimezoneOffset(), zone).not.toBe(0);

        const window = mustWindow(trend, 7);

        expect(window.startDate, zone).toBe('2026-10-30');
        expect(window.endDate, zone).toBe('2026-11-05');
        expect(datesOf(window), zone).toEqual(['2026-10-30', '2026-11-01', '2026-11-05']);
        expect(formatShortDate(window.startDate), zone).toBe('10/30');
        expect(describeMetric(window, metricExtent(window, 'rank')), zone).toContain('10月30日から11月5日まで');
      }
    } finally {
      if (originalZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalZone;
      }
    }
  });

  it('日付を解釈できない点は窓に含めず、終点は解釈できる最新の記録日から決める', () => {
    const trend = [
      point('2026-09-10', { rank: 4 }),
      point('2026-02-30', { rank: 90 }), // 存在しない日
      point('2026/09/11', { rank: 91 }), // 区切りが違う
      point('2026-9-11', { rank: 92 }), // 桁が足りない
      point('2026-09-11T00:00:00Z', { rank: 93 }), // 時刻つき
      point(' 2026-09-11', { rank: 94 }), // 前に空白
      point('2026-13-01', { rank: 95 }), // 存在しない月
      point('', { rank: 96 }),
      point('2026-09-12', { rank: 2 }),
      point('not-a-date', { rank: 97 }), // 末尾にあっても終点にしない
    ];

    const window = mustWindow(trend, 7);

    expect(window.endDate).toBe('2026-09-12');
    expect(window.startDate).toBe('2026-09-06');
    expect(datesOf(window)).toEqual(['2026-09-10', '2026-09-12']);
  });

  it('解釈できない日付の点は、要約・指標の範囲・説明文のどれにも現れない', () => {
    const trend = [
      point('2026-09-10', { rank: 4, rating: '4.1', reviewCount: 100 }),
      point('2026-09-31', { rank: 99, rating: '1.0', reviewCount: 999 }), // 存在しない日
      point('2026-09-12', { rank: 2, rating: '4.4', reviewCount: 110 }),
    ];

    const window = mustWindow(trend, 7);
    const summary = summarizeWindow(window);
    const rank = metricExtent(window, 'rank');

    // 日付まで固定する。存在しない日（2026-09-31）を読んでいないことが、値ではなく日で直接言える。
    expect(summary.rank).toEqual({
      first: { date: '2026-09-10', value: 4 },
      last: { date: '2026-09-12', value: 2 },
    });
    expect(summary.rating).toEqual({
      first: { date: '2026-09-10', value: '4.1' },
      last: { date: '2026-09-12', value: '4.4' },
    });
    expect(summary.reviewCount).toEqual({
      diff: 10,
      first: { date: '2026-09-10', value: 100 },
      last: { date: '2026-09-12', value: 110 },
    });
    // 存在しない日の順位 99 を数えれば、それが最悪になる。
    expect(rank.worst).toEqual({ date: '2026-09-10', value: 4 });
    expect(rank.recordedDays).toBe(2);
    expect(describeMetric(window, rank)).not.toContain('99');
  });

  it('終点は並びの位置ではなく日付で決まり、窓の点は終点を超えない', () => {
    // 昇順は前提であり窓の中で検証しないが、事後条件（すべての点が始点以上・終点以下）は並びに依らず守る。
    const trend = [point('2026-09-10'), point('2026-09-13'), point('2026-09-11')];

    const window = mustWindow(trend, 7);

    expect(window.endDate).toBe('2026-09-13');
    expect(window.startDate).toBe('2026-09-07');
    expect([...datesOf(window)].sort()).toEqual(['2026-09-10', '2026-09-11', '2026-09-13']);
  });

  it('日付を解釈できる点が 1 つも無ければ null を返す（推移 0 件と同じ扱い）', () => {
    expect(selectTrendWindow([], 7)).toBeNull();
    expect(selectTrendWindow([], 30)).toBeNull();
    expect(selectTrendWindow([point('2026-02-30'), point('')], 30)).toBeNull();
  });

  it('窓の点は元の昇順のまま並び、入力の配列を書き換えない', () => {
    const trend = Object.freeze([
      Object.freeze(point('2026-09-05')),
      Object.freeze(point('2026-09-08')),
      Object.freeze(point('2026-09-13')),
    ]);

    const window = mustWindow(trend, 7);

    expect(datesOf(window)).toEqual(['2026-09-08', '2026-09-13']);
    expect(trend.map((p) => p.capturedOn)).toEqual(['2026-09-05', '2026-09-08', '2026-09-13']);
  });

  it('同じ推移と期間からは同じ窓が返る', () => {
    const trend = augustTrend(20);

    for (const period of TREND_PERIODS) {
      expect(selectTrendWindow(trend, period)).toEqual(selectTrendWindow(trend, period));
    }
  });

  it('窓の点は、始点以上・終点以下にある推移の点とちょうど一致する（事後条件）', () => {
    // 9 月の奇数日と 8 月の一部（暦日が欠けた 40 日ぶんの範囲）。
    const trend = [
      point('2026-08-05'),
      point('2026-08-14'),
      point('2026-08-15'),
      point('2026-08-16'),
      ...Array.from({ length: 7 }, (_, i) => point(`2026-09-${String(i * 2 + 1).padStart(2, '0')}`)),
    ];

    for (const period of TREND_PERIODS) {
      const window = mustWindow(trend, period);
      // 'YYYY-MM-DD' は文字列の大小が日付の前後に一致するので、窓とは別の式で照合できる。
      const expected = trend
        .map((p) => p.capturedOn)
        .filter((date) => date >= window.startDate && date <= window.endDate);
      expect(datesOf(window), String(period)).toEqual(expected);
      expect(window.endDate, String(period)).toBe('2026-09-13');
    }
  });
});

// --- 既定の窓と現行の画面 -------------------------------------------------------------------

describe('既定の 30 日の窓は、現行の画面と同じ行と要約を与える（要件 8.3）', () => {
  // 着手時点の page.tsx の TrendSection が描いていた式を写したもの。表は推移のすべての点を描き、
  // 要約は先頭と末尾の点から作っていた。null を含まない推移では、値のある最初と最後の日（要件 3.4）と
  // 先頭と末尾が一致するので、既定の窓の要約はこの式と同じ文字列にならなければならない。
  function legacySummary(trend: readonly StoreDetailTrendPoint[]): readonly [string, string, string] {
    const first = trend[0];
    const latest = trend.at(-1);
    const rank = first?.rank != null && latest?.rank != null ? `${first.rank}位 → ${latest.rank}位` : '—';
    const rating = first?.rating != null && latest?.rating != null ? `${first.rating} → ${latest.rating}` : '—';
    const diff =
      latest?.reviewCount != null && first?.reviewCount != null ? latest.reviewCount - first.reviewCount : null;
    const reviewCount = diff === null ? '—' : `${diff > 0 ? '+' : ''}${diff}件`;
    return [rank, rating, reviewCount];
  }

  /** 窓の要約を、画面と同じ書式の文字列にする（書式そのものは 4.1 で page.tsx が持つ）。 */
  function renderedSummary(trend: readonly StoreDetailTrendPoint[]): readonly [string, string, string] {
    const summary = summarizeWindow(mustWindow(trend, DEFAULT_PERIOD));
    const rank = summary.rank === null ? '—' : `${summary.rank.first.value}位 → ${summary.rank.last.value}位`;
    const rating = summary.rating === null ? '—' : `${summary.rating.first.value} → ${summary.rating.last.value}`;
    const diff = summary.reviewCount === null ? null : summary.reviewCount.diff;
    const reviewCount = diff === null ? '—' : `${diff > 0 ? '+' : ''}${diff}件`;
    return [rank, rating, reviewCount];
  }

  const cases: ReadonlyArray<{ readonly name: string; readonly trend: readonly StoreDetailTrendPoint[] }> = [
    {
      name: '店舗詳細の単体テストの応答（2 日）',
      trend: [
        { capturedOn: '2026-07-10', rank: 3, rating: '4.4', reviewCount: 115 },
        { capturedOn: '2026-07-11', rank: 2, rating: '4.5', reviewCount: 120 },
      ],
    },
    { name: 'e2e の固定データと同じ形（保持の上限の 30 日）', trend: augustTrend(30) },
    { name: '日次の取得が止まり、最新の記録日が基準日より古い（20 日）', trend: augustTrend(20) },
    { name: '1 日だけ', trend: augustTrend(1) },
    {
      name: '評価が整数の日（文字列のまま描く）',
      trend: [
        { capturedOn: '2026-07-10', rank: 5, rating: '4.0', reviewCount: 130 },
        { capturedOn: '2026-07-11', rank: 6, rating: '3.9', reviewCount: 125 },
      ],
    },
  ];

  it.each(cases)('$name: 表の行は推移のすべての点と一致する', ({ trend }) => {
    const window = mustWindow(trend, DEFAULT_PERIOD);

    expect(window.points).toEqual(trend);
  });

  it.each(cases)('$name: 要約の 3 組が現行の文字列と一致する', ({ trend }) => {
    expect(renderedSummary(trend)).toEqual(legacySummary(trend));
  });

  it('単体テストの応答では、要約が「3位 → 2位」「4.4 → 4.5」「+5件」になる', () => {
    const [first, second] = cases;
    expect(renderedSummary(first?.trend ?? [])).toEqual(['3位 → 2位', '4.4 → 4.5', '+5件']);
    // 比較の相手が空振りしていないこと（2 件目は 30 点ある）。
    expect(second?.trend).toHaveLength(30);
  });
});

// --- 指標の値 --------------------------------------------------------------------------

describe('metricValue: 指標の値の取り出し', () => {
  it('順位はそのまま数値で返し、null は値なしとする', () => {
    expect(metricValue(point('2026-09-13', { rank: 2 }), 'rank')).toBe(2);
    expect(metricValue(point('2026-09-13', { rank: null }), 'rank')).toBeNull();
  });

  it('評価は文字列から数値に直す', () => {
    const value = metricValue(point('2026-09-13', { rating: '4.3' }), 'rating');

    expect(typeof value).toBe('number');
    expect(value).toBe(4.3);
    expect(metricValue(point('2026-09-13', { rating: '5.0' }), 'rating')).toBe(5);
    expect(metricValue(point('2026-09-13', { rating: '1.0' }), 'rating')).toBe(1);
  });

  it('評価の無い日は、0 ではなく値なしとする（要件 8.4）', () => {
    expect(metricValue(point('2026-09-13', { rating: null }), 'rating')).toBeNull();
    // #266 の正規化の後は届かない形だが、届いても評価 0 として描かない（評価の定義域は 1.0〜5.0）。
    expect(metricValue(point('2026-09-13', { rating: '0.0' }), 'rating')).toBeNull();
    expect(metricValue(point('2026-09-13', { rating: '0' }), 'rating')).toBeNull();
  });

  it('数値として読めない評価は値なしとする', () => {
    for (const rating of ['', ' ', 'abc', 'Infinity', 'NaN']) {
      expect(metricValue(point('2026-09-13', { rating }), 'rating'), JSON.stringify(rating)).toBeNull();
    }
  });

  it('クチコミ数は 0 件も値として返し、null は値なしとする', () => {
    expect(metricValue(point('2026-09-13', { reviewCount: 120 }), 'reviewCount')).toBe(120);
    expect(metricValue(point('2026-09-13', { reviewCount: 0 }), 'reviewCount')).toBe(0);
    expect(metricValue(point('2026-09-13', { reviewCount: null }), 'reviewCount')).toBeNull();
  });
});

// --- 指標の範囲 ------------------------------------------------------------------------

describe('metricExtent: 値のある最初・最後・最良・最悪の日と値', () => {
  const trend = [
    point('2026-09-06', { rank: 1, rating: '4.9', reviewCount: 10 }), // 窓の外（7 日前）
    point('2026-09-07', { rank: 3, rating: '4.1', reviewCount: 100 }),
    point('2026-09-08', { rank: null, rating: null, reviewCount: 0 }),
    point('2026-09-10', { rank: 2, rating: '3.9', reviewCount: null }),
    point('2026-09-11', { rank: 5, rating: '4.4', reviewCount: 130 }),
    point('2026-09-12', { rank: 4, rating: '4.0', reviewCount: 120 }),
    emptyPoint('2026-09-13'), // 終点。どの指標も値が無い
  ];
  // 窓は各テストの中で切り出す。describe の直下で切り出すと、窓の失敗が収集の失敗になり、
  // どのテストが落ちたのかが報告に出ない（「no tests」になる）。
  const week = (): TrendWindow => mustWindow(trend, 7);

  it('順位は小さいほど良く、最後の日は値のある最後の日になる', () => {
    expect(metricExtent(week(), 'rank')).toEqual({
      metric: 'rank',
      first: { date: '2026-09-07', value: 3 },
      last: { date: '2026-09-12', value: 4 },
      best: { date: '2026-09-10', value: 2 },
      worst: { date: '2026-09-11', value: 5 },
      recordedDays: 4,
    });
  });

  it('評価は数値として比べ、大きいほど良い', () => {
    expect(metricExtent(week(), 'rating')).toEqual({
      metric: 'rating',
      first: { date: '2026-09-07', value: 4.1 },
      last: { date: '2026-09-12', value: 4.0 },
      best: { date: '2026-09-11', value: 4.4 },
      worst: { date: '2026-09-10', value: 3.9 },
      recordedDays: 4,
    });
  });

  it('クチコミ数は大きいほど良く、0 件の日も値のある日に数える', () => {
    expect(metricExtent(week(), 'reviewCount')).toEqual({
      metric: 'reviewCount',
      first: { date: '2026-09-07', value: 100 },
      last: { date: '2026-09-12', value: 120 },
      best: { date: '2026-09-11', value: 130 },
      worst: { date: '2026-09-08', value: 0 },
      recordedDays: 4,
    });
  });

  it('窓の外の点は、最良にも最悪にも数えない', () => {
    // 窓の外の 9 月 6 日は順位 1・評価 4.9 で、数えれば最良になる。
    expect(metricExtent(week(), 'rank').best?.value).toBe(2);
    expect(metricExtent(week(), 'rating').best?.value).toBe(4.4);
  });

  it('値が 1 件も無ければ、日と値はすべて null で、値のある日数は 0 になる', () => {
    const empty = mustWindow([emptyPoint('2026-09-12'), emptyPoint('2026-09-13')], 7);

    for (const metric of TREND_METRICS) {
      expect(metricExtent(empty, metric), metric).toEqual({
        metric,
        first: null,
        last: null,
        best: null,
        worst: null,
        recordedDays: 0,
      });
    }
  });

  it('値のある日が 1 日だけなら、最初・最後・最良・最悪は同じ日になる', () => {
    const single = mustWindow([emptyPoint('2026-09-12'), point('2026-09-13', { rank: 6 })], 7);

    const extent = metricExtent(single, 'rank');

    const only = { date: '2026-09-13', value: 6 };
    expect(extent).toEqual({ metric: 'rank', first: only, last: only, best: only, worst: only, recordedDays: 1 });
  });

  it('同じ値が複数日にあるときは、最良と最悪に最も新しい日を採る', () => {
    const ties = mustWindow(
      [
        point('2026-09-09', { rank: 2 }),
        point('2026-09-10', { rank: 4 }),
        point('2026-09-11', { rank: 2 }),
        point('2026-09-12', { rank: 4 }),
        point('2026-09-13', { rank: 3 }),
      ],
      7,
    );

    const extent = metricExtent(ties, 'rank');

    expect(extent.best).toEqual({ date: '2026-09-11', value: 2 });
    expect(extent.worst).toEqual({ date: '2026-09-12', value: 4 });
  });
});

// --- 期間要約 --------------------------------------------------------------------------

describe('summarizeWindow: 「表示期間の変化」の 3 組（要件 3.4・3.5）', () => {
  it('両端に値があれば、窓の最初と最後の点から作る', () => {
    const window = mustWindow(
      [
        point('2026-09-10', { rank: 5, rating: '4.2', reviewCount: 130 }),
        point('2026-09-11', { rank: 4, rating: '4.3', reviewCount: 128 }),
        point('2026-09-13', { rank: 3, rating: '4.4', reviewCount: 125 }),
      ],
      7,
    );

    expect(summarizeWindow(window)).toEqual({
      rank: { first: { date: '2026-09-10', value: 5 }, last: { date: '2026-09-13', value: 3 } },
      rating: { first: { date: '2026-09-10', value: '4.2' }, last: { date: '2026-09-13', value: '4.4' } },
      reviewCount: {
        diff: -5,
        first: { date: '2026-09-10', value: 130 },
        last: { date: '2026-09-13', value: 125 },
      },
    });
  });

  it('値の null を挟むときは、指標ごとに値のある最初と最後の日から作る', () => {
    const window = mustWindow(
      [
        point('2026-09-09', { rank: null, rating: null, reviewCount: 100 }),
        point('2026-09-10', { rank: 4, rating: '4.2', reviewCount: null }),
        point('2026-09-11', { rank: null, rating: null, reviewCount: 108 }),
        point('2026-09-12', { rank: 2, rating: '4.4', reviewCount: 110 }),
        emptyPoint('2026-09-13'),
      ],
      7,
    );

    // 3 組が互いに違う日を読んでいる。順位と評価は 9/10〜9/12、クチコミ数は 9/09〜9/12 である。
    // 組ごとに独立して期間を判定しなければならない理由が、ここに期待値として現れている。
    expect(summarizeWindow(window)).toEqual({
      rank: { first: { date: '2026-09-10', value: 4 }, last: { date: '2026-09-12', value: 2 } },
      rating: { first: { date: '2026-09-10', value: '4.2' }, last: { date: '2026-09-12', value: '4.4' } },
      reviewCount: {
        diff: 10,
        first: { date: '2026-09-09', value: 100 },
        last: { date: '2026-09-12', value: 110 },
      },
    });
  });

  it('全部 null なら、3 組とも値なし（画面は記号を出す）になる', () => {
    const window = mustWindow([emptyPoint('2026-09-12'), emptyPoint('2026-09-13')], 7);

    expect(summarizeWindow(window)).toEqual({ rank: null, rating: null, reviewCount: null });
  });

  it('値のある日が 1 日だけなら、始点と終点は同じ値で、増減は 0 になる', () => {
    const window = mustWindow([emptyPoint('2026-09-12'), point('2026-09-13', { rank: 2, rating: '4.5', reviewCount: 88 })], 7);

    // 始点と終点が同じ日になる。画面はこの組に「記録 9/13」と 1 日だけを添える。
    expect(summarizeWindow(window)).toEqual({
      rank: { first: { date: '2026-09-13', value: 2 }, last: { date: '2026-09-13', value: 2 } },
      rating: { first: { date: '2026-09-13', value: '4.5' }, last: { date: '2026-09-13', value: '4.5' } },
      reviewCount: {
        diff: 0,
        first: { date: '2026-09-13', value: 88 },
        last: { date: '2026-09-13', value: 88 },
      },
    });
  });

  it('評価は表と同じ文字列のまま返す', () => {
    const window = mustWindow([point('2026-09-12', { rating: '4.0' }), point('2026-09-13', { rating: '5.0' })], 7);

    expect(summarizeWindow(window).rating).toEqual({
      first: { date: '2026-09-12', value: '4.0' },
      last: { date: '2026-09-13', value: '5.0' },
    });
  });

  it('評価 0 の日は、要約の始点にも終点にも使わない（要件 8.4）', () => {
    const window = mustWindow(
      [
        point('2026-09-11', { rating: '0.0' }),
        point('2026-09-12', { rating: '4.2' }),
        point('2026-09-13', { rating: '0.0' }),
      ],
      7,
    );

    // 9/11 と 9/13 の 0.0 を読まないので、始点も終点も 9/12 になる。
    expect(summarizeWindow(window).rating).toEqual({
      first: { date: '2026-09-12', value: '4.2' },
      last: { date: '2026-09-12', value: '4.2' },
    });
  });

  it('窓の外の点は、要約の始点に使わない', () => {
    const trend = [
      point('2026-09-06', { rank: 9, rating: '3.1', reviewCount: 10 }), // 7 日前: 窓の外
      point('2026-09-07', { rank: 4, rating: '4.1', reviewCount: 100 }),
      point('2026-09-13', { rank: 3, rating: '4.2', reviewCount: 104 }),
    ];

    // 始点の日そのものが 9/07 であること（9/06 ではないこと）を、値ではなく日で言う。
    expect(summarizeWindow(mustWindow(trend, 7))).toEqual({
      rank: { first: { date: '2026-09-07', value: 4 }, last: { date: '2026-09-13', value: 3 } },
      rating: { first: { date: '2026-09-07', value: '4.1' }, last: { date: '2026-09-13', value: '4.2' } },
      reviewCount: {
        diff: 4,
        first: { date: '2026-09-07', value: 100 },
        last: { date: '2026-09-13', value: 104 },
      },
    });
    // 30 日の窓では同じ点が入り、始点が変わる（期間の切替で要約が追随する）。
    expect(summarizeWindow(mustWindow(trend, 30))).toEqual({
      rank: { first: { date: '2026-09-06', value: 9 }, last: { date: '2026-09-13', value: 3 } },
      rating: { first: { date: '2026-09-06', value: '3.1' }, last: { date: '2026-09-13', value: '4.2' } },
      reviewCount: {
        diff: 94,
        first: { date: '2026-09-06', value: 10 },
        last: { date: '2026-09-13', value: 104 },
      },
    });
  });
});

describe('summaryPeriodNote: 公称の窓と食い違う組にだけ添える期間（要件 3.4 の 2026-09-19 訂正）', () => {
  // 下の窓はいずれも終点が 9/13 で、7 日なら公称の始点は 9/07 になる。
  // 「添える」側と「添えない」側を必ず対で置く。片側だけだと、常に添える実装も、
  // 一度も添えない実装も、どちらかの検査を素通りする。

  it('公称の始点と終点の両方に値があれば、何も添えない', () => {
    const window = mustWindow([point('2026-09-07', { rank: 5 }), point('2026-09-13', { rank: 3 })], 7);

    expect(window.startDate).toBe('2026-09-07');
    expect(summaryPeriodNote(window, summarizeWindow(window).rank)).toBeNull();
  });

  it('始点だけが食い違えば、読んだ期間を添える', () => {
    const window = mustWindow([point('2026-09-10', { rank: 5 }), point('2026-09-13', { rank: 3 })], 7);

    expect(summaryPeriodNote(window, summarizeWindow(window).rank)).toBe('記録 9/10〜9/13');
  });

  it('終点だけが食い違えば、読んだ期間を添える', () => {
    const window = mustWindow(
      [point('2026-09-07', { rank: 5 }), point('2026-09-12', { rank: 3 }), emptyPoint('2026-09-13')],
      7,
    );

    // 終点は「日付を解釈できる最新の記録日」なので、値が無くても 9/13 のままである。
    expect(window.endDate).toBe('2026-09-13');
    expect(summaryPeriodNote(window, summarizeWindow(window).rank)).toBe('記録 9/7〜9/12');
  });

  it('両端とも食い違えば、読んだ期間を添える', () => {
    const window = mustWindow(
      [point('2026-09-10', { rank: 5 }), point('2026-09-12', { rank: 3 }), emptyPoint('2026-09-13')],
      7,
    );

    expect(summaryPeriodNote(window, summarizeWindow(window).rank)).toBe('記録 9/10〜9/12');
  });

  it('読んだ日が 1 日しか無ければ、同じ日を 2 度書かずにその 1 日だけを書く', () => {
    const window = mustWindow([emptyPoint('2026-09-07'), point('2026-09-13', { rank: 2 })], 7);

    expect(summaryPeriodNote(window, summarizeWindow(window).rank)).toBe('記録 9/13');
  });

  it('値が 1 件も無い組には、読んだ日そのものが無いので添えない', () => {
    const window = mustWindow([emptyPoint('2026-09-12'), emptyPoint('2026-09-13')], 7);

    expect(summarizeWindow(window).rank).toBeNull();
    expect(summaryPeriodNote(window, summarizeWindow(window).rank)).toBeNull();
  });

  it('同じ窓でも組ごとに結果が違う（判定は組ごとに独立している）', () => {
    const window = mustWindow(
      [
        point('2026-09-07', { rank: null, rating: null, reviewCount: 100 }),
        point('2026-09-10', { rank: 5, rating: '4.1', reviewCount: 102 }),
        point('2026-09-13', { rank: 3, rating: '4.4', reviewCount: 110 }),
      ],
      7,
    );
    const summary = summarizeWindow(window);

    // 順位と評価は 9/10 からしか値が無い。クチコミ数は公称の窓のとおり 9/07〜9/13 を読んでいる。
    // 3 組をまとめて 1 つの注記にすると、どちらかの組が嘘になる。
    expect(summaryPeriodNote(window, summary.rank)).toBe('記録 9/10〜9/13');
    expect(summaryPeriodNote(window, summary.rating)).toBe('記録 9/10〜9/13');
    expect(summaryPeriodNote(window, summary.reviewCount)).toBeNull();
  });

  it('期間を切り替えると、同じ推移でも結果が変わる', () => {
    const trend = [
      point('2026-09-07', { rank: 5, rating: '4.1', reviewCount: 100 }),
      point('2026-09-13', { rank: 3, rating: '4.4', reviewCount: 110 }),
    ];
    const sevenDays = mustWindow(trend, 7);
    const thirtyDays = mustWindow(trend, 30);

    // 7 日の窓は公称の始点が 9/07 で、読んだ最初の日と一致する。
    expect(summaryPeriodNote(sevenDays, summarizeWindow(sevenDays).rank)).toBeNull();
    // 30 日の窓は公称の始点が 8/15 まで遡るので、同じ推移でも食い違う。
    expect(thirtyDays.startDate).toBe('2026-08-15');
    expect(summaryPeriodNote(thirtyDays, summarizeWindow(thirtyDays).rank)).toBe('記録 9/7〜9/13');
  });
});

// --- 表示整形 --------------------------------------------------------------------------

describe('表示整形', () => {
  it('指標名', () => {
    expect(metricName('rank')).toBe('順位');
    expect(metricName('rating')).toBe('評価');
    expect(metricName('reviewCount')).toBe('クチコミ数');
  });

  it('値は、順位に「位」、評価を小数 1 桁、クチコミ数に「件」を付けて示す', () => {
    expect(formatMetricValue('rank', 2)).toBe('2位');
    expect(formatMetricValue('rating', 4.3)).toBe('4.3');
    expect(formatMetricValue('rating', 4)).toBe('4.0');
    expect(formatMetricValue('rating', 5)).toBe('5.0');
    expect(formatMetricValue('reviewCount', 123)).toBe('123件');
    expect(formatMetricValue('reviewCount', 0)).toBe('0件');
  });

  it('目盛りは、順位に「位」、評価を小数 1 桁で示し、クチコミ数は数だけを示す', () => {
    expect(formatTickValue('rank', 2)).toBe('2位');
    expect(formatTickValue('rating', 4.5)).toBe('4.5');
    expect(formatTickValue('rating', 4)).toBe('4.0');
    expect(formatTickValue('reviewCount', 120)).toBe('120');
    expect(formatTickValue('reviewCount', 0)).toBe('0');
  });

  it('短い日付は、月と日を先頭の 0 なしで「M/D」にする', () => {
    expect(formatShortDate('2026-09-13')).toBe('9/13');
    expect(formatShortDate('2026-09-03')).toBe('9/3');
    expect(formatShortDate('2026-12-01')).toBe('12/1');
    expect(formatShortDate('2027-01-31')).toBe('1/31');
  });

  it('解釈できない日付は、書き換えずにそのまま返す', () => {
    expect(formatShortDate('2026/09/13')).toBe('2026/09/13');
  });
});

// --- 説明文 ----------------------------------------------------------------------------

describe('describeMetric: グラフの説明文（要件 5.1・3.6）', () => {
  // 始点（9 月 7 日）には記録が無く、終点（9 月 13 日）は選んだ指標の値が無い。窓の外の 9 月 6 日には
  // どの指標も極端な値を置いた。説明文が公称の期間・値のある最初と最後の日・窓の中だけを使うことを、
  // 1 つの窓で同時に確かめる。
  const trend = [
    point('2026-09-06', { rank: 9, rating: '3.0', reviewCount: 7 }), // 窓の外
    point('2026-09-08', { rank: 4, rating: '4.1', reviewCount: 100 }),
    point('2026-09-09', { rank: null, rating: null, reviewCount: 104 }),
    point('2026-09-10', { rank: 1, rating: '4.5', reviewCount: 104 }),
    point('2026-09-11', { rank: 5, rating: '3.9', reviewCount: 111 }),
    point('2026-09-12', { rank: 2, rating: '4.2', reviewCount: 118 }),
    point('2026-09-13', { rank: null, rating: null, reviewCount: 120 }),
  ];
  /** この推移から窓を切り出し、指標の説明文を返す（窓は各テストの中で切り出す。上の metricExtent の注記を参照）。 */
  function describeFor(metric: TrendMetric, periodDays: TrendPeriodDays = 7): string {
    const window = mustWindow(trend, periodDays);
    return describeMetric(window, metricExtent(window, metric));
  }

  it('順位の説明文は、指標・公称の期間・最初と最後の記録・最高と最低・最新の値と日付をこの順で持つ', () => {
    expect(describeFor('rank')).toBe(
      '順位の推移、9月7日から9月13日まで。最初の記録は4位、最後の記録は2位。最高は1位、最低は5位。最新は2位（9月12日）。',
    );
  });

  it('評価の説明文は、値を小数 1 桁で示し、「★」を付けない', () => {
    const text = describeFor('rating');

    expect(text).toBe(
      '評価の推移、9月7日から9月13日まで。最初の記録は4.1、最後の記録は4.2。最高は4.5、最低は3.9。最新は4.2（9月12日）。',
    );
    expect(text).not.toContain('★');
  });

  it('クチコミ数の説明文は、最新の値の日付に終点を使う（終点に値があるとき）', () => {
    expect(describeFor('reviewCount')).toBe(
      'クチコミ数の推移、9月7日から9月13日まで。最初の記録は100件、最後の記録は120件。最高は120件、最低は100件。最新は120件（9月13日）。',
    );
  });

  it('説明文の構成要素は、窓と指標の範囲から取った値と一致する', () => {
    const window = mustWindow(trend, 7);
    for (const metric of TREND_METRICS) {
      const extent = metricExtent(window, metric);
      const text = describeMetric(window, extent);
      const { first, last, best, worst } = extent;
      if (first === null || last === null || best === null || worst === null) {
        throw new Error(`${metric} の値が無い（この窓ではどの指標にも値がある）`);
      }
      const format = (value: number): string => formatMetricValue(metric, value);

      expect(text, metric).toContain(metricName(metric));
      expect(text, metric).toContain('9月7日から9月13日まで');
      expect(text, metric).toContain(`最初の記録は${format(first.value)}`);
      expect(text, metric).toContain(`最後の記録は${format(last.value)}`);
      expect(text, metric).toContain(`最高は${format(best.value)}`);
      expect(text, metric).toContain(`最低は${format(worst.value)}`);
      expect(text, metric).toContain(`最新は${format(last.value)}（`);
      // 窓の外の値は含めない。
      expect(text, metric).not.toContain(format(metric === 'rank' ? 9 : metric === 'rating' ? 3.0 : 7));
    }
  });

  it('値が 1 件も無い指標では、期間にその指標の記録が無いことを述べる（要件 1.10）', () => {
    const empty = mustWindow([point('2026-09-12', { rating: null }), point('2026-09-13', { rating: null })], 7);

    expect(describeMetric(empty, metricExtent(empty, 'rating'))).toBe(
      '評価の推移、9月7日から9月13日まで。この期間は評価の記録がありません。',
    );
  });

  it('期間を切り替えると、説明文の始点も公称の始点へ変わる', () => {
    const text = describeFor('rank', 30);

    expect(text).toContain('8月15日から9月13日まで');
    // 30 日の窓には 9 月 6 日が入るので、最初の記録と最低が変わる。
    expect(text).toContain('最初の記録は9位');
    expect(text).toContain('最低は9位');
  });

  it.each<TrendMetric>(['rank', 'rating', 'reviewCount'])(
    '%s: 既存の画面の文言（近隣N店中・Google 評価・表示期間の変化）を重ねない',
    (metric) => {
      const text = describeFor(metric);

      for (const phrase of ['近隣', 'Google 評価', '表示期間の変化', '自店の評価', '新着クチコミ']) {
        expect(text, phrase).not.toContain(phrase);
      }
    },
  );
});
