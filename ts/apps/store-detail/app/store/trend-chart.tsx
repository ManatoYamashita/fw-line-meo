// 推移グラフ（store-detail-trend-dashboard task 3.1・Issue #265）。
//
// 選択中の指標について、期間の窓の推移を 1 系列の線グラフとして描く。判断の正典は
// docs/design/design-language.md §7.18 であり、ここでは結論も数値も転記せず参照する。審議の記録は
// 同 spec の research.md の決定 D2（描き方）・D5（ホバー層を持たない）・D6（色の語彙）にある。
//
// 意味論:
// - figure の中に、見える figcaption を置く。中身は、指標名の推移・公称の期間の始点と終点・順位のときの
//   向き・最新の値とその日付である。
// - グラフの名前（説明文。lib/trend-view.ts の describeMetric）は、線の層の SVG に role="img" と
//   aria-label で持たせる。点の層は読み上げから隠す。
// - 目盛り・日付・最新値の HTML の文字も、読み上げから隠す。同じ内容をグラフの名前と推移の表が持つので、
//   二重に読ませないためである。
// - グラフの中にも外側の文字にも、焦点を受け取る要素を置かない。日ごとの値は推移の表で読む（要件 5.2）。
// - ポインタを重ねたときにだけ現れる表示（ツールチップや SVG の title）を持たない（要件 1.13）。
//
// 描き方（決定 D2）: 図形は表示幅に合わせて伸縮させ、文字は HTML で描いて縮めない（要件 6.5）。
// - 線の層: viewBox 0〜100 の SVG を、縦横の比を保たずに伸縮させる。線と罫線の太さは
//   non-scaling-stroke で保つ。
// - 点の層: viewBox を持たない SVG に、百分率座標の circle で描く。伸縮を受けないので、Chromium でも
//   WebKit でも真円になる（長さ 0 の線分を丸い端で描くと、WebKit では楕円になる）。
// - 線の太さ・端・角・vector-effect は、SVG の属性で書く。Tailwind にはこれらのユーティリティが無く、
//   任意値で書くと任意値の禁止に当たる。太さのクラスは、色の語彙の検査とも紛れる。
// - HTML の文字の位置は、style の top の百分率だけで与える。色・寸法・余白は style に書かない。
// - 2 枚の SVG と最新値の文字は、同じ箱（描画領域の内側）に重ねる。百分率の基準をそろえるためである。
//   目盛りの帯も、描画領域と同じ高さと上下の余白を持たせ、目盛りの文字を罫線と同じ高さに置く。
//
// 色（決定 D6）: この部品は、店舗詳細の面で色を書く唯一の場所である。書く色のクラスは次の 6 つに限る。
// - 線と点: 本文色（stroke-current・fill-current）。線の内側は塗らない（fill-none）。
// - 罫線: 区切り線色（stroke-border）。
// - 端点の輪: カードの地色（fill-card）。
// - 目盛りと日付: 補助文字色（text-muted-foreground）。
// 最新値の文字は、本文色を継承する。test/trend-chart.test.tsx が、描画結果の class の集合を完全一致で
// 固定している。
//
// id は持たせない。手書きの id を参照する記法は、直書きの色と誤検出される。必要になったときは、
// useId の値だけを使う。

import { buildGeometry, scaleFor, type PlotPoint } from '../../lib/trend-scale';
import {
  describeMetric,
  formatMetricValue,
  formatShortDate,
  formatTickValue,
  metricExtent,
  metricName,
  type TrendMetric,
  type TrendWindow,
} from '../../lib/trend-view';

export interface TrendChartProps {
  /** 期間の窓。グラフ・期間要約・推移の表・現在値は、同じ窓から導く（要件 3.1）。 */
  readonly window: TrendWindow;
  readonly metric: TrendMetric;
  /** 当日サマリーの母数（近隣の店の数）。順位の軸の下端にだけ使う。 */
  readonly rankTotal: number | null;
}

/** 印の半径。直径は 8px になる（決定 D4）。 */
const MARKER_RADIUS = 4;
/** 端点の地色の輪の半径。印の半径との差の 2px が、輪の太さになる。 */
const END_RING_RADIUS = 6;
/** 線の太さ（px）。 */
const LINE_WIDTH = 2;
/** 罫線の太さ（px）。 */
const GRIDLINE_WIDTH = 1;

/**
 * 最新値の文字を点の下へ回す、点の縦の位置の上限（上端からの百分率）。これより上端に近い点で文字を
 * 点の上に置くと、描画領域の上へはみ出す。
 */
const LABEL_BELOW_THRESHOLD = 25;

/**
 * 最新値の文字の class。右端にそろえ、点の上か下に置く。縦の余白は、端点の輪に文字が重ならないための
 * ものである。
 */
const LATEST_LABEL_ABOVE_CLASS = 'absolute right-0 -translate-y-full pb-2 text-xs tabular-nums whitespace-nowrap';
const LATEST_LABEL_BELOW_CLASS = 'absolute right-0 pt-2 text-xs tabular-nums whitespace-nowrap';

/**
 * 座標の数値を書く。幾何は丸めない百分率なので、小数第 2 位までに丸める。描画領域の高さに対して
 * 0.02px 未満の差であり、見た目は変わらない。
 */
function formatCoordinate(value: number): string {
  return String(Number(value.toFixed(2)));
}

function formatPercent(value: number): string {
  return `${formatCoordinate(value)}%`;
}

/** 線分の点を、polyline の points 属性の書式（'x,y x,y'）にする。 */
function polylinePoints(segment: readonly PlotPoint[]): string {
  return segment.map((plot) => `${formatCoordinate(plot.x)},${formatCoordinate(plot.y)}`).join(' ');
}

export function TrendChart({ window: trendWindow, metric, rankTotal }: TrendChartProps): React.JSX.Element {
  const name = metricName(metric);
  const extent = metricExtent(trendWindow, metric);
  const scale = scaleFor(extent, { rankTotal });
  const geometry = scale === null ? null : buildGeometry(trendWindow, metric, scale);
  const latest = extent.last;

  // 期間内に選択中の指標の値が 1 件も無いときは、グラフの代わりに文言を出す（要件 1.10）。
  if (geometry === null || latest === null) {
    return <p>{`この期間は${name}の記録がありません`}</p>;
  }

  const { end } = geometry;

  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="flex flex-col gap-1">
        <p>
          <span className="font-semibold">{`${name}の推移`}</span>
          {/* 順位は 1 位を上端に置くので、その向きを題に文言で添える（要件 1.3）。 */}
          {metric === 'rank' ? '（上ほど上位）' : null}
        </p>
        <p>{`${formatShortDate(trendWindow.startDate)}〜${formatShortDate(trendWindow.endDate)}`}</p>
        {/* 現在値には、その値が記録された日付を添える（要件 3.6）。 */}
        <p>{`最新 ${formatMetricValue(metric, latest.value)}（${formatShortDate(latest.date)}）`}</p>
      </figcaption>
      <div className="flex gap-2">
        {/* 縦軸の目盛りの帯（固定幅）。描画領域と同じ高さと上下の余白を持たせる。 */}
        <div aria-hidden className="h-40 w-10 shrink-0 py-2 text-xs tabular-nums text-muted-foreground">
          <div className="relative h-full">
            {geometry.ticks.map((tick) => (
              <span
                key={tick.value}
                className="absolute right-0 -translate-y-1/2 whitespace-nowrap"
                style={{ top: formatPercent(tick.y) }}
              >
                {formatTickValue(metric, tick.value)}
              </span>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 描画領域（固定高）。内側の余白は、端の点と端点の輪が枠で切れないためのものである。 */}
          <div className="h-40 p-2">
            <div className="relative size-full">
              <svg
                role="img"
                aria-label={describeMetric(trendWindow, extent)}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="absolute inset-0 size-full overflow-visible"
              >
                {geometry.ticks.map((tick) => (
                  <line
                    key={tick.value}
                    x1="0"
                    y1={formatCoordinate(tick.y)}
                    x2="100"
                    y2={formatCoordinate(tick.y)}
                    className="stroke-border"
                    strokeWidth={GRIDLINE_WIDTH}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {geometry.segments.map((segment) => (
                  <polyline
                    key={segment[0]?.date}
                    points={polylinePoints(segment)}
                    className="fill-none stroke-current"
                    strokeWidth={LINE_WIDTH}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </svg>
              <svg aria-hidden className="absolute inset-0 size-full overflow-visible">
                {geometry.markers.map((marker) => (
                  <circle
                    key={marker.date}
                    cx={formatPercent(marker.x)}
                    cy={formatPercent(marker.y)}
                    r={MARKER_RADIUS}
                    className="fill-current"
                  />
                ))}
                {/* 端点は、カードの地色の輪を先に描き、その上に印を重ねる（線に重なっても判読できるように）。 */}
                <circle cx={formatPercent(end.x)} cy={formatPercent(end.y)} r={END_RING_RADIUS} className="fill-card" />
                <circle cx={formatPercent(end.x)} cy={formatPercent(end.y)} r={MARKER_RADIUS} className="fill-current" />
              </svg>
              {/* 最新の点に、その値を文字で添える（要件 1.12）。 */}
              <span
                aria-hidden
                className={end.y < LABEL_BELOW_THRESHOLD ? LATEST_LABEL_BELOW_CLASS : LATEST_LABEL_ABOVE_CLASS}
                style={{ top: formatPercent(end.y) }}
              >
                {formatMetricValue(metric, end.value)}
              </span>
            </div>
          </div>
          {/* 横軸の日付（公称の期間の始点と終点）。描画領域の内側と左右をそろえる。 */}
          <div aria-hidden className="flex justify-between px-2 text-xs tabular-nums text-muted-foreground">
            <span>{formatShortDate(trendWindow.startDate)}</span>
            <span>{formatShortDate(trendWindow.endDate)}</span>
          </div>
        </div>
      </div>
    </figure>
  );
}
