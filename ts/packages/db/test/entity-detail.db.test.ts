import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { findStoreWithStatus, listStoresWithStatus } from '../src/stores.js';
import { findOwner, listOwners } from '../src/owners.js';

// 店舗の詳細・オーナーの詳細の 1 件の取得と、オーナーの店舗の絞り込み（agency-dashboard
// Requirement 10.1・11.1・11.6・11.7・11.9・11.10・Issue #526・tasks 9.1）。
// 他ファイルと DB を共有するため、衝突しない専用 UUID プレフィックス（ea）と line_user_id を使う。
const OP = 'ea000000-0000-0000-0000-000000000001';
const AG1 = 'ea000000-0000-0000-0000-000000000011';
const AG2 = 'ea000000-0000-0000-0000-000000000012';
// AG1 のオーナー。確定済み・停止中の確定済み・未確定の 3 店舗を持つ
const OW1 = 'ea000000-0000-0000-0000-000000000021';
// AG1 のオーナー。店舗を持たない
const OW_EMPTY = 'ea000000-0000-0000-0000-000000000022';
// AG2 のオーナー（範囲外を見る）
const OW2 = 'ea000000-0000-0000-0000-000000000023';

const ST_CONFIRMED = 'ea000000-0000-0000-0000-000000000031';
const ST_SUSPENDED = 'ea000000-0000-0000-0000-000000000032';
const ST_PENDING = 'ea000000-0000-0000-0000-000000000033';
const ST_OTHER = 'ea000000-0000-0000-0000-000000000034';

// どこにも存在しない UUID（不存在の検査用）
const MISSING = 'ea000000-0000-0000-0000-0000000000ff';

describe.skipIf(!process.env.DATABASE_URL)('1 件の取得と絞り込み (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'ea運営']);
    await pool.query(
      'INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3), ($4, $2, $5)',
      [AG1, OP, 'ea代理店1', AG2, 'ea代理店2'],
    );
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, display_name, onboarding_status, created_at)
       VALUES ($1, $2, 'U-entity-detail-1', 'ea店主', 'store_identified', '2026-07-01T00:00:00Z'),
              ($3, $2, 'U-entity-detail-empty', NULL, 'pending', '2026-07-02T00:00:00Z'),
              ($4, $5, 'U-entity-detail-2', 'ea他代理店の店主', 'store_identified', '2026-07-03T00:00:00Z')`,
      [OW1, AG1, OW_EMPTY, OW2, AG2],
    );
    // 挿入順と作成順をずらし、並びが作成日時で決まることを確かめる。
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status, created_at, suspended_at)
       VALUES ($1, $2, 'ea停止中の店', 'place-ea-suspended', 'confirmed', '2026-07-11T00:00:00Z', '2026-07-12T00:00:00Z'),
              ($3, $2, 'ea確定の店', 'place-ea-confirmed', 'confirmed', '2026-07-09T00:00:00Z', NULL),
              ($4, $5, 'ea他代理店の店', 'place-ea-other', 'confirmed', '2026-07-09T00:00:00Z', NULL)`,
      [ST_SUSPENDED, OW1, ST_CONFIRMED, ST_OTHER, OW2],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_status, created_at)
       VALUES ($1, $2, 'ea未確定の店', 'pending', '2026-07-10T00:00:00Z')`,
      [ST_PENDING, OW1],
    );
    // 競合が設定済みの店舗（competitorConfigured の値が一覧と 1 件の取得で揃うことを見る）
    await pool.query(
      `INSERT INTO competitors (store_id, place_id, active) VALUES ($1, 'place-ea-competitor', true)`,
      [ST_CONFIRMED],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  describe('findStoreWithStatus', () => {
    it('範囲内の店舗を、店舗一覧の同じ行と同じ値で返す（11.1）', async () => {
      const pool = await getPool();
      const fromList = (await listStoresWithStatus(pool, { agencyId: AG1 })).find(
        (s) => s.id === ST_CONFIRMED,
      );
      expect(fromList).toBeDefined();
      // 運営（全代理店）と代理店（自代理店）のどちらの範囲でも同じ行を返す
      expect(await findStoreWithStatus(pool, { storeId: ST_CONFIRMED, agencyId: null })).toEqual(
        fromList,
      );
      expect(await findStoreWithStatus(pool, { storeId: ST_CONFIRMED, agencyId: AG1 })).toEqual(
        fromList,
      );
      expect(fromList).toMatchObject({
        name: 'ea確定の店',
        placeStatus: 'confirmed',
        suspendedAt: null,
        competitorConfigured: true,
        ownerId: OW1,
        ownerDisplayName: 'ea店主',
        agencyId: AG1,
        agencyName: 'ea代理店1',
      });
    });

    it('停止中・未確定の店舗も状態を列として返す（11.1・状態で行を除かない）', async () => {
      const pool = await getPool();
      expect(
        await findStoreWithStatus(pool, { storeId: ST_SUSPENDED, agencyId: AG1 }),
      ).toMatchObject({ placeStatus: 'confirmed', suspendedAt: new Date('2026-07-12T00:00:00Z') });
      expect(
        await findStoreWithStatus(pool, { storeId: ST_PENDING, agencyId: AG1 }),
      ).toMatchObject({ placeStatus: 'pending', suspendedAt: null, competitorConfigured: false });
    });

    it('担当外の店舗と存在しない店舗は、どちらも null を返す（11.9・11.10）', async () => {
      const pool = await getPool();
      expect(await findStoreWithStatus(pool, { storeId: ST_OTHER, agencyId: AG1 })).toBeNull();
      expect(await findStoreWithStatus(pool, { storeId: MISSING, agencyId: AG1 })).toBeNull();
      expect(await findStoreWithStatus(pool, { storeId: MISSING, agencyId: null })).toBeNull();
      // 範囲の確認: 同じ店舗は自代理店（AG2）からは見える
      expect(await findStoreWithStatus(pool, { storeId: ST_OTHER, agencyId: AG2 })).not.toBeNull();
    });

    it('UUID の形でない id は、DB へ問い合わせずに null を返す', async () => {
      const pool = await getPool();
      expect(await findStoreWithStatus(pool, { storeId: 'not-a-uuid', agencyId: null })).toBeNull();
      expect(await findStoreWithStatus(pool, { storeId: '', agencyId: AG1 })).toBeNull();
    });

    it('大文字の UUID も同じ店舗として返す（経路の値の大小で取りこぼさない）', async () => {
      const pool = await getPool();
      // id は英字（ea）を含むので、大文字にすると文字列としては別物になる
      expect(
        await findStoreWithStatus(pool, { storeId: ST_CONFIRMED.toUpperCase(), agencyId: AG1 }),
      ).toMatchObject({ id: ST_CONFIRMED });
    });
  });

  describe('listStoresWithStatus の ownerId', () => {
    it('当該オーナーの店舗だけを、未確定も含めて作成日時の降順で返す（11.7）', async () => {
      const pool = await getPool();
      const stores = await listStoresWithStatus(pool, { ownerId: OW1 });
      expect(stores.map((s) => s.id)).toEqual([ST_SUSPENDED, ST_PENDING, ST_CONFIRMED]);
      expect(stores.every((s) => s.ownerId === OW1)).toBe(true);
    });

    it('店舗の無いオーナーは空配列を返す（11.7）', async () => {
      const pool = await getPool();
      expect(await listStoresWithStatus(pool, { ownerId: OW_EMPTY })).toEqual([]);
    });

    it('UUID の形でない ownerId は、絞り込みなしに化けず空配列を返す', async () => {
      const pool = await getPool();
      expect(await listStoresWithStatus(pool, { ownerId: '' })).toEqual([]);
      expect(await listStoresWithStatus(pool, { ownerId: 'not-a-uuid' })).toEqual([]);
    });

    it('代理店の絞り込みと重ねると、両方を満たす店舗だけを返す', async () => {
      const pool = await getPool();
      expect(await listStoresWithStatus(pool, { ownerId: OW1, agencyId: AG2 })).toEqual([]);
      expect(
        (await listStoresWithStatus(pool, { ownerId: OW1, agencyId: AG1 })).map((s) => s.id),
      ).toEqual([ST_SUSPENDED, ST_PENDING, ST_CONFIRMED]);
    });
  });

  describe('findOwner', () => {
    it('範囲内のオーナーを、オーナー一覧の同じ行と同じ値で返す（11.6）', async () => {
      const pool = await getPool();
      const fromList = (await listOwners(pool, AG1)).find((o) => o.id === OW1);
      expect(fromList).toBeDefined();
      expect(await findOwner(pool, { ownerId: OW1, agencyId: null })).toEqual(fromList);
      expect(await findOwner(pool, { ownerId: OW1, agencyId: AG1 })).toEqual(fromList);
    });

    it('担当外のオーナーと存在しないオーナーは、どちらも null を返す（11.9・11.10）', async () => {
      const pool = await getPool();
      expect(await findOwner(pool, { ownerId: OW2, agencyId: AG1 })).toBeNull();
      expect(await findOwner(pool, { ownerId: MISSING, agencyId: AG1 })).toBeNull();
      expect(await findOwner(pool, { ownerId: MISSING, agencyId: null })).toBeNull();
      expect(await findOwner(pool, { ownerId: OW2, agencyId: AG2 })).not.toBeNull();
    });

    it('UUID の形でない id は、DB へ問い合わせずに null を返す', async () => {
      const pool = await getPool();
      expect(await findOwner(pool, { ownerId: 'not-a-uuid', agencyId: null })).toBeNull();
    });

    it('大文字の UUID も同じオーナーとして返す', async () => {
      const pool = await getPool();
      expect(await findOwner(pool, { ownerId: OW1.toUpperCase(), agencyId: AG1 })).toMatchObject({
        id: OW1,
      });
    });
  });

  describe('listOwners の stores', () => {
    it('確定済みの店舗を { id, name } で、storeNames と同じ並び（作成順）で返す（10.1）', async () => {
      const pool = await getPool();
      const owner = (await listOwners(pool, AG1)).find((o) => o.id === OW1);
      // 未確定の店舗は含めず、停止中でも確定済みなら含める（storeNames と同じ集合）
      expect(owner?.stores).toEqual([
        { id: ST_CONFIRMED, name: 'ea確定の店' },
        { id: ST_SUSPENDED, name: 'ea停止中の店' },
      ]);
      expect(owner?.storeNames).toEqual(owner?.stores.map((s) => s.name));
    });

    it('店舗の無いオーナーは stores も storeNames も空配列', async () => {
      const pool = await getPool();
      const owner = (await listOwners(pool, AG1)).find((o) => o.id === OW_EMPTY);
      expect(owner?.stores).toEqual([]);
      expect(owner?.storeNames).toEqual([]);
    });
  });
});
