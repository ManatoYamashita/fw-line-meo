// 配信対象抽出（Task 4.3）。
//
// design.md「TS / delivery-job」Responsibilities: 対象抽出 = `owners.delivery_hour = 現在JST時`
// AND 当日 `daily_summaries` 存在 AND `summary_deliveries` 未存在。
//
// 「現在JST時」「当日」の算出は本モジュールの責務ではない（呼出元 = task 4.4 の index.ts が
// 起動時刻から算出し、`currentJSTHour`・`summaryDate` として注入する。純関数的にテスト可能にするため）。
//
// design.md「毎時配信（HH:00 JST）」注記: 「当日 daily_summaries が無い場合（06:00 バッチ失敗等）は
// skip として記録（silent drop にしない）」。本モジュールは配信可能な対象（queryDeliveryTargets）に
// 加え、この skip 記録の入力となる「配信時刻は該当するが当日サマリーが無い」候補を検出する
// queryOwnersDueWithoutSummary も提供する（実際の skipped_no_summary 行の書込は deliveries.ts の責務）。
//
// line-on-demand-report の design.md「DeliveryOrchestrator」Input / validation: 当日の行があり未記録の
// 店舗を、店舗名・オーナーの LINE ユーザー・前日の行とともに抽出し、当日と前日を正規化する。抽出の条件
// （配信時刻・当日の集計・未記録・特定済み）は変えない。

import type { DailySummaryCompetitor, DailySummaryRow, DailySummaryStatus, Queryable } from '@fwlm/db';
import { normalizeSummaryRatings } from '@fwlm/db/daily-summary';

/**
 * 前日の日次集計のうち、通知の判定（notification.ts の NotificationSubject）が読む列。正規化済みである。
 *
 * 判定に要らない列（新着件数・口コミの抜粋など）は読まない。前日の行は「当日の順位と比べる起点」
 * としてだけ使うので、当日の行のように行全体を運ばない。
 */
export interface DeliveryTargetYesterday {
  readonly status: DailySummaryStatus;
  readonly rank: number | null;
  readonly rank_total: number | null;
}

/** queryDeliveryTargets が返す 1 件（配信可能＝当日 summary あり・未配信）。 */
export interface DeliveryTarget {
  readonly storeId: string;
  /** 店舗名。通知の本文に必ず店舗名を出すため（1.7・3.8）。 */
  readonly storeName: string;
  readonly lineUserId: string;
  /** 当日の行（正規化済み）。 */
  readonly summary: DailySummaryRow;
  /** 前日の行（正規化済み）。前日の集計が無ければ null（初日の店舗も対象から外さない）。 */
  readonly yesterday: DeliveryTargetYesterday | null;
}

/** queryOwnersDueWithoutSummary が返す 1 件（配信時刻は該当するが当日 summary が無い＝skip 候補）。 */
export interface SkippedNoSummaryTarget {
  readonly storeId: string;
  readonly lineUserId: string;
}

/**
 * 前日の行から読む列。正規化（Issue #255）は評価・順位の列と競合の一覧をまとめて見るため、
 * 判定が読む 3 列だけでなく、正規化の入力になる列も含む。
 */
interface PreviousSummaryColumns {
  readonly status: DailySummaryStatus;
  readonly rank: number | null;
  readonly rank_total: number | null;
  readonly rank_prev: number | null;
  readonly rating: string | null;
  readonly rating_prev: string | null;
  readonly competitors: DailySummaryCompetitor[];
}

/**
 * daily_summaries の当日の列（ds.* そのまま）に、店舗名・owner の line_user_id・前日の行を
 * join した生行。
 *
 * 前日の行は jsonb の 1 列（previous_summary）として読む。当日の列と同じ平らな列にすると、
 * 当日の行（DailySummaryRow）を残りの列から作るときに前日の列を 1 つずつ除く必要があるためである。
 * 前日の行が無ければ null（LEFT JOIN）。
 */
type ReadyTargetRow = DailySummaryRow & {
  readonly store_name: string;
  readonly owner_line_user_id: string;
  readonly previous_summary: PreviousSummaryColumns | null;
};

/** 前日の行を、正規化を通した DeliveryTargetYesterday へ変換する。前日の行が無ければ null。 */
function toYesterday(previous: PreviousSummaryColumns | null): DeliveryTargetYesterday | null {
  if (previous === null) {
    return null;
  }

  const normalized = normalizeSummaryRatings(previous);
  return { status: previous.status, rank: normalized.rank, rank_total: normalized.rank_total };
}

function assertValidHour(currentJSTHour: number): void {
  if (!Number.isInteger(currentJSTHour) || currentJSTHour < 0 || currentJSTHour > 23) {
    throw new RangeError(`currentJSTHour must be an integer in 0-23, got: ${currentJSTHour}`);
  }
}

/**
 * 配信可能な対象（`owners.delivery_hour = currentJSTHour` AND 当日 `daily_summaries` 存在 AND
 * `summary_deliveries` 未存在）を、店舗名・オーナーの LINE ユーザー・前日の行とともに抽出する。
 *
 * 当日の行と前日の行は、どちらも正規化（Issue #255）を通してから返す。通知の判定（notification.ts）は
 * 正規化済みの値だけを読む。
 *
 * 前日の行は `summary_date = 当日 - 1`（暦日の 1 日前）の LEFT JOIN で読む。前日の行が無い店舗
 * （初日の店舗・前日に取得できなかった店舗）も対象から外さず、前日を null にして返す。送るかどうかの
 * 判定は呼出元の責務である。
 *
 * 配信時刻の条件（`owners.delivery_hour`）は既存のまま変えない（1.9）。
 *
 * ゲーティングは `stores.place_status = 'confirmed'` の店舗のみ（design.md 日次バッチ節の
 * ゲーティング方針と同一の「特定済み」定義を踏襲。未確定店舗には daily_summaries が生成されない
 * ため実質的にはこの条件が無くても除外されるが、意図を明示するため条件に含める。3.4）。
 *
 * 停止中の店舗（`stores.suspended_at` が非 NULL・Issue #252）は対象にしない（store-suspension 4.1）。
 * 停止中の店舗は日次取得の対象から外れるため通常は当日の集計を持たないが、集計の作成後から配信時刻までの
 * 間に停止された店舗は当日の行を持ちうるので、この述語で外す（4.2）。再開すれば（`suspended_at` が
 * NULL に戻れば）通常どおり対象になる（4.4）。
 *
 * `summaryDate` は 'YYYY-MM-DD' 形式（PostgreSQL の date 列と比較可能な文字列）。
 */
export async function queryDeliveryTargets(
  pool: Queryable,
  currentJSTHour: number,
  summaryDate: string,
): Promise<DeliveryTarget[]> {
  assertValidHour(currentJSTHour);

  const res = await pool.query<ReadyTargetRow>(
    `SELECT ds.*, s.name AS store_name, o.line_user_id AS owner_line_user_id,
            CASE WHEN prev.id IS NULL THEN NULL ELSE jsonb_build_object(
              'status', prev.status,
              'rank', prev.rank,
              'rank_total', prev.rank_total,
              'rank_prev', prev.rank_prev,
              'rating', prev.rating::text,
              'rating_prev', prev.rating_prev::text,
              'competitors', prev.competitors) END AS previous_summary
       FROM daily_summaries ds
       JOIN stores s ON s.id = ds.store_id
       JOIN owners o ON o.id = s.owner_id
       LEFT JOIN summary_deliveries sd
         ON sd.store_id = ds.store_id AND sd.summary_date = ds.summary_date
       LEFT JOIN daily_summaries prev
         ON prev.store_id = ds.store_id AND prev.summary_date = ds.summary_date - 1
      WHERE ds.summary_date = $1
        AND o.delivery_hour = $2
        AND s.place_status = 'confirmed'
        AND s.suspended_at IS NULL
        AND sd.id IS NULL`,
    [summaryDate, currentJSTHour],
  );

  return res.rows.map((row) => {
    const { store_name: storeName, owner_line_user_id: lineUserId, previous_summary: previous, ...summary } = row;
    // 評価の無い店（旧 Go のゼロ値 0 / 新 Go の null）を同じ形へ揃えてから渡す（Issue #255）。
    // 通知の判定と組立は、当日も前日も正規化済みの行を前提にする。
    return {
      storeId: summary.store_id,
      storeName,
      lineUserId,
      summary: { ...summary, ...normalizeSummaryRatings(summary) },
      yesterday: toYesterday(previous),
    };
  });
}

/**
 * 配信時刻は該当するが当日 `daily_summaries` が存在しない（06:00 バッチ失敗等）オーナー・店舗を
 * 検出する。`summary_deliveries` が既に存在する（＝前回実行で skipped_no_summary 等が記録済み）
 * 対象は除外し、同一日に重複して skip 候補として返さない（R3.9 と同じ重複防止の考え方）。
 *
 * 停止中の店舗（`stores.suspended_at` が非 NULL・Issue #252）は skip 候補にもしない。停止中の店舗には
 * 送信の記録も、いかなる理由の見送りの記録も残さない（store-suspension 4.3）。停止中の店舗は日次取得の
 * 対象から外れて当日の集計を持たないため、この述語が無いと毎日 skipped_no_summary が記録される。
 */
export async function queryOwnersDueWithoutSummary(
  pool: Queryable,
  currentJSTHour: number,
  summaryDate: string,
): Promise<SkippedNoSummaryTarget[]> {
  assertValidHour(currentJSTHour);

  const res = await pool.query<{ store_id: string; line_user_id: string }>(
    `SELECT s.id AS store_id, o.line_user_id
       FROM stores s
       JOIN owners o ON o.id = s.owner_id
       LEFT JOIN daily_summaries ds
         ON ds.store_id = s.id AND ds.summary_date = $1
       LEFT JOIN summary_deliveries sd
         ON sd.store_id = s.id AND sd.summary_date = $1
      WHERE o.delivery_hour = $2
        AND s.place_status = 'confirmed'
        AND s.suspended_at IS NULL
        AND ds.id IS NULL
        AND sd.id IS NULL`,
    [summaryDate, currentJSTHour],
  );

  return res.rows.map((row) => ({ storeId: row.store_id, lineUserId: row.line_user_id }));
}
