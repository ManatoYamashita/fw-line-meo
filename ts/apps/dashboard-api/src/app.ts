import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { handleQr, type QrDeps } from './qr.js';
import { handleMe, type MeDeps } from './me.js';
import { handleStoresList, type StoresListDeps } from './stores-list.js';
import { handleOwnersList, type OwnersListDeps } from './owners-list.js';
import { handleCategories, type CategoriesDeps } from './categories.js';
import {
  handleStoreSearch,
  handleStoreRegister,
  type StoreSearchDeps,
  type StoreRegistrationDeps,
} from './store-registration.js';
import {
  handleInviteCodesList,
  handleInviteCodeIssue,
  handleInviteCodeDisable,
  type InviteCodesListDeps,
  type InviteCodeIssueDeps,
  type InviteCodeDisableDeps,
} from './invite-codes.js';
import {
  handleAgenciesList,
  handleAgencyCreate,
  handleDashboardUsersList,
  handleDashboardUserCreate,
  handleDashboardUserDisable,
  handleDashboardUserEnable,
  type AgenciesListDeps,
  type AgencyCreateDeps,
  type DashboardUsersListDeps,
  type DashboardUserCreateDeps,
  type DashboardUserDisableDeps,
  type DashboardUserEnableDeps,
} from './admin.js';
import { jsonError } from './http.js';

// 実起動なしで app.request からテスト可能な Hono アプリのファクトリ。
// 純粋ハンドラ（2.1–2.5）を実依存（index.ts で注入）と結線する統合層（3.1）。
export interface AppDeps {
  // CORS で許可する単一オリジン（config.corsOrigin＝DASHBOARD_WEB_ORIGIN）。
  corsOrigin: string;
  qr: QrDeps;
  me: MeDeps;
  stores: StoresListDeps;
  owners: OwnersListDeps;
  categories: CategoriesDeps;
  storeRegistration: {
    search: StoreSearchDeps;
    register: StoreRegistrationDeps;
  };
  inviteCodes: {
    list: InviteCodesListDeps;
    issue: InviteCodeIssueDeps;
    disable: InviteCodeDisableDeps;
  };
  admin: {
    agenciesList: AgenciesListDeps;
    agencyCreate: AgencyCreateDeps;
    usersList: DashboardUsersListDeps;
    userCreate: DashboardUserCreateDeps;
    userDisable: DashboardUserDisableDeps;
    userEnable: DashboardUserEnableDeps;
  };
}

const SIZE_MIN = 128;
const SIZE_MAX = 1024;
const SIZE_DEFAULT = 512;

/** ?size を 128–1024 に clamp（既定 512・不正値は既定）。 */
export function clampSize(raw: string | undefined): number {
  const n = Number(raw ?? SIZE_DEFAULT);
  if (!Number.isFinite(n)) return SIZE_DEFAULT;
  return Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.trunc(n)));
}

// Authorization ヘッダを取り出す（認証はハンドラ内 authenticate が行う。ここは素通し）。
function authHeader(c: Context): string | undefined {
  return c.req.header('Authorization');
}

// クエリの ?agencyId= の空文字を undefined へ正規化する（ハンドラは undefined のみを「未指定」と解釈）。
function normalizeAgencyId(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '' ? undefined : raw;
}

type BodyResult = { ok: true; body: unknown } | { ok: false };

// POST の JSON body を読む。空 body（body 無し POST）は undefined として許容し、
// 非空だが JSON として不正な body のみ 400 に写像する（呼び出し側で判定）。
async function readJsonBody(c: Context): Promise<BodyResult> {
  const raw = await c.req.text();
  if (raw === '') return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // 公開・CORS 非適用（cors ミドルウェアより前に登録＝以降の業務ルートにのみ CORS が掛かる）。
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // 以降の全業務ルートに CORS を適用。許可は単一オリジンのみ・GET/POST・Authorization/Content-Type。
  // credentials は不使用（Cookie 非採用）。design Security Considerations に準拠。
  app.use(
    '*',
    cors({
      origin: deps.corsOrigin,
      allowMethods: ['GET', 'POST'],
      allowHeaders: ['Authorization', 'Content-Type'],
    }),
  );

  // --- 参照系（GET）。認証はハンドラ内 authenticate が前置。 ---

  app.get('/me', (c) => handleMe(deps.me, { authorization: authHeader(c) }));

  app.get('/stores', (c) =>
    handleStoresList(deps.stores, {
      authorization: authHeader(c),
      agencyId: normalizeAgencyId(c.req.query('agencyId')),
    }),
  );

  app.get('/owners', (c) =>
    handleOwnersList(deps.owners, {
      authorization: authHeader(c),
      agencyId: normalizeAgencyId(c.req.query('agencyId')),
    }),
  );

  app.get('/categories', (c) => handleCategories(deps.categories, { authorization: authHeader(c) }));

  // --- 店舗登録（POST・body 必須）。 ---

  app.post('/stores/search', async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return jsonError(400, 'validation_failed', '入力内容が正しくありません');
    return handleStoreSearch(deps.storeRegistration.search, {
      authorization: authHeader(c),
      body: parsed.body,
    });
  });

  app.post('/stores', async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return jsonError(400, 'validation_failed', '入力内容が正しくありません');
    return handleStoreRegister(deps.storeRegistration.register, {
      authorization: authHeader(c),
      body: parsed.body,
    });
  });

  // --- 招待コード。 ---

  app.get('/invite-codes', (c) =>
    handleInviteCodesList(deps.inviteCodes.list, {
      authorization: authHeader(c),
      agencyId: normalizeAgencyId(c.req.query('agencyId')),
    }),
  );

  // 発行は agency ロールでは body 無し（自代理店）も許容する。
  app.post('/invite-codes', async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return jsonError(400, 'validation_failed', '入力内容が正しくありません');
    return handleInviteCodeIssue(deps.inviteCodes.issue, {
      authorization: authHeader(c),
      body: parsed.body,
    });
  });

  // 無効化は body 無し（agency ロール・自代理店）を許容する。
  app.post('/invite-codes/:id/disable', async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return jsonError(400, 'validation_failed', '入力内容が正しくありません');
    return handleInviteCodeDisable(deps.inviteCodes.disable, {
      authorization: authHeader(c),
      id: c.req.param('id'),
      body: parsed.body,
    });
  });

  // --- 管理 API（運営専用・ハンドラ冒頭で requireOperator 前置）。 ---

  app.get('/agencies', (c) =>
    handleAgenciesList(deps.admin.agenciesList, { authorization: authHeader(c) }),
  );

  app.post('/agencies', async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return jsonError(400, 'validation_failed', '入力内容が正しくありません');
    return handleAgencyCreate(deps.admin.agencyCreate, {
      authorization: authHeader(c),
      body: parsed.body,
    });
  });

  app.get('/dashboard-users', (c) =>
    handleDashboardUsersList(deps.admin.usersList, { authorization: authHeader(c) }),
  );

  app.post('/dashboard-users', async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return jsonError(400, 'validation_failed', '入力内容が正しくありません');
    return handleDashboardUserCreate(deps.admin.userCreate, {
      authorization: authHeader(c),
      body: parsed.body,
    });
  });

  // 無効化は body 不要（対象は :id・スコープは認証ユーザーの operatorId）。
  app.post('/dashboard-users/:id/disable', (c) =>
    handleDashboardUserDisable(deps.admin.userDisable, {
      authorization: authHeader(c),
      id: c.req.param('id'),
    }),
  );

  // 再有効化も body 不要（対象は :id・スコープは認証ユーザーの operatorId）。
  app.post('/dashboard-users/:id/enable', (c) =>
    handleDashboardUserEnable(deps.admin.userEnable, {
      authorization: authHeader(c),
      id: c.req.param('id'),
    }),
  );

  // --- 既存 QR エンドポイント（CORS 適用下・挙動は不変）。 ---

  app.get('/stores/:storeId/qr.png', (c) => {
    const storeId = c.req.param('storeId');
    const size = clampSize(c.req.query('size'));
    return handleQr(deps.qr, { storeId, size, authorization: authHeader(c) });
  });

  return app;
}
