import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import QRCode from 'qrcode';
import {
  getPool,
  closePool,
  findByAuthSubject,
  findStoreWithAgency,
  linkAuthSubjectByEmail,
  listStoresWithStatus,
  setStoreCategory,
  listOwnersByAgency,
  findOwnerWithAgency,
  listCategories,
  listAgencies,
  createAgency,
  findAgencyName,
  listInviteCodes,
  createInviteCode,
  disableInviteCode,
  listDashboardUsers,
  createPendingDashboardUser,
  disableDashboardUserGuarded,
  enableDashboardUser,
  updateDashboardUserGuarded,
  findDashboardUserByEmailInOperator,
  findDashboardUserDisplayName,
  createAuditLog,
} from '@fwlm/db';
import {
  createPlacesSearchAdapter,
  createStoreIdentificationService,
  type ConfirmOutcome,
} from '@fwlm/store-identification';
import { createApp, type AppDeps } from '../src/app.js';
import { loadConfig, type DashboardApiConfig } from '../src/config.js';
import type { VerifiedToken } from '../src/auth.js';
import { generateInviteCode, createUniqueInviteCode } from '../src/invite-code-gen.js';
import type { RegisterStoreInput } from '../src/store-registration.js';

// 実 postgres（ts-test-db）＋実 @fwlm/db で dashboard-api の全ルート配線・認可マトリクス・CORS を
// app.request 経由で検証する（3.1）。firebase-admin のみモック（Bearer 文字列＝uid とみなす）。
// index.ts の実 DI を（verifier だけ差し替えて）忠実に複製し、配線の整合を機械検証する。
// DATABASE_URL 無しは skip。共有 DB のため UUID prefix は f5（f2/f3/f4 は他所で使用済み）。

const OP1 = 'f5000000-0000-0000-0000-000000000001';
const AG1 = 'f5000000-0000-0000-0000-000000000002';
const AG2 = 'f5000000-0000-0000-0000-000000000003';
const OW1 = 'f5000000-0000-0000-0000-000000000004';
const OW2 = 'f5000000-0000-0000-0000-000000000005';
const S1 = 'f5000000-0000-0000-0000-000000000006'; // AG1・confirmed
const S2 = 'f5000000-0000-0000-0000-000000000007'; // AG2・confirmed
const DU_DISABLED = 'f5000000-0000-0000-0000-000000000010'; // OP1 配下・無効化済み（enable 対象）

// --- 4.1 統合検証用の追加フィクスチャ（f5 名前空間・既存 f5 と非交差） ---
const DU_DISABLED_EMAIL = 'f5000000-0000-0000-0000-000000000011'; // OP1 配下・agency(AG1)・無効・email 付き（登録衝突の自運営ケース）
const DU_DISABLED_LOGIN = 'f5000000-0000-0000-0000-000000000012'; // OP1 配下・operator・無効・auth_subject 付き（無効ログイン拒否の回帰）
const OP2 = 'f5000000-0000-0000-0000-0000000000c2'; // 第2運営（越境秘匿の検証用）
const CROSSOP_USER = 'f5000000-0000-0000-0000-0000000000c3'; // OP2 配下・無効・email 付き（越境衝突が汎用 email_conflict になることの検証）

const OP_TOKEN = 'f5-op-uid';
const AG1_TOKEN = 'f5-ag1-uid';
const DU_DISABLED_LOGIN_TOKEN = 'f5-disabled-login-uid'; // 無効化済み運営の Bearer（/me で 403 になる）

// email はグローバル一意（ux_dashboard_users_email）のため f5 接頭辞で他ファイルと非衝突にする
// （他所の db テストは f4/f8 接頭辞の email を使用）。値そのものはテスト意味に非依存。
const DISABLED_EXISTING_EMAIL = 'f5-disabled-existing@example.com'; // 自運営の無効化済み利用者のメール
const CROSSOP_EMAIL = 'f5-crossop@example.com'; // 他運営(OP2)配下の利用者のメール

// 認可前置の 403 を確認するための整形式ダミー UUID（存在しない id・operator ガードで先に弾かれる）。
const DUMMY_UUID = 'f5000000-0000-0000-0000-0000000000ff';

// --- dashboard-user-edit（#259）の統合検証用（f5 の e 帯・既存 f5 と非交差）---
// 行はすべて各テストの中で作り、afterEach（deleteEditFixtures）で片付ける。beforeAll の共有フィクスチャと、
// 「OP_TOKEN の運営が OP1 の唯一の有効な運営である」状態は動かさない（降格の観測で一時的に
// 有効な運営を 2 名にするが、同じ afterEach で元に戻す）。
const EDIT_TARGET = 'f5000000-0000-0000-0000-0000000000e1'; // OP1・agency(AG1)・保留（表示名の更新・所属先の拒否の対象）
const EDIT_OPERATOR_TARGET = 'f5000000-0000-0000-0000-0000000000e2'; // OP1・operator・無効（所属の移動が role_changed になる対象。無効なので有効な運営の数に入らない）
const EDIT_MOVER = 'f5000000-0000-0000-0000-0000000000e3'; // OP1・agency(AG1)・リンク済み・有効（所属の移動が次の要求から効くことの観測）
const EDIT_DEMOTED = 'f5000000-0000-0000-0000-0000000000e4'; // OP1・operator・リンク済み・有効（降格が次の要求から効くことの観測）
const EDIT_OP2_AGENCY = 'f5000000-0000-0000-0000-0000000000e5'; // OP2 配下の代理店（他運営の代理店の指定）
const EDIT_CROSSOP_TARGET = 'f5000000-0000-0000-0000-0000000000e6'; // OP2・agency(EDIT_OP2_AGENCY)・保留（他運営の利用者）
const EDIT_MISSING_AGENCY = 'f5000000-0000-0000-0000-0000000000ef'; // どこにも作らない代理店 id（不在の代理店の指定）

const EDIT_MOVER_TOKEN = 'f5-edit-mover-uid';
const EDIT_DEMOTED_TOKEN = 'f5-edit-demoted-uid';

let config: DashboardApiConfig;

function buildApp(): ReturnType<typeof createApp> {
  // firebase-admin を隔離した TokenVerifier のモック（Bearer 文字列をそのまま uid とみなす）。
  const authDeps = {
    verifier: {
      verifyIdToken: (t: string): Promise<VerifiedToken> =>
        Promise.resolve({ uid: t, email: null, emailVerified: false, signInProvider: null }),
    },
    findUser: async (uid: string) => findByAuthSubject(await getPool(), uid),
    linkByEmail: async (email: string, uid: string) =>
      linkAuthSubjectByEmail(await getPool(), email, uid),
  };

  const places = createPlacesSearchAdapter({ apiKey: config.placesApiKey, fetch });
  const service = createStoreIdentificationService({
    pool: { connect: async () => (await getPool()).connect() },
    places,
  });

  const registerStore = async (input: RegisterStoreInput): Promise<ConfirmOutcome> => {
    const outcome = await service.confirmStore(input.ownerId, input.candidate);
    if (outcome.kind === 'confirmed' && input.categoryCode !== null) {
      await setStoreCategory(await getPool(), outcome.storeId, input.categoryCode);
    }
    return outcome;
  };

  const issueCode = (agencyId: string) =>
    createUniqueInviteCode({
      generate: generateInviteCode,
      create: async (code: string) => createInviteCode(await getPool(), { agencyId, code }),
    });

  const deps: AppDeps = {
    corsOrigin: config.corsOrigin,
    qr: {
      auth: authDeps,
      findStore: async (id) => findStoreWithAgency(await getPool(), id),
      renderQr: (text, size) => QRCode.toBuffer(text, { width: size }),
      surveyBaseUrl: config.surveyBaseUrl,
    },
    me: {
      auth: authDeps,
      findAgencyName: async (agencyId) => findAgencyName(await getPool(), agencyId),
      findDisplayName: async (userId) => findDashboardUserDisplayName(await getPool(), userId),
    },
    stores: {
      auth: authDeps,
      listStores: async (filter) => listStoresWithStatus(await getPool(), filter),
    },
    owners: {
      auth: authDeps,
      listOwners: async (agencyId) => listOwnersByAgency(await getPool(), agencyId),
    },
    categories: { auth: authDeps, listCategories: async () => listCategories(await getPool()) },
    storeRegistration: {
      search: { auth: authDeps, searchCandidates: (query) => service.searchCandidates(query) },
      register: {
        auth: authDeps,
        findOwner: async (ownerId) => findOwnerWithAgency(await getPool(), ownerId),
        isValidCategory: async (code) =>
          (await listCategories(await getPool())).some((cat) => cat.code === code),
        registerStore,
      },
    },
    inviteCodes: {
      list: {
        auth: authDeps,
        listInviteCodes: async (agencyId) => listInviteCodes(await getPool(), agencyId),
      },
      issue: { auth: authDeps, issueCode },
      disable: {
        auth: authDeps,
        disableCode: async (id, agencyId) => disableInviteCode(await getPool(), id, agencyId),
      },
    },
    admin: {
      agenciesList: {
        auth: authDeps,
        listAgencies: async (operatorId) => listAgencies(await getPool(), operatorId),
      },
      agencyCreate: {
        auth: authDeps,
        createAgency: async (input) => createAgency(await getPool(), input),
      },
      usersList: {
        auth: authDeps,
        listUsers: async (operatorId) => listDashboardUsers(await getPool(), operatorId),
      },
      userCreate: {
        auth: authDeps,
        createUser: async (input) => createPendingDashboardUser(await getPool(), input),
        findUserByEmailInOperator: async (operatorId, email) =>
          findDashboardUserByEmailInOperator(await getPool(), email, operatorId),
      },
      userDisable: {
        auth: authDeps,
        disableUser: async (id, operatorId) =>
          disableDashboardUserGuarded(await getPool(), id, operatorId),
      },
      userEnable: {
        auth: authDeps,
        enableUser: async (id, operatorId) => enableDashboardUser(await getPool(), id, operatorId),
      },
      userUpdate: {
        auth: authDeps,
        updateUser: async (id, operatorId, input) =>
          updateDashboardUserGuarded(await getPool(), id, operatorId, input),
        // 監査は実物を配線する。モックでは 0009 の CHECK が新しい action を受け付けるかを観測できない。
        auditLog: async (input) => createAuditLog(await getPool(), input),
      },
    },
  };
  return createApp(deps);
}

function h(bearer?: string, origin?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (bearer !== undefined) headers['Authorization'] = `Bearer ${bearer}`;
  if (origin !== undefined) headers['Origin'] = origin;
  return headers;
}

interface StoreRow {
  id: string;
  agencyId: string;
}
async function storesOf(res: Response): Promise<StoreRow[]> {
  const body = (await res.json()) as { stores: StoreRow[] };
  return body.stores;
}

// --- dashboard-user-edit の統合検証で使う DB 観測ヘルパ（f5 の e 帯の行と、既存の行の不変を見る）---

async function postUpdate(
  app: ReturnType<typeof createApp>,
  bearer: string,
  id: string,
  body: unknown,
): Promise<Response> {
  return await app.request(`/dashboard-users/${id}/update`, {
    method: 'POST',
    headers: { ...h(bearer), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface UserJsonObs {
  id: string;
  role: string;
  agencyId: string | null;
  displayName: string | null;
  disabled: boolean;
}

interface UserRowObs {
  role: string;
  agency_id: string | null;
  display_name: string | null;
  email: string | null;
  auth_subject: string | null;
  disabled: boolean;
}

// 更新が触れてよい列（role・agency_id・display_name）と、触れてはならない列（email・auth_subject・
// 無効化の状態）をまとめて読む。拒否のテストは、この形の前後一致で「行が変わらない」を確かめる。
async function userRow(id: string): Promise<UserRowObs | null> {
  const res = await (
    await getPool()
  ).query<UserRowObs>(
    `SELECT role, agency_id, display_name, email, auth_subject, disabled_at IS NOT NULL AS disabled
       FROM dashboard_users WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

interface AuditRowObs {
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string;
}

// 対象の利用者を指す監査行を発生順に返す。更新の前後で取り、増えた分（末尾）だけを比べる。
async function auditRowsFor(targetId: string): Promise<AuditRowObs[]> {
  const res = await (
    await getPool()
  ).query<AuditRowObs>(
    `SELECT actor_type, actor_id, action, target_type
       FROM audit_logs
      WHERE target_id = $1
      ORDER BY occurred_at, id`,
    [targetId],
  );
  return res.rows;
}

// 行為者（OP_TOKEN の運営）の dashboard_user id。監査行の行為者と、自分のロール変更の対象に使う。
async function operatorSelfId(): Promise<string> {
  const res = await (
    await getPool()
  ).query<{ id: string }>('SELECT id FROM dashboard_users WHERE auth_subject = $1', [OP_TOKEN]);
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error('OP_TOKEN の運営が見つかりません（beforeAll のフィクスチャ）');
  return id;
}

// OP1 の有効な運営（無効化されていない運営・保留中を含む）の数。降格の観測の前後で前提を確かめる。
async function activeOperatorCount(operatorId: string): Promise<number> {
  const res = await (
    await getPool()
  ).query<{ n: number }>(
    `SELECT count(*)::int AS n FROM dashboard_users
      WHERE operator_id = $1 AND role = 'operator' AND disabled_at IS NULL`,
    [operatorId],
  );
  return res.rows[0]?.n ?? 0;
}

// テストの中で作った e 帯の行を片付ける（dashboard_users を参照する FK は無い）。
async function deleteEditFixtures(): Promise<void> {
  const pool = await getPool();
  await pool.query('DELETE FROM dashboard_users WHERE id = ANY($1::uuid[])', [
    [EDIT_TARGET, EDIT_OPERATOR_TARGET, EDIT_MOVER, EDIT_DEMOTED, EDIT_CROSSOP_TARGET],
  ]);
  await pool.query('DELETE FROM agencies WHERE id = $1', [EDIT_OP2_AGENCY]);
}

// OP1・AG1 所属の保留中の代理店利用者（email のみ・auth_subject なし）を作る。
async function insertPendingAgencyUser(id: string, email: string, displayName: string): Promise<void> {
  await (
    await getPool()
  ).query(
    `INSERT INTO dashboard_users (id, role, operator_id, agency_id, email, display_name)
     VALUES ($1, 'agency', $2, $3, $4, $5)`,
    [id, OP1, AG1, email, displayName],
  );
}

// OP2 配下の代理店を作る（他運営の代理店の指定に使う）。
async function insertOp2Agency(): Promise<void> {
  await (
    await getPool()
  ).query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
    EDIT_OP2_AGENCY,
    OP2,
    '第2運営の代理店',
  ]);
}

describe.skipIf(!process.env.DATABASE_URL)('dashboard-api routes integration (DB)', () => {
  beforeAll(async () => {
    config = loadConfig({
      SURVEY_BASE_URL: 'https://survey.example',
      DASHBOARD_WEB_ORIGIN: 'https://dash.example',
      PLACES_API_KEY: 'test-places-key',
    });
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP1, 'ルート運営']);
    await pool.query(
      'INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3), ($4, $2, $5)',
      [AG1, OP1, 'ルート代理店1', AG2, 'ルート代理店2'],
    );
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
       VALUES ($1, $2, $3, 'active'), ($4, $5, $6, 'active')`,
      [OW1, AG1, 'U-routes-1', OW2, AG2, 'U-routes-2'],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES
        ($1, $2, '店1', 'ChIJ-f5-1', 'confirmed'),
        ($3, $4, '店2', 'ChIJ-f5-2', 'confirmed')`,
      [S1, OW1, S2, OW2],
    );
    await pool.query(
      `INSERT INTO dashboard_users (role, operator_id, agency_id, auth_subject, display_name) VALUES
        ('operator', $1, NULL, $2, '運営スタッフ'),
        ('agency', $1, $3, $4, '代理店スタッフ')`,
      [OP1, OP_TOKEN, AG1, AG1_TOKEN],
    );
    // enable ルートの operator-200 検証用: OP1 配下の無効化済み利用者。
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject, display_name, disabled_at)
       VALUES ($1, 'agency', $2, $3, 'f5-disabled-uid', '無効スタッフ', now())`,
      [DU_DISABLED, OP1, AG1],
    );

    // --- 4.1 統合検証用フィクスチャ ---
    // (a) 登録衝突の自運営ケース: OP1 配下・無効化済み・email 付きの利用者。自運営スコープの
    //     findDashboardUserByEmailInOperator が無効行を見つけ email_conflict_disabled を出す前提。
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, email, display_name, disabled_at)
       VALUES ($1, 'agency', $2, $3, $4, '無効・email付き', now())`,
      [DU_DISABLED_EMAIL, OP1, AG1, DISABLED_EXISTING_EMAIL],
    );
    // (b) 越境秘匿ケース: 第2運営 OP2 と、その配下に同一 email 検証用の無効化済み利用者を seed。
    //     OP1 からの同一メール登録は operator_id スコープで null となり汎用 email_conflict に留まる
    //     （他運営の存在・無効状態を漏らさない）。無効行にすることで秘匿の実証が一段強くなる。
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP2, '第2運営']);
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, email, display_name, disabled_at)
       VALUES ($1, 'operator', $2, NULL, $3, '越境ユーザー', now())`,
      [CROSSOP_USER, OP2, CROSSOP_EMAIL],
    );
    // (c) 無効ログイン拒否の回帰: auth_subject 付き・無効化済みの運営（OP1 配下）。この Bearer で
    //     /me は 403（findByAuthSubject が disabled → 403）。無効ゆえ OP1 の有効運営数には計上されず、
    //     OP_TOKEN の運営が唯一の有効運営である状態を崩さない。
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject, display_name, disabled_at)
       VALUES ($1, 'operator', $2, NULL, $3, '無効ログイン運営', now())`,
      [DU_DISABLED_LOGIN, OP1, DU_DISABLED_LOGIN_TOKEN],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('認証なしの全業務ルートは 401（health を除く）', async () => {
    const app = buildApp();
    const cases: [string, RequestInit][] = [
      ['/me', { method: 'GET' }],
      ['/stores', { method: 'GET' }],
      [`/owners?agencyId=${AG1}`, { method: 'GET' }],
      ['/categories', { method: 'GET' }],
      [`/invite-codes?agencyId=${AG1}`, { method: 'GET' }],
      ['/agencies', { method: 'GET' }],
      ['/dashboard-users', { method: 'GET' }],
      ['/stores/search', { method: 'POST', body: JSON.stringify({ query: 'x' }) }],
      ['/stores', { method: 'POST', body: JSON.stringify({}) }],
      ['/invite-codes', { method: 'POST', body: JSON.stringify({ agencyId: AG1 }) }],
      ['/agencies', { method: 'POST', body: JSON.stringify({ name: 'x' }) }],
      ['/dashboard-users', { method: 'POST', body: JSON.stringify({}) }],
      [`/invite-codes/${DUMMY_UUID}/disable`, { method: 'POST' }],
      [`/dashboard-users/${DUMMY_UUID}/disable`, { method: 'POST' }],
      [`/dashboard-users/${DUMMY_UUID}/enable`, { method: 'POST' }],
      [
        `/dashboard-users/${DUMMY_UUID}/update`,
        { method: 'POST', body: JSON.stringify({ displayName: 'x' }) },
      ],
    ];
    for (const [path, init] of cases) {
      const res = await app.request(path, init);
      expect(res.status, `${init.method} ${path}`).toBe(401);
    }
  });

  it('health は認証不要で 200', async () => {
    const res = await buildApp().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('agency ロールは管理 API 全てで 403（Req 6.5）', async () => {
    const app = buildApp();
    const cases: [string, RequestInit][] = [
      ['/agencies', { method: 'GET', headers: h(AG1_TOKEN) }],
      ['/agencies', { method: 'POST', headers: h(AG1_TOKEN), body: JSON.stringify({ name: 'x' }) }],
      ['/dashboard-users', { method: 'GET', headers: h(AG1_TOKEN) }],
      [
        '/dashboard-users',
        {
          method: 'POST',
          headers: h(AG1_TOKEN),
          body: JSON.stringify({ role: 'agency', agencyId: AG1, email: 'a@b.com' }),
        },
      ],
      [`/dashboard-users/${DUMMY_UUID}/disable`, { method: 'POST', headers: h(AG1_TOKEN) }],
      [`/dashboard-users/${DUMMY_UUID}/enable`, { method: 'POST', headers: h(AG1_TOKEN) }],
      [
        `/dashboard-users/${DUMMY_UUID}/update`,
        {
          method: 'POST',
          headers: h(AG1_TOKEN),
          body: JSON.stringify({ role: 'operator', displayName: 'x' }),
        },
      ],
    ];
    for (const [path, init] of cases) {
      const res = await app.request(path, init);
      expect(res.status, `${init.method} ${path}`).toBe(403);
    }
  });

  it('operator ロールは管理 API と全店一覧を 200 で取得', async () => {
    const app = buildApp();
    expect((await app.request('/agencies', { headers: h(OP_TOKEN) })).status).toBe(200);
    expect((await app.request('/dashboard-users', { headers: h(OP_TOKEN) })).status).toBe(200);

    const res = await app.request('/stores', { headers: h(OP_TOKEN) });
    expect(res.status).toBe(200);
    const stores = await storesOf(res);
    // 全代理店が見える（S1=AG1・S2=AG2 の双方が含まれる）。
    expect(stores.some((s) => s.id === S1)).toBe(true);
    expect(stores.some((s) => s.id === S2)).toBe(true);
  });

  it('operator の POST /dashboard-users/:id/enable は無効化済み利用者を 200 で再有効化する（Req 1.1, 4.2）', async () => {
    const app = buildApp();
    const res = await app.request(`/dashboard-users/${DU_DISABLED}/enable`, {
      method: 'POST',
      headers: h(OP_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; disabled: boolean } };
    expect(body.user.id).toBe(DU_DISABLED);
    expect(body.user.disabled).toBe(false);
    // DB でも有効化されている。
    const check = await (
      await getPool()
    ).query<{ disabled_at: Date | null }>('SELECT disabled_at FROM dashboard_users WHERE id = $1', [
      DU_DISABLED,
    ]);
    expect(check.rows[0]?.disabled_at).toBeNull();
  });

  it('GET /me は運営自身の id を返す（Req 2.2 の前提・自己行識別）', async () => {
    const app = buildApp();
    const res = await app.request('/me', { headers: h(OP_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    // UI が「自分の行」を識別するため /me が id を返す（自己無効化ボタン非表示の前提）。
    expect(typeof body.user.id).toBe('string');
    expect(body.user.id.length).toBeGreaterThan(0);
  });

  it('operator の自己無効化は 409 self_disable_forbidden で対象状態を変えない（Req 2.1）', async () => {
    const app = buildApp();
    // まず /me（OP_TOKEN）で運営自身の dashboard_user id を取得する（実配線での自己識別）。
    const meRes = await app.request('/me', { headers: h(OP_TOKEN) });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { user: { id: string } };
    const selfId = me.user.id;
    expect(selfId.length).toBeGreaterThan(0);

    // 自分自身の id で無効化 → DB 到達前のハンドラガードで 409 self_disable_forbidden。
    const res = await app.request(`/dashboard-users/${selfId}/disable`, {
      method: 'POST',
      headers: h(OP_TOKEN),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('self_disable_forbidden');

    // DB でも当該運営行は無効化されていない（disabled_at NULL のまま・Req 2.6）。
    const check = await (
      await getPool()
    ).query<{ disabled_at: Date | null }>('SELECT disabled_at FROM dashboard_users WHERE id = $1', [
      selfId,
    ]);
    expect(check.rows[0]?.disabled_at).toBeNull();
  });

  // last_operator（Req 2.3）はシーケンシャルな API 経路では自己無効化ガードにマスクされ到達不能
  // （呼び出し運営は常に active operator として計上され、他者を無効化しても自分が残るため0人化せず、
  //  自己無効化＝self_disable_forbidden が先に発火）。よって last_operator はハンドラ単体（admin.test）＋
  //  DAL 並行（1.2/1.3）で検証済みであり、本統合テストでは扱わない。

  it('登録: 自運営の無効化済みメール衝突は 409 email_conflict_disabled（Req 3.2・DI 引数順の回帰捕捉）', async () => {
    const app = buildApp();
    const res = await app.request('/dashboard-users', {
      method: 'POST',
      headers: h(OP_TOKEN),
      body: JSON.stringify({ role: 'agency', agencyId: AG1, email: DISABLED_EXISTING_EMAIL }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    // 自運営スコープの findDashboardUserByEmailInOperator が無効行を検出し復旧を案内する。
    // index.ts / buildApp の DI 引数順（email↔operatorId）が転置すると自運営でも null 化し、
    // 汎用 email_conflict へ化ける（あるいは uuid 型不一致で 500）。本アサートがそれを決定的に捕捉する。
    expect(body.error.code).toBe('email_conflict_disabled');
  });

  it('登録: 越境（他運営）メール衝突は汎用 409 email_conflict で存在を秘匿（Req 4.4）', async () => {
    const app = buildApp();
    const res = await app.request('/dashboard-users', {
      method: 'POST',
      headers: h(OP_TOKEN),
      body: JSON.stringify({ role: 'agency', agencyId: AG1, email: CROSSOP_EMAIL }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    // OP2 配下の無効化済み利用者は operator_id スコープで見えず、汎用コードのまま
    // （他運営の存在・無効状態を漏らさない）。email_conflict_disabled にはならない。
    expect(body.error.code).toBe('email_conflict');
  });

  it('回帰: 無効化中の利用者は /me で 403 forbidden（Req 3.3・findByAuthSubject の disabled）', async () => {
    const app = buildApp();
    const res = await app.request('/me', { headers: h(DU_DISABLED_LOGIN_TOKEN) });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    // 存在有無を漏らさない同一封筒（未登録・無効化済みとも forbidden）。
    expect(body.error.code).toBe('forbidden');
  });

  it('agency ロールの GET /stores は自代理店のみ・他代理店指定は 403', async () => {
    const app = buildApp();
    const res = await app.request('/stores', { headers: h(AG1_TOKEN) });
    expect(res.status).toBe(200);
    const stores = await storesOf(res);
    // 自代理店(AG1)の店舗のみ。他代理店(AG2)の S2 は一切漏れない。
    expect(stores.length).toBeGreaterThan(0);
    expect(stores.every((s) => s.agencyId === AG1)).toBe(true);
    expect(stores.some((s) => s.id === S1)).toBe(true);
    expect(stores.some((s) => s.id === S2)).toBe(false);

    // 他代理店を明示指定 → 越権として 403（データアクセス前に遮断）。
    const other = await app.request(`/stores?agencyId=${AG2}`, { headers: h(AG1_TOKEN) });
    expect(other.status).toBe(403);
  });

  it('空 ?agencyId= は未指定へ正規化され operator では全件（normalization 実証）', async () => {
    const app = buildApp();
    const res = await app.request('/stores?agencyId=', { headers: h(OP_TOKEN) });
    expect(res.status).toBe(200);
    const stores = await storesOf(res);
    // 正規化されなければ single('') スコープで 0 件になる。S2(AG2) の存在が「全件（all）」を証明する。
    expect(stores.some((s) => s.id === S2)).toBe(true);
  });

  it('CORS: 許可オリジンには ACAO を返し、許可外オリジンには返さない', async () => {
    const app = buildApp();
    const allowed = await app.request('/me', { headers: h(OP_TOKEN, config.corsOrigin) });
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(config.corsOrigin);

    const denied = await app.request('/me', { headers: h(OP_TOKEN, 'https://evil.example') });
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('CORS: OPTIONS プリフライトは 204 で許可メソッド/ヘッダを返す（bonus）', async () => {
    const app = buildApp();
    const res = await app.request('/me', {
      method: 'OPTIONS',
      headers: {
        Origin: config.corsOrigin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(config.corsOrigin);
    const methods = res.headers.get('Access-Control-Allow-Methods') ?? '';
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
  });

  // --- POST /dashboard-users/:id/update（dashboard-user-edit #259）---
  // 実物の認証解決（findByAuthSubject）・保護付き更新（updateDashboardUserGuarded）・監査（createAuditLog）を
  // 通して、ルートの配線と、更新後の権限が次の要求から効くことを観測する。
  describe('POST /dashboard-users/:id/update（dashboard-user-edit）', () => {
    afterEach(async () => {
      await deleteEditFixtures();
    });

    it('運営の更新は 200 で DB に反映され、表示名変更の監査行が 1 行増える（Req 5.1）', async () => {
      const app = buildApp();
      await insertPendingAgencyUser(EDIT_TARGET, 'f5-edit-target@example.com', '編集前');
      const actorId = await operatorSelfId();
      const auditBefore = await auditRowsFor(EDIT_TARGET);

      const res = await postUpdate(app, OP_TOKEN, EDIT_TARGET, { displayName: '  編集後  ' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: UserJsonObs };
      expect(body.user).toMatchObject({
        id: EDIT_TARGET,
        role: 'agency',
        agencyId: AG1,
        displayName: '編集後',
        disabled: false,
      });

      // DB へ反映されている（前後の空白は取り除く）。メール・認証主体・有効／無効は変わらない。
      expect(await userRow(EDIT_TARGET)).toEqual({
        role: 'agency',
        agency_id: AG1,
        display_name: '編集後',
        email: 'f5-edit-target@example.com',
        auth_subject: null,
        disabled: false,
      });

      // 監査行はちょうど 1 行増え、行為者は認証された運営、種類は表示名の変更である（値は残さない）。
      const auditAfter = await auditRowsFor(EDIT_TARGET);
      expect(auditAfter.length - auditBefore.length).toBe(1);
      expect(auditAfter.slice(auditBefore.length)).toEqual([
        {
          actor_type: 'operator',
          actor_id: actorId,
          action: 'dashboard_user_display_name_updated',
          target_type: 'dashboard_user',
        },
      ]);
    });

    it('JSON として壊れた body は 400 validation_failed で行を変えない', async () => {
      const app = buildApp();
      await insertPendingAgencyUser(EDIT_TARGET, 'f5-edit-target@example.com', '編集前');
      const rowBefore = await userRow(EDIT_TARGET);
      const auditBefore = await auditRowsFor(EDIT_TARGET);

      const res = await app.request(`/dashboard-users/${EDIT_TARGET}/update`, {
        method: 'POST',
        headers: { ...h(OP_TOKEN), 'Content-Type': 'application/json' },
        body: '{"displayName":',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('validation_failed');

      expect(await userRow(EDIT_TARGET)).toEqual(rowBefore);
      expect(await auditRowsFor(EDIT_TARGET)).toEqual(auditBefore);
    });

    it('自分のロール変更は 409 self_role_change_forbidden で、同じ保存の表示名も含めて自分の行を変えない（Req 2.1）', async () => {
      const app = buildApp();
      const selfId = await operatorSelfId();
      const rowBefore = await userRow(selfId);
      const auditBefore = await auditRowsFor(selfId);

      const res = await postUpdate(app, OP_TOKEN, selfId, {
        role: 'agency',
        agencyId: AG1,
        displayName: '変更されてはならない',
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('self_role_change_forbidden');

      expect(await userRow(selfId)).toEqual(rowBefore);
      expect(rowBefore).toMatchObject({ role: 'operator', agency_id: null, display_name: '運営スタッフ' });
      expect(await auditRowsFor(selfId)).toEqual(auditBefore);
    });

    it('他運営の利用者は 404 not_found。他運営の代理店を添えても利用者の not_found になる（Req 4.3, 4.5）', async () => {
      const app = buildApp();
      await insertOp2Agency();
      await (
        await getPool()
      ).query(
        `INSERT INTO dashboard_users (id, role, operator_id, agency_id, email, display_name)
         VALUES ($1, 'agency', $2, $3, $4, '他運営の利用者')`,
        [EDIT_CROSSOP_TARGET, OP2, EDIT_OP2_AGENCY, 'f5-edit-crossop@example.com'],
      );
      const rowBefore = await userRow(EDIT_CROSSOP_TARGET);
      const auditBefore = await auditRowsFor(EDIT_CROSSOP_TARGET);

      const onlyName = await postUpdate(app, OP_TOKEN, EDIT_CROSSOP_TARGET, { displayName: '越境' });
      expect(onlyName.status).toBe(404);
      const onlyNameBody = (await onlyName.json()) as { error: { code: string } };
      expect(onlyNameBody.error.code).toBe('not_found');

      // 対象の取得を所属先の確認より先に行うので、代理店の判定結果から利用者の存在は読めない。
      const withAgency = await postUpdate(app, OP_TOKEN, EDIT_CROSSOP_TARGET, {
        agencyId: EDIT_OP2_AGENCY,
        displayName: '越境',
      });
      expect(withAgency.status).toBe(404);
      const withAgencyBody = (await withAgency.json()) as { error: { code: string } };
      expect(withAgencyBody.error.code).toBe('not_found');

      expect(await userRow(EDIT_CROSSOP_TARGET)).toEqual(rowBefore);
      expect(await auditRowsFor(EDIT_CROSSOP_TARGET)).toEqual(auditBefore);
    });

    it('他運営の代理店と不在の代理店は同じ 404 agency_not_found で、表示名も含めて行を変えない（Req 4.4）', async () => {
      const app = buildApp();
      await insertPendingAgencyUser(EDIT_TARGET, 'f5-edit-target@example.com', '編集前');
      await insertOp2Agency();
      const rowBefore = await userRow(EDIT_TARGET);
      const auditBefore = await auditRowsFor(EDIT_TARGET);

      const otherOperator = await postUpdate(app, OP_TOKEN, EDIT_TARGET, {
        agencyId: EDIT_OP2_AGENCY,
        displayName: '変更されてはならない',
      });
      const missing = await postUpdate(app, OP_TOKEN, EDIT_TARGET, {
        agencyId: EDIT_MISSING_AGENCY,
        displayName: '変更されてはならない',
      });
      expect(otherOperator.status).toBe(404);
      expect(missing.status).toBe(404);
      const otherOperatorBody = (await otherOperator.json()) as { error: { code: string } };
      const missingBody = (await missing.json()) as { error: { code: string } };
      expect(otherOperatorBody.error.code).toBe('agency_not_found');
      // 存在しない代理店と他運営の代理店を区別できない同一の応答にする。
      expect(otherOperatorBody).toEqual(missingBody);

      expect(await userRow(EDIT_TARGET)).toEqual(rowBefore);
      expect(await auditRowsFor(EDIT_TARGET)).toEqual(auditBefore);
    });

    it('運営ロールの利用者への所属の移動は 409 role_changed で、同じ保存の表示名も変えない（Req 3.4）', async () => {
      const app = buildApp();
      // 無効化済みの運営にする（有効な運営の数に入らないので、行為者が唯一の有効な運営である状態を崩さない）。
      await (
        await getPool()
      ).query(
        `INSERT INTO dashboard_users (id, role, operator_id, agency_id, email, display_name, disabled_at)
         VALUES ($1, 'operator', $2, NULL, $3, '運営ロールの対象', now())`,
        [EDIT_OPERATOR_TARGET, OP1, 'f5-edit-operator@example.com'],
      );
      const rowBefore = await userRow(EDIT_OPERATOR_TARGET);
      const auditBefore = await auditRowsFor(EDIT_OPERATOR_TARGET);

      const res = await postUpdate(app, OP_TOKEN, EDIT_OPERATOR_TARGET, {
        agencyId: AG1,
        displayName: '変更されてはならない',
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('role_changed');

      // 降格として実行されていない（ロール・所属・表示名のいずれも変わらない）。
      expect(await userRow(EDIT_OPERATOR_TARGET)).toEqual(rowBefore);
      expect(rowBefore).toMatchObject({ role: 'operator', agency_id: null });
      expect(await auditRowsFor(EDIT_OPERATOR_TARGET)).toEqual(auditBefore);
    });

    it('リンク済みの代理店利用者の所属を移すと、次の要求から店舗一覧が新しい代理店の範囲になり、店舗は移らない（Req 1.10, 1.11）', async () => {
      const app = buildApp();
      await (
        await getPool()
      ).query(
        `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject, display_name)
         VALUES ($1, 'agency', $2, $3, $4, '所属を移す代理店スタッフ')`,
        [EDIT_MOVER, OP1, AG1, EDIT_MOVER_TOKEN],
      );

      // 対照: 移す前は元の代理店（AG1）の店舗だけが見える。
      const beforeRes = await app.request('/stores', { headers: h(EDIT_MOVER_TOKEN) });
      expect(beforeRes.status).toBe(200);
      const beforeStores = await storesOf(beforeRes);
      expect(beforeStores.length).toBeGreaterThan(0);
      expect(beforeStores.every((s) => s.agencyId === AG1)).toBe(true);
      expect(beforeStores.some((s) => s.id === S1)).toBe(true);
      expect(beforeStores.some((s) => s.id === S2)).toBe(false);

      const actorId = await operatorSelfId();
      const auditBefore = await auditRowsFor(EDIT_MOVER);
      const res = await postUpdate(app, OP_TOKEN, EDIT_MOVER, { agencyId: AG2 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: UserJsonObs };
      expect(body.user).toMatchObject({ id: EDIT_MOVER, role: 'agency', agencyId: AG2 });

      // 同じトークンの次の要求は、実物の認証解決を経て新しい代理店（AG2）の範囲で返る。
      const afterRes = await app.request('/stores', { headers: h(EDIT_MOVER_TOKEN) });
      expect(afterRes.status).toBe(200);
      const afterStores = await storesOf(afterRes);
      expect(afterStores.length).toBeGreaterThan(0);
      expect(afterStores.every((s) => s.agencyId === AG2)).toBe(true);
      expect(afterStores.some((s) => s.id === S2)).toBe(true);
      expect(afterStores.some((s) => s.id === S1)).toBe(false);

      // 店舗は利用者と一緒に移らない（代理店に属する情報は元の代理店のまま）。
      const pool = await getPool();
      expect((await findStoreWithAgency(pool, S1))?.agencyId).toBe(AG1);
      expect((await findStoreWithAgency(pool, S2))?.agencyId).toBe(AG2);

      const auditAfter = await auditRowsFor(EDIT_MOVER);
      expect(auditAfter.length - auditBefore.length).toBe(1);
      expect(auditAfter.slice(auditBefore.length)).toEqual([
        {
          actor_type: 'operator',
          actor_id: actorId,
          action: 'dashboard_user_agency_updated',
          target_type: 'dashboard_user',
        },
      ]);
    });

    it('有効な運営を降格すると、次の要求から管理 API が 403 になる（降格の前は 200・Req 1.10, 4.2）', async () => {
      const app = buildApp();
      // 前提: 行為者（OP_TOKEN）が OP1 の唯一の有効な運営である（先行テストの片付けの確認を兼ねる）。
      expect(await activeOperatorCount(OP1)).toBe(1);
      await (
        await getPool()
      ).query(
        `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject, display_name)
         VALUES ($1, 'operator', $2, NULL, $3, '降格される運営')`,
        [EDIT_DEMOTED, OP1, EDIT_DEMOTED_TOKEN],
      );
      // 有効な運営が 2 名なので、この降格は最後の運営の保護に当たらない。
      expect(await activeOperatorCount(OP1)).toBe(2);

      // 対照: 降格の前は、同じトークンで管理 API に届く（ここが 403 だと、後の 403 は降格の証拠にならない）。
      const beforeRes = await app.request('/dashboard-users', { headers: h(EDIT_DEMOTED_TOKEN) });
      expect(beforeRes.status).toBe(200);

      const actorId = await operatorSelfId();
      const auditBefore = await auditRowsFor(EDIT_DEMOTED);
      const res = await postUpdate(app, OP_TOKEN, EDIT_DEMOTED, { role: 'agency', agencyId: AG1 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: UserJsonObs };
      expect(body.user).toMatchObject({ id: EDIT_DEMOTED, role: 'agency', agencyId: AG1 });

      // 同じトークンの次の要求は、実物の認証解決を経て代理店ロールとして扱われ、管理 API は 403。
      const afterRes = await app.request('/dashboard-users', { headers: h(EDIT_DEMOTED_TOKEN) });
      expect(afterRes.status).toBe(403);
      const afterBody = (await afterRes.json()) as { error: { code: string } };
      expect(afterBody.error.code).toBe('forbidden');
      expect(await activeOperatorCount(OP1)).toBe(1);

      // 降格は所属の設定を含めて 1 件だけ記録する（所属変更の行を重ねない・Req 5.3）。
      const auditAfter = await auditRowsFor(EDIT_DEMOTED);
      expect(auditAfter.length - auditBefore.length).toBe(1);
      expect(auditAfter.slice(auditBefore.length)).toEqual([
        {
          actor_type: 'operator',
          actor_id: actorId,
          action: 'dashboard_user_demoted_to_agency',
          target_type: 'dashboard_user',
        },
      ]);
    });
  });
});
