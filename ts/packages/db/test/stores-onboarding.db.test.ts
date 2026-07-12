import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { findStoreByPlaceId, createConfirmedStore } from '../src/stores.js';
import { createOwner } from '../src/owners.js';

// 他ファイルと衝突しない専用 UUID プレフィックス（e8/e9）。
const OP = 'e8888888-8888-8888-8888-888888888888';
const AG = 'e9999999-9999-9999-9999-999999999999';

describe.skipIf(!process.env.DATABASE_URL)('stores onboarding accessors (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'store運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      'store代理店',
    ]);
  });

  afterAll(async () => {
    await closePool();
  });

  describe('findStoreByPlaceId', () => {
    it('未登録の place_id は null', async () => {
      const pool = await getPool();
      expect(await findStoreByPlaceId(pool, 'ChIJ_not_registered')).toBeNull();
    });
  });

  describe('createConfirmedStore / findStoreByPlaceId', () => {
    it('confirmed 状態・place_id 設定済みの店舗を作成する（Req 4.2）', async () => {
      const pool = await getPool();
      const owner = await createOwner(pool, { agencyId: AG, lineUserId: 'U-store-owner-1' });

      const store = await createConfirmedStore(pool, {
        ownerId: owner.id,
        placeId: 'ChIJ_confirmed_1',
        name: '確定店舗テスト',
        latitude: 35.6,
        longitude: 139.7,
      });

      expect(store.owner_id).toBe(owner.id);
      expect(store.place_id).toBe('ChIJ_confirmed_1');
      expect(store.place_status).toBe('confirmed');

      const found = await findStoreByPlaceId(pool, 'ChIJ_confirmed_1');
      expect(found?.id).toBe(store.id);
    });

    it('同一 place_id で 2 店舗目を作成すると一意制約違反になる（Req 4.4 の下地）', async () => {
      const pool = await getPool();
      const owner = await createOwner(pool, { agencyId: AG, lineUserId: 'U-store-owner-2' });

      await expect(
        createConfirmedStore(pool, {
          ownerId: owner.id,
          placeId: 'ChIJ_confirmed_1',
          name: '重複登録テスト',
        }),
      ).rejects.toThrow();
    });

    it('categoryCode を省略しても作成できる', async () => {
      const pool = await getPool();
      const owner = await createOwner(pool, { agencyId: AG, lineUserId: 'U-store-owner-3' });

      const store = await createConfirmedStore(pool, {
        ownerId: owner.id,
        placeId: 'ChIJ_confirmed_no_category',
        name: 'カテゴリ省略店舗',
      });

      expect(store.category_code).toBeNull();
    });
  });
});
