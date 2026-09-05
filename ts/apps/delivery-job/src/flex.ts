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
import { lineColors, lineLayout } from '@fwlm/design-tokens';

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
  // 容器幅を超える text を自動縮小する（LINE 10.13.0+）。wrap を持たない text は既定では
  // 省略記号で切り詰められるため、大きな段を使う数値表示にはこれを添える。
  readonly adjustMode?: 'shrink-to-fit';
}

export interface FlexSeparator {
  readonly type: 'separator';
  readonly margin?: string;
}

export interface FlexButton {
  readonly type: 'button';
  readonly action: FlexUriAction;
  readonly style?: 'primary' | 'secondary' | 'link';
  readonly color?: string;
  readonly height?: 'sm' | 'md';
}

export type FlexBoxContent = FlexText | FlexSeparator | FlexButton | FlexBox;

export interface FlexBox {
  readonly type: 'box';
  readonly layout: 'vertical' | 'horizontal' | 'baseline';
  readonly contents: readonly FlexBoxContent[];
  readonly spacing?: string;
  readonly margin?: string;
  readonly paddingAll?: string;
  readonly paddingBottom?: string;
}

// Bubble の各ブロックの装飾。references/flex-message.md「Bubble Styles」準拠で、
// separator はそのブロックの**上**に線を引く。
export interface FlexBlockStyle {
  readonly separator?: boolean;
}

export interface FlexBubbleStyles {
  readonly footer?: FlexBlockStyle;
}

export interface FlexBubble {
  readonly type: 'bubble';
  readonly styles?: FlexBubbleStyles;
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
      size: lineLayout.bodySize,
      wrap: true,
    });
  } else {
    // 順位はこのカードで唯一の大声（design-language.md「巨大表示はプロダクト全体で 1 箇所」の
    // LINE 面への写像）。wrap を持たない text は容器幅を超えると省略記号で切り詰められるため、
    // 大きな段を使う以上 adjustMode を対で添える（「近隣12店中 10位」のような 2 桁 × 2 が入る）。
    contents.push({
      type: 'text',
      text: `近隣${summary.rank_total}店中 ${summary.rank}位`,
      weight: 'bold',
      size: lineLayout.displaySize,
      adjustMode: 'shrink-to-fit',
    });

    const diffText = formatRankDiffArrow(summary.rank, summary.rank_prev);
    if (diffText !== null) {
      contents.push({
        type: 'text',
        text: `前日比: ${diffText}`,
        size: lineLayout.descriptionSize,
        color: lineColors.description,
      });
    }
  }

  return {
    type: 'box',
    layout: 'vertical',
    contents,
    paddingAll: lineLayout.blockPadding,
    paddingBottom: lineLayout.headerPaddingBottom,
  };
}

/**
 * セクション見出しを組み立てる。
 *
 * 色は description を使う。muted は「補助的な数値・ラベル」の役割であり、本文より薄いため
 * 見出しに当てると階層が逆転する。見出しであることは size と、直下の本文が bold であることが
 * 担っているので、色を一段上げても補足としての読まれ方は変わらない。
 */
function buildSectionHeading(text: string): FlexText {
  return { type: 'text', text, size: lineLayout.descriptionSize, color: lineColors.description };
}

function buildSelfMetricsSection(summary: DailySummaryRow): FlexBox {
  const ratingText = summary.rating ?? '—';
  const reviewCountText = summary.review_count !== null ? `${summary.review_count}件` : '—';
  return {
    type: 'box',
    layout: 'vertical',
    spacing: lineLayout.itemGap,
    contents: [
      buildSectionHeading('自店の評価'),
      {
        type: 'text',
        text: `★${ratingText}（クチコミ ${reviewCountText}）`,
        weight: 'bold',
        size: lineLayout.bodySize,
      },
    ],
  };
}

function formatNewReviewExcerpt(review: DailySummaryNewReview): FlexText {
  const stars = '★'.repeat(Math.max(0, Math.min(5, Math.round(review.rating))));
  return {
    type: 'text',
    text: `${review.authorName}さん ${stars}「${review.textExcerpt}」`,
    size: lineLayout.descriptionSize,
    color: lineColors.description,
    wrap: true,
  };
}

function buildNewReviewsSection(summary: DailySummaryRow): FlexBox {
  const heading = buildSectionHeading('新着クチコミ');

  if (summary.new_review_count <= 0) {
    return {
      type: 'box',
      layout: 'vertical',
      spacing: lineLayout.itemGap,
      contents: [heading, { type: 'text', text: NO_NEW_REVIEWS_TEXT, size: lineLayout.bodySize }],
    };
  }

  const excerpts = summary.new_reviews
    .slice(0, MAX_DISPLAYED_NEW_REVIEWS)
    .map(formatNewReviewExcerpt);

  // 抜粋は表示上限で打ち切るため、見出しが告げる件数と実際に読める件数が食い違う場合がある。
  // 手がかりが無いと、読み手は「5件」と言われて 3 件しか見えない状態に置かれる。
  const hiddenCount = summary.new_review_count - excerpts.length;
  const overflowNotice: readonly FlexText[] =
    hiddenCount > 0
      ? [
          {
            type: 'text',
            text: `ほか${hiddenCount}件`,
            size: lineLayout.descriptionSize,
            color: lineColors.description,
          },
        ]
      : [];

  return {
    type: 'box',
    layout: 'vertical',
    spacing: lineLayout.itemGap,
    contents: [
      heading,
      {
        type: 'text',
        text: `${summary.new_review_count}件の新着クチコミ`,
        weight: 'bold',
        size: lineLayout.bodySize,
      },
      ...excerpts,
      ...overflowNotice,
    ],
  };
}

/**
 * competitor.starDiff（自店 - 競合、design.md 定義）を符号付きの表示文字列に整形する。
 * 正の値には「+」を付与し、0・負値はそのまま toFixed(1) の符号表現に従う。
 */
function formatStarDiff(diff: number): string {
  return diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
}

function formatCompetitorLine(competitor: DailySummaryCompetitor): FlexBox {
  // task 7.1（クロスランタイム契約検証）で発見: competitor.rating/starDiff は jsonb 内の
  // number であり（Go の SummaryCompetitor は文字列化せず float64 をそのまま json.Marshal
  // する）、あらかじめフォーマット済みの文字列ではない。表示直前に本関数で明示的に文字列化する
  // （旧コードは `?? '—'` で string 型を期待しており、型を number に是正した際に
  // コンパイルエラーで顕在化した。詳細は ts/packages/db/src/types.ts のコメント参照）。
  const ratingText = competitor.rating.toFixed(1);
  const diffText = formatStarDiff(competitor.starDiff);
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'text', text: competitor.name, size: lineLayout.descriptionSize, wrap: true, flex: 3 },
      {
        type: 'text',
        text: `★${ratingText}`,
        size: lineLayout.descriptionSize,
        align: 'end',
        flex: 1,
      },
      // 星差はこの行で最も情報量の多い数値（自店が勝っているか負けているか）であり、
      // 行内で最も薄い色を当てると読めない。差分が補足であることは位置（右端）と符号が
      // 運んでいるので、色は説明文と同じ段でよい。
      {
        type: 'text',
        text: diffText,
        size: lineLayout.descriptionSize,
        align: 'end',
        color: lineColors.description,
        flex: 1,
      },
    ],
  };
}

function buildCompetitorsSection(summary: DailySummaryRow): FlexBox {
  const heading = buildSectionHeading('競合との比較');

  // R1.3: 競合が 1 店も見つからない場合は自店のみの旨を明示する。
  if (summary.competitors.length === 0) {
    return {
      type: 'box',
      layout: 'vertical',
      spacing: lineLayout.itemGap,
      contents: [
        heading,
        { type: 'text', text: NO_COMPETITORS_TEXT, size: lineLayout.descriptionSize, wrap: true },
      ],
    };
  }

  return {
    type: 'box',
    layout: 'vertical',
    spacing: lineLayout.itemGap,
    contents: [heading, ...summary.competitors.map(formatCompetitorLine)],
  };
}

function buildBody(summary: DailySummaryRow): FlexBox {
  // 区切り線の margin は親の spacing を、その子についてだけ上書きする。セクション間の間隔より
  // 大きい段を取ることで「節を閉じる線」として読ませる（同じ段だと均等な区切りにしか見えない）。
  const separator: FlexSeparator = { type: 'separator', margin: lineLayout.dividerMargin };
  return {
    type: 'box',
    layout: 'vertical',
    spacing: lineLayout.sectionGap,
    paddingAll: lineLayout.blockPadding,
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
    spacing: lineLayout.itemGap,
    paddingAll: lineLayout.blockPadding,
    contents: [
      {
        type: 'button',
        style: 'primary',
        height: lineLayout.actionHeight,
        // 色を明示しないと LINE 既定の緑で描かれ、オンボーディング完了バブルの CTA
        // （lineColors.action を明示している）と別の緑になりうる。2 面の主要操作を揃える。
        color: lineColors.action,
        action: { type: 'uri', label: DETAIL_BUTTON_LABEL, uri: liffUrl },
      },
      {
        type: 'text',
        text: GOOGLE_ATTRIBUTION_TEXT,
        size: lineLayout.captionSize,
        color: lineColors.muted,
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
    // footer の上に線を引き、操作と帰属表記を本文から切り離す（法的表記の帯として読ませる）。
    styles: { footer: { separator: true } },
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
