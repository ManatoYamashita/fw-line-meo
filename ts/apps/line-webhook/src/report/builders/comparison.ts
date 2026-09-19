// 競合店との比較のレポート（design.md「Report builders（表示）」の ComparisonBuilder・
// Requirements 5.1–5.8, 8.3, 8.4, 8.5）。
//
// 本文は、上から次の順に並べる。
// - 順位の段: 競合比較可能なら「近隣 N 店中 R 位」を LINE 面の巨大表示の段で置く（5.4）。自店が未評価の日は
//   順位の代わりに Issue #255 の文（SELF_UNRATED_RANK_TEXT）を置く（5.5）。どちらでもない日は段を置かない
// - 自店の評価と口コミ総数（5.2・5.6）
// - 競合: 評価のある店を日次集計の順（Go が書く順位の順）に、評価のない店を末尾に並べる（5.7）。1 店ごとに
//   名称・評価・口コミ総数・星差を出す。評価を持つ競合がいなければ、比較に使えるデータが無い旨を先頭に置き（5.6）、
//   評価のない店がいれば一覧の下に注記を添える（5.7）
//
// 評価のない店の扱いは Issue #255 の正規化（呼出元が normalizeReadRow で通す）と、`@fwlm/db/daily-summary` の
// 整形と文言だけで決める（8.5）。ここでは星差を計算せず、正規化後の行にある値だけを出す（8.4）。
// 星評価・星差・「評価なし」の表示は、詳細画面（store-detail）と同じ関数を使う（5.8）。
//
// 競合の順位は日次集計に持たないので、評価のある店の並びは Go の順（星評価の降順・同率は口コミ総数の降順）を
// そのまま使い、ここで並べ直さない。順位の規則を 2 つの言語へ二重に持たないためである。

import {
  SELF_UNRATED_RANK_TEXT,
  UNRATED_EXCLUDED_NOTE,
  formatRatingLabel,
  formatStarDiff,
  hasUnratedCompetitor,
  isUnratedSelf,
} from '@fwlm/db/daily-summary';
import type { DailySummaryCompetitor } from '@fwlm/db';
import { lineColors, lineLayout } from '@fwlm/design-tokens';
import type { LineMessage } from '../../line/client.js';
import type { FlexBoxComponent, FlexBoxContent, FlexTextComponent } from '../../line/flex-types.js';
import {
  buildReportBubble,
  formatDataDate,
  isComparableRow,
  toReportMessage,
  type NormalizedReadRow,
  type ReportContext,
} from '../format.js';

const SELF_HEADING = '自店の評価';
const COMPETITORS_HEADING = '競合との比較';

/** 評価を持つ競合がいない日の文（5.6）。「競合店との比較」はリッチメニューの項目名と同じ語である。 */
const NO_COMPARABLE_COMPETITORS_TEXT = '競合店との比較に使えるデータがありません';

/** 取得済みの値に無い欄の表記（8.4）。値を推測して埋めない。 */
const MISSING_VALUE = '—';

// --- 値の表記 ----------------------------------------------------------------------

/** 口コミ総数を `N件` と書く。0 以上の整数でなければ「—」にする（jsonb の値は型どおりとは限らない）。 */
function formatReviewCount(value: number | null): string {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? `${value}件` : MISSING_VALUE;
}

/** 評価と口コミ総数を 1 行にする（`★4.2（クチコミ 120件）`・`評価なし（クチコミ 0件）`）。 */
function formatRatingAndReviews(rating: number | string | null, reviewCount: number | null): string {
  return `${formatRatingLabel(rating)}（クチコミ ${formatReviewCount(reviewCount)}）`;
}

/** 競合の店名。空の text は LINE がメッセージ全体を拒否するので、読めない名前は「—」にする。 */
function competitorName(competitor: DailySummaryCompetitor): string {
  return typeof competitor.name === 'string' && competitor.name.trim() !== '' ? competitor.name : MISSING_VALUE;
}

/**
 * 評価のある店を入力の順のまま前に、評価のない店を入力の順のまま後ろに並べる（5.7）。
 * 評価の有無は正規化後の rating だけで決める（評価 0 の既存データは正規化で null になっている）。
 */
function orderForDisplay(competitors: readonly DailySummaryCompetitor[]): DailySummaryCompetitor[] {
  return [
    ...competitors.filter((competitor) => competitor.rating !== null),
    ...competitors.filter((competitor) => competitor.rating === null),
  ];
}

// --- 部品 --------------------------------------------------------------------------

function sectionHeading(text: string): FlexTextComponent {
  return { type: 'text', text, size: lineLayout.descriptionSize, color: lineColors.description };
}

/** 節の中身に代わる文（評価を持つ競合がいない日の文）。一覧の行と同じ段で、本文の色で描く。 */
function sectionStatusText(text: string): FlexTextComponent {
  return { type: 'text', text, size: lineLayout.descriptionSize, color: lineColors.body, wrap: true };
}

/** 一覧に添える補足の注記。 */
function noteText(text: string): FlexTextComponent {
  return { type: 'text', text, size: lineLayout.descriptionSize, color: lineColors.description, wrap: true };
}

/**
 * 順位の段。競合比較可能なら「近隣 N 店中 R 位」、自店が未評価なら Issue #255 の文、どちらでもなければ null。
 *
 * 自店の未評価を先に判定する。isUnratedSelf は評価 0 の既存データも未評価と読むので、正規化の前の形の行
 * （旧 Go は自店の評価 0 にも順位を付けていた）が渡されても順位を出さない。
 */
function buildPositionText(row: NormalizedReadRow): FlexTextComponent | null {
  if (isUnratedSelf(row.status, row.rating)) {
    return {
      type: 'text',
      text: SELF_UNRATED_RANK_TEXT,
      weight: 'bold',
      size: lineLayout.bodySize,
      color: lineColors.body,
      wrap: true,
    };
  }
  if (!isComparableRow(row) || row.rank === null || row.rank_total === null) {
    return null;
  }
  // 順位はこのプロダクトの LINE 面で唯一の巨大表示である（design-language.md §7.13）。折り返さない text は
  // 容器の幅を超えると省略記号で切られるので、大きな段を使う以上 adjustMode を対で添える。
  return {
    type: 'text',
    text: `近隣${row.rank_total}店中 ${row.rank}位`,
    weight: 'bold',
    size: lineLayout.displaySize,
    color: lineColors.body,
    adjustMode: 'shrink-to-fit',
  };
}

function buildSelfSection(row: NormalizedReadRow): FlexBoxComponent {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: lineLayout.itemGap,
    contents: [
      sectionHeading(SELF_HEADING),
      {
        type: 'text',
        text: formatRatingAndReviews(row.rating, row.review_count),
        weight: 'bold',
        size: lineLayout.bodySize,
        color: lineColors.body,
        wrap: true,
      },
    ],
  };
}

/**
 * 1 店の枠。店名の下に、評価と口コミ総数、右端に星差を並べる。星差が無い店（評価のない店・自店が未評価の日）は
 * 星差の部品を置かず、評価と口コミ総数の段が行の幅を使う（空の text は作らない）。
 */
function buildCompetitorRow(competitor: DailySummaryCompetitor): FlexBoxComponent {
  const starDiff = formatStarDiff(competitor.starDiff);
  const metrics: FlexBoxContent[] = [
    {
      type: 'text',
      text: formatRatingAndReviews(competitor.rating, competitor.reviewCount),
      size: lineLayout.descriptionSize,
      color: lineColors.body,
      wrap: true,
      flex: 1,
    },
  ];
  if (starDiff !== null) {
    // 星差は行で最も情報量の多い数値だが、差分であることは位置（右端）と符号が運ぶので、色は説明の段でよい
    // （旧来の日次カードと同じ）。flex 0 で文字の幅だけを取り、評価の段を縮めない。
    metrics.push({
      type: 'text',
      text: `星差 ${starDiff}`,
      size: lineLayout.descriptionSize,
      color: lineColors.description,
      align: 'end',
      flex: 0,
    });
  }
  return {
    type: 'box',
    layout: 'vertical',
    contents: [
      {
        type: 'text',
        text: competitorName(competitor),
        weight: 'bold',
        size: lineLayout.descriptionSize,
        color: lineColors.body,
        wrap: true,
      },
      { type: 'box', layout: 'horizontal', spacing: lineLayout.itemGap, contents: metrics },
    ],
  };
}

function buildCompetitorsSection(row: NormalizedReadRow): FlexBoxComponent {
  const competitors = orderForDisplay(row.competitors);
  const hasRatedCompetitor = competitors.some((competitor) => competitor.rating !== null);
  return {
    type: 'box',
    layout: 'vertical',
    spacing: lineLayout.itemGap,
    contents: [
      sectionHeading(COMPETITORS_HEADING),
      ...(hasRatedCompetitor ? [] : [sectionStatusText(NO_COMPARABLE_COMPETITORS_TEXT)]),
      ...competitors.map(buildCompetitorRow),
      // 評価のない店は順位の比較集合に入らない。「近隣 N 店中」の N と一覧の件数が食い違う理由を、
      // 該当する店がいるときだけ一覧の下に添える（詳細画面と同じ文言）。
      ...(hasUnratedCompetitor(competitors) ? [noteText(UNRATED_EXCLUDED_NOTE)] : []),
    ],
  };
}

function altTextFor(ctx: ReportContext, row: NormalizedReadRow): string {
  const head = `${ctx.storeName}（${formatDataDate(row.summary_date)}時点）`;
  if (isUnratedSelf(row.status, row.rating)) {
    return `${head}: ${SELF_UNRATED_RANK_TEXT}`;
  }
  if (isComparableRow(row) && row.rank !== null && row.rank_total !== null) {
    return `${head}: 近隣${row.rank_total}店中 ${row.rank}位`;
  }
  if (!row.competitors.some((competitor) => competitor.rating !== null)) {
    return `${head}: ${NO_COMPARABLE_COMPETITORS_TEXT}`;
  }
  return `${head}: 競合店との比較`;
}

// --- レポート ----------------------------------------------------------------------

/**
 * 競合店との比較のレポート（5.1）。見出しに店舗名とデータ対象日、footer に帰属表示を置く（5.2・8.1・8.3）。
 *
 * 取得失敗の行は受け取らない。取得失敗の日は、呼出元が取得失敗の案内を返す（7.2）。取得失敗の行の評価は
 * 取得できなかったので null なだけで、ここで組み立てると「評価なし」と取り違えて表示してしまう。
 *
 * 大きさは上限に届かない構成である（競合は Go が 5 店までに固定し、1 店は数個の部品である）。それでも超えるとき
 * （極端に長い店舗名など）は toReportMessage が FlexBubbleTooLargeError を投げる。
 */
export function buildComparisonReport(ctx: ReportContext, row: NormalizedReadRow): LineMessage {
  if (row.status === 'failed') {
    throw new Error('buildComparisonReport: a failed summary must be answered with the fetch-failed notice');
  }
  const position = buildPositionText(row);
  const bubble = buildReportBubble({
    ctx,
    span: { kind: 'date', date: row.summary_date },
    body: [...(position === null ? [] : [position]), buildSelfSection(row), buildCompetitorsSection(row)],
  });
  return toReportMessage(altTextFor(ctx, row), bubble);
}
