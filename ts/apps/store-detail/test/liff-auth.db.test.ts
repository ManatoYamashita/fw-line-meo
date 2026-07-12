// LIFF 認可ライブラリ（liff-auth.ts, Task 5.1）の owner/store 解決テスト（実 postgres 必須）。
//
// resolveOwnerStore は「検証済み sub → owners.line_user_id 突合 → 自店解決」のみを行い、
// storeId・ownerId をパラメータとして一切受け取らない（design.md「Security Considerations」:
// storeId を URL・リクエストボディから受けない）。引数形状のコンパイル時検証は liff-auth.test.ts。
//
// four-tier-data-model の確定仕様（1 オーナー: 複数店舗＝1:N、db/migrations/0001 の stores に
// owner_id 側の UNIQUE 制約なし）により、1 owner が複数の confirmed 店舗を持ちうる。sub のみを
// 入力とする本関数はそれらを一意に絞り込めないため、confirmed 店舗が 2 件以上のケースは
// AMBIGUOUS_STORE として安全側に倒すことをここで検証する。
//
// 他テストファイルと DB を共有するため、衝突しない固有 UUID / line_user_id を使う
// （delivery-settings.db.test.ts / deliveries.db.test.ts の慣習に準拠）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, closePool } from '@fwlm/db';
import {
  authorizeStoreDetailRequest,
  resolveOwnerStore,
  type LiffAuthOptions,
} from '../lib/liff-auth.js';

const OP = 'd5000000-0000-0000-0000-000000000001';
const AG = 'd5000000-0000-0000-0000-000000000002';

const OWNER_SINGLE = 'd5000000-0000-0000-0000-000000000011'; // confirmed 店舗 1 件
const OWNER_UNCONFIRMED = 'd5000000-0000-0000-0000-000000000012'; // confirmed 店舗 0 件（pending のみ）
const OWNER_NO_STORE = 'd5000000-0000-0000-0000-000000000013'; // 店舗そのものが無い
const OWNER_MULTI = 'd5000000-0000-0000-0000-000000000014'; // confirmed 店舗 2 件（1:N の実例）

const SUB_SINGLE = `U-${OWNER_SINGLE}`;
const SUB_UNCONFIRMED = `U-${OWNER_UNCONFIRMED}`;
const SUB_NO_STORE = `U-${OWNER_NO_STORE}`;
const SUB_MULTI = `U-${OWNER_MULTI}`;
const SUB_UNKNOWN = 'U-unknown-does-not-exist';

const ST_CONFIRMED = 'd6000000-0000-0000-0000-000000000001';
const ST_PENDING = 'd6000000-0000-0000-0000-000000000002';
const ST_MULTI_A = 'd6000000-0000-0000-0000-000000000003';
const ST_MULTI_B = 'd6000000-0000-0000-0000-000000000004';

describe.skipIf(!process.env.DATABASE_URL)('liff-auth: resolveOwnerStore / authorizeStoreDetailRequest (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'LIFF認可検証運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      'LIFF認可検証代理店',
    ]);

    for (const [id, sub] of [
      [OWNER_SINGLE, SUB_SINGLE],
      [OWNER_UNCONFIRMED, SUB_UNCONFIRMED],
      [OWNER_NO_STORE, SUB_NO_STORE],
      [OWNER_MULTI, SUB_MULTI],
    ] as const) {
      await pool.query(
        'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
        [id, AG, sub, 'active'],
      );
    }

    await pool.query(
      'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
      [ST_CONFIRMED, OWNER_SINGLE, '確定済み店舗', 'places/liff-confirmed', 'confirmed'],
    );
    await pool.query(
      'INSERT INTO stores (id, owner_id, name, place_status) VALUES ($1, $2, $3, $4)',
      [ST_PENDING, OWNER_UNCONFIRMED, '未確定店舗', 'pending'],
    );
    await pool.query(
      'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
      [ST_MULTI_A, OWNER_MULTI, '複数店舗オーナーの店舗A', 'places/liff-multi-a', 'confirmed'],
    );
    await pool.query(
      'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
      [ST_MULTI_B, OWNER_MULTI, '複数店舗オーナーの店舗B', 'places/liff-multi-b', 'confirmed'],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  describe('resolveOwnerStore', () => {
    it('正常系: 確定済み店舗が1件のオーナーは自店を解決する', async () => {
      const pool = await getPool();
      const result = await resolveOwnerStore(pool, SUB_SINGLE);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(ST_CONFIRMED);
        expect(result.value.owner_id).toBe(OWNER_SINGLE);
        expect(result.value.place_status).toBe('confirmed');
      }
    });

    it('異常系: line_user_id に一致する owner が存在しない → OWNER_NOT_FOUND', async () => {
      const pool = await getPool();
      const result = await resolveOwnerStore(pool, SUB_UNKNOWN);

      expect(result).toEqual({ ok: false, error: 'OWNER_NOT_FOUND' });
    });

    it('異常系: owner は存在するが confirmed 店舗が無い（pending のみ）→ STORE_NOT_IDENTIFIED', async () => {
      const pool = await getPool();
      const result = await resolveOwnerStore(pool, SUB_UNCONFIRMED);

      expect(result).toEqual({ ok: false, error: 'STORE_NOT_IDENTIFIED' });
    });

    it('異常系: owner は存在するが店舗が1件も無い → STORE_NOT_IDENTIFIED', async () => {
      const pool = await getPool();
      const result = await resolveOwnerStore(pool, SUB_NO_STORE);

      expect(result).toEqual({ ok: false, error: 'STORE_NOT_IDENTIFIED' });
    });

    it('異常系（1:N の実例）: confirmed 店舗が2件のオーナーは一意に解決できないため AMBIGUOUS_STORE', async () => {
      const pool = await getPool();
      const result = await resolveOwnerStore(pool, SUB_MULTI);

      expect(result).toEqual({ ok: false, error: 'AMBIGUOUS_STORE' });
    });

    it('セキュリティ制約: storeId を渡す手段が無い（sub のみが入力）ことを確認する — 異なる sub は互いの店舗を返さない', async () => {
      const pool = await getPool();
      const resultA = await resolveOwnerStore(pool, SUB_SINGLE);
      const resultB = await resolveOwnerStore(pool, SUB_MULTI);

      expect(resultA.ok && resultA.value.id).toBe(ST_CONFIRMED);
      expect(resultB.ok).toBe(false); // 複数店舗のため AMBIGUOUS_STORE であり、A の店舗を漏らさない
    });
  });

  describe('authorizeStoreDetailRequest（verify + resolve の合成）', () => {
    it('有効トークン → 自店解決まで一気通貫で成功する', async () => {
      const pool = await getPool();
      const options: LiffAuthOptions = {
        fetchImpl: async () =>
          new Response(JSON.stringify({ sub: SUB_SINGLE }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      };

      const result = await authorizeStoreDetailRequest('valid-id-token', 'test-client-id', pool, options);

      expect(result).toEqual({
        ok: true,
        value: expect.objectContaining({ id: ST_CONFIRMED, owner_id: OWNER_SINGLE }),
      });
    });

    it('無効トークン → 検証エラーで終了し、DB を引かない（owner 解決まで進まない）', async () => {
      const pool = await getPool();
      // pg.Pool#query はオーバーロードを持つため、素朴なラッパー関数では型が壊れる。
      // Proxy で `query` プロパティへのアクセスのみを検知し、元の型（Queryable と互換）を保つ。
      let dbQueried = false;
      const trackingPool: typeof pool = new Proxy(pool, {
        get(target, prop, receiver) {
          if (prop === 'query') {
            dbQueried = true;
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const options: LiffAuthOptions = {
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 }),
      };

      const result = await authorizeStoreDetailRequest(
        'invalid-id-token',
        'test-client-id',
        trackingPool,
        options,
      );

      expect(result).toEqual({ ok: false, error: 'INVALID_TOKEN' });
      expect(dbQueried).toBe(false);
    });
  });
});
