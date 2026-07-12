// 詳細データの読取クエリ（Task 5.2）。
//
// 責務は「認可済み storeId から、当日サマリー・自店/競合の指標・直近30日推移を読み取る」ことのみ。
// 認可（sub → storeId の解決）は lib/liff-auth.ts（task 5.1）の責務であり、本モジュールは
// クライアント制御可能な識別子を一切受け取らない liff-auth.ts とは異なり、既に認可済みの
// storeId を信頼して受け取る（呼出元 = app/api/detail/route.ts が authorizeStoreDetailRequest の
// 成功結果からのみ storeId を渡すことを保証する）。
//
// 契約の根拠（CLAUDE.md「LINE API を記憶で答えない」規律・design.md/research.md の事前調査のみを用いる）:
//   design.md「TS / store-detail」Responsibilities & Constraints:
//     表示: 当日サマリー・自店/競合の星評価とクチコミ総数・直近30日の自店順位/評価推移・Google 帰属表示
//   design.md「File Structure Plan」:
//     lib/data.ts: snapshots/summaries/competitors の読取クエリ
//   design.md「Physical Data Model」:
//     daily_summaries は店舗×日付で一意（store_id, summary_date）。competitors jsonb は表示順が
//     rank 順で最大5要素（抽出時固定の上限に一致）。
//   db/migrations/0001_four_tier_baseline.sql（rating_snapshots）:
//     自店の日次順位/評価は subject_kind='self' の行に captured_on（date）単位で記録される。
//   research.md「30日ローリング保持」・go/internal/repo/summaries.go PurgeOlderThan:
//     境界は「asOf を基準に cutoff = asOf - 30日、captured_on/summary_date <= cutoff の行を削除」。
//     保持対象は captured_on > cutoff（= [asOf-29日, asOf] の30日分）。本モジュールの trend 抽出
//     ウィンドウは Go のパージ境界と同一の off-by-one 規約に厳密に合わせる（別の規約を発明しない）。
//
// 読取専用: 本モジュールは SELECT のみを発行し、一切の書込（INSERT/UPDATE/DELETE）を行わない
// （design.md「4.2 閲覧のみ・OAuth 不要」の構造的担保の一部）。

import type {
  DailySummaryCompetitor,
  DailySummaryNewReview,
  DailySummaryStatus,
  Queryable,
} from '@fwlm/db';

// --- 応答形状 ------------------------------------------------------------------------

/** 直近30日推移の1点（自店の日次スナップショット由来）。 */
export interface StoreDetailTrendPoint {
  /** 'YYYY-MM-DD'（rating_snapshots.captured_on）。 */
  readonly capturedOn: string;
  readonly rank: number | null;
  /** numeric(2,1) を精度保持のため文字列で返す（types.ts の既存規約に合わせる）。 */
  readonly rating: string | null;
  readonly reviewCount: number | null;
}

/** 当日サマリー（daily_summaries 1 行の読取専用ビュー）。当日行が無い場合は null。 */
export interface StoreDetailSummary {
  /** 'YYYY-MM-DD'（daily_summaries.summary_date）。 */
  readonly summaryDate: string;
  readonly status: DailySummaryStatus;
  readonly rank: number | null;
  readonly rankTotal: number | null;
  readonly rankPrev: number | null;
  readonly rating: string | null;
  readonly reviewCount: number | null;
  readonly ratingPrev: string | null;
  readonly reviewCountPrev: number | null;
  readonly newReviewCount: number;
  readonly newReviews: readonly DailySummaryNewReview[];
}

export interface StoreDetailResult {
  readonly storeId: string;
  /** 当日 daily_summaries 行が無い場合（バッチ未実行等）は null。silent drop はしない
   *  （呼出元は null を「本日分は準備中」として表示する想定・書込はしない）。 */
  readonly summary: StoreDetailSummary | null;
  /** daily_summaries.competitors（jsonb）から取り出した当日の競合一覧。表示順は rank 順・最大5件。
   *  当日行が無い場合、または R1.3（0件競合）の場合は空配列。 */
  readonly competitors: readonly DailySummaryCompetitor[];
  /** 直近30日（Go の PurgeOlderThan と同一境界）の自店 rank/rating/reviewCount 推移。
   *  captured_on 昇順（古い→新しい）。 */
  readonly trend: readonly StoreDetailTrendPoint[];
}

export interface QueryStoreDetailOptions {
  /** 30日窓・当日サマリーの基準日（'YYYY-MM-DD'）。省略時は現在日付（UTC 基準）。
   *  DB テストで境界（30日目 vs 31日目）を実行時刻に依存せず厳密に固定するための注入口。 */
  readonly asOf?: string;
}

function defaultAsOf(): string {
  const iso = new Date().toISOString();
  return iso.slice(0, 10);
}

// --- 内部クエリ行型（DB 列名そのまま。SELECT で明示的に列指定し、date 列は to_char で
// 'YYYY-MM-DD' テキストとして取得する — pg のタイムゾーン依存な Date パースに頼らないため） ---

interface SummaryQueryRow {
  summary_date: string;
  status: DailySummaryStatus;
  rank: number | null;
  rank_total: number | null;
  rank_prev: number | null;
  rating: string | null;
  review_count: number | null;
  rating_prev: string | null;
  review_count_prev: number | null;
  new_review_count: number;
  new_reviews: DailySummaryNewReview[];
  competitors: DailySummaryCompetitor[];
}

interface TrendQueryRow {
  captured_on: string;
  rating: string | null;
  review_count: number | null;
  rank: number | null;
}

/**
 * 認可済み storeId から、当日サマリー・競合一覧（当日 competitors jsonb 由来）・直近30日の
 * 自店推移を読み取る。競合が1店も無い場合（R1.3・R4.3）は competitors が自然に空配列となる
 * （Go 側が daily_summaries.competitors を '[]' で書き込むため、特別分岐は不要）。
 */
export async function queryStoreDetail(
  pool: Queryable,
  storeId: string,
  options: QueryStoreDetailOptions = {},
): Promise<StoreDetailResult> {
  const asOf = options.asOf ?? defaultAsOf();

  const [summaryRes, trendRes] = await Promise.all([
    pool.query<SummaryQueryRow>(
      `SELECT to_char(summary_date, 'YYYY-MM-DD') AS summary_date,
              status, rank, rank_total, rank_prev,
              rating, review_count, rating_prev, review_count_prev,
              new_review_count, new_reviews, competitors
         FROM daily_summaries
        WHERE store_id = $1 AND summary_date = $2::date`,
      [storeId, asOf],
    ),
    // 境界: cutoff = asOf - 30日。保持（＝表示）対象は captured_on > cutoff（PurgeOlderThan と同一）。
    // 上限 captured_on <= asOf は将来日付の混入を防ぐ防御的な条件（通常は発生しない）。
    pool.query<TrendQueryRow>(
      `SELECT to_char(captured_on, 'YYYY-MM-DD') AS captured_on,
              rating, review_count, rank
         FROM rating_snapshots
        WHERE store_id = $1
          AND subject_kind = 'self'
          AND captured_on > ($2::date - INTERVAL '30 days')
          AND captured_on <= $2::date
        ORDER BY captured_on ASC`,
      [storeId, asOf],
    ),
  ]);

  const summaryRow = summaryRes.rows[0];

  const summary: StoreDetailSummary | null = summaryRow
    ? {
        summaryDate: summaryRow.summary_date,
        status: summaryRow.status,
        rank: summaryRow.rank,
        rankTotal: summaryRow.rank_total,
        rankPrev: summaryRow.rank_prev,
        rating: summaryRow.rating,
        reviewCount: summaryRow.review_count,
        ratingPrev: summaryRow.rating_prev,
        reviewCountPrev: summaryRow.review_count_prev,
        newReviewCount: summaryRow.new_review_count,
        newReviews: summaryRow.new_reviews,
      }
    : null;

  const competitors: readonly DailySummaryCompetitor[] = summaryRow?.competitors ?? [];

  const trend: StoreDetailTrendPoint[] = trendRes.rows.map((row) => ({
    capturedOn: row.captured_on,
    rank: row.rank,
    rating: row.rating,
    reviewCount: row.review_count,
  }));

  return { storeId, summary, competitors, trend };
}
