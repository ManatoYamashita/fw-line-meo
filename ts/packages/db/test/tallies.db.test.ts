import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { incrementTallies } from '../src/tallies.js';

// accessors テストと DB を共有するため、衝突しない固有 UUID / line_user_id を使う。
const OP = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AG = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OW = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const STORE = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

async function ratingCount(storeId: string, star: number, periodMonth?: string): Promise<number> {
  const pool = await getPool();
  const sql = periodMonth
    ? 'SELECT count FROM survey_rating_tallies WHERE store_id=$1 AND star=$2 AND period_month=$3::date'
    : 'SELECT count FROM survey_rating_tallies WHERE store_id=$1 AND star=$2';
  const params = periodMonth ? [storeId, star, periodMonth] : [storeId, star];
  const res = await pool.query<{ count: number }>(sql, params);
  return res.rows[0]?.count ?? 0;
}

async function aspectCount(storeId: string, code: string): Promise<number> {
  const pool = await getPool();
  const res = await pool.query<{ count: number }>(
    'SELECT count FROM survey_aspect_tallies WHERE store_id=$1 AND aspect_code=$2',
    [storeId, code],
  );
  return res.rows[0]?.count ?? 0;
}

describe.skipIf(!process.env.DATABASE_URL)('incrementTallies (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '集計運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      '集計代理店',
    ]);
    await pool.query(
      'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
      [OW, AG, 'U-tally-line-user', 'active'],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status)
       VALUES ($1, $2, $3, $4, 'confirmed')`,
      [STORE, OW, '集計店舗', 'ChIJ_tally'],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('1 回答で rating と選択 aspect を加算する', async () => {
    const pool = await getPool();
    await incrementTallies(pool, { storeId: STORE, star: 5, aspectCodes: ['taste', 'service'] });
    expect(await ratingCount(STORE, 5)).toBe(1);
    expect(await aspectCount(STORE, 'taste')).toBe(1);
    expect(await aspectCount(STORE, 'service')).toBe(1);
  });

  it('同一 store・同一月の再回答で count が加算される', async () => {
    const pool = await getPool();
    await incrementTallies(pool, { storeId: STORE, star: 5, aspectCodes: ['taste', 'service'] });
    expect(await ratingCount(STORE, 5)).toBe(2);
    expect(await aspectCount(STORE, 'taste')).toBe(2);
  });

  it('aspect 空の回答は rating のみ加算し aspect は変えない', async () => {
    const pool = await getPool();
    const tasteBefore = await aspectCount(STORE, 'taste');
    await incrementTallies(pool, { storeId: STORE, star: 3, aspectCodes: [] });
    expect(await ratingCount(STORE, 3)).toBe(1);
    expect(await aspectCount(STORE, 'taste')).toBe(tasteBefore);
  });

  it('同一回答内の重複 aspect は 1 回分だけ加算する', async () => {
    const pool = await getPool();
    await incrementTallies(pool, { storeId: STORE, star: 2, aspectCodes: ['volume', 'volume'] });
    expect(await aspectCount(STORE, 'volume')).toBe(1);
  });

  it('JST 月境界: 7/31 23:59 JST は 7 月に加算', async () => {
    const pool = await getPool();
    // 2026-07-31T14:59:00Z = 2026-07-31 23:59 JST
    await incrementTallies(
      pool,
      { storeId: STORE, star: 4, aspectCodes: ['price'] },
      new Date('2026-07-31T14:59:00Z'),
    );
    expect(await ratingCount(STORE, 4, '2026-07-01')).toBe(1);
  });

  it('JST 月境界: 8/1 00:01 JST は 8 月に加算（7 月分は不変）', async () => {
    const pool = await getPool();
    // 2026-07-31T15:01:00Z = 2026-08-01 00:01 JST
    await incrementTallies(
      pool,
      { storeId: STORE, star: 4, aspectCodes: ['price'] },
      new Date('2026-07-31T15:01:00Z'),
    );
    expect(await ratingCount(STORE, 4, '2026-08-01')).toBe(1);
    expect(await ratingCount(STORE, 4, '2026-07-01')).toBe(1); // 別月として分離
  });

  it('不正な aspect_code は TX 全体をロールバックし rating も加算しない', async () => {
    const pool = await getPool();
    await expect(
      incrementTallies(pool, { storeId: STORE, star: 1, aspectCodes: ['__no_such_aspect__'] }),
    ).rejects.toThrow();
    // FK 違反で rating(1) も未コミット
    expect(await ratingCount(STORE, 1)).toBe(0);
  });
});
