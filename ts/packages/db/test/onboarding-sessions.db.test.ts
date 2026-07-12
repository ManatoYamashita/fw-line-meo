import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { getOrCreateSession, updateSession } from '../src/onboarding-sessions.js';
import { createOwner } from '../src/owners.js';

// 他ファイルと衝突しない専用 UUID プレフィックス（e5/e6）。
const OP = 'e5555555-5555-5555-5555-555555555555';
const AG = 'e6666666-6666-6666-6666-666666666666';

describe.skipIf(!process.env.DATABASE_URL)('onboarding-sessions accessors (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'session運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      'session代理店',
    ]);
  });

  afterAll(async () => {
    await closePool();
  });

  describe('getOrCreateSession', () => {
    it('未登録の line_user_id は await_invite_code・owner_id=null で新規作成される', async () => {
      const pool = await getPool();
      const session = await getOrCreateSession(pool, 'U-session-1');
      expect(session.stage).toBe('await_invite_code');
      expect(session.owner_id).toBeNull();
      expect(session.invite_failures).toBe(0);
      expect(session.locked_until).toBeNull();
      expect(session.candidates).toBeNull();
    });

    it('既存セッションは重複作成せず同一行を返す（再訪・Req 5.1/5.2）', async () => {
      const pool = await getPool();
      const first = await getOrCreateSession(pool, 'U-session-1');
      const second = await getOrCreateSession(pool, 'U-session-1');
      expect(second.created_at).toEqual(first.created_at);
    });
  });

  describe('updateSession', () => {
    it('invite_failures を加算しロックを設定できる（Req 2.3）', async () => {
      const pool = await getPool();
      await getOrCreateSession(pool, 'U-session-lock');
      await updateSession(pool, 'U-session-lock', { inviteFailures: 1 });
      await updateSession(pool, 'U-session-lock', { inviteFailures: 2 });
      const lockedUntil = new Date(Date.now() + 10 * 60 * 1000);
      await updateSession(pool, 'U-session-lock', { inviteFailures: 5, lockedUntil });

      const session = await getOrCreateSession(pool, 'U-session-lock');
      expect(session.invite_failures).toBe(5);
      expect(session.locked_until).not.toBeNull();
    });

    it('owner 作成に合わせて stage と owner_id を同時に遷移できる（CHECK 制約整合）', async () => {
      const pool = await getPool();
      await getOrCreateSession(pool, 'U-session-owner');
      const owner = await createOwner(pool, { agencyId: AG, lineUserId: 'U-session-owner' });

      await updateSession(pool, 'U-session-owner', {
        stage: 'await_store_name',
        ownerId: owner.id,
      });

      const session = await getOrCreateSession(pool, 'U-session-owner');
      expect(session.stage).toBe('await_store_name');
      expect(session.owner_id).toBe(owner.id);
    });

    it('stage のみ await_invite_code から遷移させ owner_id を設定しないと CHECK 制約違反', async () => {
      const pool = await getPool();
      await getOrCreateSession(pool, 'U-session-invalid');
      await expect(
        updateSession(pool, 'U-session-invalid', { stage: 'await_store_name' }),
      ).rejects.toThrow();
    });

    it('candidates（jsonb）を保存し読み出せる', async () => {
      const pool = await getPool();
      await getOrCreateSession(pool, 'U-session-candidates');
      const candidates = [
        {
          placeId: 'ChIJ_c1',
          name: '候補店舗1',
          address: '東京都渋谷区1-1-1',
          latitude: 35.1,
          longitude: 139.1,
          types: ['restaurant'],
        },
      ];
      await updateSession(pool, 'U-session-candidates', { candidates, selectedIndex: 0 });

      const session = await getOrCreateSession(pool, 'U-session-candidates');
      expect(session.candidates).toEqual(candidates);
      expect(session.selected_index).toBe(0);
    });

    it('candidates を null にリセットできる', async () => {
      const pool = await getPool();
      await getOrCreateSession(pool, 'U-session-reset');
      await updateSession(pool, 'U-session-reset', {
        candidates: [
          {
            placeId: 'ChIJ_r1',
            name: 'リセット前候補',
            address: '住所',
            latitude: 0,
            longitude: 0,
            types: [],
          },
        ],
      });
      await updateSession(pool, 'U-session-reset', { candidates: null, selectedIndex: null });

      const session = await getOrCreateSession(pool, 'U-session-reset');
      expect(session.candidates).toBeNull();
      expect(session.selected_index).toBeNull();
    });
  });
});
