import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { findStoreForSurvey, findStoreWithAgency } from '../src/stores.js';
import { listSurveyAspects } from '../src/aspects.js';
import { findByAuthSubject } from '../src/dashboard-users.js';

// 4 階層フィクスチャ（固定 UUID）。DB は make ts-test-db の一時インスタンスで毎回まっさら。
const OP = '11111111-1111-1111-1111-111111111111';
const AG = '22222222-2222-2222-2222-222222222222';
const OW = '33333333-3333-3333-3333-333333333333';
const STORE_CONFIRMED = '44444444-4444-4444-4444-444444444444';
const STORE_PENDING = '55555555-5555-5555-5555-555555555555';
const MISSING = '99999999-9999-9999-9999-999999999999';

describe.skipIf(!process.env.DATABASE_URL)('read accessors (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'テスト運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      'テスト代理店',
    ]);
    await pool.query(
      'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
      [OW, AG, 'U-test-line-user', 'active'],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status)
       VALUES ($1, $2, $3, $4, 'confirmed')`,
      [STORE_CONFIRMED, OW, '確定店舗', 'ChIJ_test_place'],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status)
       VALUES ($1, $2, $3, NULL, 'pending')`,
      [STORE_PENDING, OW, '未確定店舗'],
    );
    await pool.query(
      `INSERT INTO dashboard_users (role, operator_id, agency_id, auth_subject)
       VALUES ('operator', $1, NULL, 'op-uid'), ('agency', $1, $2, 'ag-uid')`,
      [OP, AG],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  describe('findStoreForSurvey', () => {
    it('確定店舗を placeStatus=confirmed で返す', async () => {
      const pool = await getPool();
      const store = await findStoreForSurvey(pool, STORE_CONFIRMED);
      expect(store).toEqual({
        id: STORE_CONFIRMED,
        name: '確定店舗',
        placeId: 'ChIJ_test_place',
        placeStatus: 'confirmed',
      });
    });

    it('未確定店舗を placeStatus=pending・placeId=null で返す', async () => {
      const pool = await getPool();
      const store = await findStoreForSurvey(pool, STORE_PENDING);
      expect(store?.placeStatus).toBe('pending');
      expect(store?.placeId).toBeNull();
    });

    it('存在しない store は null', async () => {
      const pool = await getPool();
      expect(await findStoreForSurvey(pool, MISSING)).toBeNull();
    });

    it('UUID 形式でない ID は DB を叩かず null（無効 URL 対策）', async () => {
      const pool = await getPool();
      expect(await findStoreForSurvey(pool, 'not-a-uuid')).toBeNull();
    });
  });

  describe('findStoreWithAgency', () => {
    it('owner 経由で担当代理店 agencyId を同梱する', async () => {
      const pool = await getPool();
      const store = await findStoreWithAgency(pool, STORE_CONFIRMED);
      expect(store?.agencyId).toBe(AG);
      expect(store?.ownerId).toBe(OW);
    });

    it('存在しない store は null', async () => {
      const pool = await getPool();
      expect(await findStoreWithAgency(pool, MISSING)).toBeNull();
    });
  });

  describe('listSurveyAspects', () => {
    it('seed の選択肢を code 昇順で返す', async () => {
      const pool = await getPool();
      const aspects = await listSurveyAspects(pool);
      expect(aspects.length).toBe(6);
      expect(aspects[0]?.code).toBe('atmosphere');
      expect(aspects.map((a) => a.code)).toContain('taste');
      // 昇順であること
      const codes = aspects.map((a) => a.code);
      expect(codes).toEqual([...codes].sort());
    });
  });

  describe('findByAuthSubject', () => {
    it('operator ロールは agencyId=null で返す', async () => {
      const pool = await getPool();
      const user = await findByAuthSubject(pool, 'op-uid');
      expect(user?.role).toBe('operator');
      expect(user?.agencyId).toBeNull();
    });

    it('agency ロールは担当 agencyId を返す', async () => {
      const pool = await getPool();
      const user = await findByAuthSubject(pool, 'ag-uid');
      expect(user?.role).toBe('agency');
      expect(user?.agencyId).toBe(AG);
    });

    it('未登録 UID は null', async () => {
      const pool = await getPool();
      expect(await findByAuthSubject(pool, 'unknown-uid')).toBeNull();
    });
  });
});
