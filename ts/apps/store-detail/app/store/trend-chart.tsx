// 推移グラフ（store-detail-trend-dashboard task 3.1・Issue #265）。
//
// 選択中の指標について、期間の窓の推移を 1 系列の線グラフとして描く。判断の正典は
// docs/design/design-language.md §7.19 であり、ここでは結論も数値も転記せず参照する。審議の記録は
// 同 spec の research.md の決定 D2（描き方）・D5（ホバー層を持たない）・D6（色の語彙）にある。
//
// 意味論:
// - figure の中に、見える figcaption を置く。中身は、指標名の推移・公称の期間の始点と終点・順位のときの
//   向き・最新の値とその日付である。
// - グラフの名前（説明文。lib/trend-view.ts の describeMetric）は、線の層の SVG に role="img" と
//   aria-label で持たせる。点の層は読み上げから隠す。
// - 目盛りと日付の HTML の文字も、最新値の文字（点の層の中）も、読み上げから隠す。同じ内容をグラフの
//   名前と推移の表が持つので、二重に読ませないためである。
// - グラフの中にも外側の文字にも、焦点を受け取る要素を置かない。日ごとの値は推移の表で読む（要件 5.2）。
// - ポインタを重ねたときにだけ現れる表示（ツールチップや SVG の title）を持たない（要件 1.13）。
//
// 描き方（決定 D2）: 図形は表示幅に合わせて伸縮させ、文字は HTML で描いて縮めない（要件 6.5）。
// - 線の層: viewBox 0〜100 の SVG を、縦横の比を保たずに伸縮させる。線と罫線の太さは
//   non-scaling-stroke で保つ。
// - 点の層: viewBox を持たない SVG に、百分率座標の circle で描く。伸縮を受けないので、Chromium でも
//   WebKit でも真円になる（長さ 0 の線分を丸い端で描くと、WebKit では楕円になる）。
// - 最新値の文字も、点の層に text として描く（2026-09-16 改定）。HTML のラベルで点の上下を選び分ける
//   規則では、30 日の窓で線が字を貫く。字の幅（約 19.6px）が 1 日の間隔（6.6px・320px 幅）より広く、
//   字の下を 3 本の区間が通るためで、最後の区間の向きだけを見ても側を決められない。代わりに地色の
//   縁取りを字の下に敷き（端点の輪と同じ考え方）、置き場所は端点の少し上に固定する。
// - 線の太さ・端・角・vector-effect・縁取りの太さ・塗りの順序は、SVG の属性で書く。Tailwind にはこれらの
//   ユーティリティが無く、任意値で書くと任意値の禁止に当たる。太さのクラスは、色の語彙の検査とも紛れる。
// - HTML の文字（目盛り）の位置は、style の top の百分率だけで与える。色・寸法・余白は style に書かない。
// - 2 枚の SVG は、同じ箱（描画領域の内側）に重ねる。百分率の基準をそろえるためである。
//   目盛りの帯も、描画領域と同じ高さと上下の余白を持たせ、目盛りの文字を罫線と同じ高さに置く。
//
// 色（決定 D6）: この部品は、店舗詳細の面で色を書く唯一の場所である。書く色のクラスは次の 7 つに限る。
// - 線と点と最新値の文字: 本文色（stroke-current・fill-current）。線の内側は塗らない（fill-none）。
// - 罫線: 区切り線色（stroke-border）。
// - 端点の輪と最新値の文字の縁取り: カードの地色（fill-card・stroke-card）。
// - 目盛りと日付: 補助文字色（text-muted-foreground）。
// test/trend-chart.test.tsx が、描画結果の class の集合を完全一致で固定している。
//
// id は持たせない。手書きの id を参照する記法は、直書きの色と誤検出される。必要になったときは、
// useId の値だけを使う。

import { EmptyState } from '@fwlm/ui/components/empty-state';

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

/** 百分率の全体（描画領域の幅と高さ）。最新値の文字は、横 100%（右端）に置く。 */
const FULL_PERCENT = 100;
/**
 * 百分率の基準になる高さ（px）。描画領域（h-40 = 160px）から、上下の内側の余白（p-2 = 8px）を引いた
 * 値である。
 */
const PLOT_HEIGHT = 144;
/** 描画領域の内側の余白（p-2 = 8px）。文字はここまでなら、描画領域の外へはみ出さずに置ける。 */
const PLOT_PADDING = 8;
/** 最新値の文字と端点の輪の間隔（px）。 */
const LABEL_CLEARANCE = 4;
/** 最新値の文字の字面の高さ（px）。text-xs（12px）の数字は、基準線から上へおよそこれだけ占める。 */
const LABEL_DIGIT_HEIGHT = 9;
/** 点の中心から字面までの距離（px）。端点の輪の半径と間隔の合計である。 */
const LABEL_POINT_DISTANCE = END_RING_RADIUS + LABEL_CLEARANCE;
/** 上に置くときの基準線の移動（px）。基準線は字面の下端なので、上向き（負）に動かす。 */
const LABEL_ABOVE_DY = -LABEL_POINT_DISTANCE;
/** 下に置くときの基準線の移動（px）。字面の上端を点から離すので、字面の高さぶん足す。 */
const LABEL_BELOW_DY = LABEL_POINT_DISTANCE + LABEL_DIGIT_HEIGHT;
/** 最新値の文字に敷く、地色の縁取りの太さ（px）。 */
const LABEL_HALO_WIDTH = 3;
/**
 * 文字を点の上に置ける、端点の縦の位置の下限（百分率）。
 *
 * 上に置くと、字面の上端は点から 19px（= 輪の半径 6 + 間隔 4 + 字面の高さ 9）上に来る。点から上端まで
 * の余地は「百分率 × 144px + 内側の余白 8px」なので、下限は (19 − 8) ÷ 144 = 7.64% になる。
 */
const LABEL_ROOM_MIN_PERCENT =
  ((LABEL_POINT_DISTANCE + LABEL_DIGIT_HEIGHT - PLOT_PADDING) / PLOT_HEIGHT) * FULL_PERCENT;

/**
 * 最新値の文字の class。本文色で塗り、カードの地色で縁取る（縁取りの太さと塗りの順序は SVG の属性で
 * 与える）。寸法は目盛りと同じ段にし、数字の幅をそろえる。
 */
const LATEST_VALUE_CLASS = 'fill-current stroke-card text-xs tabular-nums';

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
  //
  // 2026-09-18 の画面レビューでの改定が 3 つある。
  // 1. 素の段落をやめ、空状態の部品で描く。この面の「一覧が空」の案内 4 件はすべてこの部品であり、
  //    5 件目のここだけが素の段落だった（同一役割を 2 通りに描かないこと・page.tsx 冒頭の方針）。
  // 2. 描画領域と同じ高さの下限を与える。指標を切り替えただけで figcaption・描画領域・日付軸が消え、
  //    下にある表が飛び上がっていた。下限を置くと崩れの大半が止まる（figcaption のぶんは残る）。
  // 3. 期間を文言に入れる。この分岐は figcaption ごと落ちるので、どの期間の話なのかが画面から消えていた。
  //    合わせて、切り替えれば表示できることがある旨を添える（この面で唯一、0 件を利用者が解消できる状態である）。
  if (geometry === null || latest === null) {
    const period = `${formatShortDate(trendWindow.startDate)}〜${formatShortDate(trendWindow.endDate)}`;
    return (
      <EmptyState className="min-h-40 justify-center">
        <p>{`この期間（${period}）は${name}の記録がありません。ほかの項目や期間に切り替えると表示できることがあります。`}</p>
      </EmptyState>
    );
  }

  const { end } = geometry;
  // 最新値の文字は端点の少し上に置く。上に置くと描画領域の外へ出るときだけ、点の下へ回す。
  const labelAbove = end.y >= LABEL_ROOM_MIN_PERCENT;

  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="flex flex-col gap-1">
        <p>
          <span className="font-semibold">{`${name}の推移`}</span>
          {/* 順位は 1 位を上端に置くので、その向きを題に文言で添える（要件 1.3）。 */}
          {metric === 'rank' ? '（上ほど上位）' : null}
        </p>
        {/* 補助の 2 行は本文より 1 段下げる（2026-09-18 の画面レビュー）。段を下げないと、指標ラベルの
            dt（text-sm）より大きい文字で補助情報が並び、声の大きさが情報の重みと逆になる。
            日付を補助文字色にするのは §7.19 の役割割当（目盛りと日付は補助文字色）そのものである。 */}
        <p className="text-sm text-muted-foreground">
          {`${formatShortDate(trendWindow.startDate)}〜${formatShortDate(trendWindow.endDate)}`}
        </p>
        {/* 現在値には、その値が記録された日付を添える（要件 3.6）。 */}
        <p className="text-sm">{`最新 ${formatMetricValue(metric, latest.value)}（${formatShortDate(latest.date)}）`}</p>
      </figcaption>
      <div className="flex gap-2">
        {/*
          縦軸の目盛りの帯（固定幅）。描画領域と同じ高さと上下の余白を持たせる。

          幅は 2026-09-18 の画面レビューで 40px から 48px へ広げた。等幅数字の 1 桁は text-xs で約 7.2px
          なので、40px では 5 桁（36px）で余地がほぼ尽き、端末側の文字拡大で溢れる。帯は絶対配置の文字
          だけを持つため、内容に追随させる（w-fit）ことも、溢れを横スクロールとして観測することもできず、
          Card の overflow が黙って切る。内容に追随させるには流し込みの幅基準の要素を足すことになるが、
          それはグラフの文字を数える e2e（store-surface.spec.ts の readChartTexts）が余分な「日付」として
          拾ってしまう。したがってここは値の是正にとどめ、構造の是正は帯の作り直しとして別に扱う。
        */}
        <div aria-hidden className="h-40 w-12 shrink-0 py-2 text-xs tabular-nums text-muted-foreground">
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
                {/*
                  最新の点に、その値を文字で添える（要件 1.12）。右端にそろえ、端点と同じ高さを基準に
                  少し上（余地が無ければ下）へ動かす。地色の縁取りを塗りの下に敷くので、線が後ろを
                  通っても字は読める。
                */}
                <text
                  x={formatPercent(FULL_PERCENT)}
                  y={formatPercent(end.y)}
                  dy={labelAbove ? LABEL_ABOVE_DY : LABEL_BELOW_DY}
                  textAnchor="end"
                  className={LATEST_VALUE_CLASS}
                  paintOrder="stroke"
                  strokeWidth={LABEL_HALO_WIDTH}
                >
                  {formatMetricValue(metric, end.value)}
                </text>
              </svg>
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
