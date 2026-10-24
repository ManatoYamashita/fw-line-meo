import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { findActiveInviteCode } from '../src/invite-codes.js';
import { createOwner, findOwnerByLineUserId, listOwnersByAgency } from '../src/owners.js';

// オーナーの登録に用いられた招待コードの記録（agency-dashboard Requirement 8・Issue #486・migration 0017）。
// 共有テスト DB での衝突回避のため専用 UUID プレフィックス（48600000）と専用のコード・LINE ユーザー ID を用いる。
const OP = '48600000-0000-0000-0000-0000000000a1';
const AG_A = '48600000-0000-0000-0000-00000000a001';
const AG_B = '48600000-0000-0000-0000-00000000b001';
const LEGACY_OWNER = '48600000-0000-0000-0000-0000000e0001';

describe.skipIf(!process.env.DATABASE_URL)('owner invite code record (DB)', () => {
  let codeA = '';
  let codeB = '';

  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '486運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3), ($4, $2, $5)', [
      AG_A,
      OP,
      '486代理店A',
      AG_B,
      '486代理店B',
    ]);
    const a = await pool.query<{ id: string }>(
      'INSERT INTO agency_invite_codes (agency_id, code) VALUES ($1, $2) RETURNING id',
      [AG_A, 'OIC486A1'],
    );
    const b = await pool.query<{ id: string }>(
      'INSERT INTO agency_invite_codes (agency_id, code) VALUES ($1, $2) RETURNING id',
      [AG_B, 'OIC486B1'],
    );
    codeA = a.rows[0]!.id;
    codeB = b.rows[0]!.id;
    // 代理店 A に記録には使わない 2 本目のコードを置く。コードが 1 本だけだと、一覧の結合キーを
    // 誤って agency_id で結んでも行が増えず、試験が誤りを見逃す（Issue #486 のレビューで実測）。
    await pool.query('INSERT INTO agency_invite_codes (agency_id, code) VALUES ($1, $2)', [
      AG_A,
      'OIC486A2',
    ]);
    // 0017 より前の登録と同じ形（invite_code_id を書かない行）。
    await pool.query(
      'INSERT INTO owners (id, agency_id, line_user_id, display_name) VALUES ($1, $2, $3, $4)',
      [LEGACY_OWNER, AG_A, 'U-486-legacy', '486既存オーナー'],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  describe('findActiveInviteCode（8.1 の照合）', () => {
    it('有効なコードはコードの行の id と代理店を返す', async () => {
      const pool = await getPool();
      expect(await findActiveInviteCode(pool, 'OIC486A1')).toEqual({ id: codeA, agencyId: AG_A });
    });
  });

  describe('createOwner（8.1 の記録）', () => {
    it('渡した招待コードの id を invite_code_id に書く', async () => {
      const pool = await getPool();
      const owner = await createOwner(pool, {
        agencyId: AG_A,
        inviteCodeId: codeA,
        lineUserId: 'U-486-recorded',
        displayName: '486記録ありオーナー',
      });
      expect(owner.invite_code_id).toBe(codeA);

      const raw = await pool.query<{ invite_code_id: string | null }>(
        'SELECT invite_code_id FROM owners WHERE id = $1',
        [owner.id],
      );
      expect(raw.rows[0]?.invite_code_id).toBe(codeA);
      expect((await findOwnerByLineUserId(pool, 'U-486-recorded'))?.invite_code_id).toBe(codeA);
    });

    it('別の代理店のコードとは結びつけられない（8.2・複合 FK）', async () => {
      const pool = await getPool();
      await expect(
        createOwner(pool, { agencyId: AG_A, inviteCodeId: codeB, lineUserId: 'U-486-cross' }),
      ).rejects.toThrow(/fk_owners_invite_code_same_agency/);
      expect(await findOwnerByLineUserId(pool, 'U-486-cross')).toBeNull();
    });
  });

  describe('listOwnersByAgency（8.5 の読出）', () => {
    it('記録ありは { id, code, disabled }、記録なしは null を返す', async () => {
      const pool = await getPool();
      const owners = await listOwnersByAgency(pool, AG_A);

      // 1 オーナー 1 行。代理店のコードの本数に応じて行が増えないこと（結合キーの誤りを止める）。
      const raw = await pool.query<{ n: string }>('SELECT count(*) AS n FROM owners WHERE agency_id = $1', [AG_A]);
      expect(owners).toHaveLength(Number(raw.rows[0]?.n));
      expect(new Set(owners.map((o) => o.id)).size).toBe(owners.length);

      const recorded = owners.find((o) => o.displayName === '486記録ありオーナー');
      expect(recorded?.inviteCode).toEqual({ id: codeA, code: 'OIC486A1', disabled: false });

      const legacy = owners.find((o) => o.id === LEGACY_OWNER);
      expect(legacy).toBeDefined();
      expect(legacy?.inviteCode).toBeNull();
    });

    it('コードを無効化した後も結びつきを返し、disabled: true になる（8.3）', async () => {
      const pool = await getPool();
      await pool.query('UPDATE agency_invite_codes SET disabled_at = now() WHERE id = $1', [codeA]);
      expect(await findActiveInviteCode(pool, 'OIC486A1')).toBeNull();

      const owners = await listOwnersByAgency(pool, AG_A);
      const recorded = owners.find((o) => o.displayName === '486記録ありオーナー');
      expect(recorded?.inviteCode).toEqual({ id: codeA, code: 'OIC486A1', disabled: true });
    });
  });
});
