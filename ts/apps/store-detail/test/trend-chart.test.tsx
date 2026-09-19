// @vitest-environment jsdom
// store-detail-trend-dashboard task 3.1（Issue #265）: 推移グラフの部品（app/store/trend-chart.tsx）を検証する。
//
// グラフは figure として描き、見える figcaption に指標名・期間・順位の向き・最新の値と日付を置く。
// 図形は、2 枚の SVG を同じ描画領域に重ねて描く（同 spec の research.md の決定 D2）。
// - 線の層: viewBox を持ち、縦横の比を保たずに伸縮する。罫線と線を描き、グラフの名前（説明文）を持つ。
// - 点の層: viewBox を持たない。百分率座標の circle で、印と端点の地色の輪を描く。読み上げからは隠す。
//   最新値の文字も、この層の text として描く（2026-09-16 改定。HTML のラベルでは、30 日の窓で線が字を
//   貫くことを実測した）。目盛りと日付は HTML の文字として百分率の位置へ置き、読み上げからは隠す。
//
// この部品は、店舗詳細の面で色を書く唯一の場所である。そこで、使う色のクラスを決定 D6 の 7 つに固定する。
// style に書いてよいのは top と left の百分率だけとする。検査の範囲はこの部品の figure の中に限る
// （Base UI の隠し radio もインライン style を持つので、ページ全体で取ると必ず赤になる）。
//
// 期待する文言・日付・目盛りは、リテラルで書く。説明文は、代表の状態をリテラルで照合し、加えて
// すべての状態で describeMetric の結果と照合する（部品が説明文を別の方法で組み立て直していないことを
// 確かめるため）。
//
// このファイルは部品単体の検査だけを持つ。ページ全体での切替・一貫性の検査は、タスク 4.1 以降の
// ページ全体のテストファイルが持つ。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TrendChart, type TrendChartProps } from '../app/store/trend-chart';
import type { StoreDetailTrendPoint } from '../lib/data';
import {
  TREND_METRICS,
  TREND_PERIODS,
  describeMetric,
  metricExtent,
  selectTrendWindow,
  type TrendPeriodDays,
  type TrendWindow,
} from '../lib/trend-view';
import { announcedText } from './live-region';

afterEach(() => {
  cleanup();
});

// --- テスト用の推移 ------------------------------------------------------------------------

/** 既定では 3 指標とも値を持つ点。上書きした項目だけが変わる。 */
function point(
  capturedOn: string,
  values: Partial<Omit<StoreDetailTrendPoint, 'capturedOn'>> = {},
): StoreDetailTrendPoint {
  return { capturedOn, rank: 3, rating: '4.3', reviewCount: 120, ...values };
}

/** 2026 年 8 月の日付（入力を作るためだけに使う）。 */
function augustDate(day: number): string {
  return `2026-08-${String(day).padStart(2, '0')}`;
}

function mustWindow(trend: readonly StoreDetailTrendPoint[], periodDays: TrendPeriodDays): TrendWindow {
  const window = selectTrendWindow(trend, periodDays);
  if (window === null) {
    throw new Error('窓が null になりました（日付を解釈できる点があるはずです）');
  }
  return window;
}

interface ChartCase {
  readonly name: string;
  readonly props: TrendChartProps;
}

/**
 * 7 日・順位。窓の外（8/20）に 9 位の点を置き、8/28 は値が無い。線は 2 本に切れ、7 日なので全点に印が付く。
 * 端点は 8/31 の 2 位で、縦の位置は 25%（上端から 4 分の 1）。
 */
const RANK_7: ChartCase = {
  name: '7日・順位（線 2 本・全点に印）',
  props: {
    window: mustWindow(
      [
        point(augustDate(20), { rank: 9 }),
        point(augustDate(25), { rank: 4 }),
        point(augustDate(26), { rank: 3 }),
        point(augustDate(27), { rank: 3 }),
        point(augustDate(28), { rank: null, rating: null }),
        point(augustDate(29), { rank: 3 }),
        point(augustDate(30), { rank: 2 }),
        point(augustDate(31), { rank: 2 }),
      ],
      7,
    ),
    metric: 'rank',
    rankTotal: 5,
  },
};

/** 7 日・順位。端点が 1 位で上端に張りつく（縦 0%。最新値の文字を点の下へ回す）。 */
const RANK_TOP_7: ChartCase = {
  name: '7日・順位（端点が上端）',
  props: {
    window: mustWindow(
      [2, 2, 2, 2, 2, 2, 1].map((rank, index) => point(augustDate(25 + index), { rank })),
      7,
    ),
    metric: 'rank',
    rankTotal: 5,
  },
};

/**
 * 7 日・順位。記録が 8/28 から始まる店。横軸は公称の期間（8/25〜8/31）に固定するので、8/25〜8/27 は
 * 空白として描き、最初の点は横の 50% に来る。期間の始点の文字は、最初の記録日（8/28）ではなく 8/25 である。
 */
const RANK_SHORT_7: ChartCase = {
  name: '7日・順位（記録が期間の途中から始まる）',
  props: {
    window: mustWindow(
      [28, 29, 30, 31].map((day) => point(augustDate(day), { rank: 3 })),
      7,
    ),
    metric: 'rank',
    rankTotal: 5,
  },
};

/**
 * 7 日・順位。終点の 8/31 は評価と順位が無く、クチコミ数だけがある（窓の終点は 8/31 のまま）。
 * 順位の値がある最後の日は 8/30 なので、現在値の日付（8/30）と窓の終点（8/31）が食い違う。
 * 端点は 8/30 の 2 位で、横の位置は公称の始点から数えて 5 日目、縦の位置は 25%。
 */
const RANK_END_GAP_7: ChartCase = {
  name: '7日・順位（終点の日に順位の値が無い）',
  props: {
    window: mustWindow(
      [
        ...[4, 4, 3, 3, 3, 2].map((rank, index) => point(augustDate(25 + index), { rank })),
        point(augustDate(31), { rank: null, rating: null, reviewCount: 130 }),
      ],
      7,
    ),
    metric: 'rank',
    rankTotal: 5,
  },
};

/**
 * 30 日・順位。9 位まで落ちた後に持ち直し、端点は 8/31 の 2 位。下端 9 位の軸で、端点の縦の位置は
 * 12.5% である。タスク 5.4 で「字の下を複数の区間が通る」ことを実測した状態がこれに当たる
 * （30 日の窓は 1 日の間隔が字の幅より狭い）。
 */
const RANK_NEAR_TOP_30: ChartCase = {
  name: '30日・順位（端点が上端寄り・字の下を線が通る）',
  props: {
    window: mustWindow(
      Array.from({ length: 30 }, (_, index) => point(augustDate(2 + index), { rank: Math.min(9, 31 - index) })),
      30,
    ),
    metric: 'rank',
    rankTotal: 5,
  },
};

/** 7 日・順位。端点は 8/31 の 4 位で、下端 5 位の軸では縦 75%（下端寄り）。 */
const RANK_LOW_END_7: ChartCase = {
  name: '7日・順位（端点が下端寄り）',
  props: {
    window: mustWindow(
      [2, 2, 2, 2, 2, 3, 4].map((rank, index) => point(augustDate(25 + index), { rank })),
      7,
    ),
    metric: 'rank',
    rankTotal: 5,
  },
};

/**
 * 7 日・順位。記録は 8/25（9 位）・8/28（1 位）・8/31（2 位）の 3 日だけで、どの 2 日も暦日で連続
 * しないので線が 1 本も無い（端点が孤立する）。下端 9 位の軸で、端点の縦の位置は 12.5% である。
 */
const RANK_ISOLATED_END_7: ChartCase = {
  name: '7日・順位（端点が孤立し、線が 1 本も無い）',
  props: {
    window: mustWindow(
      [
        point(augustDate(25), { rank: 9 }),
        point(augustDate(28), { rank: 1 }),
        point(augustDate(31), { rank: 2 }),
      ],
      7,
    ),
    metric: 'rank',
    rankTotal: 5,
  },
};

/** 30 日・クチコミ数。8/2〜8/31 の 30 日すべてに値があり、線は 1 本、印は端点だけ。 */
const REVIEWS_30: ChartCase = {
  name: '30日・クチコミ数（線 1 本・印は端点だけ）',
  props: {
    window: mustWindow(
      Array.from({ length: 30 }, (_, index) => point(augustDate(2 + index), { reviewCount: 100 + index })),
      30,
    ),
    metric: 'reviewCount',
    rankTotal: 5,
  },
};

/**
 * 30 日・クチコミ数。7 件から 36 件まで毎日 1 件ずつ増える。軸は 0〜40 件（間隔 10 件）になり、端点
 * （36 件）の縦の位置は 10% である。上に置く余地はぎりぎり残る（下限は 7.64%）。
 */
const REVIEWS_NEAR_TOP_30: ChartCase = {
  name: '30日・クチコミ数（端点が上端寄り）',
  props: {
    window: mustWindow(
      Array.from({ length: 30 }, (_, index) => point(augustDate(2 + index), { reviewCount: 7 + index })),
      30,
    ),
    metric: 'reviewCount',
    rankTotal: 5,
  },
};

/**
 * 30 日・クチコミ数。9 件から 38 件まで毎日 1 件ずつ増える。軸は同じ 0〜40 件で、端点（38 件）の
 * 縦の位置は 5% になる。上に置くと字が描画領域の外へ出るので、点の下へ回す状態である。
 */
const REVIEWS_TOP_30: ChartCase = {
  name: '30日・クチコミ数（端点が上端に張りつく）',
  props: {
    window: mustWindow(
      Array.from({ length: 30 }, (_, index) => point(augustDate(2 + index), { reviewCount: 9 + index })),
      30,
    ),
    metric: 'reviewCount',
    rankTotal: 5,
  },
};

/** 30 日・評価。値があるのは 8/31 の 1 日だけ（線は無く、端点だけを描く）。 */
const RATING_SINGLE_30: ChartCase = {
  name: '30日・評価（値が 1 日だけ）',
  props: {
    window: mustWindow(
      Array.from({ length: 30 }, (_, index) =>
        index === 29 ? point(augustDate(31)) : point(augustDate(2 + index), { rank: null, rating: null }),
      ),
      30,
    ),
    metric: 'rating',
    rankTotal: null,
  },
};

/** 評価と順位の値が期間内に 1 件も無い窓（評価の無い日は、順位とともに null で届く）。 */
const NO_RATING_WINDOW = mustWindow(
  Array.from({ length: 7 }, (_, index) => point(augustDate(25 + index), { rank: null, rating: null })),
  7,
);

/** 評価の値が無い期間（グラフの代わりに文言を出す）。 */
const RATING_EMPTY_7: ChartCase = {
  name: '7日・評価（値が無い）',
  props: { window: NO_RATING_WINDOW, metric: 'rating', rankTotal: 5 },
};

/**
 * 3 指標とも値が揺れる 30 日の推移（8/15 だけ評価と順位が無い）。期間と指標のすべての組み合わせを
 * 回すのに使う。
 */
const RICH_TREND: readonly StoreDetailTrendPoint[] = Array.from({ length: 30 }, (_, index) =>
  index === 13
    ? point(augustDate(2 + index), { rank: null, rating: null, reviewCount: 100 + index })
    : point(augustDate(2 + index), {
        rank: 2 + (index % 3),
        rating: (4 + (index % 5) / 10).toFixed(1),
        reviewCount: 100 + index,
      }),
);

/** 期間 × 指標のすべての組み合わせ（数は TREND_PERIODS と TREND_METRICS から導く）。 */
const COMBINATIONS: readonly ChartCase[] = TREND_PERIODS.flatMap((periodDays) =>
  TREND_METRICS.map((metric) => ({
    name: `推移あり・${periodDays}日・${metric}`,
    props: { window: mustWindow(RICH_TREND, periodDays), metric, rankTotal: 5 },
  })),
);

/** グラフを描く状態のすべて。 */
const CHART_CASES: readonly ChartCase[] = [
  RANK_7,
  RANK_TOP_7,
  RANK_SHORT_7,
  RANK_END_GAP_7,
  RANK_NEAR_TOP_30,
  RANK_LOW_END_7,
  RANK_ISOLATED_END_7,
  REVIEWS_30,
  REVIEWS_NEAR_TOP_30,
  REVIEWS_TOP_30,
  RATING_SINGLE_30,
  ...COMBINATIONS,
];

/** 文言だけを出す状態も含めた、すべての状態。 */
const ALL_CASES: readonly ChartCase[] = [...CHART_CASES, RATING_EMPTY_7];

// --- 取り出しの補助 ------------------------------------------------------------------------

function renderChart(props: TrendChartProps): { readonly container: HTMLElement; readonly figure: HTMLElement } {
  const { container } = render(<TrendChart {...props} />);
  const figure = container.querySelector('figure');
  if (figure === null) {
    throw new Error('figure が描かれていません');
  }
  return { container, figure };
}

/** class 属性を空白で割ったトークン。SVG の要素でも取れるよう、className ではなく属性を読む。 */
function classTokens(element: Element): readonly string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/).filter((token) => token.length > 0);
}

/** 起点の要素とその子孫（querySelectorAll は起点を含まないので足す）。 */
function selfAndDescendants(root: Element, selector: string): readonly Element[] {
  return [...(root.matches(selector) ? [root] : []), ...Array.from(root.querySelectorAll(selector))];
}

/** 線の層（viewBox を持つ SVG）。 */
function lineLayer(figure: HTMLElement): SVGSVGElement {
  const layers = figure.querySelectorAll<SVGSVGElement>('svg[viewBox]');
  expect(layers).toHaveLength(1);
  return layers[0]!;
}

/** 点の層（viewBox を持たない SVG）。 */
function pointLayer(figure: HTMLElement): SVGSVGElement {
  const layers = figure.querySelectorAll<SVGSVGElement>('svg:not([viewBox])');
  expect(layers).toHaveLength(1);
  return layers[0]!;
}

/**
 * 最新値の文字 = 点の層の SVG に描く `<text>`（2026-09-16 改定。HTML では描かない）。
 */
function latestValueText(figure: HTMLElement): SVGTextElement {
  const texts = pointLayer(figure).querySelectorAll<SVGTextElement>('text');
  expect(texts).toHaveLength(1);
  return texts[0]!;
}

/**
 * 最新値の文字を、点の上と下のどちらに置いたか。基準線の移動（`dy`）の向きで読む。基準線は字面の
 * 下端なので、上に置くときは負、下に置くときは正になる。
 */
function labelPlacement(figure: HTMLElement): 'above' | 'below' {
  const dy = Number(latestValueText(figure).getAttribute('dy'));
  expect(Number.isFinite(dy), 'dy が数でない（点の高さから動かす量を SVG の属性で与える）').toBe(true);
  expect(dy, 'dy が 0 だと、字面が点に重なる').not.toBe(0);
  return dy < 0 ? 'above' : 'below';
}

/** 'top: 25%; left: 3%' を [プロパティ, 値] の並びに割る。 */
function styleDeclarations(styleText: string): readonly (readonly [string, string])[] {
  return styleText
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.length > 0)
    .map((declaration) => {
      const colon = declaration.indexOf(':');
      return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()] as const;
    });
}

/** style の top の百分率を数で取り出す。 */
function topPercent(element: Element): number {
  const top = styleDeclarations(element.getAttribute('style') ?? '').find(([property]) => property === 'top');
  expect(top, `top を持たない: ${element.outerHTML}`).toBeDefined();
  return parseFloat(top![1]);
}

/** 百分率の座標属性（'33.33%'）を数で取り出す。 */
function percentAttribute(element: Element, name: string): number {
  const value = element.getAttribute(name) ?? '';
  expect(value, `${name} が百分率でない: ${element.outerHTML}`).toMatch(/%$/);
  return parseFloat(value);
}

/** 横の位置の設計の式（日の番号 ÷ (期間の日数 − 1) × 100）。 */
function xOf(day: number, periodDays: number): number {
  return (day / (periodDays - 1)) * 100;
}

// --- 色の語彙（決定 D6） --------------------------------------------------------------------

/**
 * この部品が書いてよい色のクラス。本文色・区切り線色・カードの地色・補助文字色の 4 色と、塗らない指定。
 * カードの地色は、端点の輪（塗り）と最新値の文字の縁取り（線）の 2 通りで使う。
 */
const CHART_COLOR_CLASSES = [
  'fill-card',
  'fill-current',
  'fill-none',
  'stroke-border',
  'stroke-card',
  'stroke-current',
  'text-muted-foreground',
] as const;

/** `text-` で始まるが色ではないクラス: 文字サイズの段（text-xs〜text-2xl）と揃え。 */
const TEXT_SIZE_STEPS: ReadonlySet<string> = new Set(['text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl', 'text-2xl']);
const TEXT_ALIGNMENTS: ReadonlySet<string> = new Set([
  'text-left',
  'text-center',
  'text-right',
  'text-justify',
  'text-start',
  'text-end',
]);
/**
 * `text-` で始まるが色ではないクラス: 行の分け方（Issue #286 項目 3 で空状態の部品が持つようになった）。
 * 段と揃えに続く第 3 の分類であり、色の語彙を緩めるための除外ではない。
 */
const TEXT_WRAPPING: ReadonlySet<string> = new Set(['text-wrap', 'text-nowrap', 'text-balance', 'text-pretty']);

/**
 * 色のユーティリティか。`stroke-`・`fill-` で始まるものはすべて、`text-` で始まるものは文字サイズの段・
 * 揃え・行の分け方を除いたものを、色として数える（design の「色の語彙」の抜き出しの規則）。
 * `hover:` などの前置の変種は外してから判定し、抜き出す値は前置を含めたトークンのままにする
 * （変種つきの色を、変種なしの同名と同じものとして数えないため）。
 */
function isColorUtility(token: string): boolean {
  const utility = token.slice(token.lastIndexOf(':') + 1).replace(/^!/, '');
  if (utility.startsWith('stroke-') || utility.startsWith('fill-')) {
    return true;
  }
  return (
    utility.startsWith('text-') &&
    !TEXT_SIZE_STEPS.has(utility) &&
    !TEXT_ALIGNMENTS.has(utility) &&
    !TEXT_WRAPPING.has(utility)
  );
}

/** 起点とその子孫の class から、色のユーティリティをすべて抜き出す（重複を含む）。 */
function colorUtilities(root: Element): readonly string[] {
  return selfAndDescendants(root, '[class]').flatMap((element) => classTokens(element).filter(isColorUtility));
}

function sortedSet(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

// --- 焦点 ---------------------------------------------------------------------------------

/** 焦点を受け取りうる要素。グラフの中には 1 つも置かない（要件 5.2）。 */
const FOCUSABLE_SELECTOR = [
  'a',
  'area',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'object',
  'embed',
  'summary',
  'audio',
  'video',
  '[tabindex]',
  '[contenteditable]',
  '[autofocus]',
].join(', ');

// --- テスト ------------------------------------------------------------------------------

describe('TrendChart（store-detail-trend-dashboard task 3.1・Issue #265）', () => {
  describe('意味論', () => {
    it('説明文をグラフの名前として取れ、名前を持つのは線の層だけである（Req 5.1）', () => {
      const { figure } = renderChart(RANK_7.props);

      const chart = screen.getByRole('img', {
        name: '順位の推移、8月25日から8月31日まで。最初の記録は4位、最後の記録は2位。最高は2位、最低は4位。最新は2位（8月31日）。',
      });
      // 名前を持つのは、線の層（viewBox を持つ SVG）である。
      expect(chart).toBe(lineLayer(figure));
      // 読み上げ上の画像は 1 つだけ。点の層は名前も役割も持たず、読み上げから隠す（二重に読ませない）。
      expect(within(figure).getAllByRole('img', { hidden: true })).toHaveLength(1);
      const points = pointLayer(figure);
      expect(points.getAttribute('aria-hidden')).toBe('true');
      expect(points.getAttribute('role')).toBeNull();
      expect(points.getAttribute('aria-label')).toBeNull();
    });

    it('クチコミ数の説明文も、指標・期間・始点と終点の値・最高と最低・現在値と日付を持つ（Req 5.1）', () => {
      renderChart(REVIEWS_30.props);
      expect(
        screen.getByRole('img', {
          name: 'クチコミ数の推移、8月2日から8月31日まで。最初の記録は100件、最後の記録は129件。最高は129件、最低は100件。最新は129件（8月31日）。',
        }),
      ).toBeDefined();
    });

    it('すべての状態で、グラフの名前が describeMetric の説明文と一致する（Req 5.1）', () => {
      let visited = 0;
      for (const item of CHART_CASES) {
        const { window, metric } = item.props;
        const expected = describeMetric(window, metricExtent(window, metric));
        const { figure } = renderChart(item.props);
        expect(within(figure).getByRole('img', { name: expected }), item.name).toBe(lineLayer(figure));
        cleanup();
        visited += 1;
      }
      // 期間と指標の組み合わせを回り切ったこと（空振り対策）。
      expect(COMBINATIONS).toHaveLength(TREND_PERIODS.length * TREND_METRICS.length);
      expect(visited).toBe(CHART_CASES.length);
    });

    it('figcaption に、指標名・期間の始点と終点・順位の向き・最新の値と日付を見える文字で置く（Req 1.3, 1.11, 3.6）', () => {
      const cases = [
        { item: RANK_7, lines: ['順位の推移（上ほど上位）', '8/25〜8/31', '最新 2位（8/31）'] },
        { item: REVIEWS_30, lines: ['クチコミ数の推移', '8/2〜8/31', '最新 129件（8/31）'] },
        // 期間の始点は、窓の中で最初に記録された日ではなく、公称の始点である。
        { item: RANK_SHORT_7, lines: ['順位の推移（上ほど上位）', '8/25〜8/31', '最新 3位（8/31）'] },
        // 最新の日付は、窓の終点（8/31）ではなく、選択中の指標の値がある最後の日（8/30）である（Req 3.6）。
        { item: RANK_END_GAP_7, lines: ['順位の推移（上ほど上位）', '8/25〜8/31', '最新 2位（8/30）'] },
        { item: RATING_SINGLE_30, lines: ['評価の推移', '8/2〜8/31', '最新 4.3（8/31）'] },
      ] as const;
      for (const { item, lines } of cases) {
        const { figure } = renderChart(item.props);
        const captions = figure.querySelectorAll('figcaption');
        expect(captions, item.name).toHaveLength(1);
        const rows = Array.from(captions[0]!.children);
        expect(rows.map((line) => announcedText(line)), item.name).toEqual(lines);
        // 段: 題だけが本文の段で、期間と現在値は 1 つ下の段に置く（2026-09-18 の画面レビュー）。
        // 下げないと、補助の 3 行が指標ラベルの dt（text-sm）より大きくなり、声の大きさが情報の重みと
        // 逆になる。期間（日付）は §7.19 の役割割当どおり補助文字色で描く。
        // （題の段落は class を持たない。太字は中の span が持つ。）
        expect(rows.map((line) => classTokens(line)), item.name).toEqual([
          [],
          ['text-sm', 'text-muted-foreground'],
          ['text-sm'],
        ]);
        cleanup();
      }
    });

    it('目盛り・日付・最新値の文字は読み上げから隠し、figure が読み上げるのは figcaption だけにする（Req 1.11, 1.12, 5.1）', () => {
      const { figure } = renderChart(RANK_7.props);
      const caption = figure.querySelector('figcaption')!;

      // 文字は描かれている（見える）。
      const visible = figure.textContent ?? '';
      for (const label of ['1位', '5位', '8/25', '8/31']) {
        expect(visible).toContain(label);
      }
      // 読み上げられるのは figcaption の文だけ（目盛り・日付・最新値は、SVG の名前と表が同じ内容を持つ）。
      expect(announcedText(figure)).toBe(announcedText(caption));
      expect(announcedText(caption).length).toBeGreaterThan(0);
    });

    it('ポインタを重ねたときにだけ現れる浮遊表示を持たない（Req 1.13）', () => {
      for (const item of ALL_CASES) {
        const { container } = render(<TrendChart {...item.props} />);
        // 走査した要素が 1 件以上あること（何も描かない実装で緑にならないため）。
        expect(container.querySelectorAll('*').length, item.name).toBeGreaterThan(0);
        // SVG の title 要素と title 属性は、ブラウザがポインタを重ねたときに浮遊表示を出す。
        expect(container.querySelectorAll('title, [title], [role="tooltip"]'), item.name).toHaveLength(0);
        cleanup();
      }
    });
  });

  describe('焦点', () => {
    it('SVG の中にも外側の文字にも、焦点を受け取る要素を置かない（Req 5.2）', () => {
      let scannedSvgs = 0;
      for (const item of ALL_CASES) {
        const { container } = render(<TrendChart {...item.props} />);
        // 走査した要素が 1 件以上あること（空振り対策）。
        expect(container.querySelectorAll('*').length, item.name).toBeGreaterThan(0);
        expect(container.querySelectorAll(FOCUSABLE_SELECTOR), item.name).toHaveLength(0);
        for (const svg of Array.from(container.querySelectorAll('svg'))) {
          expect(svg.querySelectorAll('*').length, item.name).toBeGreaterThan(0);
          expect(selfAndDescendants(svg, FOCUSABLE_SELECTOR), item.name).toHaveLength(0);
          scannedSvgs += 1;
        }
        cleanup();
      }
      // グラフを描く状態では、線の層と点の層の 2 枚を必ず走査している。
      expect(scannedSvgs).toBe(CHART_CASES.length * 2);
    });
  });

  describe('色の語彙（決定 D6）', () => {
    it('抜き出しの規則は、文字サイズの段・揃え・行の分け方を除き、色だけを前置の変種ごと抜き出す（自己検証）', () => {
      const fixture = document.createElement('div');
      fixture.innerHTML = [
        '<div class="text-xs tabular-nums text-muted-foreground">',
        '  <span class="absolute text-right text-2xl">1</span>',
        '  <p class="sm:text-lg hover:text-foreground">2</p>',
        '  <p class="text-balance text-pretty text-nowrap">3</p>',
        '  <svg class="size-full overflow-visible"><line class="stroke-border"></line><circle class="fill-card"></circle></svg>',
        '</div>',
      ].join('');
      // SVG の要素の class も抜き出せていること（className は SVG では文字列でないため、属性で読む）。
      expect(fixture.querySelector('circle')?.namespaceURI).toBe('http://www.w3.org/2000/svg');

      const extracted = colorUtilities(fixture);
      expect(sortedSet(extracted)).toEqual(['fill-card', 'hover:text-foreground', 'stroke-border', 'text-muted-foreground']);
      for (const excluded of [
        'text-xs',
        'text-right',
        'text-2xl',
        'sm:text-lg',
        'tabular-nums',
        'size-full',
        'text-balance',
        'text-pretty',
        'text-nowrap',
      ]) {
        expect(extracted).not.toContain(excluded);
      }
    });

    it('線・罫線・印・端点の輪・最新値の縁取り・目盛りを描く状態で、色のクラスの集合が 7 つと完全一致する（Req 5.3, 5.4）', () => {
      const { container } = renderChart(RANK_7.props);
      const extracted = colorUtilities(container);
      // 抜き出した件数が 1 以上であること（空振り対策）。
      expect(extracted.length).toBeGreaterThan(0);
      expect(sortedSet(extracted)).toEqual([...CHART_COLOR_CLASSES]);
    });

    it('どの状態でも、7 つの外の色のクラスを書かない（Req 5.3, 5.4）', () => {
      const allowed: ReadonlySet<string> = new Set(CHART_COLOR_CLASSES);
      const union = new Set<string>();
      for (const item of ALL_CASES) {
        const { container } = render(<TrendChart {...item.props} />);
        const extracted = colorUtilities(container);
        expect(
          extracted.filter((token) => !allowed.has(token)),
          item.name,
        ).toEqual([]);
        for (const token of extracted) {
          union.add(token);
        }
        cleanup();
      }
      expect([...union].sort()).toEqual([...CHART_COLOR_CLASSES]);
    });

    it('任意値（角括弧の記法）の class を書かない', () => {
      for (const item of ALL_CASES) {
        const { container } = render(<TrendChart {...item.props} />);
        const tokens = selfAndDescendants(container, '[class]').flatMap((element) => classTokens(element));
        // グラフを描く状態では、走査した class が 1 件以上あること（空振り対策）。文言だけの状態は class を持たない。
        if (CHART_CASES.includes(item)) {
          expect(tokens.length, item.name).toBeGreaterThan(0);
        }
        expect(
          tokens.filter((token) => token.includes('[')),
          item.name,
        ).toEqual([]);
        cleanup();
      }
    });
  });

  describe('style の範囲', () => {
    const PERCENT = /^-?\d+(?:\.\d+)?%$/;
    const POSITION_PROPERTIES: ReadonlySet<string> = new Set(['top', 'left']);

    it('figure の中の style は top と left の百分率だけで、style を持つ要素が 1 件以上ある（Req 6.5）', () => {
      for (const item of CHART_CASES) {
        const { figure } = renderChart(item.props);
        const styled = selfAndDescendants(figure, '[style]');
        expect(styled.length, item.name).toBeGreaterThan(0);
        for (const element of styled) {
          const declarations = styleDeclarations(element.getAttribute('style') ?? '');
          expect(declarations.length, `${item.name}: ${element.outerHTML}`).toBeGreaterThan(0);
          for (const [property, value] of declarations) {
            expect(POSITION_PROPERTIES.has(property), `${item.name}: ${property}`).toBe(true);
            expect(value, `${item.name}: ${property}`).toMatch(PERCENT);
          }
        }
        cleanup();
      }
    });

    it('静的に描いた HTML でも、style は top と left の百分率だけである（jsdom が捨てるプロパティも捕まえる）', () => {
      // jsdom の CSSOM は、実装していないプロパティ（paint-order など。着手時点で実測）を style 属性へ
      // 書き出さずに黙って捨てる。そのため DOM の検査だけでは、style={{ paintOrder: … }} のような改変が
      // 素通りする。React が書き出す文字列そのものでも確かめる。
      for (const item of CHART_CASES) {
        const markup = renderToStaticMarkup(<TrendChart {...item.props} />);
        const styles = Array.from(markup.matchAll(/\sstyle="([^"]*)"/g), (match) => match[1] ?? '');
        expect(styles.length, item.name).toBeGreaterThan(0);
        for (const style of styles) {
          const declarations = styleDeclarations(style);
          expect(declarations.length, `${item.name}: ${style}`).toBeGreaterThan(0);
          for (const [property, value] of declarations) {
            expect(POSITION_PROPERTIES.has(property), `${item.name}: ${style}`).toBe(true);
            expect(value, `${item.name}: ${style}`).toMatch(PERCENT);
          }
        }
      }
    });
  });

  describe('描画の構造（決定 D2）', () => {
    it('線の層は viewBox 0〜100 を縦横の比を保たずに伸縮させ、罫線と線の太さ・端・角・vector-effect を SVG の属性で書く（Req 1.1, 1.11）', () => {
      const { figure } = renderChart(RANK_7.props);
      const layer = lineLayer(figure);
      expect(layer.getAttribute('viewBox')).toBe('0 0 100 100');
      expect(layer.getAttribute('preserveAspectRatio')).toBe('none');
      expect(layer.getAttribute('role')).toBe('img');

      // 罫線: 目盛りの位置（1〜5 位 → 上端から 0・25・50・75・100）に 1px の実線。
      const gridlines = Array.from(layer.querySelectorAll('line'));
      expect(gridlines.map((line) => Number(line.getAttribute('y1')))).toEqual([0, 25, 50, 75, 100]);
      for (const line of gridlines) {
        expect(line.getAttribute('y2')).toBe(line.getAttribute('y1'));
        expect([line.getAttribute('x1'), line.getAttribute('x2')]).toEqual(['0', '100']);
        expect(line.getAttribute('stroke-width')).toBe('1');
        expect(line.getAttribute('vector-effect')).toBe('non-scaling-stroke');
        expect(classTokens(line)).toContain('stroke-border');
      }

      // 線: 値の無い 8/28 で切れて 2 本。2px で、端と角を丸める。
      const polylines = Array.from(layer.querySelectorAll('polyline'));
      expect(polylines).toHaveLength(2);
      const coordinates = polylines.map((polyline) =>
        (polyline.getAttribute('points') ?? '').split(' ').map((pair) => pair.split(',').map(Number)),
      );
      const expected = [
        [
          [xOf(0, 7), 75],
          [xOf(1, 7), 50],
          [xOf(2, 7), 50],
        ],
        [
          [xOf(4, 7), 50],
          [xOf(5, 7), 25],
          [xOf(6, 7), 25],
        ],
      ];
      expect(coordinates.map((line) => line.length)).toEqual(expected.map((line) => line.length));
      coordinates.forEach((line, lineIndex) => {
        line.forEach(([x, y], pointIndex) => {
          expect(x).toBeCloseTo(expected[lineIndex]![pointIndex]![0]!, 1);
          expect(y).toBeCloseTo(expected[lineIndex]![pointIndex]![1]!, 1);
        });
      });
      for (const polyline of polylines) {
        expect(polyline.getAttribute('stroke-width')).toBe('2');
        expect(polyline.getAttribute('stroke-linecap')).toBe('round');
        expect(polyline.getAttribute('stroke-linejoin')).toBe('round');
        expect(polyline.getAttribute('vector-effect')).toBe('non-scaling-stroke');
        expect(classTokens(polyline)).toEqual(expect.arrayContaining(['fill-none', 'stroke-current']));
      }
    });

    it('点の層は百分率座標の circle で印を描き、端点は地色の輪の上に印を重ねる（Req 1.6, 1.12, 1.14）', () => {
      const { figure } = renderChart(RANK_7.props);
      const circles = Array.from(pointLayer(figure).querySelectorAll('circle'));
      // 7 日なので値のある 6 日すべてに印を置く。端点（8/31）は印の並びに入れず、輪と印の 2 つで描く。
      expect(circles).toHaveLength(5 + 2);
      const expectedMarkers = [
        [xOf(0, 7), 75],
        [xOf(1, 7), 50],
        [xOf(2, 7), 50],
        [xOf(4, 7), 50],
        [xOf(5, 7), 25],
      ];
      circles.slice(0, 5).forEach((circle, index) => {
        expect(percentAttribute(circle, 'cx')).toBeCloseTo(expectedMarkers[index]![0]!, 1);
        expect(percentAttribute(circle, 'cy')).toBeCloseTo(expectedMarkers[index]![1]!, 1);
        expect(circle.getAttribute('r')).toBe('4');
        expect(classTokens(circle)).toContain('fill-current');
      });

      // 輪（半径 6・カードの地色）を先に、印（半径 4）を後に描いて、印を輪の上に重ねる。
      const [ring, dot] = circles.slice(5);
      for (const circle of [ring!, dot!]) {
        expect(percentAttribute(circle, 'cx')).toBeCloseTo(100, 1);
        expect(percentAttribute(circle, 'cy')).toBeCloseTo(25, 1);
      }
      expect(ring!.getAttribute('r')).toBe('6');
      expect(classTokens(ring!)).toContain('fill-card');
      expect(dot!.getAttribute('r')).toBe('4');
      expect(classTokens(dot!)).toContain('fill-current');
    });

    it('30 日で途切れない線は、印を端点にだけ置く。値が 1 日だけなら線を描かず、端点だけを描く（Req 1.6, 1.9）', () => {
      const reviews = renderChart(REVIEWS_30.props);
      expect(lineLayer(reviews.figure).querySelectorAll('polyline')).toHaveLength(1);
      expect(pointLayer(reviews.figure).querySelectorAll('circle')).toHaveLength(2);
      cleanup();

      const single = renderChart(RATING_SINGLE_30.props);
      expect(lineLayer(single.figure).querySelectorAll('polyline')).toHaveLength(0);
      const circles = Array.from(pointLayer(single.figure).querySelectorAll('circle'));
      expect(circles.map((circle) => circle.getAttribute('r'))).toEqual(['6', '4']);
      // 評価 4.3 は、4.0〜5.0 の軸で上端から 70% の位置。
      for (const circle of circles) {
        expect(percentAttribute(circle, 'cx')).toBeCloseTo(100, 1);
        expect(percentAttribute(circle, 'cy')).toBeCloseTo(70, 1);
      }
    });

    it('2 枚の SVG は、箱の外へはみ出す図形を切らずに描く（決定 D2）', () => {
      // HTML に埋め込んだ SVG は、既定で箱の外を切り取る。端の点の輪（半径 6）や線の丸い端は SVG の箱の
      // 外へはみ出すので、両方の層ではみ出しを描かせる。枠で切れないための余白は、描画領域の内側の余白が持つ。
      for (const item of CHART_CASES) {
        const { figure } = renderChart(item.props);
        expect(classTokens(lineLayer(figure)), item.name).toContain('overflow-visible');
        expect(classTokens(pointLayer(figure)), item.name).toContain('overflow-visible');
        cleanup();
      }
    });

    it('記録が期間の途中から始まる店では、公称の始点からの空白を残して線を描く（横軸を公称の期間に固定する）', () => {
      const { figure } = renderChart(RANK_SHORT_7.props);
      const polylines = Array.from(lineLayer(figure).querySelectorAll('polyline'));
      expect(polylines).toHaveLength(1);
      const [first] = (polylines[0]!.getAttribute('points') ?? '').split(' ');
      // 8/28 は公称の始点（8/25）から数えて 3 日目。
      expect(Number(first!.split(',')[0])).toBeCloseTo(xOf(3, 7), 1);
    });

    it('目盛りの文字を罫線と同じ高さに、期間の始点と終点の日付を横軸の下に置く（Req 1.11）', () => {
      const cases = [
        { item: RANK_7, ticks: ['1位', '2位', '3位', '4位', '5位'], dates: ['8/25', '8/31'] },
        { item: REVIEWS_30, ticks: ['100', '110', '120', '130'], dates: ['8/2', '8/31'] },
        // 横軸の始点の日付は、最初の記録日（8/28）ではなく公称の始点（8/25）である。
        { item: RANK_SHORT_7, ticks: ['1位', '2位', '3位', '4位', '5位'], dates: ['8/25', '8/31'] },
        // 横軸の終点は、選択中の指標の値の有無に依らず窓の終点（8/31）である。
        { item: RANK_END_GAP_7, ticks: ['1位', '2位', '3位', '4位', '5位'], dates: ['8/25', '8/31'] },
        { item: RATING_SINGLE_30, ticks: ['4.0', '4.5', '5.0'], dates: ['8/2', '8/31'] },
      ] as const;
      for (const { item, ticks, dates } of cases) {
        const { figure } = renderChart(item.props);
        const layer = lineLayer(figure);
        const plot = layer.parentElement!;
        // 目盛りの文字 = 描画領域の外にある、位置を持つ文字。
        const tickLabels = selfAndDescendants(figure, '[style]').filter((element) => !plot.contains(element));
        expect(tickLabels.map((label) => label.textContent), item.name).toEqual(ticks);
        const gridY = Array.from(layer.querySelectorAll('line')).map((line) => Number(line.getAttribute('y1')));
        expect(tickLabels.map((label) => topPercent(label)).map(Math.round), item.name).toEqual(gridY.map(Math.round));

        for (const date of dates) {
          const label = within(figure).getByText(date);
          expect(label.closest('[aria-hidden="true"]'), `${item.name}: ${date}`).not.toBeNull();
        }
        cleanup();
      }
    });
  });

  describe('最新値の文字', () => {
    it('端点の値を、点の層の text として端点と同じ高さに右端ぞろえで描き、読み上げからは隠す（Req 1.12）', () => {
      const cases = [
        { item: RANK_7, text: '2位', y: 25 },
        { item: REVIEWS_30, text: '129件', y: (1 / 30) * 100 },
        { item: RATING_SINGLE_30, text: '4.3', y: 70 },
      ] as const;
      for (const { item, text, y } of cases) {
        const { figure } = renderChart(item.props);
        const label = latestValueText(figure);
        expect(label.textContent, item.name).toBe(text);
        expect(label.namespaceURI, item.name).toBe('http://www.w3.org/2000/svg');
        // 高さの基準は端点と同じ百分率。横は描画領域の右端にそろえる（端点が右端より手前でも右端）。
        expect(percentAttribute(label, 'y'), item.name).toBeCloseTo(y, 1);
        expect(percentAttribute(label, 'x'), item.name).toBeCloseTo(100, 1);
        expect(label.getAttribute('text-anchor'), item.name).toBe('end');
        // 位置は SVG の属性だけで与える（style を持たない）。
        expect(label.getAttribute('style'), item.name).toBeNull();
        expect(label.closest('[aria-hidden="true"]'), item.name).not.toBeNull();
        // 文字の寸法は目盛りと同じ段で、数字の幅もそろえる。
        expect(classTokens(label), item.name).toEqual(expect.arrayContaining(['text-xs', 'tabular-nums']));
        cleanup();
      }
    });

    it('最新値の文字は HTML では描かない。描画領域の中に style を持つ要素を残さない（Req 1.12）', () => {
      // 2026-09-16 改定: HTML のラベルでは、30 日の窓で線が字を貫く（字の幅 19.6px > 1 日の間隔 6.6px）。
      for (const item of CHART_CASES) {
        const { figure } = renderChart(item.props);
        const plot = lineLayer(figure).parentElement!;
        expect(selfAndDescendants(plot, '[style]'), item.name).toEqual([]);
        // 目盛りの帯には style を持つ文字が残る（空振り対策）。
        expect(selfAndDescendants(figure, '[style]').length, item.name).toBeGreaterThan(0);
        cleanup();
      }
    });

    it('線が後ろを通っても字が読めるよう、地色の縁取りを塗りの下に敷く（Req 1.12・決定 D6）', () => {
      // 端点の輪（fill-card）と同じ考え方である。paint-order="stroke" が無いと、縁取りが字の上に
      // 乗って字が細る。縁取りの太さは SVG の属性で与える（クラスは色の語彙の検査と紛れる）。
      for (const item of CHART_CASES) {
        const { figure } = renderChart(item.props);
        const label = latestValueText(figure);
        expect(classTokens(label), item.name).toEqual(expect.arrayContaining(['fill-current', 'stroke-card']));
        expect(label.getAttribute('paint-order'), item.name).toBe('stroke');
        expect(label.getAttribute('stroke-width'), item.name).toBe('3');
        cleanup();

        // サーバーが描く HTML にも同じ属性が出ること（面はサーバーで描かれる。属性の名前を取り違えると、
        // 最初の描画だけ縁取りが無い状態になる）。
        const markup = renderToStaticMarkup(<TrendChart {...item.props} />);
        expect(markup, item.name).toContain('paint-order="stroke"');
      }
    });

    // 置き場所は端点の少し上に固定する（design「TrendChart」の「HTML のラベル」・2026-09-16 改定）。
    // 線との重なりは、字の後ろに敷く地色の縁取りが引き受けるので、向きで側を選び分けない。
    //
    // 余地の計算: 百分率の基準になる高さは、描画領域（h-40 = 160px）から上下の内側の余白（p-2 = 8px）を
    // 引いた 144px である。点から上端までの余地は「百分率 × 144px + 余白 8px」で、上に置いた字面の
    // 上端は点から 19px（= 輪の半径 6 + 間隔 4 + 字面の高さ 9）上に来る。したがって、上に置けるのは
    // 端点が上端から 7.64%（= (19 − 8) ÷ 144）以上離れているときである。
    it('既定では、文字を端点の少し上に置く（Req 1.12）', () => {
      const cases = [
        // 30 日・順位（縦 12.5%）。字の下を複数の区間が通るが、縁取りがあるので上に置いたままでよい。
        { item: RANK_NEAR_TOP_30, y: 12.5 },
        // 端点が下端寄り（縦 75%）でも、上端寄り（縦 10%）でも、孤立していても側は変わらない。
        { item: RANK_LOW_END_7, y: 75 },
        { item: REVIEWS_NEAR_TOP_30, y: 10 },
        { item: RANK_ISOLATED_END_7, y: 12.5 },
        { item: RANK_7, y: 25 },
        { item: RATING_SINGLE_30, y: 70 },
      ] as const;
      for (const { item, y } of cases) {
        const { figure } = renderChart(item.props);
        expect(percentAttribute(latestValueText(figure), 'y'), item.name).toBeCloseTo(y, 1);
        expect(labelPlacement(figure), item.name).toBe('above');
        cleanup();
      }
    });

    it('端点が上端に近く、上に置くと描画領域の外へ出るときは、点の下に置く（Req 1.12）', () => {
      // 端点は 38 件（0〜40 件の軸で縦 5%）。上の余地は 5% × 144px + 8px = 15.2px で、字面に要る
      // 19px に足りない。
      const { figure } = renderChart(REVIEWS_TOP_30.props);
      expect(percentAttribute(latestValueText(figure), 'y')).toBeCloseTo(5, 1);
      expect(labelPlacement(figure)).toBe('below');
      cleanup();

      // 端点が 1 位（縦 0%）で上端に張りつく状態も同じ。
      const top = renderChart(RANK_TOP_7.props);
      expect(percentAttribute(latestValueText(top.figure), 'y')).toBeCloseTo(0, 1);
      expect(labelPlacement(top.figure)).toBe('below');
    });

    it('どの状態でも、上下の別は基準線の移動だけで与え、移動の量は 2 通りしか無い（Req 1.12）', () => {
      const seen = new Set<string>();
      for (const item of CHART_CASES) {
        const { figure } = renderChart(item.props);
        const label = latestValueText(figure);
        const dy = label.getAttribute('dy');
        expect(dy, item.name).not.toBeNull();
        // 高さの基準（y）は常に端点の百分率で、上下の別は dy だけが持つ。
        expect(percentAttribute(label, 'y'), item.name).toBeGreaterThanOrEqual(0);
        seen.add(dy!);
        cleanup();
      }
      // 上と下の 2 通りだけ（状態ごとに量を変えない）。
      expect([...seen].map(Number).sort((left, right) => left - right)).toEqual([-10, 19]);
    });
  });

  describe('現在値の日付が窓の終点と食い違うとき（Req 3.6）', () => {
    it('端点・最新値の文字・グラフの名前は、窓の終点（8/31）ではなく、順位の値がある最後の日（8/30）を指す', () => {
      const { figure } = renderChart(RANK_END_GAP_7.props);

      // グラフの名前: 期間は公称の終点（8/31）までで、最新は値のある最後の日（8/30）である。
      const chart = within(figure).getByRole('img', {
        name: '順位の推移、8月25日から8月31日まで。最初の記録は4位、最後の記録は2位。最高は2位、最低は4位。最新は2位（8月30日）。',
      });
      expect(chart).toBe(lineLayer(figure));
      expect(chart.getAttribute('aria-label')).toContain('最新は2位（8月30日）。');

      // 端点の輪と印は、8/30（公称の始点から数えて 5 日目）に置く。横の右端（100%）には置かない。
      const circles = Array.from(pointLayer(figure).querySelectorAll('circle'));
      const [ring, dot] = circles.slice(-2);
      expect(ring!.getAttribute('r')).toBe('6');
      expect(dot!.getAttribute('r')).toBe('4');
      for (const circle of [ring!, dot!]) {
        expect(percentAttribute(circle, 'cx')).toBeCloseTo(xOf(5, 7), 1);
        expect(percentAttribute(circle, 'cy')).toBeCloseTo(25, 1);
      }
      // 8/31 には順位の値が無いので、そこへ印も線も伸ばさない。
      for (const circle of circles) {
        expect(percentAttribute(circle, 'cx')).toBeLessThan(100);
      }
      const polylines = Array.from(lineLayer(figure).querySelectorAll('polyline'));
      expect(polylines).toHaveLength(1);
      const lastPair = (polylines[0]!.getAttribute('points') ?? '').split(' ').at(-1);
      expect(Number(lastPair!.split(',')[0])).toBeCloseTo(xOf(5, 7), 1);

      // 最新値の文字は端点の値で、描画領域の右端にそろえる（端点が右端より手前にあっても、右端に置く）。
      const label = latestValueText(figure);
      expect(label.textContent).toBe('2位');
      expect(percentAttribute(label, 'y')).toBeCloseTo(25, 1);
      expect(percentAttribute(label, 'x')).toBeCloseTo(100, 1);
      expect(label.getAttribute('text-anchor')).toBe('end');
    });
  });

  describe('値が無い期間', () => {
    it('期間内に選択中の指標の値が無いときは、グラフの代わりに記録が無い旨を出す（Req 1.10）', () => {
      // 文言は、指標名に加えて**窓の期間**を持つ（2026-09-18 の画面レビュー）。この分岐は figcaption ごと
      // 落ちるので、期間を文言へ入れないと「どの期間の話か」が画面から消える。窓は 8/25〜8/31 である。
      const cases = [
        {
          metric: 'rating',
          text: 'この期間（8/25〜8/31）は評価の記録がありません。ほかの項目や期間に切り替えると表示できることがあります。',
        },
        {
          metric: 'rank',
          text: 'この期間（8/25〜8/31）は順位の記録がありません。ほかの項目や期間に切り替えると表示できることがあります。',
        },
      ] as const;
      for (const { metric, text } of cases) {
        const { container } = render(<TrendChart window={NO_RATING_WINDOW} metric={metric} rankTotal={5} />);
        const message = screen.getByText(text);
        // この面の「表示するものが無い」案内は、すべて同じ空状態の部品で描く（同一役割を 2 通りに
        // 描かない・page.tsx 冒頭の方針）。素の段落へ戻す改変は、ここで赤になる。
        const state = message.closest('[data-slot="empty-state"]');
        expect(state, metric).not.toBeNull();
        // 描画領域と同じ高さの下限を持たせ、指標を切り替えたときの崩れを抑える。
        expect(classTokens(state!), metric).toContain('min-h-40');
        // 導線（リンクや押しボタン）は置かない（構造契約と、要件 4.9 と同じ扱い）。
        expect(state!.querySelectorAll('a, button'), metric).toHaveLength(0);
        expect(container.querySelectorAll('figure, svg'), metric).toHaveLength(0);
        expect(screen.queryByRole('img', { hidden: true }), metric).toBeNull();
        expect(container.querySelectorAll('[style]'), metric).toHaveLength(0);
        cleanup();
      }

      // 同じ窓でも、値のある指標（クチコミ数）ではグラフを描く（文言は指標ごとの判定である）。
      const { figure } = renderChart({ window: NO_RATING_WINDOW, metric: 'reviewCount', rankTotal: 5 });
      expect(lineLayer(figure).getAttribute('role')).toBe('img');
      expect(screen.queryByText(/の記録がありません$/)).toBeNull();
    });
  });
});
