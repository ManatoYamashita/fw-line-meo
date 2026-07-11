import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool, createOwner, findOwnerByLineUserId, findStoreByPlaceId } from '@fwlm/db';
import type { StoreCandidate } from '@fwlm/db';
import { createStoreIdentificationService } from '../../src/onboarding/store-identification.js';
import type { SearchOutcome, PlacesSearchAdapter } from '../../src/places/search.js';

// 実 postgres（ts-test-db）で確定の原子性と重複 place_id の拒否を検証する。
// 他ファイルと衝突しない専用 UUID プレフィックス（e7）。DATABASE_URL 無しは skip。
const OP = 'e7777777-7777-7777-7777-777777777770';
const AG = 'e7777777-7777-7777-7777-777777777771';
const NON_EXISTENT_OWNER_ID = 'e7777777-7777-7777-7777-77777777ffff';

function candidate(placeId: string, name = 'テスト店舗'): StoreCandidate {
  return {
    placeId,
    name,
    address: '東京都テスト区1-1-1',
    latitude: 35.6,
    longitude: 139.7,
    types: ['restaurant'],
  };
}

function stubPlaces(outcome: SearchOutcome): PlacesSearchAdapter {
  return {
    searchCandidates: async () => outcome,
  };
}

describe.skipIf(!process.env.DATABASE_URL)('StoreIdentificationService (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'store-ident運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      'store-ident代理店',
    ]);
  });

  afterAll(async () => {
    await closePool();
  });

  describe('searchCandidates', () => {
    it('注入された PlacesSearchAdapter の結果をそのまま返す（Req 3.1・パススルー）', async () => {
      const pool = await getPool();
      const outcome: SearchOutcome = {
        kind: 'found',
        candidates: [candidate('ChIJ_passthrough_1')],
      };
      const service = createStoreIdentificationService({ pool, places: stubPlaces(outcome) });

      expect(await service.searchCandidates('テスト店')).toBe(outcome);
    });

    it('empty / error もそのまま透過する', async () => {
      const pool = await getPool();
      const emptyService = createStoreIdentificationService({
        pool,
        places: stubPlaces({ kind: 'empty' }),
      });
      expect(await emptyService.searchCandidates('存在しない店')).toEqual({ kind: 'empty' });

      const errorService = createStoreIdentificationService({
        pool,
        places: stubPlaces({ kind: 'error' }),
      });
      expect(await errorService.searchCandidates('タイムアウト店')).toEqual({ kind: 'error' });
    });
  });

  describe('confirmStore', () => {
    it('store 作成（confirmed・place_id）と owner の store_identified 遷移を単一 TX で行う（Req 4.2）', async () => {
      const pool = await getPool();
      const owner = await createOwner(pool, { agencyId: AG, lineUserId: 'U-store-ident-1' });
      const service = createStoreIdentificationService({
        pool,
        places: stubPlaces({ kind: 'empty' }),
      });

      const result = await service.confirmStore(owner.id, candidate('ChIJ_confirm_1', '確定店舗A'));

      expect(result.kind).toBe('confirmed');
      if (result.kind !== 'confirmed') throw new Error('unreachable');
      expect(result.storeId).toBeTruthy();

      const store = await findStoreByPlaceId(pool, 'ChIJ_confirm_1');
      expect(store?.id).toBe(result.storeId);
      expect(store?.place_status).toBe('confirmed');
      expect(store?.owner_id).toBe(owner.id);

      const updatedOwner = await findOwnerByLineUserId(pool, 'U-store-ident-1');
      expect(updatedOwner?.onboarding_status).toBe('store_identified');
    });

    it('同一 place_id を別オーナーが確定しようとすると place_already_registered（Req 4.4）で、2 人目の owner 状態は変わらない', async () => {
      const pool = await getPool();
      const ownerA = await createOwner(pool, { agencyId: AG, lineUserId: 'U-store-ident-2a' });
      const ownerB = await createOwner(pool, { agencyId: AG, lineUserId: 'U-store-ident-2b' });
      const service = createStoreIdentificationService({
        pool,
        places: stubPlaces({ kind: 'empty' }),
      });

      const first = await service.confirmStore(ownerA.id, candidate('ChIJ_confirm_dup', '確定店舗B'));
      expect(first.kind).toBe('confirmed');

      const second = await service.confirmStore(ownerB.id, candidate('ChIJ_confirm_dup', '確定店舗B別名'));
      expect(second).toEqual({ kind: 'place_already_registered' });

      // 2 人目のオーナーは pending のまま（ロールバックされ状態が変わっていない）。
      const ownerBAfter = await findOwnerByLineUserId(pool, 'U-store-ident-2b');
      expect(ownerBAfter?.onboarding_status).toBe('pending');

      // 登録済みなのは 1 人目の store のみ。
      const store = await findStoreByPlaceId(pool, 'ChIJ_confirm_dup');
      expect(store?.owner_id).toBe(ownerA.id);
    });

    it('原子性: owner_id が存在しない場合、store INSERT ごとロールバックされ何も残らない', async () => {
      const pool = await getPool();
      const service = createStoreIdentificationService({
        pool,
        places: stubPlaces({ kind: 'empty' }),
      });

      await expect(
        service.confirmStore(NON_EXISTENT_OWNER_ID, candidate('ChIJ_confirm_atomic')),
      ).rejects.toThrow();

      // store 行そのものが残っていない（stores INSERT 自体がロールバックされている）。
      const store = await findStoreByPlaceId(pool, 'ChIJ_confirm_atomic');
      expect(store).toBeNull();
    });
  });
});
