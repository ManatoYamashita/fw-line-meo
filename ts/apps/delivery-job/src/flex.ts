// Flex Message 組立（Task 4.1）。
//
// 入力は daily_summaries 1 行のみ（design.md「Flex 組立は daily_summaries のみを入力とする
// （rating_snapshots は読まない — 素材はバッチが確定済み）」）。ここでは Push もクエリも行わず、
// 「値を受け取り Flex JSON を返す／サイズを検証する」純関数のみを提供する。
//
// 構成契約（design.md Data Contracts & Integration・R3.4 の順序固定）:
//   ① header = 順位＋前日比矢印
//   ② body 前段 = 自店 星/クチコミ総数
//   ③ body 中段 = 新着クチコミ（件数＋抜粋 or「新着なし」）
//   ④ body 後段 = 競合一覧（星差） + footer = 「詳細を見る」ボタン＋Google 帰属
//
// @line/bot-sdk は追加しない。task 2.2 の骨格が明示的に見送っており、本タスクの境界（flex.ts と
// そのテストのみ）でも Push クライアント（task 4.2）の型は不要なため、Flex JSON の形だけを
// 厳密なローカル型として定義する（no `any`）。詳細は CONCERNS 参照。

import type { DailySummaryCompetitor, DailySummaryNewReview, DailySummaryRow } from '@fwlm/db';

// --- Flex JSON の最小・厳密な型（このモジュールが実際に使う形のみ） -----------------

export interface FlexUriAction {
  readonly type: 'uri';
  readonly label: string;
  readonly uri: string;
}

export interface FlexText {
  readonly type: 'text';
  readonly text: string;
  readonly size?: string;
  readonly weight?: 'regular' | 'bold';
  readonly color?: string;
  readonly wrap?: boolean;
  readonly align?: 'start' | 'center' | 'end';
  readonly flex?: number;
}

export interface FlexSeparator {
  readonly type: 'separator';
  readonly margin?: string;
}

export interface FlexButton {
  readonly type: 'button';
  readonly action: FlexUriAction;
  readonly style?: 'primary' | 'secondary' | 'link';
  readonly height?: 'sm' | 'md';
}

export type FlexBoxContent = FlexText | FlexSeparator | FlexButton | FlexBox;

export interface FlexBox {
  readonly type: 'box';
  readonly layout: 'vertical' | 'horizontal' | 'baseline';
  readonly contents: readonly FlexBoxContent[];
  readonly spacing?: string;
  readonly margin?: string;
}

export interface FlexBubble {
  readonly type: 'bubble';
  readonly header?: FlexBox;
  readonly body?: FlexBox;
  readonly footer?: FlexBox;
}

/** LINE へ送る Flex メッセージオブジェクト（messages 配列の 1 要素）。 */
export interface FlexMessagePayload {
  readonly type: 'flex';
  readonly altText: string;
  readonly contents: FlexBubble;
}

// --- 定数 ------------------------------------------------------------------------

/** LINE Flex Message の Bubble サイズ上限（バイト）。 */
export const BUBBLE_SIZE_LIMIT_BYTES = 30 * 1024;

/** LINE Flex Message の altText 文字数上限。 */
export const ALT_TEXT_MAX_LENGTH = 400;

const GOOGLE_ATTRIBUTION_TEXT = 'データ提供: Google Maps';
const DETAIL_BUTTON_LABEL = '詳細を見る';
const NO_NEW_REVIEWS_TEXT = '新着なし';
const NO_COMPETITORS_TEXT = '競合が見つかっていません（自店のみの計測です）';

/** 新着クチコミ抜粋として本文に表示する最大件数（bubble サイズ抑制のための表示上限）。 */
const MAX_DISPLAYED_NEW_REVIEWS = 3;

// --- エラー型 ----------------------------------------------------------------------

/** サイズ検証で 30KB 超過が検出された場合に送出する。 */
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

// --- サイズ検証（純関数・単独でテスト可能） ------------------------------------------

export interface BubbleSizeCheck {
  readonly withinLimit: boolean;
  readonly sizeBytes: number;
  readonly limitBytes: number;
}

/** 組立後の Bubble を実際にシリアライズしてバイト数を検証する（30KB 上限）。 */
export function validateBubbleSize(bubble: FlexBubble): BubbleSizeCheck {
  const sizeBytes = Buffer.byteLength(JSON.stringify(bubble), 'utf8');
  return {
    withinLimit: sizeBytes <= BUBBLE_SIZE_LIMIT_BYTES,
    sizeBytes,
    limitBytes: BUBBLE_SIZE_LIMIT_BYTES,
  };
}

// --- 表示ヘルパー ----------------------------------------------------------------

function formatRankDiffArrow(rank: number | null, rankPrev: number | null): string | null {
  // R3.7: 前日の記録が存在しない場合は前日比を表示しない。
  if (rank === null || rankPrev === null) {
    return null;
  }
  if (rank < rankPrev) {
    return '↑ 上昇';
  }
  if (rank > rankPrev) {
    return '↓ 下降';
  }
  return '→ 変動なし';
}

function buildHeader(summary: DailySummaryRow): FlexBox {
  const contents: FlexText[] = [];

  if (summary.status === 'failed' || summary.rank === null || summary.rank_total === null) {
    contents.push({
      type: 'text',
      text: '本日のポジションを取得できませんでした',
      weight: 'bold',
      size: 'md',
      wrap: true,
    });
  } else {
    contents.push({
      type: 'text',
      text: `近隣${summary.rank_total}店中 ${summary.rank}位`,
      weight: 'bold',
      size: 'xl',
    });

    const diffText = formatRankDiffArrow(summary.rank, summary.rank_prev);
    if (diffText !== null) {
      contents.push({
        type: 'text',
        text: `前日比: ${diffText}`,
        size: 'sm',
        color: '#666666',
      });
    }
  }

  return { type: 'box', layout: 'vertical', contents };
}

function buildSelfMetricsSection(summary: DailySummaryRow): FlexBox {
  const ratingText = summary.rating ?? '—';
  const reviewCountText = summary.review_count !== null ? `${summary.review_count}件` : '—';
  return {
    type: 'box',
    layout: 'vertical',
    contents: [
      {
        type: 'text',
        text: '自店の評価',
        size: 'sm',
        color: '#aaaaaa',
      },
      {
        type: 'text',
        text: `★${ratingText}（クチコミ ${reviewCountText}）`,
        weight: 'bold',
        size: 'md',
      },
    ],
  };
}

function formatNewReviewExcerpt(review: DailySummaryNewReview): FlexText {
  const stars = '★'.repeat(Math.max(0, Math.min(5, Math.round(review.rating))));
  return {
    type: 'text',
    text: `${review.authorName}さん ${stars}「${review.textExcerpt}」`,
    size: 'sm',
    color: '#666666',
    wrap: true,
  };
}

function buildNewReviewsSection(summary: DailySummaryRow): FlexBox {
  const header: FlexText = {
    type: 'text',
    text: '新着クチコミ',
    size: 'sm',
    color: '#aaaaaa',
  };

  if (summary.new_review_count <= 0) {
    return {
      type: 'box',
      layout: 'vertical',
      contents: [
        header,
        { type: 'text', text: NO_NEW_REVIEWS_TEXT, size: 'md' },
      ],
    };
  }

  const excerpts = summary.new_reviews
    .slice(0, MAX_DISPLAYED_NEW_REVIEWS)
    .map(formatNewReviewExcerpt);

  return {
    type: 'box',
    layout: 'vertical',
    contents: [
      header,
      { type: 'text', text: `${summary.new_review_count}件の新着クチコミ`, weight: 'bold', size: 'md' },
      ...excerpts,
    ],
  };
}

function formatCompetitorLine(competitor: DailySummaryCompetitor): FlexBox {
  const ratingText = competitor.rating ?? '—';
  const diffText = competitor.starDiff ?? '—';
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: competitor.name, size: 'sm', wrap: true, flex: 3 },
      { type: 'text', text: `★${ratingText}`, size: 'sm', align: 'end', flex: 1 },
      { type: 'text', text: diffText, size: 'sm', align: 'end', color: '#aaaaaa', flex: 1 },
    ],
  };
}

function buildCompetitorsSection(summary: DailySummaryRow): FlexBox {
  const header: FlexText = {
    type: 'text',
    text: '競合との比較',
    size: 'sm',
    color: '#aaaaaa',
  };

  // R1.3: 競合が 1 店も見つからない場合は自店のみの旨を明示する。
  if (summary.competitors.length === 0) {
    return {
      type: 'box',
      layout: 'vertical',
      contents: [header, { type: 'text', text: NO_COMPETITORS_TEXT, size: 'sm', wrap: true }],
    };
  }

  return {
    type: 'box',
    layout: 'vertical',
    contents: [header, ...summary.competitors.map(formatCompetitorLine)],
  };
}

function buildBody(summary: DailySummaryRow): FlexBox {
  const separator: FlexSeparator = { type: 'separator', margin: 'md' };
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'md',
    contents: [
      buildSelfMetricsSection(summary),
      separator,
      buildNewReviewsSection(summary),
      separator,
      buildCompetitorsSection(summary),
    ],
  };
}

function buildFooter(liffUrl: string): FlexBox {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    contents: [
      {
        type: 'button',
        style: 'primary',
        height: 'sm',
        action: { type: 'uri', label: DETAIL_BUTTON_LABEL, uri: liffUrl },
      },
      {
        type: 'text',
        text: GOOGLE_ATTRIBUTION_TEXT,
        size: 'xxs',
        color: '#aaaaaa',
        align: 'center',
      },
    ],
  };
}

/** altText を 400 字以内に切り詰める（末尾に省略記号を付与）。 */
function truncateAltText(text: string): string {
  if (text.length <= ALT_TEXT_MAX_LENGTH) {
    return text;
  }
  return `${text.slice(0, ALT_TEXT_MAX_LENGTH - 1)}…`;
}

function buildAltText(summary: DailySummaryRow): string {
  if (summary.status === 'failed' || summary.rank === null || summary.rank_total === null) {
    return truncateAltText('【今朝のポジション】本日のデータを取得できませんでした');
  }

  const diffText = formatRankDiffArrow(summary.rank, summary.rank_prev);
  const diffSuffix = diffText !== null ? `（前日比${diffText}）` : '';
  const newReviewSuffix =
    summary.new_review_count > 0 ? ` 新着クチコミ${summary.new_review_count}件あり。` : '';

  const text =
    `【今朝のポジション】近隣${summary.rank_total}店中${summary.rank}位${diffSuffix}。` +
    `★${summary.rating ?? '—'}（クチコミ${summary.review_count ?? 0}件）。${newReviewSuffix}`;

  return truncateAltText(text);
}

/**
 * daily_summaries の 1 行から Flex Message ペイロードを組み立てる。
 *
 * - 前日なし（rank_prev=null）・競合なし（competitors=[]）・新着なし（new_review_count=0）の
 *   各分岐を含む（R1.3, R3.6, R3.7）。
 * - status='failed' の行が渡された場合（本来は target 選定 = task 4.3/4.4 の責務で除外される想定）
 *   でも例外を投げず、取得失敗を伝える縮退表示を返す（silent drop を避ける設計方針に合わせる）。
 * - 組立後に必ずサイズ検証を行い、30KB を超える場合は `FlexBubbleTooLargeError` を送出する
 *   （design.md「組立後にサイズ検証」）。
 */
export function buildDailySummaryFlex(summary: DailySummaryRow, liffUrl: string): FlexMessagePayload {
  const bubble: FlexBubble = {
    type: 'bubble',
    header: buildHeader(summary),
    body: buildBody(summary),
    footer: buildFooter(liffUrl),
  };

  const sizeCheck = validateBubbleSize(bubble);
  if (!sizeCheck.withinLimit) {
    throw new FlexBubbleTooLargeError(sizeCheck.sizeBytes, sizeCheck.limitBytes);
  }

  return {
    type: 'flex',
    altText: buildAltText(summary),
    contents: bubble,
  };
}
