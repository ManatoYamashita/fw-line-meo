import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { findActiveInviteCode } from '../src/invite-codes.js';
import { createOwner } from '../src/owners.js';

// 他ファイルと衝突しない専用 UUID プレフィックス（e3/e4）。
const OP = 'e3333333-3333-3333-3333-333333333333';
const AG1 = 'e4444444-4444-4444-4444-444444444444';
const AG2 = 'e4444444-4444-4444-4444-444444444445';

describe.skipIf(!process.env.DATABASE_URL)('invite-codes accessors (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'invite運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG1,
      OP,
      'invite代理店1',
    ]);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG2,
      OP,
      'invite代理店2',
    ]);
    await pool.query(
      `INSERT INTO agency_invite_codes (agency_id, code) VALUES ($1, $2)`,
      [AG1, 'ACTIVE001'],
    );
    await pool.query(
      `INSERT INTO agency_invite_codes (agency_id, code, disabled_at) VALUES ($1, $2, now())`,
      [AG2, 'DISABLED01'],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('有効なコードは紐付く agencyId を返す', async () => {
    const pool = await getPool();
    const result = await findActiveInviteCode(pool, 'ACTIVE001');
    expect(result).toEqual({ agencyId: AG1 });
  });

  it('disabled_at 済みのコードは null（無効）', async () => {
    const pool = await getPool();
    expect(await findActiveInviteCode(pool, 'DISABLED01')).toBeNull();
  });

  it('存在しないコードは null', async () => {
    const pool = await getPool();
    expect(await findActiveInviteCode(pool, 'NOSUCHCODE')).toBeNull();
  });

  it('同一コードで複数オーナーを登録できる（コードは使い切りにならない・Req 2.5）', async () => {
    const pool = await getPool();
    const first = await findActiveInviteCode(pool, 'ACTIVE001');
    expect(first).toEqual({ agencyId: AG1 });
    await createOwner(pool, { agencyId: AG1, lineUserId: 'U-invite-owner-1' });

    // 1 人目登録後も同じコードは有効なまま
    const second = await findActiveInviteCode(pool, 'ACTIVE001');
    expect(second).toEqual({ agencyId: AG1 });
    await createOwner(pool, { agencyId: AG1, lineUserId: 'U-invite-owner-2' });

    const third = await findActiveInviteCode(pool, 'ACTIVE001');
    expect(third).toEqual({ agencyId: AG1 });
  });
});
