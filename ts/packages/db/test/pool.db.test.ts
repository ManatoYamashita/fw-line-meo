import { describe, it, expect, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';

// DATABASE_URL が無い環境（通常の make ts-test）では自動 skip。
// make ts-test-db が native postgres を用意して DATABASE_URL を注入したときのみ実行。
describe.skipIf(!process.env.DATABASE_URL)('pool (DB)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('pool 経由で SELECT 1 が通る', async () => {
    const pool = await getPool();
    const res = await pool.query<{ one: number }>('SELECT 1 AS one');
    expect(res.rows[0]?.one).toBe(1);
  });
});
