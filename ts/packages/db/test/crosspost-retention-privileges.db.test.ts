import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool, type Queryable } from '../src/pool.js';
import { purgeCrosspostRetention } from '../src/crosspost.js';
import { withGrantsLock } from './support/grants-lock.js';

// 保存期間の削除（purgeCrosspostRetention）が、配信ジョブの SA に grants.sql が与える権限（crosspost_drafts・
// crosspost_media の DELETE だけ）で実際に動くことを確かめる（line-crosspost Req 8.8）。
// superuser の接続で緑でも、本番の SA では権限の不足（FOR UPDATE は UPDATE を要する など）で落ちうる。

const here = dirname(fileURLToPath(import.meta.url));
const GRANTS_SQL = resolve(here, '../../../../infra/sql/grants.sql');

const SUFFIX = `${process.pid}_${Date.now()}`;
const ROLE_KEYS = ['line_webhook', 'survey', 'dashboard', 'batch', 'delivery', 'detail'] as const;
const roleName = (key: string) => `fwlm_t494_${key}_${SUFFIX}`;

function grantStatements(): string[] {
  const text = readFileSync(GRANTS_SQL, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('\\'))
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return text
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /^(GRANT|REVOKE)\b/.test(s))
    .map((s) =>
      s.replace(/:"(\w+)"/g, (_, key: string) => {
        if (!(ROLE_KEYS as readonly string[]).includes(key)) throw new Error(`grants.sql の未知の SA: ${key}`);
        return `"${roleName(key)}"`;
      }),
    );
}

const OP = '3c900000-0000-4000-8000-000000000001';
const AG = '3c900000-0000-4000-8000-000000000002';
const OW = '3c900000-0000-4000-8000-000000000003';
const STORE = '3c900000-0000-4000-8000-000000000004';
const DRAFT_PURGE = '3c900000-0000-4000-8000-0000000000d1';
const DRAFT_EXPIRED = '3c900000-0000-4000-8000-0000000000d2';
const DRAFT_KEEP = '3c900000-0000-4000-8000-0000000000d3';

describe.skipIf(!process.env.DATABASE_URL)('一括発信の保存期間の削除 × grants.sql（配信ジョブの権限だけで動く）', () => {
  beforeAll(async () => {
    const pool = await getPool();
    const ok = await pool.query<{ ok: boolean }>('SELECT rolcreaterole OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user');
    expect(ok.rows[0]?.ok, '接続ユーザーに CREATEROLE がありません').toBe(true);
    for (const key of ROLE_KEYS) await pool.query(`CREATE ROLE "${roleName(key)}" NOLOGIN`);
    await pool.query(`GRANT "${roleName('delivery')}" TO CURRENT_USER`);
    await withGrantsLock(pool, async (db) => {
      for (const sql of grantStatements()) await db.query(sql);
    });

    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '保存期間運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, '保存期間代理店']);
    await pool.query(`INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, 'U-3c9', 'store_identified')`, [OW, AG]);
    await pool.query(`INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, '保存期間店', 'P-3c9', 'confirmed')`, [STORE, OW]);
    await pool.query(
      `INSERT INTO crosspost_drafts (id, owner_id, store_id, status, approved_at, approved_revision, google_text, expires_at, purge_after, created_at, line_started_at)
       VALUES ($1, $4, $5, 'approved', now() - interval '31 days', 1, 'g', now() - interval '31 days', now() - interval '1 hour', now() - interval '31 days', now() - interval '31 days'),
              ($2, $4, $5, 'canceled', NULL, NULL, NULL, now() - interval '2 days', now() + interval '28 days', now() - interval '2 days', now() - interval '2 days'),
              ($3, $4, $5, 'collecting', NULL, NULL, NULL, now() - interval '1 hour', now() + interval '29 days', now() - interval '1 day', now() - interval '1 day')`,
      [DRAFT_PURGE, DRAFT_KEEP, DRAFT_EXPIRED, OW, STORE],
    );
    await pool.query(
      `INSERT INTO crosspost_deliveries (draft_id, destination, status, body_text, with_media, attempt_count, last_attempt_at, finished_at)
       VALUES ($1, 'google', 'succeeded', 'g', false, 1, now() - interval '31 days', now() - interval '31 days')`,
      [DRAFT_PURGE],
    );
    await pool.query(
      `INSERT INTO crosspost_media (draft_id, line_message_id, line_sent_at, storage_key, content_type, width, height, byte_size, sha256, created_at)
       VALUES ($1, '1', now(), 'crosspost/3c9-old.jpg', 'image/jpeg', 10, 10, 10, $2, now() - interval '8 days')`,
      [DRAFT_KEEP, 'c'.repeat(64)],
    );
  });

  afterAll(async () => {
    const pool = await getPool();
    await pool.query('DELETE FROM crosspost_drafts WHERE owner_id = $1', [OW]);
    await withGrantsLock(pool, async (db) => {
      for (const key of ROLE_KEYS) {
        const role = roleName(key);
        await db.query(`DROP OWNED BY "${role}"`).catch(() => undefined);
        await db.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
      }
    });
    await closePool();
  });

  it('配信ジョブのロールで、保存期間を過ぎた下書き・期限切れの作成中の下書き・古い写真の行を消せる', async () => {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE "${roleName('delivery')}"`);
      const db: Queryable = { query: client.query.bind(client) as Queryable['query'] };
      const result = await purgeCrosspostRetention(db, {
        now: new Date(),
        mediaOlderThan: new Date(Date.now() - 7 * 86400_000),
        limit: 100,
      });
      expect(result.purgedDrafts).toBeGreaterThanOrEqual(1);
      expect(result.expiredOpenDrafts).toBeGreaterThanOrEqual(1);
      expect(result.removedStorageKeys).toContain('crosspost/3c9-old.jpg');
      // 配信ジョブは下書きの内容を変えられない
      await expect(client.query(`UPDATE crosspost_drafts SET google_text = 'x' WHERE id = $1`, [DRAFT_KEEP])).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
    const left = await pool.query<{ id: string }>('SELECT id FROM crosspost_drafts WHERE owner_id = $1', [OW]);
    expect(left.rows.map((r) => r.id)).toEqual([DRAFT_KEEP]);
    const deliveries = await pool.query('SELECT count(*)::int AS n FROM crosspost_deliveries WHERE draft_id = $1', [DRAFT_PURGE]);
    expect(deliveries.rows[0].n).toBe(0);
  });
});
