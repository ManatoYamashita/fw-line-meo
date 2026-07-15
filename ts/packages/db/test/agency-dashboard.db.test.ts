import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { listStoresWithStatus } from '../src/stores.js';
import { listOwnersByAgency, findOwnerWithAgency } from '../src/owners.js';
import { createAgency, listAgencies } from '../src/agencies.js';
import { listCategories } from '../src/categories.js';
import {
  listInviteCodes,
  createInviteCode,
  disableInviteCode,
  findActiveInviteCode,
} from '../src/invite-codes.js';

// 共有テスト DB での衝突回避のため専用 UUID プレフィックス（f3）を用いる（f2 までは他ファイルで使用済み）。
const OP_A = 'f3000000-0000-0000-0000-0000000000a1';
const OP_B = 'f3000000-0000-0000-0000-0000000000b2';
const AG_A1 = 'f3000000-0000-0000-0000-00000000a101';
const AG_A2 = 'f3000000-0000-0000-0000-00000000a202';
const AG_B1 = 'f3000000-0000-0000-0000-00000000b101';
const OWN_A1_1 = 'f3000000-0000-0000-0000-a10100000001';
const OWN_A1_2 = 'f3000000-0000-0000-0000-a10100000002';
const OWN_A2_1 = 'f3000000-0000-0000-0000-a20200000001';
const ST_A1_1 = 'f3000000-0000-0000-0000-510100000001';
const ST_A1_2 = 'f3000000-0000-0000-0000-510100000002';
const ST_A2_1 = 'f3000000-0000-0000-0000-520200000001';
const MISSING_OWNER = 'f3000000-0000-0000-0000-0000000fffff';

describe.skipIf(!process.env.DATABASE_URL)('agency-dashboard accessors (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2), ($3, $4)', [
      OP_A,
      'f3運営A',
      OP_B,
      'f3運営B',
    ]);
    await pool.query(
      `INSERT INTO agencies (id, operator_id, name)
       VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)`,
      [AG_A1, OP_A, 'f3代理店A1', AG_A2, OP_A, 'f3代理店A2', AG_B1, OP_B, 'f3代理店B1'],
    );
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, display_name)
       VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12)`,
      [
        OWN_A1_1, AG_A1, 'U-f3-a11', 'f3オーナーA1-1',
        OWN_A1_2, AG_A1, 'U-f3-a12', 'f3オーナーA1-2',
        OWN_A2_1, AG_A2, 'U-f3-a21', 'f3オーナーA2-1',
      ],
    );
    // 確定店舗（place_id 必須・ck_place_confirmed）。
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status)
       VALUES ($1, $2, $3, $4, 'confirmed'), ($5, $6, $7, $8, 'confirmed')`,
      [ST_A1_1, OWN_A1_1, 'f3店舗A1-1', 'place-f3-a11', ST_A2_1, OWN_A2_1, 'f3店舗A2-1', 'place-f3-a21'],
    );
    // 未確定店舗（place_id NULL）。
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_status) VALUES ($1, $2, $3, 'pending')`,
      [ST_A1_2, OWN_A1_2, 'f3店舗A1-2'],
    );
    // competitorConfigured の検証: A1-1 は active 競合あり=true、A1-2 は inactive 競合のみ=false。
    await pool.query(
      `INSERT INTO competitors (store_id, place_id, active)
       VALUES ($1, $2, true), ($3, $4, false)`,
      [ST_A1_1, 'comp-f3-1', ST_A1_2, 'comp-f3-2'],
    );
    // 招待コード一覧・スコープ検証用（AG_A1 に有効/無効各1、AG_A2 に有効1）。
    await pool.query(`INSERT INTO agency_invite_codes (agency_id, code) VALUES ($1, $2)`, [
      AG_A1,
      'F3AG1ACT',
    ]);
    await pool.query(
      `INSERT INTO agency_invite_codes (agency_id, code, disabled_at) VALUES ($1, $2, now())`,
      [AG_A1, 'F3AG1DIS'],
    );
    await pool.query(`INSERT INTO agency_invite_codes (agency_id, code) VALUES ($1, $2)`, [
      AG_A2,
      'F3AG2ACT',
    ]);
  });

  afterAll(async () => {
    await closePool();
  });

  describe('listStoresWithStatus', () => {
    it('agencyId 絞り込みは他代理店の店舗を漏らさない（Req 2.1, 4.1）', async () => {
      const pool = await getPool();
      const a1 = await listStoresWithStatus(pool, { agencyId: AG_A1 });
      const ids = a1.map((s) => s.id);
      expect(ids).toContain(ST_A1_1);
      expect(ids).toContain(ST_A1_2);
      expect(ids).not.toContain(ST_A2_1); // AG_A2 の店舗は漏れない
      expect(a1.every((s) => s.agencyId === AG_A1)).toBe(true);
    });

    it('competitorConfigured は active 競合の有無を反映（Req 4.3）', async () => {
      const pool = await getPool();
      const a1 = await listStoresWithStatus(pool, { agencyId: AG_A1 });
      const s11 = a1.find((s) => s.id === ST_A1_1);
      const s12 = a1.find((s) => s.id === ST_A1_2);
      expect(s11?.competitorConfigured).toBe(true); // active 競合あり
      expect(s12?.competitorConfigured).toBe(false); // inactive 競合のみ
    });

    it('JOIN 由来の店名・オーナー・代理店・ステータスを同梱する（Req 4.2, 4.3）', async () => {
      const pool = await getPool();
      const a1 = await listStoresWithStatus(pool, { agencyId: AG_A1 });
      const s11 = a1.find((s) => s.id === ST_A1_1);
      expect(s11).toBeDefined();
      expect(s11?.name).toBe('f3店舗A1-1');
      expect(s11?.placeStatus).toBe('confirmed');
      expect(s11?.ownerId).toBe(OWN_A1_1);
      expect(s11?.ownerDisplayName).toBe('f3オーナーA1-1');
      expect(s11?.agencyId).toBe(AG_A1);
      expect(s11?.agencyName).toBe('f3代理店A1');
      expect(s11?.createdAt).toBeInstanceOf(Date);
      const s12 = a1.find((s) => s.id === ST_A1_2);
      expect(s12?.placeStatus).toBe('pending');
    });

    it('filter 未指定は全代理店の店舗を返す（Req 2.2, 4.2）', async () => {
      const pool = await getPool();
      const all = await listStoresWithStatus(pool, {});
      const ids = all.map((s) => s.id);
      expect(ids).toContain(ST_A1_1);
      expect(ids).toContain(ST_A2_1); // 未絞り込み時は他代理店も見える
    });
  });

  describe('listOwnersByAgency / findOwnerWithAgency', () => {
    it('自代理店のオーナーのみ返す（Req 2.1）', async () => {
      const pool = await getPool();
      const owners = await listOwnersByAgency(pool, AG_A1);
      const ids = owners.map((o) => o.id);
      expect(ids).toEqual(expect.arrayContaining([OWN_A1_1, OWN_A1_2]));
      expect(ids).not.toContain(OWN_A2_1); // AG_A2 のオーナーは漏れない
      const o = owners.find((x) => x.id === OWN_A1_1);
      expect(o?.displayName).toBe('f3オーナーA1-1');
      expect(o?.onboardingStatus).toBe('pending');
      expect(o?.createdAt).toBeInstanceOf(Date);
    });

    it('findOwnerWithAgency は id と agencyId を返す（不在は null）', async () => {
      const pool = await getPool();
      expect(await findOwnerWithAgency(pool, OWN_A1_1)).toEqual({
        id: OWN_A1_1,
        agencyId: AG_A1,
      });
      expect(await findOwnerWithAgency(pool, MISSING_OWNER)).toBeNull();
    });
  });

  describe('listCategories', () => {
    it('seed の categories を code 昇順で返す（seed が SoT）', async () => {
      const pool = await getPool();
      const cats = await listCategories(pool);
      expect(cats).toContainEqual({ code: 'ramen', label: 'ラーメン' });
      expect(cats.length).toBeGreaterThanOrEqual(11);
      const codes = cats.map((c) => c.code);
      expect(codes).toEqual([...codes].sort());
    });
  });

  describe('createAgency / listAgencies', () => {
    it('createAgency は operatorId 紐付きで作成し、listAgencies は operator スコープで返す（Req 6.1）', async () => {
      const pool = await getPool();
      const created = await createAgency(pool, { operatorId: OP_A, name: 'f3新代理店A' });
      expect(created.operatorId).toBe(OP_A);
      expect(created.name).toBe('f3新代理店A');
      expect(typeof created.id).toBe('string');
      expect(created.createdAt).toBeInstanceOf(Date);

      const agenciesA = await listAgencies(pool, OP_A);
      const ids = agenciesA.map((a) => a.id);
      expect(ids).toEqual(expect.arrayContaining([AG_A1, AG_A2, created.id]));
      expect(ids).not.toContain(AG_B1); // OP_B の代理店は漏れない
      expect(agenciesA.every((a) => a.operatorId === OP_A)).toBe(true);
    });
  });

  describe('listInviteCodes / createInviteCode / disableInviteCode', () => {
    it('listInviteCodes は agency スコープ＋有効/無効を反映（Req 5.1）', async () => {
      const pool = await getPool();
      const codes = await listInviteCodes(pool, AG_A1);
      const vals = codes.map((c) => c.code);
      expect(vals).toContain('F3AG1ACT');
      expect(vals).toContain('F3AG1DIS');
      expect(vals).not.toContain('F3AG2ACT'); // AG_A2 のコードは漏れない
      expect(codes.every((c) => c.agencyId === AG_A1)).toBe(true);
      expect(codes.find((c) => c.code === 'F3AG1ACT')?.disabled).toBe(false);
      expect(codes.find((c) => c.code === 'F3AG1DIS')?.disabled).toBe(true);
    });

    it('createInviteCode は有効な新規コードを作る（Req 5.2）', async () => {
      const pool = await getPool();
      const nc = await createInviteCode(pool, { agencyId: AG_A1, code: 'F3AG1NEW' });
      expect(nc.agencyId).toBe(AG_A1);
      expect(nc.code).toBe('F3AG1NEW');
      expect(nc.disabled).toBe(false);
      const vals = (await listInviteCodes(pool, AG_A1)).map((c) => c.code);
      expect(vals).toContain('F3AG1NEW');
    });

    it('disableInviteCode: agencyId 不一致は null かつ無効化しない、一致は無効化する（Req 5.3）', async () => {
      const pool = await getPool();
      const target = await createInviteCode(pool, { agencyId: AG_A1, code: 'F3AG1DISME' });

      // 他代理店スコープでの無効化は拒否（null）かつ実際に無効化されない。
      const wrong = await disableInviteCode(pool, target.id, AG_A2);
      expect(wrong).toBeNull();
      const stillActive = (await listInviteCodes(pool, AG_A1)).find((c) => c.id === target.id);
      expect(stillActive?.disabled).toBe(false);

      // 正しいスコープでは無効化される。
      const ok = await disableInviteCode(pool, target.id, AG_A1);
      expect(ok).not.toBeNull();
      expect(ok?.disabled).toBe(true);
      const nowDisabled = (await listInviteCodes(pool, AG_A1)).find((c) => c.id === target.id);
      expect(nowDisabled?.disabled).toBe(true);
    });

    it('既存 findActiveInviteCode は無改変で有効コードを解決する（回帰なし）', async () => {
      const pool = await getPool();
      expect(await findActiveInviteCode(pool, 'F3AG1ACT')).toEqual({ agencyId: AG_A1 });
      expect(await findActiveInviteCode(pool, 'F3AG1DIS')).toBeNull();
    });
  });
});
