import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { listConfirmedStoresByOwner } from '../src/stores.js';

// gbp-post-review-reply spec task 3.3: `listConfirmedStoresByOwner` の実 SQL 検証。
// このアクセサは GbpFlows における **所有検証の唯一の根拠**（postback 由来の storeId は
// この結果集合との突合でしか信用されない）であり、かつ Req 1.1「Place 確定済み店舗のみ」の
// 実装点でもあるため、フィルタ・テナント隔離・並び順を実 DB で固定する。
//
// 専用 UUID プレフィックス `fcd`（ts/ ワークスペース全体で未使用）。
// with-test-db.sh の一時 postgres は make ts-test-db の 1 実行を全パッケージで共有するため、
// fixture の固定 UUID は他の *.db.test.ts と衝突しない値を選ぶこと。
const OP = 'fcd00000-0000-0000-0000-000000000001';
const AG = 'fcd00000-0000-0000-0000-000000000002';
const OWNER_A = 'fcda0000-0000-0000-0000-00000000000a';
const OWNER_B = 'fcdb0000-0000-0000-0000-00000000000b';
const OWNER_EMPTY = 'fcde0000-0000-0000-0000-00000000000e';
const STORE_A_OLD = 'fcda5000-0000-0000-0000-000000000001';
const STORE_A_NEW = 'fcda5000-0000-0000-0000-000000000002';
const STORE_A_PENDING = 'fcda5000-0000-0000-0000-000000000003';
const STORE_B = 'fcdb5000-0000-0000-0000-000000000001';

describe.skipIf(!process.env.DATABASE_URL)('listConfirmedStoresByOwner (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'gbp店舗一覧運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      'gbp店舗一覧代理店',
    ]);
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
       VALUES ($1, $4, 'U-gbp-list-a', 'active'),
              ($2, $4, 'U-gbp-list-b', 'active'),
              ($3, $4, 'U-gbp-list-empty', 'active')`,
      [OWNER_A, OWNER_B, OWNER_EMPTY, AG],
    );
    // created_at を明示して並び順（created_at ASC）を決定的にする。
    // STORE_A_PENDING は place_status='pending'（ck_place_confirmed により place_id は NULL 必須）。
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status, created_at)
       VALUES ($1, $5, 'A店_古', 'ChIJ_gbp_list_a_old', 'confirmed', '2026-01-01T00:00:00Z'),
              ($2, $5, 'A店_新', 'ChIJ_gbp_list_a_new', 'confirmed', '2026-02-01T00:00:00Z'),
              ($3, $5, 'A店_未確定', NULL, 'pending', '2026-01-15T00:00:00Z'),
              ($4, $6, 'B店', 'ChIJ_gbp_list_b', 'confirmed', '2026-01-01T00:00:00Z')`,
      [STORE_A_OLD, STORE_A_NEW, STORE_A_PENDING, STORE_B, OWNER_A, OWNER_B],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('Place 確定済み店舗のみを created_at 昇順で返す（Req 1.1）', async () => {
    const pool = await getPool();

    const stores = await listConfirmedStoresByOwner(pool, OWNER_A);

    expect(stores).toEqual([
      { id: STORE_A_OLD, name: 'A店_古', placeId: 'ChIJ_gbp_list_a_old' },
      { id: STORE_A_NEW, name: 'A店_新', placeId: 'ChIJ_gbp_list_a_new' },
    ]);
  });

  it('未確定（pending）店舗は連携対象に含めない（Req 1.1）', async () => {
    const pool = await getPool();

    const stores = await listConfirmedStoresByOwner(pool, OWNER_A);

    expect(stores.map((store) => store.id)).not.toContain(STORE_A_PENDING);
  });

  it('他オーナーの店舗を返さない（Req 2.6・テナント隔離）', async () => {
    const pool = await getPool();

    const stores = await listConfirmedStoresByOwner(pool, OWNER_B);

    expect(stores).toEqual([{ id: STORE_B, name: 'B店', placeId: 'ChIJ_gbp_list_b' }]);
  });

  it('店舗を持たないオーナーは空配列を返す', async () => {
    const pool = await getPool();

    expect(await listConfirmedStoresByOwner(pool, OWNER_EMPTY)).toEqual([]);
  });

  it('UUID 形式でない ownerId はクエリを発行せず空配列を返す（fail-closed）', async () => {
    const pool = await getPool();

    expect(await listConfirmedStoresByOwner(pool, "' OR 1=1 --")).toEqual([]);
  });
});
