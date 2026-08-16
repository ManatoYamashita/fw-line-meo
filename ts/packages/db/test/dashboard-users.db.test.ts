import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import {
  findByAuthSubject,
  linkAuthSubjectByEmail,
  createPendingDashboardUser,
  listDashboardUsers,
  disableDashboardUserGuarded,
  findDashboardUserDisplayName,
  enableDashboardUser,
  findDashboardUserByEmailInOperator,
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
    // 別 operator のリンク済み利用者（listDashboardUsers の operator スコープ検証用）。
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

  // 注: 旧 disableDashboardUser（ガードなし単純版）のテストは Task 2.1 で撤去（保護付き
  // disableDashboardUserGuarded に置換）。無効化の網羅は下部の disableDashboardUserGuarded ブロック
  // （f8g 帯）と並行安全性ブロック（f8c 帯）が担う。DU_DISABLE_TARGET/SUB_DISABLE_TARGET のフィクスチャ行は
  // findByAuthSubject など他ブロックのスコープ検証で参照されるため残置する。

  describe('findDashboardUserDisplayName', () => {
    // 掃除は afterAll の operator_id スコープ DELETE（OP_A 配下）に含まれる。
    const DU_NAMED = 'f4000000-0000-0000-0000-d00000000007';

    it('display_name 設定行は表示名・未設定行は null を返す（GET /me の displayName 用）', async () => {
      const pool = await getPool();
      await pool.query(
        `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject, display_name)
         VALUES ($1, 'operator', $2, NULL, $3, $4)`,
        [DU_NAMED, OP_A, 'authsub-f4-named', 'f4表示名テスト'],
      );
      expect(await findDashboardUserDisplayName(pool, DU_NAMED)).toBe('f4表示名テスト');
      // フィクスチャの既存行は display_name 未設定＝null。
      expect(await findDashboardUserDisplayName(pool, DU_ENABLED_LINKED)).toBeNull();
    });

    it('不在の id は null', async () => {
      const pool = await getPool();
      expect(
        await findDashboardUserDisplayName(pool, 'f4000000-0000-0000-0000-d0000000fffe'),
      ).toBeNull();
    });
  });

  it('掃除対象の f4 利用者 id はすべて既知（テスト自己検証）', () => {
    expect(new Set(F4_IDS).size).toBe(F4_IDS.length);
  });
});

// ============================================================
// Task 1.1: 再有効化（enableDashboardUser）とスコープ限定メールルックアップ
//           （findDashboardUserByEmailInOperator）。
// f4 とは operator_id が異なる独立フィクスチャ（接頭辞 f8・f7 まで使用済み）。
// enable 系は disabled_at を書き換えるため lookup 系（read-only）と id を分離する。
// ============================================================
const F8_OP_A = 'f8000000-0000-0000-0000-0000000000a1';
const F8_OP_B = 'f8000000-0000-0000-0000-0000000000b2';

// enable 系ターゲット（OP_A、disabled_at を書き換える）。
const F8_DU_DISABLED_LINKED = 'f8000000-0000-0000-0000-d00000000001'; // auth_subject 設定済・無効
const F8_DU_PENDING_DISABLED = 'f8000000-0000-0000-0000-d00000000002'; // auth_subject NULL・email 設定・無効（保留無効）
const F8_DU_ENABLED_LINKED = 'f8000000-0000-0000-0000-d00000000003'; // auth_subject 設定済・有効
const F8_DU_OTHER_OP = 'f8000000-0000-0000-0000-d00000000004'; // OP_B（越境・不在検証用）

// lookup 系ターゲット（read-only、enable 系とは非重複）。
const F8_LOOKUP_DISABLED = 'f8000000-0000-0000-0000-d00000000005'; // OP_A・email 設定・無効
const F8_LOOKUP_ENABLED = 'f8000000-0000-0000-0000-d00000000006'; // OP_A・email 設定（大小混在）・有効
const F8_LOOKUP_OTHER_OP = 'f8000000-0000-0000-0000-d00000000007'; // OP_B・email 設定（越境秘匿検証）

const SUB_F8_DISABLED_LINKED = 'authsub-f8-disabled-linked';
const SUB_F8_ENABLED_LINKED = 'authsub-f8-enabled-linked';
const SUB_F8_OTHER_OP = 'authsub-f8-otherop';
const SUB_F8_LOOKUP_ENABLED = 'authsub-f8-lookup-enabled';

const F8_PENDING_DISABLED_EMAIL = 'f8pending-disabled@example.com';
const F8_LOOKUP_DISABLED_EMAIL = 'f8lookup-disabled@example.com';
// 大小混在で格納し、lower(email) 照合が効くことを検証する。
const F8_LOOKUP_ENABLED_EMAIL_STORED = 'F8Lookup-Enabled@Example.COM';
const F8_LOOKUP_ENABLED_EMAIL_NORMALIZED = 'f8lookup-enabled@example.com';
const F8_LOOKUP_OTHER_EMAIL = 'f8lookup-other@example.com';

describe.skipIf(!process.env.DATABASE_URL)('dashboard-users lifecycle accessors (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2), ($3, $4)', [
      F8_OP_A,
      'f8運営A',
      F8_OP_B,
      'f8運営B',
    ]);
    // enable 系（OP_A）: リンク済み無効・有効、保留無効。
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject, email, disabled_at)
       VALUES ($1, 'operator', $2, NULL, $3,   NULL, now()),
              ($4, 'operator', $2, NULL, $5,   NULL, NULL),
              ($6, 'operator', $2, NULL, NULL, $7,   now())`,
      [
        F8_DU_DISABLED_LINKED,
        F8_OP_A,
        SUB_F8_DISABLED_LINKED,
        F8_DU_ENABLED_LINKED,
        SUB_F8_ENABLED_LINKED,
        F8_DU_PENDING_DISABLED,
        F8_PENDING_DISABLED_EMAIL,
      ],
    );
    // 越境検証用（OP_B・有効）。
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject)
       VALUES ($1, 'operator', $2, NULL, $3)`,
      [F8_DU_OTHER_OP, F8_OP_B, SUB_F8_OTHER_OP],
    );
    // lookup 系: OP_A の無効・有効（大小混在 email）、OP_B の同名スコープ外。
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject, email, disabled_at)
       VALUES ($1, 'operator', $2, NULL, NULL, $3, now()),
              ($4, 'operator', $2, NULL, $5,   $6, NULL),
              ($7, 'operator', $8, NULL, NULL, $9, NULL)`,
      [
        F8_LOOKUP_DISABLED,
        F8_OP_A,
        F8_LOOKUP_DISABLED_EMAIL,
        F8_LOOKUP_ENABLED,
        SUB_F8_LOOKUP_ENABLED,
        F8_LOOKUP_ENABLED_EMAIL_STORED,
        F8_LOOKUP_OTHER_OP,
        F8_OP_B,
        F8_LOOKUP_OTHER_EMAIL,
      ],
    );
  });

  afterAll(async () => {
    const pool = await getPool();
    await pool.query('DELETE FROM dashboard_users WHERE operator_id = ANY($1)', [[F8_OP_A, F8_OP_B]]);
    await pool.query('DELETE FROM operators WHERE id = ANY($1)', [[F8_OP_A, F8_OP_B]]);
    await closePool();
  });

  describe('enableDashboardUser', () => {
    it('リンク済み無効行を有効化し disabled_at を NULL・行を返して再ログイン可能に戻す（Req 1.1, 1.2）', async () => {
      const pool = await getPool();
      const res = await enableDashboardUser(pool, F8_DU_DISABLED_LINKED, F8_OP_A);
      expect(res).not.toBeNull();
      expect(res?.id).toBe(F8_DU_DISABLED_LINKED);
      expect(res?.operatorId).toBe(F8_OP_A);
      expect(res?.disabled).toBe(false);

      // disabled_at が実際に NULL へ戻ったこと。
      const check = await pool.query<{ disabled_at: Date | null }>(
        'SELECT disabled_at FROM dashboard_users WHERE id = $1',
        [F8_DU_DISABLED_LINKED],
      );
      expect(check.rows[0]?.disabled_at).toBeNull();

      // 従前のロール・所属のまま findByAuthSubject が有効判定に戻る（再ログイン可能・1.2）。
      const resolved = await findByAuthSubject(pool, SUB_F8_DISABLED_LINKED);
      expect(resolved?.id).toBe(F8_DU_DISABLED_LINKED);
      expect(resolved?.role).toBe('operator');
      expect(resolved?.disabled).toBe(false);
    });

    it('保留無効行: 有効化前はリンク不可・有効化後に初回ログイン紐付けが再開できる（Req 1.3）', async () => {
      const pool = await getPool();
      // 無効なうちは linkAuthSubjectByEmail の対象外（disabled_at IS NULL 条件を満たさない）。
      const beforeLink = await linkAuthSubjectByEmail(pool, F8_PENDING_DISABLED_EMAIL, 'uid-f8-pre');
      expect(beforeLink).toBeNull();

      // 有効化（disabled_at を NULL に戻す）。
      const enabled = await enableDashboardUser(pool, F8_DU_PENDING_DISABLED, F8_OP_A);
      expect(enabled?.id).toBe(F8_DU_PENDING_DISABLED);
      expect(enabled?.disabled).toBe(false);

      // 有効化後は初回ログイン紐付けが再び可能（linkAuthSubjectByEmail は無変更）。
      const afterLink = await linkAuthSubjectByEmail(pool, F8_PENDING_DISABLED_EMAIL, 'uid-f8-relink');
      expect(afterLink?.id).toBe(F8_DU_PENDING_DISABLED);
    });

    it('既に有効な行の有効化は状態を変えず冪等に行を返す（Req 1.4）', async () => {
      const pool = await getPool();
      const res = await enableDashboardUser(pool, F8_DU_ENABLED_LINKED, F8_OP_A);
      expect(res).not.toBeNull();
      expect(res?.id).toBe(F8_DU_ENABLED_LINKED);
      expect(res?.disabled).toBe(false);
    });

    it('範囲外（他 operator）・不在の id は同一の null（越権秘匿・Req 1.5, 4.1）', async () => {
      const pool = await getPool();
      // 他 operator 配下の id を自 operator スコープで有効化 → null。
      expect(await enableDashboardUser(pool, F8_DU_OTHER_OP, F8_OP_A)).toBeNull();
      // 不在 id → null。
      expect(
        await enableDashboardUser(pool, 'f8000000-0000-0000-0000-d0000000ffff', F8_OP_A),
      ).toBeNull();
    });
  });

  describe('findDashboardUserByEmailInOperator', () => {
    it('自運営の無効化済みメールは { disabled: true } を返す（Req 3.2）', async () => {
      const pool = await getPool();
      const res = await findDashboardUserByEmailInOperator(pool, F8_LOOKUP_DISABLED_EMAIL, F8_OP_A);
      expect(res).not.toBeNull();
      expect(res?.id).toBe(F8_LOOKUP_DISABLED);
      expect(res?.disabled).toBe(true);
    });

    it('自運営の有効メールは { disabled: false } を返す・lower(email) で照合する（Req 3.2）', async () => {
      const pool = await getPool();
      // 格納は 'F8Lookup-Enabled@Example.COM'、正規化済み小文字で照合できる。
      const res = await findDashboardUserByEmailInOperator(
        pool,
        F8_LOOKUP_ENABLED_EMAIL_NORMALIZED,
        F8_OP_A,
      );
      expect(res?.id).toBe(F8_LOOKUP_ENABLED);
      expect(res?.disabled).toBe(false);
    });

    it('他運営配下のみに存在するメールは自運営スコープでは null（越境秘匿・Req 3.2, 4.1）', async () => {
      const pool = await getPool();
      // OP_A スコープでは存在を漏らさない（null）。
      expect(await findDashboardUserByEmailInOperator(pool, F8_LOOKUP_OTHER_EMAIL, F8_OP_A)).toBeNull();
      // 正しいスコープ（OP_B）では見つかることで、上の null が越境秘匿であることを担保する。
      const inScope = await findDashboardUserByEmailInOperator(pool, F8_LOOKUP_OTHER_EMAIL, F8_OP_B);
      expect(inScope?.id).toBe(F8_LOOKUP_OTHER_OP);
      expect(inScope?.disabled).toBe(false);
    });

    it('該当メールが無い場合は null', async () => {
      const pool = await getPool();
      expect(
        await findDashboardUserByEmailInOperator(pool, 'f8-no-such@example.com', F8_OP_A),
      ).toBeNull();
    });
  });
});

// 保護付き無効化（disableDashboardUserGuarded）専用フィクスチャ。
// operator は 9001（複数運営テナント）/ 9002（単独運営テナント）、利用者は e0000000XXXX 帯で
// 上の lifecycle ブロック（a1/b2・d0000000000X）と非干渉。
const F8G_OP_MULTI = 'f8000000-0000-0000-0000-000000009001'; // 有効運営2名のテナント
const F8G_OP_SINGLE = 'f8000000-0000-0000-0000-000000009002'; // 有効運営1名のテナント
const F8G_AG = 'f8000000-0000-0000-0000-000000009a01'; // F8G_OP_MULTI 配下の代理店

const F8G_OP1 = 'f8000000-0000-0000-0000-e00000000001'; // operator・リンク済み・有効
const F8G_OP2_PENDING = 'f8000000-0000-0000-0000-e00000000002'; // operator・保留(未ログイン)・有効
const F8G_PREDISABLED = 'f8000000-0000-0000-0000-e00000000003'; // operator・無効（冪等検証用）
const F8G_AGENCY_USER = 'f8000000-0000-0000-0000-e00000000004'; // agency・有効
const F8G_SOLO_OP = 'f8000000-0000-0000-0000-e00000000005'; // operator・単独テナント・有効
const F8G_MISSING = 'f8000000-0000-0000-0000-e0000000ffff';

describe.skipIf(!process.env.DATABASE_URL)('disableDashboardUserGuarded (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2), ($3, $4)', [
      F8G_OP_MULTI,
      'f8g複数運営',
      F8G_OP_SINGLE,
      'f8g単独運営',
    ]);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      F8G_AG,
      F8G_OP_MULTI,
      'f8g代理店',
    ]);
    // 複数運営テナント: リンク済み有効 operator + 保留(未ログイン)有効 operator + 無効 operator + 有効 agency。
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject, email, disabled_at)
       VALUES ($1, 'operator', $2, NULL,  $3,   NULL, NULL),
              ($4, 'operator', $2, NULL,  NULL, $5,   NULL),
              ($6, 'operator', $2, NULL,  $7,   NULL, now()),
              ($8, 'agency',   $2, $9,    $10,  NULL, NULL)`,
      [
        F8G_OP1,
        F8G_OP_MULTI,
        'authsub-f8g-op1',
        F8G_OP2_PENDING,
        'f8g-pending-op@example.com',
        F8G_PREDISABLED,
        'authsub-f8g-predisabled',
        F8G_AGENCY_USER,
        F8G_AG,
        'authsub-f8g-agency',
      ],
    );
    // 単独運営テナント: 有効 operator 1名のみ。
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject)
       VALUES ($1, 'operator', $2, NULL, $3)`,
      [F8G_SOLO_OP, F8G_OP_SINGLE, 'authsub-f8g-solo'],
    );
  });

  afterAll(async () => {
    const pool = await getPool();
    await pool.query('DELETE FROM dashboard_users WHERE operator_id = ANY($1)', [
      [F8G_OP_MULTI, F8G_OP_SINGLE],
    ]);
    await pool.query('DELETE FROM agencies WHERE id = $1', [F8G_AG]);
    await pool.query('DELETE FROM operators WHERE id = ANY($1)', [[F8G_OP_MULTI, F8G_OP_SINGLE]]);
    await closePool();
  });

  it('有効運営が2名以上なら運営を無効化できる・保留運営も有効として計上（Req 2.4）', async () => {
    const pool = await getPool();
    // F8G_OP1 を無効化。相方 F8G_OP2_PENDING は未ログインだが disabled_at IS NULL のため有効に計上され、
    // 無効化後も有効運営が1名残るため許可される。
    const res = await disableDashboardUserGuarded(pool, F8G_OP1, F8G_OP_MULTI);
    expect(res.kind).toBe('disabled');
    if (res.kind === 'disabled') {
      expect(res.user.id).toBe(F8G_OP1);
      expect(res.user.disabled).toBe(true);
    }
    const check = await pool.query<{ disabled_at: Date | null }>(
      'SELECT disabled_at FROM dashboard_users WHERE id = $1',
      [F8G_OP1],
    );
    expect(check.rows[0]?.disabled_at).not.toBeNull();
  });

  it('有効運営が1名のみならその運営は last_operator で拒否され、行は無効化されない（Req 2.3）', async () => {
    const pool = await getPool();
    const res = await disableDashboardUserGuarded(pool, F8G_SOLO_OP, F8G_OP_SINGLE);
    expect(res.kind).toBe('last_operator');
    // 行は有効なまま（ロックアウトを防止）。
    const check = await pool.query<{ disabled_at: Date | null }>(
      'SELECT disabled_at FROM dashboard_users WHERE id = $1',
      [F8G_SOLO_OP],
    );
    expect(check.rows[0]?.disabled_at).toBeNull();
  });

  it('代理店ロールは運営数に関わらず常に無効化できる（Req 2.4）', async () => {
    const pool = await getPool();
    const res = await disableDashboardUserGuarded(pool, F8G_AGENCY_USER, F8G_OP_MULTI);
    expect(res.kind).toBe('disabled');
    if (res.kind === 'disabled') {
      expect(res.user.id).toBe(F8G_AGENCY_USER);
      expect(res.user.disabled).toBe(true);
    }
  });

  it('範囲外（他 operator スコープ）・不在は not_found（越権秘匿・Req 4.1）', async () => {
    const pool = await getPool();
    // 単独テナントの id を複数テナントのスコープで無効化 → not_found（かつ無効化されない）。
    const wrong = await disableDashboardUserGuarded(pool, F8G_SOLO_OP, F8G_OP_MULTI);
    expect(wrong.kind).toBe('not_found');
    const stillActive = await pool.query<{ disabled_at: Date | null }>(
      'SELECT disabled_at FROM dashboard_users WHERE id = $1',
      [F8G_SOLO_OP],
    );
    expect(stillActive.rows[0]?.disabled_at).toBeNull();
    // 不在 id → not_found。
    expect((await disableDashboardUserGuarded(pool, F8G_MISSING, F8G_OP_MULTI)).kind).toBe(
      'not_found',
    );
  });

  it('既に無効な対象は disabled を冪等に返す（再スタンプしない）', async () => {
    const pool = await getPool();
    const before = await pool.query<{ disabled_at: Date }>(
      'SELECT disabled_at FROM dashboard_users WHERE id = $1',
      [F8G_PREDISABLED],
    );
    const res = await disableDashboardUserGuarded(pool, F8G_PREDISABLED, F8G_OP_MULTI);
    expect(res.kind).toBe('disabled');
    if (res.kind === 'disabled') expect(res.user.disabled).toBe(true);
    // disabled_at は据え置き（再スタンプなし）。
    const after = await pool.query<{ disabled_at: Date }>(
      'SELECT disabled_at FROM dashboard_users WHERE id = $1',
      [F8G_PREDISABLED],
    );
    expect(after.rows[0]?.disabled_at.getTime()).toBe(before.rows[0]?.disabled_at.getTime());
  });
});

// 並行安全性（Req 2.5・write-skew の決定的検証）。
// design「並行ガードの正当性」の直列化機構を、テナント advisory ロックを別接続で保持して
// トランザクション制御で決定的に検証する。タイミング依存（Promise.all）ではなく、
// 「先行操作がロック保持中はガードがブロックし、解放後に最新状態を観測して0人化を防ぐ」ことを
// 100% 再現する。ガードから advisory ロックを外すと本テストは必ず失敗する（非空虚性の担保）。
const F8C_OP = 'f8000000-0000-0000-0000-000000009003'; // 有効運営ちょうど2名のテナント
const F8C_OP1 = 'f8000000-0000-0000-0000-e10000000001';
const F8C_OP2 = 'f8000000-0000-0000-0000-e10000000002';
// disableDashboardUserGuarded と同一の advisory ロッククラス（src の DISABLE_LOCK_CLASS と一致させる）。
const DISABLE_LOCK_CLASS = 0x64756c31;

describe.skipIf(!process.env.DATABASE_URL)('disableDashboardUserGuarded 並行安全性 (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [F8C_OP, 'f8c並行運営']);
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject)
       VALUES ($1, 'operator', $3, NULL, $4), ($2, 'operator', $3, NULL, $5)`,
      [F8C_OP1, F8C_OP2, F8C_OP, 'authsub-f8c-op1', 'authsub-f8c-op2'],
    );
  });

  afterAll(async () => {
    const pool = await getPool();
    await pool.query('DELETE FROM dashboard_users WHERE operator_id = $1', [F8C_OP]);
    await pool.query('DELETE FROM operators WHERE id = $1', [F8C_OP]);
    await closePool();
  });

  it('先行無効化がロック保持中はガードがブロックし、解放後 last_operator で0人化を防ぐ（Req 2.5・決定的）', async () => {
    const pool = await getPool();
    const holder = await pool.connect();
    let holderCommitted = false;
    try {
      // 「先行する無効化操作」を模す: テナント advisory ロックを取得し op2 を無効化して未コミットで保持。
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::int4, hashtext($2)::int4)', [
        DISABLE_LOCK_CLASS,
        F8C_OP,
      ]);
      await holder.query('UPDATE dashboard_users SET disabled_at = now() WHERE id = $1', [F8C_OP2]);

      // 「後続の無効化操作」= 本物のガード。同じテナントロックを取りに行きブロックする。
      let settled = false;
      const guard = disableDashboardUserGuarded(pool, F8C_OP1, F8C_OP).then((r) => {
        settled = true;
        return r;
      });

      // 有界待機の間、ガードはロック待ちで解決しない（＝直列化機構が働いている決定的証拠）。
      // advisory ロックを外した実装ではここでガードが先行し settled=true になり本アサートが失敗する。
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);

      // 先行操作を確定（op2 無効化を commit・ロック解放）。
      await holder.query('COMMIT');
      holderCommitted = true;

      // ガードが処理を進める。op2 は無効化済みのため有効運営は op1 のみ＝op1 は最後の運営 → last_operator。
      // 直列化が無ければガードは op2 無効化を観測できず（未コミット）op1 を無効化し 0 人化する。
      const result = await guard;
      expect(result.kind).toBe('last_operator');
    } finally {
      if (!holderCommitted) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    // 0人化していない: op1 は有効のまま・有効運営は1名（op1）残る（ロックアウト不能性）。
    const op1 = await pool.query<{ disabled_at: Date | null }>(
      'SELECT disabled_at FROM dashboard_users WHERE id = $1',
      [F8C_OP1],
    );
    expect(op1.rows[0]?.disabled_at).toBeNull();
    const active = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM dashboard_users
        WHERE operator_id = $1 AND role = 'operator' AND disabled_at IS NULL`,
      [F8C_OP],
    );
    expect(active.rows[0]?.n).toBe(1);
  });
});
