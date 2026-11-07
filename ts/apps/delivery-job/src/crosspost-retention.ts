// 一括発信（line-crosspost・Issue #494）の保存期間の削除（Req 8.3, 8.4, 8.8）。
//
// 保存期間を守るのは利用者の操作に依存してはならない（店主が二度と LINE を開かなくても消える）。毎時の配信ジョブの
// ついでに、保存期間を過ぎた下書き・期限切れの作成中の下書き・受け取りから 7 日を過ぎた写真の行を消す。
// 配信ジョブの SA は crosspost_drafts・crosspost_media の DELETE だけを持つ（infra/sql/grants.sql）。
// 写真の実体は置き場（GCS）の寿命の規則（7 日）が消す。このジョブは置き場へは触れない。
//
// 一括発信が既定 OFF のあいだも動くが、行が無ければ何もしない。migration 0019 が当たる前の DB（表が無い）では
// 何もせずに null を返す（配信の本処理を巻き込まない）。

import { CROSSPOST_MEDIA_RETENTION_MS, purgeCrosspostRetention, type Queryable } from '@fwlm/db';

/** 1 回の削除の件数と、1 回の実行で繰り返す上限（多ければ次の回に続く）。 */
const BATCH_SIZE = 500;
const MAX_BATCHES = 10;

export interface CrosspostRetentionSummary {
  readonly crosspostPurgedDrafts: number;
  readonly crosspostExpiredDrafts: number;
  readonly crosspostPurgedMedia: number;
}

export async function runCrosspostRetention(db: Queryable, now: Date): Promise<CrosspostRetentionSummary | null> {
  const exists = await db.query<{ ok: boolean }>(
    "SELECT to_regclass('public.crosspost_drafts') IS NOT NULL AND to_regclass('public.crosspost_media') IS NOT NULL AS ok",
  );
  if (exists.rows[0]?.ok !== true) return null;

  const mediaOlderThan = new Date(now.getTime() - CROSSPOST_MEDIA_RETENTION_MS);
  let purgedDrafts = 0;
  let expiredDrafts = 0;
  let purgedMedia = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const result = await purgeCrosspostRetention(db, { now, mediaOlderThan, limit: BATCH_SIZE });
    purgedDrafts += result.purgedDrafts;
    expiredDrafts += result.expiredOpenDrafts;
    purgedMedia += result.purgedMedia;
    if (result.purgedDrafts + result.expiredOpenDrafts < BATCH_SIZE && result.purgedMedia < BATCH_SIZE) break;
  }
  return {
    crosspostPurgedDrafts: purgedDrafts,
    crosspostExpiredDrafts: expiredDrafts,
    crosspostPurgedMedia: purgedMedia,
  };
}
