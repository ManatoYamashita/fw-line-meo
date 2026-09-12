import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/pool.js';
import { createAuditLog } from '../src/audit-logs.js';

const ACTOR = 'e7777777-7777-7777-7777-777777777777';
const TARGET = 'e8888888-8888-8888-8888-888888888888';

describe.skipIf(!process.env.DATABASE_URL)('audit_logs accessors (DB)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('業務書込の監査行を追記できる', async () => {
    const pool = await getPool();
    const occurredAt = new Date('2026-09-13T00:00:00.000Z');

    await createAuditLog(pool, {
      actorType: 'operator',
      actorId: ACTOR,
      action: 'agency_created',
      targetType: 'agency',
      targetId: TARGET,
      occurredAt,
    });

    const result = await pool.query<{
      actor_type: string;
      actor_id: string;
      action: string;
      target_type: string;
      target_id: string;
      occurred_at: Date;
    }>(
      `SELECT actor_type, actor_id, action, target_type, target_id, occurred_at
         FROM audit_logs
        WHERE actor_id = $1
        ORDER BY occurred_at DESC
        LIMIT 1`,
      [ACTOR],
    );

    expect(result.rows[0]).toMatchObject({
      actor_type: 'operator',
      actor_id: ACTOR,
      action: 'agency_created',
      target_type: 'agency',
      target_id: TARGET,
    });
    expect(result.rows[0]?.occurred_at.toISOString()).toBe(occurredAt.toISOString());
  });

  it('customer は監査主体として登録できない', async () => {
    const pool = await getPool();

    await expect(
      pool.query(
        `INSERT INTO audit_logs
           (actor_type, actor_id, action, target_type, target_id)
         VALUES ('customer', $1, 'onboarding_completed', 'store', $2)`,
        [ACTOR, TARGET],
      ),
    ).rejects.toMatchObject({ code: '22P02' });
  });
});
