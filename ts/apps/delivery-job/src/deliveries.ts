// 配信記録（Task 4.3）。
//
// design.md「Batch / Job Contract」Idempotency & recovery: 配信前に `summary_deliveries` 行を
// retry_key（UUID）付き INSERT（一意制約違反＝処理済みでスキップ）。Push 後に結果と
// `X-Line-Request-Id` を同じ行へ記録する。
//
// 重要な正しさの性質（task 指示・design.md 準拠）: 「予約（reserve）してから記録（record）する」
// 2 段階は、`UNIQUE (store_id, summary_date)` 制約 + `ON CONFLICT DO NOTHING` の INSERT で
// アトミック・競合安全に行う（アプリ側の check-then-insert は競合状態を生むため使わない）。
// 衝突（既に行が存在する）は「他の実行が既に処理済み」を意味し、本実行はこの対象を skip する
// （行の上書きはしない — Go 側 summaries.go の ON CONFLICT DO UPDATE とは異なり、ここでは
// DO NOTHING が正しい: 予約は早い者勝ちで、2 回目の予約試行が 1 回目の結果を壊してはならない）。
//
// summary_deliveries.status は CHECK 制約で 'delivered' | 'failed' | 'skipped_no_summary' |
// 'quota_exceeded' の 4 値のみを許容し、「予約済みだが結果未確定」を表す専用値は存在しない。
// そのため予約 INSERT は暫定的に status='failed'（+ プレースホルダの error_detail）を書き込み、
// Push 実行後に recordDeliveryResult が必ず最終値へ上書きする。万一プロセスがクラッシュし
// recordDeliveryResult が呼ばれないまま終了した場合でも、行は「失敗」として正直に残り
// （silent drop にしない）、かつ当日中の再試行では一意制約により再配信されない
// （最悪でも「その日は届かない」に倒れる安全側の設計）。

import type { Queryable, SummaryDeliveryStatus } from '@fwlm/db';

/** 予約 INSERT の結果。'reserved' = 新規行を確保できた。'already_processed' = 一意制約衝突（skip）。 */
export type ReserveDeliveryOutcome = 'reserved' | 'already_processed';

/** recordDeliveryResult が最終的な結果へ上書きするまでの暫定 status（CHECK 制約の許容値の 1 つ）。 */
const RESERVATION_PLACEHOLDER_STATUS: SummaryDeliveryStatus = 'failed';
const RESERVATION_PLACEHOLDER_ERROR_DETAIL =
  'reserved: delivery result not yet recorded (recordDeliveryResult 未実行のまま終了した可能性あり)';

/**
 * `summary_deliveries` 行を retry_key 付きで事前確保する。呼出元（task 4.4）は Push 実行前に
 * これを呼び、'reserved' が返った場合のみ Push・recordDeliveryResult へ進む。
 * 'already_processed' は同一 (store_id, summary_date) が既に他の実行で確保済みであることを示し、
 * 呼出元はこのイテレーションを skip する（重複配信防止・R3.9）。
 */
export async function reserveDelivery(
  pool: Queryable,
  storeId: string,
  summaryDate: string,
  lineUserId: string,
  retryKey: string,
): Promise<ReserveDeliveryOutcome> {
  const res = await pool.query(
    `INSERT INTO summary_deliveries (store_id, summary_date, line_user_id, status, retry_key, error_detail)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (store_id, summary_date) DO NOTHING
     RETURNING id`,
    [
      storeId,
      summaryDate,
      lineUserId,
      RESERVATION_PLACEHOLDER_STATUS,
      retryKey,
      RESERVATION_PLACEHOLDER_ERROR_DETAIL,
    ],
  );

  return res.rowCount && res.rowCount > 0 ? 'reserved' : 'already_processed';
}

/**
 * 予約済みの `summary_deliveries` 行へ最終結果を記録する。reserveDelivery が 'reserved' を返した
 * (store_id, summary_date) に対してのみ呼び出すこと。
 *
 * status は line.ts の `LinePushResult`（'success'→'delivered' / 'failed'→'failed' /
 * 'quota_exceeded'→'quota_exceeded'）または targets.ts の skip 検出（→'skipped_no_summary'）と
 * 1:1 で対応させる（このマッピング自体は呼出元 index.ts の責務・本関数は受け取った値をそのまま書く）。
 *
 * 対象行が存在しない（reserveDelivery を経ずに呼ばれた等のプログラムエラー）場合は例外を送出する
 * （silent drop を避ける — design.md Error Strategy）。
 */
export async function recordDeliveryResult(
  pool: Queryable,
  storeId: string,
  summaryDate: string,
  status: SummaryDeliveryStatus,
  lineRequestId: string | null = null,
  errorDetail: string | null = null,
  deliveredAt: Date | null = null,
): Promise<void> {
  const res = await pool.query(
    `UPDATE summary_deliveries
        SET status = $3, line_request_id = $4, error_detail = $5, delivered_at = $6
      WHERE store_id = $1 AND summary_date = $2`,
    [storeId, summaryDate, status, lineRequestId, errorDetail, deliveredAt],
  );

  if (!res.rowCount) {
    throw new Error(
      `recordDeliveryResult: no reserved summary_deliveries row for store_id=${storeId} summary_date=${summaryDate} (reserveDelivery が先に呼ばれていない可能性)`,
    );
  }
}
