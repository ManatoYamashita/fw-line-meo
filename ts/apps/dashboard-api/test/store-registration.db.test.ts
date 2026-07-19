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
  listInviteCodes,
  createInviteCode,
  disableInviteCode,
  listDashboardUsers,
  createPendingDashboardUser,
  disableDashboardUserGuarded,
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

// 実 postgres（ts-test-db）＋実 @fwlm/db ＋実 @fwlm/store-identification で、配線済み dashboard-api の
// 「店舗登録」を app.request 経由で END-TO-END 検証する（6.1）。app-routes.db.test.ts（3.1）が
// 認可マトリクス（401/403/CORS）を担うのに対し、本テストは confirmStore の単一 TX 副作用
// （stores INSERT confirmed ＋ owner の store_identified 遷移 ＋ 重複 Place 拒否 ＋ 越権時 no-row）を
// DB を実クエリして裏付ける。firebase-admin のみモック（Bearer 文字列＝uid）。DATABASE_URL 無しは skip。
// 共有 DB のため UUID prefix は f6（f5=app-routes / f2・f3・f4 は他所で使用済み）。

const OP1 = 'f6000000-0000-0000-0000-000000000001';
const AG_A = 'f6000000-0000-0000-0000-000000000002'; // 代理店A
const AG_B = 'f6000000-0000-0000-0000-000000000003'; // 代理店B
const OW_A1 = 'f6000000-0000-0000-0000-000000000004'; // 代理店A・pending（正常系）
const OW_A2 = 'f6000000-0000-0000-0000-000000000005'; // 代理店A・pending（重複 Place 試行）
const OW_B = 'f6000000-0000-0000-0000-000000000006'; // 代理店B・pending（越権 403 対象）
const OW_B2 = 'f6000000-0000-0000-0000-000000000007'; // 代理店B・pending（operator 越境許可）

const OP_TOKEN = 'f6-op-uid';
const AG_A_TOKEN = 'f6-ag-a-uid';

// Place（Google 一意 ID）。重複テストは PLACE_HAPPY を再利用する。
const PLACE_HAPPY = 'ChIJ-f6-happy';
const PLACE_SCOPE = 'ChIJ-f6-scope'; // 越権テスト用。DB に決して INSERT されてはならない。
const PLACE_OP = 'ChIJ-f6-op';

// 有効カテゴリ（0002_reference_seed の 'ramen'）。無効値は 400 になるため実在コードを使う。
const CATEGORY = 'ramen';

interface Candidate {
  placeId: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  types: string[];
}

function candidate(placeId: string, name: string): Candidate {
  return {
    placeId,
    name,
    address: '東京都新宿区西新宿2-8-1',
    latitude: 35.6895,
    longitude: 139.6917,
    types: ['restaurant'],
  };
}

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

  // index.ts の実 registerStore 合成を忠実に複製する（凍結 confirmStore TX ＋ best-effort setStoreCategory）。
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

  const findAgencyName = async (agencyId: string): Promise<string | null> => {
    const res = await (
      await getPool()
    ).query<{ name: string }>('SELECT name FROM agencies WHERE id = $1', [agencyId]);
    return res.rows[0]?.name ?? null;
  };
  const findDisplayName = async (userId: string): Promise<string | null> => {
    const res = await (
      await getPool()
    ).query<{ display_name: string | null }>(
      'SELECT display_name FROM dashboard_users WHERE id = $1',
      [userId],
    );
    return res.rows[0]?.display_name ?? null;
  };

  const deps: AppDeps = {
    corsOrigin: config.corsOrigin,
    qr: {
      auth: authDeps,
      findStore: async (id) => findStoreWithAgency(await getPool(), id),
      renderQr: (text, size) => QRCode.toBuffer(text, { width: size }),
      surveyBaseUrl: config.surveyBaseUrl,
    },
    me: { auth: authDeps, findAgencyName, findDisplayName },
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
      },
      userDisable: {
        auth: authDeps,
        disableUser: async (id, operatorId) =>
          disableDashboardUserGuarded(await getPool(), id, operatorId),
      },
    },
  };
  return createApp(deps);
}

function post(
  app: ReturnType<typeof createApp>,
  bearer: string,
  body: unknown,
): Promise<Response> {
  return app.request('/stores', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// --- fixture スコープに閉じた DB 観測ヘルパ ---

async function ownerStatus(ownerId: string): Promise<string | null> {
  const res = await (
    await getPool()
  ).query<{ onboarding_status: string }>(
    'SELECT onboarding_status FROM owners WHERE id = $1',
    [ownerId],
  );
  return res.rows[0]?.onboarding_status ?? null;
}

interface StoreRowObs {
  id: string;
  place_status: string;
  place_id: string | null;
  category_code: string | null;
  owner_id: string;
}
async function storeById(storeId: string): Promise<StoreRowObs | null> {
  const res = await (
    await getPool()
  ).query<StoreRowObs>(
    'SELECT id, place_status, place_id, category_code, owner_id FROM stores WHERE id = $1',
    [storeId],
  );
  return res.rows[0] ?? null;
}
async function countStoresByPlace(placeId: string): Promise<number> {
  const res = await (
    await getPool()
  ).query<{ n: string }>('SELECT count(*)::text AS n FROM stores WHERE place_id = $1', [placeId]);
  return Number(res.rows[0]?.n ?? '0');
}
async function countStoresByOwner(ownerId: string): Promise<number> {
  const res = await (
    await getPool()
  ).query<{ n: string }>('SELECT count(*)::text AS n FROM stores WHERE owner_id = $1', [ownerId]);
  return Number(res.rows[0]?.n ?? '0');
}

describe.skipIf(!process.env.DATABASE_URL)('店舗登録の TX 副作用・重複拒否・スコープ統合検証 (DB)', () => {
  beforeAll(async () => {
    config = loadConfig({
      SURVEY_BASE_URL: 'https://survey.example',
      DASHBOARD_WEB_ORIGIN: 'https://dash.example',
      PLACES_API_KEY: 'test-places-key',
    });
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP1, 'f6運営']);
    await pool.query(
      'INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3), ($4, $2, $5)',
      [AG_A, OP1, 'f6代理店A', AG_B, 'f6代理店B'],
    );
    // 全オーナーを pending で作成（登録により store_identified へ遷移することを観測する）。
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES
        ($1, $2, $3, 'pending'),
        ($4, $2, $5, 'pending'),
        ($6, $7, $8, 'pending'),
        ($9, $7, $10, 'pending')`,
      [
        OW_A1, AG_A, 'U-f6-a1',
        OW_A2, 'U-f6-a2',
        OW_B, AG_B, 'U-f6-b',
        OW_B2, 'U-f6-b2',
      ],
    );
    // operator と代理店A ユーザーのみ（越権テストは AG_A ユーザーが AG_B オーナーを触る形で行う）。
    await pool.query(
      `INSERT INTO dashboard_users (role, operator_id, agency_id, auth_subject, display_name) VALUES
        ('operator', $1, NULL, $2, 'f6運営スタッフ'),
        ('agency', $1, $3, $4, 'f6代理店Aスタッフ')`,
      [OP1, OP_TOKEN, AG_A, AG_A_TOKEN],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('正常系: agency が自代理店オーナーを登録 → 201 かつ stores=confirmed と owner=store_identified が単一 TX で成立', async () => {
    const app = buildApp();
    const res = await post(app, AG_A_TOKEN, {
      ownerId: OW_A1,
      candidate: candidate(PLACE_HAPPY, 'f6ハッピー食堂'),
      categoryCode: CATEGORY,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { storeId: string };
    expect(typeof body.storeId).toBe('string');

    // (a) stores 行が confirmed・place_id・category_code 付きで作成されている。
    const store = await storeById(body.storeId);
    expect(store).not.toBeNull();
    expect(store?.place_status).toBe('confirmed');
    expect(store?.place_id).toBe(PLACE_HAPPY);
    expect(store?.category_code).toBe(CATEGORY);
    expect(store?.owner_id).toBe(OW_A1);

    // (b) owner の onboarding_status が store_identified へ遷移している。
    //     (a) と (b) が同時に真であることが confirmStore の単一 TX 実行を証明する（Req 3.8, 3.10）。
    expect(await ownerStatus(OW_A1)).toBe('store_identified');
  });

  it('重複 Place: 別オーナーで同一 placeId → 409 place_already_registered・2 件目の stores 行は作られない', async () => {
    const app = buildApp();
    const before = await countStoresByPlace(PLACE_HAPPY);
    expect(before).toBe(1); // 正常系で 1 件だけ存在。

    const res = await post(app, AG_A_TOKEN, {
      ownerId: OW_A2,
      candidate: candidate(PLACE_HAPPY, 'f6重複店'),
      categoryCode: null,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('place_already_registered');

    // 2 件目は作られない（UNIQUE 違反で TX 全体が ROLLBACK・Req 3.9）。
    expect(await countStoresByPlace(PLACE_HAPPY)).toBe(1);
    // ROLLBACK により OW_A2 の状態遷移も起きていない（pending のまま）。
    expect(await ownerStatus(OW_A2)).toBe('pending');
  });

  it('越権: agency が他代理店オーナーを登録 → 403・当該オーナーに stores 行は作られない', async () => {
    const app = buildApp();
    const res = await post(app, AG_A_TOKEN, {
      ownerId: OW_B, // 代理店B のオーナー（AG_A ユーザーの担当外）
      candidate: candidate(PLACE_SCOPE, 'f6越権店'),
      categoryCode: null,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');

    // registerStore に一切到達していない（担当外オーナーへの紐付けを構造的に作らない・Req 2.4）。
    expect(await countStoresByOwner(OW_B)).toBe(0);
    expect(await countStoresByPlace(PLACE_SCOPE)).toBe(0);
    expect(await ownerStatus(OW_B)).toBe('pending');
  });

  it('operator 越境: 任意代理店のオーナーを登録可 → 201 かつ TX 副作用が成立', async () => {
    const app = buildApp();
    const res = await post(app, OP_TOKEN, {
      ownerId: OW_B2, // 代理店B のオーナー。operator スコープでは許可される。
      candidate: candidate(PLACE_OP, 'f6運営登録店'),
      categoryCode: null,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { storeId: string };
    const store = await storeById(body.storeId);
    expect(store?.place_status).toBe('confirmed');
    expect(store?.place_id).toBe(PLACE_OP);
    expect(store?.owner_id).toBe(OW_B2);
    expect(await ownerStatus(OW_B2)).toBe('store_identified');
  });
});
