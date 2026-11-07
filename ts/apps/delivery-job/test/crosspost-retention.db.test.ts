import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool, type Queryable } from '@fwlm/db';
import { runCrosspostRetention, runCrosspostRetentionSafely } from '../src/crosspost-retention.js';

// 一括発信の保存期間の削除（line-crosspost Req 8.8）。利用者の操作が無くても、毎時の配信ジョブが消すことを確かめる。
// 専用 UUID プレフィックス `3a`。

const OP = '3a000000-0000-4000-8000-000000000001';
const AG = '3a000000-0000-4000-8000-000000000002';
const OW = '3a000000-0000-4000-8000-000000000003';
const STORE = '3a000000-0000-4000-8000-000000000004';
const PURGE = '3a000000-0000-4000-8000-0000000000d1';
const EXPIRED = '3a000000-0000-4000-8000-0000000000d2';
const KEEP = '3a000000-0000-4000-8000-0000000000d3';

describe('runCrosspostRetention', () => {
  it('migration 0019 が当たる前の DB（表が無い）では何もしない', async () => {
    const calls: string[] = [];
    const db = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [{ ok: false }], rowCount: 1 };
      },
    } as unknown as Queryable;
    expect(await runCrosspostRetention(db, new Date())).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('runCrosspostRetentionSafely（配信の本処理を巻き込まない）', () => {
  it('migration 0019 が当たる前の DB では何も記録せず、例外も投げない', async () => {
    const logs: string[] = [];
    const db = { query: async () => ({ rows: [{ ok: false }], rowCount: 1 }) } as unknown as Queryable;
    await expect(runCrosspostRetentionSafely(db, new Date(), (_l, event) => logs.push(event))).resolves.toBeUndefined();
    expect(logs).toEqual([]);
  });

  it('削除が失敗しても（権限の不足・接続断）例外を投げず、失敗の種別だけを記録する', async () => {
    const logs: Array<{ level: string; event: string; fields: Readonly<Record<string, number | string>> }> = [];
    let calls = 0;
    const db = {
      query: async () => {
        calls += 1;
        if (calls === 1) return { rows: [{ ok: true }], rowCount: 1 };
        const err = new Error('permission denied for table crosspost_drafts（本文は記録しない）');
        err.name = 'DatabaseError';
        throw err;
      },
    } as unknown as Queryable;
    await expect(
      runCrosspostRetentionSafely(db, new Date(), (level, event, fields) => logs.push({ level, event, fields })),
    ).resolves.toBeUndefined();
    expect(logs).toEqual([{ level: 'warn', event: 'delivery-job.crosspost_retention_failed', fields: { errorKind: 'Error' } }]);
    expect(JSON.stringify(logs)).not.toContain('permission denied');
  });
});

describe.skipIf(!process.env.DATABASE_URL)('runCrosspostRetention (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '保存期間ジョブ運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, '保存期間ジョブ代理店']);
    await pool.query(`INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, 'U-3a', 'store_identified')`, [OW, AG]);
    await pool.query(`INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, '保存期間ジョブ店', 'P-3a', 'confirmed')`, [STORE, OW]);
    await pool.query(
      `INSERT INTO crosspost_drafts (id, owner_id, store_id, status, approved_at, approved_revision, google_text, expires_at, purge_after, created_at)
       VALUES ($1, $4, $5, 'approved', now() - interval '31 days', 1, 'g', now() - interval '31 days', now() - interval '1 hour', now() - interval '31 days'),
              ($2, $4, $5, 'collecting', NULL, NULL, NULL, now() - interval '1 minute', now() + interval '29 days', now() - interval '1 day'),
              ($3, $4, $5, 'approved', now() - interval '8 days', 1, 'g', now(), now() + interval '22 days', now() - interval '8 days')`,
      [PURGE, EXPIRED, KEEP, OW, STORE],
    );
    await pool.query(
      `INSERT INTO crosspost_media (draft_id, line_message_id, line_sent_at, storage_key, content_type, width, height, byte_size, sha256, created_at)
       VALUES ($1, '1', now(), 'crosspost/3a-expired.jpg', 'image/jpeg', 10, 10, 10, $3, now() - interval '1 day'),
              ($2, '2', now(), 'crosspost/3a-old.jpg', 'image/jpeg', 10, 10, 10, $3, now() - interval '8 days')`,
      [EXPIRED, KEEP, 'd'.repeat(64)],
    );
  });

  afterAll(async () => {
    const pool = await getPool();
    await pool.query('DELETE FROM crosspost_drafts WHERE owner_id = $1', [OW]);
    await closePool();
  });

  it('保存期間を過ぎた下書き・期限切れの作成中の下書き・7 日を過ぎた写真の行を消し、件数を返す', async () => {
    const pool = await getPool();
    const summary = await runCrosspostRetention(pool, new Date());
    expect(summary).not.toBeNull();
    expect(summary!.crosspostPurgedDrafts).toBeGreaterThanOrEqual(1);
    expect(summary!.crosspostExpiredDrafts).toBeGreaterThanOrEqual(1);
    expect(summary!.crosspostPurgedMedia).toBeGreaterThanOrEqual(1);
    const drafts = await pool.query<{ id: string }>('SELECT id FROM crosspost_drafts WHERE owner_id = $1', [OW]);
    expect(drafts.rows.map((r) => r.id)).toEqual([KEEP]);
    const media = await pool.query('SELECT count(*)::int AS n FROM crosspost_media WHERE storage_key LIKE $1', ['crosspost/3a-%']);
    expect(media.rows[0].n).toBe(0);
    // 2 回目は消すものが無い（冪等）
    const again = await runCrosspostRetention(pool, new Date());
    expect(again).toMatchObject({ crosspostExpiredDrafts: 0 });
  });
});
