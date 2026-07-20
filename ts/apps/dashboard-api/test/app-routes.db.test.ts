import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  findDashboardUserByEmailInOperator,
  findDashboardUserDisplayName,
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

  it('認証なしの全業務ルートは 401（healthz を除く）', async () => {
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
    ];
    for (const [path, init] of cases) {
      const res = await app.request(path, init);
      expect(res.status, `${init.method} ${path}`).toBe(401);
    }
  });

  it('healthz は認証不要で 200', async () => {
    const res = await buildApp().request('/healthz');
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
});
