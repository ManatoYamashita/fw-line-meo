import { describe, it, expect, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { recordWebhookEventOnce } from '../src/webhook-events.js';

describe.skipIf(!process.env.DATABASE_URL)('webhook-events accessors (DB)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('初回の webhookEventId は true（新規記録）を返す', async () => {
    const pool = await getPool();
    expect(await recordWebhookEventOnce(pool, 'evt-webhook-1')).toBe(true);
  });

  it('同一 webhookEventId の再送は false（既記録・Req 5.4）', async () => {
    const pool = await getPool();
    await recordWebhookEventOnce(pool, 'evt-webhook-2');
    expect(await recordWebhookEventOnce(pool, 'evt-webhook-2')).toBe(false);
  });

  it('異なる webhookEventId はそれぞれ独立して true', async () => {
    const pool = await getPool();
    expect(await recordWebhookEventOnce(pool, 'evt-webhook-3a')).toBe(true);
    expect(await recordWebhookEventOnce(pool, 'evt-webhook-3b')).toBe(true);
  });
});
