// LIFF 認可ライブラリ（liff-auth.ts）の認可済み集合の生成テスト（実 postgres 必須）。
//
// listOwnerConfirmedStores は「検証済み sub → owners.line_user_id 突合 → 所有 confirmed 店舗の
// 集合」のみを行い、storeId・ownerId をパラメータとして一切受け取らない。集合の境界は常に
// sub のみが決める（design.md「クライアント入力の不変条件」）。引数形状の検証は liff-auth.test.ts。
//
// four-tier-data-model の確定仕様（1 オーナー: 複数店舗＝1:N、db/migrations/0001 の stores に
// owner_id 側の UNIQUE 制約なし）により、1 owner が複数の confirmed 店舗を持ちうる。Issue #61
// 以前はこれを AMBIGUOUS_STORE として失敗させていたが、現在は集合をそのまま返し、集合内の
// 絞り込みは selectAuthorizedStore（DB に触れない純関数）が担う。
//
// 他テストファイルと DB を共有するため、衝突しない固有 UUID / line_user_id を使う
// （delivery-settings.db.test.ts / deliveries.db.test.ts の慣習に準拠）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, closePool } from '@fwlm/db';
import {
  authorizeStoreDetailRequest,
  listOwnerConfirmedStores,
  selectAuthorizedStore,
  type LiffAuthOptions,
} from '../lib/liff-auth.js';

const OP = 'd5000000-0000-0000-0000-000000000001';
const AG = 'd5000000-0000-0000-0000-000000000002';

const OWNER_SINGLE = 'd5000000-0000-0000-0000-000000000011'; // confirmed 店舗 1 件
const OWNER_UNCONFIRMED = 'd5000000-0000-0000-0000-000000000012'; // confirmed 店舗 0 件（pending のみ）
const OWNER_NO_STORE = 'd5000000-0000-0000-0000-000000000013'; // 店舗そのものが無い
const OWNER_MULTI = 'd5000000-0000-0000-0000-000000000014'; // confirmed 店舗 2 件（1:N の実例）
const OWNER_SAME_TX = 'd5000000-0000-0000-0000-000000000015'; // 2 店舗を単一 INSERT で登録（created_at 同値）

const SUB_SINGLE = `U-${OWNER_SINGLE}`;
const SUB_UNCONFIRMED = `U-${OWNER_UNCONFIRMED}`;
const SUB_NO_STORE = `U-${OWNER_NO_STORE}`;
const SUB_MULTI = `U-${OWNER_MULTI}`;
const SUB_SAME_TX = `U-${OWNER_SAME_TX}`;
const SUB_UNKNOWN = 'U-unknown-does-not-exist';

const ST_CONFIRMED = 'd6000000-0000-0000-0000-000000000001';
const ST_PENDING = 'd6000000-0000-0000-0000-000000000002';
const ST_MULTI_A = 'd6000000-0000-0000-0000-000000000003';
const ST_MULTI_B = 'd6000000-0000-0000-0000-000000000004';
// created_at が同値になるため、id ASC の tiebreaker が効かないと順序が揺れる組。
// 意図的に「id が大きい方を先に」INSERT し、返却順が挿入順ではなく id 昇順であることを見る。
const ST_SAME_TX_LOW = 'd6000000-0000-0000-0000-000000000005';
const ST_SAME_TX_HIGH = 'd6000000-0000-0000-0000-000000000006';

describe.skipIf(!process.env.DATABASE_URL)('liff-auth: listOwnerConfirmedStores / selectAuthorizedStore / authorizeStoreDetailRequest (DB)', () => {
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
      [OWNER_SAME_TX, SUB_SAME_TX],
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
    // 単一 INSERT ＝ 単一トランザクション。created_at の既定値 now() はトランザクション開始
    // 時刻なので 2 行の created_at は同値になる（id ASC の tiebreaker が無いと順序が揺れる）。
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status)
       VALUES ($1, $3, '同一Tx登録の店舗HIGH', 'places/liff-sametx-high', 'confirmed'),
              ($2, $3, '同一Tx登録の店舗LOW',  'places/liff-sametx-low',  'confirmed')`,
      [ST_SAME_TX_HIGH, ST_SAME_TX_LOW, OWNER_SAME_TX],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  describe('listOwnerConfirmedStores', () => {
    it('正常系: 確定済み店舗が1件のオーナーは要素1件の集合を返す', async () => {
      const pool = await getPool();
      const result = await listOwnerConfirmedStores(pool, SUB_SINGLE);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]!.id).toBe(ST_CONFIRMED);
        expect(result.value[0]!.owner_id).toBe(OWNER_SINGLE);
        expect(result.value[0]!.place_status).toBe('confirmed');
      }
    });

    it('異常系: line_user_id に一致する owner が存在しない → OWNER_NOT_FOUND', async () => {
      const pool = await getPool();
      const result = await listOwnerConfirmedStores(pool, SUB_UNKNOWN);

      expect(result).toEqual({ ok: false, error: 'OWNER_NOT_FOUND' });
    });

    it('異常系: owner は存在するが confirmed 店舗が無い（pending のみ）→ STORE_NOT_IDENTIFIED', async () => {
      const pool = await getPool();
      const result = await listOwnerConfirmedStores(pool, SUB_UNCONFIRMED);

      expect(result).toEqual({ ok: false, error: 'STORE_NOT_IDENTIFIED' });
    });

    it('異常系: owner は存在するが店舗が1件も無い → STORE_NOT_IDENTIFIED', async () => {
      const pool = await getPool();
      const result = await listOwnerConfirmedStores(pool, SUB_NO_STORE);

      expect(result).toEqual({ ok: false, error: 'STORE_NOT_IDENTIFIED' });
    });

    it('正常系（1:N の実例）: confirmed 店舗が2件のオーナーは両方を含む集合を決定的な順序で返す', async () => {
      const pool = await getPool();
      const result = await listOwnerConfirmedStores(pool, SUB_MULTI);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      // created_at ASC, id ASC。A/B は別 INSERT なので created_at が昇順に並ぶ。
      expect(result.value.map((store) => store.id)).toEqual([ST_MULTI_A, ST_MULTI_B]);
      // 集合の境界は sub のみが決める: 他オーナーの店舗は 1 件たりとも混ざらない。
      expect(result.value.every((store) => store.owner_id === OWNER_MULTI)).toBe(true);
      expect(result.value.map((store) => store.id)).not.toContain(ST_CONFIRMED);
      expect(result.value.map((store) => store.id)).not.toContain(ST_PENDING);
    });

    it('決定性: created_at が同値（単一 Tx 登録）でも id ASC の tiebreaker により順序が揺れない', async () => {
      const pool = await getPool();
      const first = await listOwnerConfirmedStores(pool, SUB_SAME_TX);
      const second = await listOwnerConfirmedStores(pool, SUB_SAME_TX);

      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        return;
      }
      // created_at が同値であること自体をまず確認する（前提が崩れたらこのテストは無意味になる）。
      expect(first.value[0]!.created_at.getTime()).toBe(first.value[1]!.created_at.getTime());
      // 挿入順は HIGH → LOW だが、返却順は id 昇順で固定される。
      expect(first.value.map((store) => store.id)).toEqual([ST_SAME_TX_LOW, ST_SAME_TX_HIGH]);
      expect(second.value.map((store) => store.id)).toEqual(first.value.map((store) => store.id));
    });

    it('セキュリティ制約: 異なる sub の集合は互いに素であり、他オーナーの実在 storeId を渡しても集合内に現れない', async () => {
      const pool = await getPool();
      const single = await listOwnerConfirmedStores(pool, SUB_SINGLE);
      const multi = await listOwnerConfirmedStores(pool, SUB_MULTI);

      expect(single.ok && multi.ok).toBe(true);
      if (!single.ok || !multi.ok) {
        return;
      }

      const singleIds = new Set(single.value.map((store) => store.id));
      const multiIds = new Set(multi.value.map((store) => store.id));
      expect([...singleIds].some((id) => multiIds.has(id))).toBe(false);

      // クライアントが他オーナーの「実在する」storeId をヒントとして渡しても、集合外なので
      // 選ばれない。ヒントは集合の境界を広げられない（design.md の不変条件）。
      expect(selectAuthorizedStore(multi.value, ST_CONFIRMED)).toBeNull();
      expect(selectAuthorizedStore(single.value, ST_MULTI_A)).toBeNull();
      // 自分の集合内であれば当然選べる。
      expect(selectAuthorizedStore(multi.value, ST_MULTI_B)?.id).toBe(ST_MULTI_B);
    });
  });

  describe('authorizeStoreDetailRequest（verify + 認可済み集合の生成 の合成）', () => {
    it('有効トークン → 認可済み集合の生成まで一気通貫で成功する', async () => {
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
        value: [expect.objectContaining({ id: ST_CONFIRMED, owner_id: OWNER_SINGLE })],
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
