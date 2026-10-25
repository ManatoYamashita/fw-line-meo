import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { listRegisteredPlaceIds } from '../src/stores.js';

// 店名検索の「登録済み」照合（Issue #485）。
// 他ファイルと DB を共有するため、衝突しない専用 UUID プレフィックス（b8）と place_id を使う。
const OP = 'b8000000-0000-0000-0000-000000000001';
const AG1 = 'b8000000-0000-0000-0000-000000000011';
const AG2 = 'b8000000-0000-0000-0000-000000000012';
const OW1 = 'b8000000-0000-0000-0000-000000000021';
const OW2 = 'b8000000-0000-0000-0000-000000000022';
const ST_ACTIVE = 'b8000000-0000-0000-0000-000000000031';
const ST_SUSPENDED = 'b8000000-0000-0000-0000-000000000032';
const ST_OTHER_AGENCY = 'b8000000-0000-0000-0000-000000000033';

const PLACE_ACTIVE = 'ChIJ_registered_ids_active';
const PLACE_SUSPENDED = 'ChIJ_registered_ids_suspended';
const PLACE_OTHER_AGENCY = 'ChIJ_registered_ids_other_agency';
const PLACE_UNREGISTERED = 'ChIJ_registered_ids_unregistered';

describe.skipIf(!process.env.DATABASE_URL)('listRegisteredPlaceIds (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '照合運営']);
    await pool.query(
      'INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3), ($4, $2, $5)',
      [AG1, OP, '照合代理店1', AG2, '照合代理店2'],
    );
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
       VALUES ($1, $2, $3, 'store_identified'), ($4, $5, $6, 'store_identified')`,
      [OW1, AG1, 'U-registered-ids-owner-1', OW2, AG2, 'U-registered-ids-owner-2'],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status, suspended_at)
       VALUES ($1, $4, '照合店舗-利用中', $5, 'confirmed', NULL),
              ($2, $4, '照合店舗-停止中', $6, 'confirmed', now()),
              ($3, $7, '照合店舗-他代理店', $8, 'confirmed', NULL)`,
      [ST_ACTIVE, ST_SUSPENDED, ST_OTHER_AGENCY, OW1, PLACE_ACTIVE, PLACE_SUSPENDED, OW2, PLACE_OTHER_AGENCY],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('登録済みの Place ID だけを返す。停止中の店舗・他代理店の店舗も登録済みに含める', async () => {
    const pool = await getPool();
    const registered = await listRegisteredPlaceIds(pool, [
      PLACE_ACTIVE,
      PLACE_SUSPENDED,
      PLACE_OTHER_AGENCY,
      PLACE_UNREGISTERED,
    ]);
    expect([...registered].sort()).toEqual(
      [PLACE_ACTIVE, PLACE_OTHER_AGENCY, PLACE_SUSPENDED].sort(),
    );
  });

  it('未登録だけを渡すと 0 件を返す', async () => {
    const pool = await getPool();
    expect((await listRegisteredPlaceIds(pool, [PLACE_UNREGISTERED])).size).toBe(0);
  });

  it('空配列は 0 件を返す', async () => {
    const pool = await getPool();
    expect((await listRegisteredPlaceIds(pool, [])).size).toBe(0);
  });
});
