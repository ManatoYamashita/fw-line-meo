import type { Queryable } from './pool.js';

/**
 * webhookEventId を初回のみ記録する（Req 5.4: 重複イベントの二重処理防止）。
 * 戻り値 true = 今回が初回記録（処理を続行してよい）。false = 既記録（黙ってスキップすべき）。
 */
export async function recordWebhookEventOnce(
  db: Queryable,
  webhookEventId: string,
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO line_webhook_events (webhook_event_id)
     VALUES ($1)
     ON CONFLICT (webhook_event_id) DO NOTHING`,
    [webhookEventId],
  );
  return (res.rowCount ?? 0) > 0;
}
