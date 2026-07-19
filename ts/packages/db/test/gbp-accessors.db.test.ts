import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { upsertOauthToken, getOauthToken, deleteOauthToken } from '../src/oauth-tokens.js';
import { upsertGbpLocation, getGbpLocation, deleteGbpLocation } from '../src/gbp-locations.js';
import {
  getActiveGbpSession,
  upsertGbpSession,
  clearGbpSession,
  beginGbpSessionExecution,
  completeGbpSessionExecution,
  revertGbpSessionExecution,
} from '../src/gbp-sessions.js';
import type { Result } from '../src/types.js';

// 専用 UUID プレフィックス `fc`（ワークスペース全体で未使用であること）。
// with-test-db.sh の一時 postgres は make ts-test-db の 1 実行を全パッケージで共有するため、
// fixture の固定 UUID は ts/ 配下の全 *.db.test.ts と衝突しない値を選ぶこと。
const OP = 'fc000000-0000-0000-0000-000000000001';
const AG = 'fc000000-0000-0000-0000-000000000002';
const OWNER_A = 'fca00000-0000-0000-0000-00000000000a';
const OWNER_B = 'fcb00000-0000-0000-0000-00000000000b';
const STORE_A1 = 'fca50000-0000-0000-0000-000000000001';
const STORE_A2 = 'fca50000-0000-0000-0000-000000000002';
const STORE_B1 = 'fcb50000-0000-0000-0000-000000000001';
const MISSING_STORE = 'fcff0000-0000-0000-0000-0000000000ff';

/** Result の ok を絞り込み、失敗なら即テスト失敗させるヘルパ。 */
function unwrap<T, E>(res: Result<T, E>): T {
  if (!res.ok) throw new Error(`expected ok Result, got error: ${String(res.error)}`);
  return res.value;
}

describe.skipIf(!process.env.DATABASE_URL)('gbp accessors (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'gbp運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      'gbp代理店',
    ]);
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
       VALUES ($1, $3, 'U-gbp-owner-a', 'active'), ($2, $3, 'U-gbp-owner-b', 'active')`,
      [OWNER_A, OWNER_B, AG],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status)
       VALUES ($1, $4, 'A店1', 'ChIJ_gbp_a1', 'confirmed'),
              ($2, $4, 'A店2', 'ChIJ_gbp_a2', 'confirmed'),
              ($3, $5, 'B店1', 'ChIJ_gbp_b1', 'confirmed')`,
      [STORE_A1, STORE_A2, STORE_B1, OWNER_A, OWNER_B],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  describe('oauth-tokens', () => {
    it('upsertOauthToken: 所有 store へ新規挿入できる', async () => {
      const pool = await getPool();
      const row = unwrap(
        await upsertOauthToken(pool, {
          ownerId: OWNER_A,
          storeId: STORE_A1,
          provider: 'google',
          tokenRef: 'v1:iv:tag:cipher-1',
          scopes: 'https://www.googleapis.com/auth/business.manage',
          expiresAt: null,
        }),
      );
      expect(row.store_id).toBe(STORE_A1);
      expect(row.provider).toBe('google');
      expect(row.token_ref).toBe('v1:iv:tag:cipher-1');
      expect(row.scopes).toBe('https://www.googleapis.com/auth/business.manage');
      expect(row.expires_at).toBeNull();
    });

    it('upsertOauthToken: 同一 store×provider の再 upsert は行を増やさず更新する', async () => {
      const pool = await getPool();
      const first = await getOauthToken(pool, {
        ownerId: OWNER_A,
        storeId: STORE_A1,
        provider: 'google',
      });
      const row = unwrap(
        await upsertOauthToken(pool, {
          ownerId: OWNER_A,
          storeId: STORE_A1,
          provider: 'google',
          tokenRef: 'v1:iv:tag:cipher-2',
          scopes: null,
          expiresAt: null,
        }),
      );
      expect(row.id).toBe(first?.id);
      expect(row.token_ref).toBe('v1:iv:tag:cipher-2');
      expect(row.scopes).toBeNull();
      const count = await pool.query(
        'SELECT count(*)::int AS n FROM oauth_tokens WHERE store_id = $1',
        [STORE_A1],
      );
      expect(count.rows[0].n).toBe(1);
    });

    it('upsertOauthToken: 他オーナーの storeId は STORE_NOT_OWNED（行を作らない・Req 2.6）', async () => {
      const pool = await getPool();
      const res = await upsertOauthToken(pool, {
        ownerId: OWNER_B,
        storeId: STORE_A1,
        provider: 'google',
        tokenRef: 'v1:forged',
        scopes: null,
        expiresAt: null,
      });
      expect(res).toEqual({ ok: false, error: 'STORE_NOT_OWNED' });
      // A の既存トークンが偽装 upsert で上書きされていないこと。
      const kept = await getOauthToken(pool, {
        ownerId: OWNER_A,
        storeId: STORE_A1,
        provider: 'google',
      });
      expect(kept?.token_ref).toBe('v1:iv:tag:cipher-2');
    });

    it('upsertOauthToken: 存在しない storeId も STORE_NOT_OWNED', async () => {
      const pool = await getPool();
      const res = await upsertOauthToken(pool, {
        ownerId: OWNER_A,
        storeId: MISSING_STORE,
        provider: 'google',
        tokenRef: 'v1:x',
        scopes: null,
        expiresAt: null,
      });
      expect(res).toEqual({ ok: false, error: 'STORE_NOT_OWNED' });
    });

    it('getOauthToken: 他オーナーからは同じ storeId でも null（テナント隔離・Req 2.6）', async () => {
      const pool = await getPool();
      const row = await getOauthToken(pool, {
        ownerId: OWNER_B,
        storeId: STORE_A1,
        provider: 'google',
      });
      expect(row).toBeNull();
    });

    it('getOauthToken: トークン未登録の所有 store は null', async () => {
      const pool = await getPool();
      const row = await getOauthToken(pool, {
        ownerId: OWNER_A,
        storeId: STORE_A2,
        provider: 'google',
      });
      expect(row).toBeNull();
    });

    it('deleteOauthToken: 他オーナーからは削除できず行が残る（Req 1.7/2.6）', async () => {
      const pool = await getPool();
      const deleted = await deleteOauthToken(pool, {
        ownerId: OWNER_B,
        storeId: STORE_A1,
        provider: 'google',
      });
      expect(deleted).toBe(false);
      const kept = await getOauthToken(pool, {
        ownerId: OWNER_A,
        storeId: STORE_A1,
        provider: 'google',
      });
      expect(kept).not.toBeNull();
    });

    it('deleteOauthToken: 所有者は削除でき、再削除は false（冪等）', async () => {
      const pool = await getPool();
      expect(
        await deleteOauthToken(pool, { ownerId: OWNER_A, storeId: STORE_A1, provider: 'google' }),
      ).toBe(true);
      expect(
        await getOauthToken(pool, { ownerId: OWNER_A, storeId: STORE_A1, provider: 'google' }),
      ).toBeNull();
      expect(
        await deleteOauthToken(pool, { ownerId: OWNER_A, storeId: STORE_A1, provider: 'google' }),
      ).toBe(false);
    });
  });

  describe('gbp-locations', () => {
    it('upsertGbpLocation: 所有 store へ新規挿入できる', async () => {
      const pool = await getPool();
      const row = unwrap(
        await upsertGbpLocation(pool, {
          ownerId: OWNER_A,
          storeId: STORE_A1,
          accountName: 'accounts/111',
          locationName: 'locations/222',
          placeId: 'ChIJ_gbp_a1',
          canOperateLocalPost: true,
        }),
      );
      expect(row.store_id).toBe(STORE_A1);
      expect(row.account_name).toBe('accounts/111');
      expect(row.location_name).toBe('locations/222');
      expect(row.place_id).toBe('ChIJ_gbp_a1');
      expect(row.can_operate_local_post).toBe(true);
      expect(row.linked_at).toBeInstanceOf(Date);
    });

    it('upsertGbpLocation: 再連携は行を増やさず身元を更新する', async () => {
      const pool = await getPool();
      const first = await getGbpLocation(pool, { ownerId: OWNER_A, storeId: STORE_A1 });
      const row = unwrap(
        await upsertGbpLocation(pool, {
          ownerId: OWNER_A,
          storeId: STORE_A1,
          accountName: 'accounts/333',
          locationName: 'locations/444',
          placeId: 'ChIJ_gbp_a1',
          canOperateLocalPost: false,
        }),
      );
      expect(row.id).toBe(first?.id);
      expect(row.account_name).toBe('accounts/333');
      expect(row.can_operate_local_post).toBe(false);
      const count = await pool.query(
        'SELECT count(*)::int AS n FROM gbp_locations WHERE store_id = $1',
        [STORE_A1],
      );
      expect(count.rows[0].n).toBe(1);
    });

    it('upsertGbpLocation: 他オーナーの storeId は STORE_NOT_OWNED（Req 2.6）', async () => {
      const pool = await getPool();
      const res = await upsertGbpLocation(pool, {
        ownerId: OWNER_B,
        storeId: STORE_A1,
        accountName: 'accounts/evil',
        locationName: 'locations/evil',
        placeId: 'ChIJ_forged',
        canOperateLocalPost: true,
      });
      expect(res).toEqual({ ok: false, error: 'STORE_NOT_OWNED' });
      const kept = await getGbpLocation(pool, { ownerId: OWNER_A, storeId: STORE_A1 });
      expect(kept?.account_name).toBe('accounts/333');
    });

    it('getGbpLocation: 他オーナーからは null・未連携 store も null', async () => {
      const pool = await getPool();
      expect(await getGbpLocation(pool, { ownerId: OWNER_B, storeId: STORE_A1 })).toBeNull();
      expect(await getGbpLocation(pool, { ownerId: OWNER_A, storeId: STORE_A2 })).toBeNull();
    });

    it('deleteGbpLocation: 他オーナーは削除不可・所有者は削除でき冪等', async () => {
      const pool = await getPool();
      expect(await deleteGbpLocation(pool, { ownerId: OWNER_B, storeId: STORE_A1 })).toBe(false);
      expect(await getGbpLocation(pool, { ownerId: OWNER_A, storeId: STORE_A1 })).not.toBeNull();
      expect(await deleteGbpLocation(pool, { ownerId: OWNER_A, storeId: STORE_A1 })).toBe(true);
      expect(await getGbpLocation(pool, { ownerId: OWNER_A, storeId: STORE_A1 })).toBeNull();
      expect(await deleteGbpLocation(pool, { ownerId: OWNER_A, storeId: STORE_A1 })).toBe(false);
    });
  });

  describe('gbp-sessions', () => {
    const FUTURE = () => new Date(Date.now() + 30 * 60 * 1000);

    it('getActiveGbpSession: セッションが無ければ none', async () => {
      const pool = await getPool();
      expect(await getActiveGbpSession(pool, OWNER_A)).toEqual({ kind: 'none' });
    });

    it('upsertGbpSession: storeId=null で開始でき payload が round-trip する', async () => {
      const pool = await getPool();
      const row = unwrap(
        await upsertGbpSession(pool, {
          ownerId: OWNER_A,
          storeId: null,
          flow: 'connect',
          stage: 'await_store',
          payload: { state: 'nonce-1', pendingStoreId: STORE_A1 },
          draftText: null,
          expiresAt: FUTURE(),
        }),
      );
      expect(row.owner_id).toBe(OWNER_A);
      expect(row.store_id).toBeNull();
      expect(row.flow).toBe('connect');
      expect(row.stage).toBe('await_store');

      const lookup = await getActiveGbpSession(pool, OWNER_A);
      expect(lookup.kind).toBe('active');
      if (lookup.kind !== 'active') throw new Error('unreachable');
      expect(lookup.session.payload).toEqual({ state: 'nonce-1', pendingStoreId: STORE_A1 });
    });

    it('upsertGbpSession: 新フロー開始は旧セッションを置換し行は 1 つのまま', async () => {
      const pool = await getPool();
      const row = unwrap(
        await upsertGbpSession(pool, {
          ownerId: OWNER_A,
          storeId: STORE_A1,
          flow: 'post',
          stage: 'await_input',
          payload: {},
          draftText: '下書きです',
          expiresAt: FUTURE(),
        }),
      );
      expect(row.flow).toBe('post');
      expect(row.stage).toBe('await_input');
      expect(row.store_id).toBe(STORE_A1);
      expect(row.draft_text).toBe('下書きです');
      const count = await pool.query(
        'SELECT count(*)::int AS n FROM gbp_sessions WHERE owner_id = $1',
        [OWNER_A],
      );
      expect(count.rows[0].n).toBe(1);
    });

    it('upsertGbpSession: 他オーナーの storeId は STORE_NOT_OWNED で既存セッション不変（Req 2.6）', async () => {
      const pool = await getPool();
      const res = await upsertGbpSession(pool, {
        ownerId: OWNER_A,
        storeId: STORE_B1,
        flow: 'reply',
        stage: 'await_review_pick',
        payload: {},
        draftText: null,
        expiresAt: FUTURE(),
      });
      expect(res).toEqual({ ok: false, error: 'STORE_NOT_OWNED' });
      const lookup = await getActiveGbpSession(pool, OWNER_A);
      if (lookup.kind !== 'active') throw new Error('session should remain active');
      expect(lookup.session.flow).toBe('post');
      expect(lookup.session.store_id).toBe(STORE_A1);
    });

    it('getActiveGbpSession: 期限切れは expired として行ごと返す（次回入力時の案内＋削除用）', async () => {
      const pool = await getPool();
      unwrap(
        await upsertGbpSession(pool, {
          ownerId: OWNER_B,
          storeId: STORE_B1,
          flow: 'reply',
          stage: 'await_decision',
          payload: { reviews: [] },
          draftText: '期限切れ下書き',
          expiresAt: new Date(Date.now() - 1000),
        }),
      );
      const lookup = await getActiveGbpSession(pool, OWNER_B);
      expect(lookup.kind).toBe('expired');
      if (lookup.kind !== 'expired') throw new Error('unreachable');
      expect(lookup.session.draft_text).toBe('期限切れ下書き');
    });

    it('getActiveGbpSession: now 引数の注入で期限判定を制御できる', async () => {
      const pool = await getPool();
      // OWNER_B のセッションは 1 秒前に期限切れ。過去時刻を now とすれば active 扱い。
      const past = new Date(Date.now() - 60 * 1000);
      const lookup = await getActiveGbpSession(pool, OWNER_B, past);
      expect(lookup.kind).toBe('active');
    });

    it('clearGbpSession: 自分の行のみ削除し冪等・他オーナーには影響しない', async () => {
      const pool = await getPool();
      expect(await clearGbpSession(pool, OWNER_A)).toBe(true);
      expect(await getActiveGbpSession(pool, OWNER_A)).toEqual({ kind: 'none' });
      expect(await clearGbpSession(pool, OWNER_A)).toBe(false);
      // OWNER_B のセッションは残っている。
      const lookupB = await getActiveGbpSession(pool, OWNER_B);
      expect(lookupB.kind).toBe('expired');
    });
  });

  // 承認実行の CAS ガード（spec task 4.1・design「GbpFlows > State Management」）。
  // 二重タップ・並行リクエストでも GBP 書込が高々 1 回になることの DB 側の根拠。
  describe('gbp-sessions の承認実行 CAS', () => {
    const FUTURE = (): Date => new Date(Date.now() + 30 * 60 * 1000);

    async function seedDecisionSession(): Promise<void> {
      const pool = await getPool();
      unwrap(
        await upsertGbpSession(pool, {
          ownerId: OWNER_A,
          storeId: STORE_A1,
          flow: 'post',
          stage: 'await_decision',
          payload: { material: { ownerInput: '本日から新メニュー' } },
          draftText: '本日から新メニューを始めました。',
          expiresAt: FUTURE(),
        }),
      );
    }

    it('beginGbpSessionExecution: await_decision の行のみ executing へ遷移し、行を返す', async () => {
      const pool = await getPool();
      await seedDecisionSession();

      const claimed = await beginGbpSessionExecution(pool, OWNER_A);
      expect(claimed).not.toBeNull();
      expect(claimed?.stage).toBe('executing');
      expect(claimed?.store_id).toBe(STORE_A1);
      expect(claimed?.draft_text).toBe('本日から新メニューを始めました。');
    });

    it('beginGbpSessionExecution: 既に executing の行は獲得できない（二重タップの排他）', async () => {
      const pool = await getPool();
      const second = await beginGbpSessionExecution(pool, OWNER_A);
      expect(second).toBeNull();
    });

    it('revertGbpSessionExecution: executing → await_decision へ戻し draft を温存する', async () => {
      const pool = await getPool();
      const reverted = await revertGbpSessionExecution(pool, OWNER_A, FUTURE());
      expect(reverted?.stage).toBe('await_decision');
      expect(reverted?.draft_text).toBe('本日から新メニューを始めました。');
      // executing 以外には作用しない（冪等ではなく条件付き）。
      expect(await revertGbpSessionExecution(pool, OWNER_A, FUTURE())).toBeNull();
    });

    it('completeGbpSessionExecution: executing の行のみ削除する', async () => {
      const pool = await getPool();
      // await_decision の状態では削除されない（他フローのセッションを巻き込まない保証）。
      expect(await completeGbpSessionExecution(pool, OWNER_A)).toBe(false);
      expect((await getActiveGbpSession(pool, OWNER_A)).kind).toBe('active');

      await beginGbpSessionExecution(pool, OWNER_A);
      expect(await completeGbpSessionExecution(pool, OWNER_A)).toBe(true);
      expect(await getActiveGbpSession(pool, OWNER_A)).toEqual({ kind: 'none' });
    });

    it('並行 2 リクエストのうち executing を獲得できるのは高々 1 つ', async () => {
      const pool = await getPool();
      await seedDecisionSession();

      const [a, b] = await Promise.all([
        beginGbpSessionExecution(pool, OWNER_A),
        beginGbpSessionExecution(pool, OWNER_A),
      ]);
      expect([a, b].filter((row) => row !== null)).toHaveLength(1);

      await completeGbpSessionExecution(pool, OWNER_A);
    });

    it('他オーナーの executing セッションには到達しない', async () => {
      const pool = await getPool();
      unwrap(
        await upsertGbpSession(pool, {
          ownerId: OWNER_B,
          storeId: STORE_B1,
          flow: 'post',
          stage: 'await_decision',
          payload: {},
          draftText: 'B の下書き',
          expiresAt: FUTURE(),
        }),
      );

      expect(await beginGbpSessionExecution(pool, OWNER_A)).toBeNull();
      const claimedB = await beginGbpSessionExecution(pool, OWNER_B);
      expect(claimedB?.owner_id).toBe(OWNER_B);
      expect(await completeGbpSessionExecution(pool, OWNER_A)).toBe(false);
      expect((await getActiveGbpSession(pool, OWNER_B)).kind).toBe('active');
    });
  });
});
