import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import {
  findByAuthSubject,
  linkAuthSubjectByEmail,
  createPendingDashboardUser,
  listDashboardUsers,
  disableDashboardUser,
} from '../src/dashboard-users.js';

// 共有テスト DB での衝突回避のため専用 UUID プレフィックス（f4）を用いる（f3 までは他ファイルで使用済み）。
const OP_A = 'f4000000-0000-0000-0000-0000000000a1';
const OP_B = 'f4000000-0000-0000-0000-0000000000b2';
const AG_A1 = 'f4000000-0000-0000-0000-00000000a101';

// 既存（リンク済み）利用者。
const DU_DISABLED_LINKED = 'f4000000-0000-0000-0000-d00000000001'; // auth_subject 設定済・disabled_at 設定済
const DU_ENABLED_LINKED = 'f4000000-0000-0000-0000-d00000000002'; // auth_subject 設定済・有効
// 保留（未ログイン）利用者。
const DU_PENDING = 'f4000000-0000-0000-0000-d00000000003'; // auth_subject NULL・email 大小混在・有効
const DU_PENDING_DISABLED = 'f4000000-0000-0000-0000-d00000000004'; // auth_subject NULL・email 設定・無効
// スコープ検証用（別 operator）。
const DU_OTHER_OP = 'f4000000-0000-0000-0000-d00000000005'; // operator_id = OP_B
// 無効化テスト専用ターゲット（有効・OP_A）。
const DU_DISABLE_TARGET = 'f4000000-0000-0000-0000-d00000000006';

const SUB_DISABLED = 'authsub-f4-disabled';
const SUB_ENABLED = 'authsub-f4-enabled';
const SUB_OTHER_OP = 'authsub-f4-otherop';
const SUB_DISABLE_TARGET = 'authsub-f4-disable-target';

// DU_PENDING の格納 email（大小混在。lower(email) 照合が効くことを検証するため意図的に混在させる）。
const PENDING_EMAIL_STORED = 'F4Pending@Example.COM';
const PENDING_EMAIL_NORMALIZED = 'f4pending@example.com';
const PENDING_DISABLED_EMAIL = 'f4disabled-pending@example.com';

const F4_IDS = [
  DU_DISABLED_LINKED,
  DU_ENABLED_LINKED,
  DU_PENDING,
  DU_PENDING_DISABLED,
  DU_OTHER_OP,
  DU_DISABLE_TARGET,
];

describe.skipIf(!process.env.DATABASE_URL)('dashboard-users accessors (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2), ($3, $4)', [
      OP_A,
      'f4運営A',
      OP_B,
      'f4運営B',
    ]);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG_A1,
      OP_A,
      'f4代理店A1',
    ]);
    // リンク済み（disabled/enabled）・operator ロール。
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject, disabled_at)
       VALUES ($1, 'operator', $2, NULL, $3, now()),
              ($4, 'operator', $2, NULL, $5, NULL),
              ($6, 'operator', $2, NULL, $7, NULL)`,
      [
        DU_DISABLED_LINKED,
        OP_A,
        SUB_DISABLED,
        DU_ENABLED_LINKED,
        SUB_ENABLED,
        DU_DISABLE_TARGET,
        SUB_DISABLE_TARGET,
      ],
    );
    // 別 operator のリンク済み利用者（listDashboardUsers/disableDashboardUser のスコープ検証用）。
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject)
       VALUES ($1, 'operator', $2, NULL, $3)`,
      [DU_OTHER_OP, OP_B, SUB_OTHER_OP],
    );
    // 保留（auth_subject NULL・email 設定）。DU_PENDING は agency ロール（FK 検証込み）。
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject, email, disabled_at)
       VALUES ($1, 'agency',   $2, $3,   NULL, $4, NULL),
              ($5, 'operator', $2, NULL, NULL, $6, now())`,
      [DU_PENDING, OP_A, AG_A1, PENDING_EMAIL_STORED, DU_PENDING_DISABLED, PENDING_DISABLED_EMAIL],
    );
  });

  afterAll(async () => {
    const pool = await getPool();
    // createPendingDashboardUser で追加される行も含め f4 の operator 配下を掃除する。
    await pool.query('DELETE FROM dashboard_users WHERE operator_id = ANY($1)', [[OP_A, OP_B]]);
    await pool.query('DELETE FROM agencies WHERE id = $1', [AG_A1]);
    await pool.query('DELETE FROM operators WHERE id = ANY($1)', [[OP_A, OP_B]]);
    await closePool();
  });

  describe('findByAuthSubject', () => {
    it('disabled_at が設定された行は disabled: true を返す（Req 6.4）', async () => {
      const pool = await getPool();
      const res = await findByAuthSubject(pool, SUB_DISABLED);
      expect(res).not.toBeNull();
      expect(res?.id).toBe(DU_DISABLED_LINKED);
      expect(res?.role).toBe('operator');
      expect(res?.operatorId).toBe(OP_A);
      expect(res?.agencyId).toBeNull();
      expect(res?.disabled).toBe(true);
    });

    it('disabled_at が NULL の行は disabled: false を返す（Req 6.2）', async () => {
      const pool = await getPool();
      const res = await findByAuthSubject(pool, SUB_ENABLED);
      expect(res?.id).toBe(DU_ENABLED_LINKED);
      expect(res?.disabled).toBe(false);
    });

    it('未登録 subject は null（回帰なし）', async () => {
      const pool = await getPool();
      expect(await findByAuthSubject(pool, 'authsub-f4-nonexistent')).toBeNull();
    });
  });

  describe('linkAuthSubjectByEmail', () => {
    it('保留行（auth_subject NULL）を大文字小文字を無視して原子的にリンクし、二重リンクは 0 行=null（Req 6.2）', async () => {
      const pool = await getPool();
      // 格納は 'F4Pending@Example.COM'、正規化済み小文字で照合しリンクできる（lower(email)=$1）。
      const linked = await linkAuthSubjectByEmail(pool, PENDING_EMAIL_NORMALIZED, 'uid-f4-link-1');
      expect(linked).not.toBeNull();
      expect(linked?.id).toBe(DU_PENDING);
      expect(linked?.role).toBe('agency');
      expect(linked?.operatorId).toBe(OP_A);
      expect(linked?.agencyId).toBe(AG_A1);

      // auth_subject が実際に埋まったことを確認。
      const check = await pool.query<{ auth_subject: string | null }>(
        'SELECT auth_subject FROM dashboard_users WHERE id = $1',
        [DU_PENDING],
      );
      expect(check.rows[0]?.auth_subject).toBe('uid-f4-link-1');

      // 2 回目は auth_subject が NULL でないため一致せず null（二重リンク不可）。
      const second = await linkAuthSubjectByEmail(pool, PENDING_EMAIL_NORMALIZED, 'uid-f4-link-2');
      expect(second).toBeNull();
      // 元の auth_subject は上書きされない。
      const recheck = await pool.query<{ auth_subject: string | null }>(
        'SELECT auth_subject FROM dashboard_users WHERE id = $1',
        [DU_PENDING],
      );
      expect(recheck.rows[0]?.auth_subject).toBe('uid-f4-link-1');
    });

    it('disabled_at が設定された保留行はリンクしない（null・無効利用者は復活させない）（Req 6.4）', async () => {
      const pool = await getPool();
      const res = await linkAuthSubjectByEmail(pool, PENDING_DISABLED_EMAIL, 'uid-f4-link-3');
      expect(res).toBeNull();
      // auth_subject は NULL のまま。
      const check = await pool.query<{ auth_subject: string | null }>(
        'SELECT auth_subject FROM dashboard_users WHERE id = $1',
        [DU_PENDING_DISABLED],
      );
      expect(check.rows[0]?.auth_subject).toBeNull();
    });

    it('該当メールの保留行が無い場合は null', async () => {
      const pool = await getPool();
      expect(
        await linkAuthSubjectByEmail(pool, 'f4-no-such@example.com', 'uid-f4-link-x'),
      ).toBeNull();
    });
  });

  describe('createPendingDashboardUser', () => {
    it('operator ロール（agencyId null）で auth_subject NULL の保留行を作り email を正規化保存する（Req 6.2）', async () => {
      const pool = await getPool();
      const created = await createPendingDashboardUser(pool, {
        role: 'operator',
        operatorId: OP_A,
        agencyId: null,
        email: 'F4Create-Op@Example.COM',
        displayName: 'f4作成運営',
      });
      expect(created.role).toBe('operator');
      expect(created.operatorId).toBe(OP_A);
      expect(created.agencyId).toBeNull();
      expect(created.email).toBe('f4create-op@example.com'); // 小文字正規化
      expect(created.displayName).toBe('f4作成運営');
      expect(created.disabled).toBe(false);
      expect(created.createdAt).toBeInstanceOf(Date);

      // auth_subject が NULL であること（保留＝未ログイン）を直接確認。
      const check = await pool.query<{ auth_subject: string | null }>(
        'SELECT auth_subject FROM dashboard_users WHERE id = $1',
        [created.id],
      );
      expect(check.rows[0]?.auth_subject).toBeNull();

      // 正規化保存ゆえ、正規化 email でリンク可能。
      const linked = await linkAuthSubjectByEmail(pool, 'f4create-op@example.com', 'uid-f4-create-op');
      expect(linked?.id).toBe(created.id);
    });

    it('agency ロール（agencyId 指定）で保留行を作れる（ck_dashboard_role_scope を満たす）（Req 6.3）', async () => {
      const pool = await getPool();
      const created = await createPendingDashboardUser(pool, {
        role: 'agency',
        operatorId: OP_A,
        agencyId: AG_A1,
        email: 'f4create-ag@example.com',
      });
      expect(created.role).toBe('agency');
      expect(created.agencyId).toBe(AG_A1);
      expect(created.email).toBe('f4create-ag@example.com');
      expect(created.displayName).toBeNull(); // displayName 省略時は null
    });
  });

  describe('listDashboardUsers', () => {
    it('operator スコープで自運営の利用者のみを返す（別 operator は漏れない）', async () => {
      const pool = await getPool();
      const users = await listDashboardUsers(pool, OP_A);
      const ids = users.map((u) => u.id);
      expect(ids).toEqual(expect.arrayContaining([DU_DISABLED_LINKED, DU_ENABLED_LINKED, DU_PENDING]));
      expect(ids).not.toContain(DU_OTHER_OP); // OP_B の利用者は漏れない
      expect(users.every((u) => u.operatorId === OP_A)).toBe(true);
      // disabled フラグが disabled_at を反映する。
      expect(users.find((u) => u.id === DU_DISABLED_LINKED)?.disabled).toBe(true);
      expect(users.find((u) => u.id === DU_ENABLED_LINKED)?.disabled).toBe(false);
    });
  });

  describe('disableDashboardUser', () => {
    it('operator 不一致は null かつ無効化しない、一致は無効化する（Req 6.4）', async () => {
      const pool = await getPool();
      // 越権（別 operator スコープ）では無効化拒否（null）かつ実際に無効化されない。
      const wrong = await disableDashboardUser(pool, DU_DISABLE_TARGET, OP_B);
      expect(wrong).toBeNull();
      const stillEnabled = await findByAuthSubject(pool, SUB_DISABLE_TARGET);
      expect(stillEnabled?.disabled).toBe(false);

      // 正しい operator スコープでは無効化される。
      const ok = await disableDashboardUser(pool, DU_DISABLE_TARGET, OP_A);
      expect(ok).not.toBeNull();
      expect(ok?.id).toBe(DU_DISABLE_TARGET);
      expect(ok?.disabled).toBe(true);
      // 以後 findByAuthSubject は disabled: true（ログイン拒否に写像される）。
      const nowDisabled = await findByAuthSubject(pool, SUB_DISABLE_TARGET);
      expect(nowDisabled?.disabled).toBe(true);
    });

    it('存在しない id は null', async () => {
      const pool = await getPool();
      expect(
        await disableDashboardUser(pool, 'f4000000-0000-0000-0000-d0000000ffff', OP_A),
      ).toBeNull();
    });
  });

  it('掃除対象の f4 利用者 id はすべて既知（テスト自己検証）', () => {
    expect(new Set(F4_IDS).size).toBe(F4_IDS.length);
  });
});
