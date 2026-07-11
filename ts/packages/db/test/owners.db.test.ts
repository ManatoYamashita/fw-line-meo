import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { findOwnerByLineUserId, createOwner, markOwnerStoreIdentified } from '../src/owners.js';

// 他ファイルと衝突しない専用 UUID プレフィックス（e1/e2）。
const OP = 'e1111111-1111-1111-1111-111111111111';
const AG = 'e2222222-2222-2222-2222-222222222222';

describe.skipIf(!process.env.DATABASE_URL)('owners accessors (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'owners運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      'owners代理店',
    ]);
  });

  afterAll(async () => {
    await closePool();
  });

  describe('findOwnerByLineUserId / createOwner', () => {
    it('未登録の line_user_id は null', async () => {
      const pool = await getPool();
      expect(await findOwnerByLineUserId(pool, 'U-owners-unknown')).toBeNull();
    });

    it('createOwner は agency_id 紐付き・pending 状態で owner を作成する', async () => {
      const pool = await getPool();
      const owner = await createOwner(pool, {
        agencyId: AG,
        lineUserId: 'U-owners-1',
        displayName: 'テストオーナー',
      });
      expect(owner.agency_id).toBe(AG);
      expect(owner.line_user_id).toBe('U-owners-1');
      expect(owner.display_name).toBe('テストオーナー');
      expect(owner.onboarding_status).toBe('pending');

      const found = await findOwnerByLineUserId(pool, 'U-owners-1');
      expect(found?.id).toBe(owner.id);
    });

    it('displayName を省略すると null で作成される', async () => {
      const pool = await getPool();
      const owner = await createOwner(pool, { agencyId: AG, lineUserId: 'U-owners-2' });
      expect(owner.display_name).toBeNull();
    });

    it('同一 line_user_id を二重作成すると一意制約違反になる', async () => {
      const pool = await getPool();
      await expect(
        createOwner(pool, { agencyId: AG, lineUserId: 'U-owners-1' }),
      ).rejects.toThrow();
    });
  });

  describe('markOwnerStoreIdentified', () => {
    it('onboarding_status を store_identified に遷移させる', async () => {
      const pool = await getPool();
      const owner = await createOwner(pool, { agencyId: AG, lineUserId: 'U-owners-3' });
      expect(owner.onboarding_status).toBe('pending');

      await markOwnerStoreIdentified(pool, owner.id);

      const found = await findOwnerByLineUserId(pool, 'U-owners-3');
      expect(found?.onboarding_status).toBe('store_identified');
    });
  });
});
