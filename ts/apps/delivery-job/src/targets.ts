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

import type { DailySummaryRow, Queryable } from '@fwlm/db';

/** queryDeliveryTargets が返す 1 件（配信可能＝当日 summary あり・未配信）。 */
export interface DeliveryTarget {
  readonly storeId: string;
  readonly lineUserId: string;
  readonly summary: DailySummaryRow;
}

/** queryOwnersDueWithoutSummary が返す 1 件（配信時刻は該当するが当日 summary が無い＝skip 候補）。 */
export interface SkippedNoSummaryTarget {
  readonly storeId: string;
  readonly lineUserId: string;
}

/** daily_summaries の列（ds.* そのまま）に owner の line_user_id を join した生行。 */
type ReadyTargetRow = DailySummaryRow & { readonly owner_line_user_id: string };

function assertValidHour(currentJSTHour: number): void {
  if (!Number.isInteger(currentJSTHour) || currentJSTHour < 0 || currentJSTHour > 23) {
    throw new RangeError(`currentJSTHour must be an integer in 0-23, got: ${currentJSTHour}`);
  }
}

/**
 * 配信可能な対象（`owners.delivery_hour = currentJSTHour` AND 当日 `daily_summaries` 存在 AND
 * `summary_deliveries` 未存在）を抽出する。
 *
 * ゲーティングは `stores.place_status = 'confirmed'` の店舗のみ（design.md 日次バッチ節の
 * ゲーティング方針と同一の「特定済み」定義を踏襲。未確定店舗には daily_summaries が生成されない
 * ため実質的にはこの条件が無くても除外されるが、意図を明示するため条件に含める）。
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
    `SELECT ds.*, o.line_user_id AS owner_line_user_id
       FROM daily_summaries ds
       JOIN stores s ON s.id = ds.store_id
       JOIN owners o ON o.id = s.owner_id
       LEFT JOIN summary_deliveries sd
         ON sd.store_id = ds.store_id AND sd.summary_date = ds.summary_date
      WHERE ds.summary_date = $1
        AND o.delivery_hour = $2
        AND s.place_status = 'confirmed'
        AND sd.id IS NULL`,
    [summaryDate, currentJSTHour],
  );

  return res.rows.map((row) => {
    const { owner_line_user_id: lineUserId, ...summary } = row;
    return { storeId: summary.store_id, lineUserId, summary };
  });
}

/**
 * 配信時刻は該当するが当日 `daily_summaries` が存在しない（06:00 バッチ失敗等）オーナー・店舗を
 * 検出する。`summary_deliveries` が既に存在する（＝前回実行で skipped_no_summary 等が記録済み）
 * 対象は除外し、同一日に重複して skip 候補として返さない（R3.9 と同じ重複防止の考え方）。
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
        AND ds.id IS NULL
        AND sd.id IS NULL`,
    [summaryDate, currentJSTHour],
  );

  return res.rows.map((row) => ({ storeId: row.store_id, lineUserId: row.line_user_id }));
}
