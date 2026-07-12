import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { updateDeliveryHour } from '../src/delivery-settings.js';

// 他テストファイルと DB を共有するため、衝突しない固有 UUID / line_user_id を使う。
const OP = '77777777-7777-7777-7777-777777777777';
const AG = '88888888-8888-8888-8888-888888888888';
const OW = '99999999-8888-7777-6666-555555555555';
const LINE_USER_ID = 'U-delivery-hour-owner';
const UNKNOWN_LINE_USER_ID = 'U-unknown-owner';

async function currentDeliveryHour(lineUserId: string): Promise<number> {
  const pool = await getPool();
  const res = await pool.query<{ delivery_hour: number }>(
    'SELECT delivery_hour FROM owners WHERE line_user_id = $1',
    [lineUserId],
  );
  const row = res.rows[0];
  if (!row) throw new Error('owner not found');
  return row.delivery_hour;
}

describe.skipIf(!process.env.DATABASE_URL)('updateDeliveryHour (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '配信時刻運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      '配信時刻代理店',
    ]);
    await pool.query(
      'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
      [OW, AG, LINE_USER_ID, 'active'],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('デフォルトの配信時刻は 7 時（migration 0004 の DEFAULT）', async () => {
    expect(await currentDeliveryHour(LINE_USER_ID)).toBe(7);
  });

  it('正常系: 0-23 の範囲内なら更新に成功し DB へ永続化される', async () => {
    const pool = await getPool();
    const result = await updateDeliveryHour(pool, LINE_USER_ID, 21);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(await currentDeliveryHour(LINE_USER_ID)).toBe(21);
  });

  it('境界値: 0 は許容される', async () => {
    const pool = await getPool();
    const result = await updateDeliveryHour(pool, LINE_USER_ID, 0);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(await currentDeliveryHour(LINE_USER_ID)).toBe(0);
  });

  it('境界値: 23 は許容される', async () => {
    const pool = await getPool();
    const result = await updateDeliveryHour(pool, LINE_USER_ID, 23);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(await currentDeliveryHour(LINE_USER_ID)).toBe(23);
  });

  it('異常系: 負数は INVALID_HOUR を返し DB を変更しない', async () => {
    const pool = await getPool();
    const before = await currentDeliveryHour(LINE_USER_ID);
    const result = await updateDeliveryHour(pool, LINE_USER_ID, -1);
    expect(result).toEqual({ ok: false, error: 'INVALID_HOUR' });
    expect(await currentDeliveryHour(LINE_USER_ID)).toBe(before);
  });

  it('異常系: 24 以上は INVALID_HOUR を返し DB を変更しない', async () => {
    const pool = await getPool();
    const before = await currentDeliveryHour(LINE_USER_ID);
    const result = await updateDeliveryHour(pool, LINE_USER_ID, 24);
    expect(result).toEqual({ ok: false, error: 'INVALID_HOUR' });
    expect(await currentDeliveryHour(LINE_USER_ID)).toBe(before);
  });

  it('異常系: 非整数（小数）は INVALID_HOUR を返す', async () => {
    const pool = await getPool();
    const result = await updateDeliveryHour(pool, LINE_USER_ID, 7.5);
    expect(result).toEqual({ ok: false, error: 'INVALID_HOUR' });
  });

  it('異常系: 該当オーナーが存在しない line_user_id は OWNER_NOT_FOUND を返す', async () => {
    const pool = await getPool();
    const result = await updateDeliveryHour(pool, UNKNOWN_LINE_USER_ID, 10);
    expect(result).toEqual({ ok: false, error: 'OWNER_NOT_FOUND' });
  });

  it('検証順序: 不正な hour は該当オーナーが無くても INVALID_HOUR を返す（DB を叩かない）', async () => {
    const pool = await getPool();
    const result = await updateDeliveryHour(pool, UNKNOWN_LINE_USER_ID, 99);
    expect(result).toEqual({ ok: false, error: 'INVALID_HOUR' });
  });
});
