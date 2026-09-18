import { describe, it, expect, vi } from 'vitest';
import {
  auditActionsForUserUpdate,
  handleAgenciesList,
  handleAgencyCreate,
  handleDashboardUsersList,
  handleDashboardUserCreate,
  handleDashboardUserDisable,
  handleDashboardUserEnable,
  handleDashboardUserUpdate,
  type AgenciesListDeps,
  type AgencyCreateDeps,
  type DashboardUsersListDeps,
  type DashboardUserCreateDeps,
  type DashboardUserDisableDeps,
  type DashboardUserEnableDeps,
  type DashboardUserUpdateDeps,
  type DashboardUserItemJson,
} from '../src/admin.js';
import type { AuthDeps } from '../src/auth.js';
import type {
  AgencyItem,
  AuditLogAction,
  AuditLogger,
  DashboardUserIdentity,
  DashboardUserItem,
  DashboardUserUpdateInput,
  DisableOutcome,
  UpdateOutcome,
} from '@fwlm/db';
import { readJson, type ErrorEnvelope } from './support/json.js';

// 運営（operator）は全管理 API 許可、代理店（agency）は全管理 API 拒否（Req 6.5）。
const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };

const CREATED_AT = new Date('2026-07-01T12:34:56.000Z');
const AGENCY_ID = 'a1a1a1a1-1111-4111-8111-111111111111';
const USER_ID = 'b2b2b2b2-2222-4222-8222-222222222222';

function agencyItem(over: Partial<AgencyItem> = {}): AgencyItem {
  return { id: AGENCY_ID, operatorId: 'op1', name: 'テスト代理店', createdAt: CREATED_AT, ...over };
}

function userItem(over: Partial<DashboardUserItem> = {}): DashboardUserItem {
  return {
    id: USER_ID,
    role: 'agency',
    operatorId: 'op1',
    agencyId: AGENCY_ID,
    email: 'user@example.com',
    displayName: '担当者',
    disabled: false,
    createdAt: CREATED_AT,
    ...over,
  };
}

// authenticate 依存のモック（invite-codes.test.ts と同型）。user=null で未登録、disabled で無効化。
function authDeps(user: DashboardUserIdentity | null, disabled = false): AuthDeps {
  return {
    verifier: {
      verifyIdToken: (t) =>
        Promise.resolve({ uid: `uid-${t}`, email: null, emailVerified: false, signInProvider: null }),
    },
    findUser: () => Promise.resolve(user === null ? null : { ...user, disabled }),
    linkByEmail: () => Promise.resolve(null),
  };
}

// --- 横断ガード（Req 6.5, 7.1）: 全ハンドラで一様に検証する ---
// 各エントリは共有スパイ dep を持つ deps を組み立て、認証結果に応じた封筒を返す。

type Spy = ReturnType<typeof vi.fn>;
interface GuardCase {
  name: string;
  invoke: (opts: {
    user: DashboardUserIdentity | null;
    disabled?: boolean;
    authorization: string | undefined;
  }) => { res: Promise<Response>; dep: Spy };
}

const guardCases: GuardCase[] = [
  {
    name: 'GET /agencies',
    invoke: ({ user, disabled = false, authorization }) => {
      const dep = vi.fn(() => Promise.resolve([agencyItem()]));
      const res = handleAgenciesList({ auth: authDeps(user, disabled), listAgencies: dep }, {
        authorization,
      });
      return { res, dep };
    },
  },
  {
    name: 'POST /agencies',
    invoke: ({ user, disabled = false, authorization }) => {
      const dep = vi.fn((input: { operatorId: string; name: string }) =>
        Promise.resolve(agencyItem({ operatorId: input.operatorId, name: input.name })),
      );
      const res = handleAgencyCreate({ auth: authDeps(user, disabled), createAgency: dep }, {
        authorization,
        body: { name: '新規代理店' },
      });
      return { res, dep };
    },
  },
  {
    name: 'GET /dashboard-users',
    invoke: ({ user, disabled = false, authorization }) => {
      const dep = vi.fn(() => Promise.resolve([userItem()]));
      const res = handleDashboardUsersList({ auth: authDeps(user, disabled), listUsers: dep }, {
        authorization,
      });
      return { res, dep };
    },
  },
  {
    name: 'POST /dashboard-users',
    invoke: ({ user, disabled = false, authorization }) => {
      const dep = vi.fn(() => Promise.resolve(userItem()));
      const res = handleDashboardUserCreate(
        {
          auth: authDeps(user, disabled),
          createUser: dep,
          findUserByEmailInOperator: () => Promise.resolve(null),
        },
        {
          authorization,
          body: { role: 'agency', agencyId: AGENCY_ID, email: 'new@example.com' },
        },
      );
      return { res, dep };
    },
  },
  {
    name: 'POST /dashboard-users/:id/disable',
    invoke: ({ user, disabled = false, authorization }) => {
      const dep = vi.fn(() =>
        Promise.resolve<DisableOutcome>({ kind: 'disabled', user: userItem({ disabled: true }) }),
      );
      const res = handleDashboardUserDisable({ auth: authDeps(user, disabled), disableUser: dep }, {
        authorization,
        id: USER_ID,
      });
      return { res, dep };
    },
  },
  {
    name: 'POST /dashboard-users/:id/enable',
    invoke: ({ user, disabled = false, authorization }) => {
      const dep = vi.fn(() =>
        Promise.resolve<DashboardUserItem | null>(userItem({ disabled: false })),
      );
      const res = handleDashboardUserEnable({ auth: authDeps(user, disabled), enableUser: dep }, {
        authorization,
        id: USER_ID,
      });
      return { res, dep };
    },
  },
  {
    // dashboard-user-edit（Req 4.1, 4.2）: 権限の付与そのものなので、運営以外は依存へ一切到達させない。
    name: 'POST /dashboard-users/:id/update',
    invoke: ({ user, disabled = false, authorization }) => {
      const dep = vi.fn(() =>
        Promise.resolve<UpdateOutcome>({
          kind: 'updated',
          before: userItem(),
          user: userItem({ displayName: '新しい名前' }),
        }),
      );
      const res = handleDashboardUserUpdate({ auth: authDeps(user, disabled), updateUser: dep }, {
        authorization,
        id: USER_ID,
        body: { displayName: '新しい名前' },
      });
      return { res, dep };
    },
  },
];

describe('admin ハンドラ — 横断ガード（Req 6.5, 7.1）', () => {
  it.each(guardCases)('$name: 認証なしは 401 で dep 未呼出', async ({ invoke }) => {
    const { res, dep } = invoke({ user: OP, authorization: undefined });
    const r = await res;
    expect(r.status).toBe(401);
    expect((await readJson<ErrorEnvelope>(r)).error.code).toBe('unauthenticated');
    expect(dep).not.toHaveBeenCalled();
  });

  it.each(guardCases)('$name: agency ロールは 403 forbidden で dep 未呼出（6.5）', async ({ invoke }) => {
    const { res, dep } = invoke({ user: AG, authorization: 'Bearer tok' });
    const r = await res;
    expect(r.status).toBe(403);
    expect((await readJson<ErrorEnvelope>(r)).error.code).toBe('forbidden');
    expect(dep).not.toHaveBeenCalled();
  });

  it.each(guardCases)('$name: 未登録と無効化は同一 403 封筒で dep 未呼出', async ({ invoke }) => {
    const unreg = invoke({ user: null, authorization: 'Bearer tok' });
    const dis = invoke({ user: OP, disabled: true, authorization: 'Bearer tok' });
    const rU = await unreg.res;
    const rD = await dis.res;
    expect(rU.status).toBe(403);
    expect(rD.status).toBe(403);
    expect(await rU.json()).toEqual(await rD.json());
    expect(unreg.dep).not.toHaveBeenCalled();
    expect(dis.dep).not.toHaveBeenCalled();
  });
});

// --- GET /agencies ---

function agenciesListDeps(over: Partial<AgenciesListDeps> = {}, user: DashboardUserIdentity | null = OP): AgenciesListDeps {
  return {
    auth: authDeps(user),
    listAgencies: () => Promise.resolve([agencyItem()]),
    ...over,
  };
}

describe('handleAgenciesList', () => {
  it('operator は自身の operatorId でスコープされた一覧を 200・createdAt は ISO 文字列', async () => {
    const listAgencies = vi.fn(() => Promise.resolve([agencyItem()]));
    const res = await handleAgenciesList(agenciesListDeps({ listAgencies }), {
      authorization: 'Bearer tok',
    });
    expect(res.status).toBe(200);
    expect(listAgencies).toHaveBeenCalledWith('op1');
    expect(await res.json()).toEqual({
      agencies: [{ id: AGENCY_ID, operatorId: 'op1', name: 'テスト代理店', createdAt: '2026-07-01T12:34:56.000Z' }],
    });
  });

  it('0 件は 200 で空配列', async () => {
    const res = await handleAgenciesList(
      agenciesListDeps({ listAgencies: () => Promise.resolve([]) }),
      { authorization: 'Bearer tok' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agencies: [] });
  });
});

// --- POST /agencies ---

function agencyCreateDeps(over: Partial<AgencyCreateDeps> = {}, user: DashboardUserIdentity | null = OP): AgencyCreateDeps {
  return {
    auth: authDeps(user),
    createAgency: (input) => Promise.resolve(agencyItem({ operatorId: input.operatorId, name: input.name })),
    ...over,
  };
}

describe('handleAgencyCreate', () => {
  it('空文字の name は 400 で createAgency 未呼出', async () => {
    const createAgency = vi.fn((input: { operatorId: string; name: string }) =>
      Promise.resolve(agencyItem({ operatorId: input.operatorId, name: input.name })),
    );
    const res = await handleAgencyCreate(agencyCreateDeps({ createAgency }), {
      authorization: 'Bearer tok',
      body: { name: '' },
    });
    expect(res.status).toBe(400);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('validation_failed');
    expect(createAgency).not.toHaveBeenCalled();
  });

  it('空白のみの name は 400 で createAgency 未呼出', async () => {
    const createAgency = vi.fn((input: { operatorId: string; name: string }) =>
      Promise.resolve(agencyItem({ operatorId: input.operatorId, name: input.name })),
    );
    const res = await handleAgencyCreate(agencyCreateDeps({ createAgency }), {
      authorization: 'Bearer tok',
      body: { name: '   ' },
    });
    expect(res.status).toBe(400);
    expect(createAgency).not.toHaveBeenCalled();
  });

  it('有効な name は 201・operatorId は認証ユーザー由来（クライアント入力ではない）', async () => {
    const createAgency = vi.fn((input: { operatorId: string; name: string }) =>
      Promise.resolve(agencyItem({ operatorId: input.operatorId, name: input.name })),
    );
    const res = await handleAgencyCreate(agencyCreateDeps({ createAgency }), {
      authorization: 'Bearer tok',
      // クライアントが operatorId を詐称しても無視され、認証ユーザーの op1 が使われる。
      body: { name: '  新しい代理店  ', operatorId: 'HACKED' },
    });
    expect(res.status).toBe(201);
    expect(createAgency).toHaveBeenCalledWith({ operatorId: 'op1', name: '新しい代理店' });
    expect(await res.json()).toEqual({
      agency: { id: AGENCY_ID, operatorId: 'op1', name: '新しい代理店', createdAt: '2026-07-01T12:34:56.000Z' },
    });
  });
});

// --- GET /dashboard-users ---

function usersListDeps(over: Partial<DashboardUsersListDeps> = {}, user: DashboardUserIdentity | null = OP): DashboardUsersListDeps {
  return {
    auth: authDeps(user),
    listUsers: () => Promise.resolve([userItem()]),
    ...over,
  };
}

describe('handleDashboardUsersList', () => {
  it('operator は自身の operatorId でスコープされた一覧を 200・createdAt は ISO 文字列', async () => {
    const listUsers = vi.fn(() => Promise.resolve([userItem()]));
    const res = await handleDashboardUsersList(usersListDeps({ listUsers }), {
      authorization: 'Bearer tok',
    });
    expect(res.status).toBe(200);
    expect(listUsers).toHaveBeenCalledWith('op1');
    expect(await res.json()).toEqual({
      users: [
        {
          id: USER_ID,
          role: 'agency',
          operatorId: 'op1',
          agencyId: AGENCY_ID,
          email: 'user@example.com',
          displayName: '担当者',
          disabled: false,
          createdAt: '2026-07-01T12:34:56.000Z',
        },
      ],
    });
  });

  it('0 件は 200 で空配列', async () => {
    const res = await handleDashboardUsersList(
      usersListDeps({ listUsers: () => Promise.resolve([]) }),
      { authorization: 'Bearer tok' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ users: [] });
  });
});

// --- POST /dashboard-users ---

function userCreateDeps(over: Partial<DashboardUserCreateDeps> = {}, user: DashboardUserIdentity | null = OP): DashboardUserCreateDeps {
  return {
    auth: authDeps(user),
    createUser: (input) =>
      Promise.resolve(
        userItem({ role: input.role, operatorId: input.operatorId, agencyId: input.agencyId, email: input.email, displayName: input.displayName }),
      ),
    // 既定は「自運営配下に該当メールなし（＝越境 or 不在扱い）」。衝突分岐を検証するテストで差し替える。
    findUserByEmailInOperator: () => Promise.resolve(null),
    ...over,
  };
}

describe('handleDashboardUserCreate', () => {
  it('role が operator/agency 以外は 400 で createUser 未呼出', async () => {
    const createUser = vi.fn(userCreateDeps().createUser);
    const res = await handleDashboardUserCreate(userCreateDeps({ createUser }), {
      authorization: 'Bearer tok',
      body: { role: 'admin', email: 'x@example.com' },
    });
    expect(res.status).toBe(400);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('validation_failed');
    expect(createUser).not.toHaveBeenCalled();
  });

  it('agency ロールで agencyId 欠落は 400（ck_dashboard_role_scope・6.3）で createUser 未呼出', async () => {
    const createUser = vi.fn(userCreateDeps().createUser);
    const res = await handleDashboardUserCreate(userCreateDeps({ createUser }), {
      authorization: 'Bearer tok',
      body: { role: 'agency', email: 'x@example.com' },
    });
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('agency ロールで agencyId が UUID 形式でないなら 400', async () => {
    const createUser = vi.fn(userCreateDeps().createUser);
    const res = await handleDashboardUserCreate(userCreateDeps({ createUser }), {
      authorization: 'Bearer tok',
      body: { role: 'agency', agencyId: 'not-a-uuid', email: 'x@example.com' },
    });
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('operator ロールで agencyId を指定したら 400（operator は agency_id 不可・6.3）', async () => {
    const createUser = vi.fn(userCreateDeps().createUser);
    const res = await handleDashboardUserCreate(userCreateDeps({ createUser }), {
      authorization: 'Bearer tok',
      body: { role: 'operator', agencyId: AGENCY_ID, email: 'x@example.com' },
    });
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('email 欠落は 400 で createUser 未呼出', async () => {
    const createUser = vi.fn(userCreateDeps().createUser);
    const res = await handleDashboardUserCreate(userCreateDeps({ createUser }), {
      authorization: 'Bearer tok',
      body: { role: 'operator' },
    });
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('@ を含まない email は 400', async () => {
    const createUser = vi.fn(userCreateDeps().createUser);
    const res = await handleDashboardUserCreate(userCreateDeps({ createUser }), {
      authorization: 'Bearer tok',
      body: { role: 'operator', email: 'noatsign' },
    });
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('内部に空白を含む email は 400', async () => {
    const createUser = vi.fn(userCreateDeps().createUser);
    const res = await handleDashboardUserCreate(userCreateDeps({ createUser }), {
      authorization: 'Bearer tok',
      body: { role: 'operator', email: 'a b@example.com' },
    });
    expect(res.status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('email は trim + 小文字化して dep に渡す（DAL/リンク正規化と一致）', async () => {
    const createUser = vi.fn(userCreateDeps().createUser);
    const res = await handleDashboardUserCreate(userCreateDeps({ createUser }), {
      authorization: 'Bearer tok',
      body: { role: 'operator', email: '  MixedCase@Example.COM  ' },
    });
    expect(res.status).toBe(201);
    expect(createUser).toHaveBeenCalledWith({
      role: 'operator',
      operatorId: 'op1',
      agencyId: null,
      email: 'mixedcase@example.com',
      displayName: null,
    });
  });

  it('email UNIQUE 衝突（pg 23505）は 409 email_conflict', async () => {
    const createUser = vi.fn(() => Promise.reject(Object.assign(new Error('dup'), { code: '23505' })));
    const res = await handleDashboardUserCreate(userCreateDeps({ createUser }), {
      authorization: 'Bearer tok',
      body: { role: 'agency', agencyId: AGENCY_ID, email: 'dup@example.com' },
    });
    expect(res.status).toBe(409);
    const json = await readJson<ErrorEnvelope>(res);
    expect(json.error.code).toBe('email_conflict');
    expect(json.error.message).toBe('既に登録済みのメールアドレスです');
  });

  it('自運営配下の無効化済みメール衝突（23505）は 409 email_conflict_disabled（再有効化案内・Req 3.2）', async () => {
    const createUser = vi.fn(() => Promise.reject(Object.assign(new Error('dup'), { code: '23505' })));
    // 自運営スコープで同一メールが引け、無効化済み（disabled:true）。
    const findUserByEmailInOperator = vi.fn(() =>
      Promise.resolve<{ id: string; disabled: boolean } | null>({ id: USER_ID, disabled: true }),
    );
    const res = await handleDashboardUserCreate(
      userCreateDeps({ createUser, findUserByEmailInOperator }),
      {
        authorization: 'Bearer tok',
        body: { role: 'operator', email: '  Disabled@Example.COM  ' },
      },
    );
    expect(res.status).toBe(409);
    const json = await readJson<ErrorEnvelope>(res);
    expect(json.error.code).toBe('email_conflict_disabled');
    expect(json.error.message).toBe(
      'このメールアドレスは無効化済みの利用者です。復旧するには利用者管理から有効化してください',
    );
    // ルックアップは (operatorId, 正規化 email) = 認証ユーザー由来 op1 ＋ trim+小文字化済み で呼ばれる。
    expect(findUserByEmailInOperator).toHaveBeenCalledWith('op1', 'disabled@example.com');
  });

  it('自運営配下の有効メール衝突（23505）は汎用 409 email_conflict（Req 3.1）', async () => {
    const createUser = vi.fn(() => Promise.reject(Object.assign(new Error('dup'), { code: '23505' })));
    // 自運営スコープで引けるが有効（disabled:false）→ 復旧案内はしない。
    const findUserByEmailInOperator = vi.fn(() =>
      Promise.resolve<{ id: string; disabled: boolean } | null>({ id: USER_ID, disabled: false }),
    );
    const res = await handleDashboardUserCreate(
      userCreateDeps({ createUser, findUserByEmailInOperator }),
      {
        authorization: 'Bearer tok',
        body: { role: 'operator', email: 'active@example.com' },
      },
    );
    expect(res.status).toBe(409);
    const json = await readJson<ErrorEnvelope>(res);
    expect(json.error.code).toBe('email_conflict');
    expect(json.error.message).toBe('既に登録済みのメールアドレスです');
    expect(findUserByEmailInOperator).toHaveBeenCalledWith('op1', 'active@example.com');
  });

  it('越境（他運営配下）の衝突は findUserByEmailInOperator が null → 汎用 409 email_conflict（存在秘匿・Req 4.4）', async () => {
    const createUser = vi.fn(() => Promise.reject(Object.assign(new Error('dup'), { code: '23505' })));
    // グローバル一意制約では衝突するが、operator_id スコープでは 0 行 → null（他運営の存在を漏らさない）。
    const findUserByEmailInOperator = vi.fn(() =>
      Promise.resolve<{ id: string; disabled: boolean } | null>(null),
    );
    const res = await handleDashboardUserCreate(
      userCreateDeps({ createUser, findUserByEmailInOperator }),
      {
        authorization: 'Bearer tok',
        body: { role: 'operator', email: 'crosstenant@example.com' },
      },
    );
    expect(res.status).toBe(409);
    const raw = await res.text();
    const json = JSON.parse(raw);
    // 無効化済み専用コードは出さない（越境相手の状態を漏らさない）。汎用コードのみ。
    expect(json.error.code).toBe('email_conflict');
    expect(json.error.message).toBe('既に登録済みのメールアドレスです');
    // 内部詳細（SQL・元エラー文言）を一切表出しない。
    expect(raw).not.toContain('dup');
    expect(raw).not.toContain('email_conflict_disabled');
    expect(findUserByEmailInOperator).toHaveBeenCalledWith('op1', 'crosstenant@example.com');
  });

  it('23505 以外のエラーは 500 internal（詳細を漏らさない）', async () => {
    const createUser = vi.fn(() => Promise.reject(new Error('SENSITIVE_DB_DETAIL')));
    const res = await handleDashboardUserCreate(userCreateDeps({ createUser }), {
      authorization: 'Bearer tok',
      body: { role: 'operator', email: 'x@example.com' },
    });
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(JSON.parse(raw).error.code).toBe('internal');
    expect(raw).not.toContain('SENSITIVE_DB_DETAIL');
  });

  it('有効な agency 利用者の作成は 201・operatorId は認証ユーザー由来', async () => {
    const createUser = vi.fn(userCreateDeps().createUser);
    const res = await handleDashboardUserCreate(userCreateDeps({ createUser }), {
      authorization: 'Bearer tok',
      body: { role: 'agency', agencyId: AGENCY_ID, email: 'agent@example.com', displayName: '新担当' },
    });
    expect(res.status).toBe(201);
    expect(createUser).toHaveBeenCalledWith({
      role: 'agency',
      operatorId: 'op1',
      agencyId: AGENCY_ID,
      email: 'agent@example.com',
      displayName: '新担当',
    });
    const json = await readJson<{ user: DashboardUserItemJson }>(res);
    expect(json.user.role).toBe('agency');
    expect(json.user.createdAt).toBe('2026-07-01T12:34:56.000Z');
  });

  it('有効な operator 利用者の作成は 201（agencyId は null）', async () => {
    const createUser = vi.fn(userCreateDeps().createUser);
    const res = await handleDashboardUserCreate(userCreateDeps({ createUser }), {
      authorization: 'Bearer tok',
      body: { role: 'operator', email: 'boss@example.com' },
    });
    expect(res.status).toBe(201);
    expect(createUser).toHaveBeenCalledWith({
      role: 'operator',
      operatorId: 'op1',
      agencyId: null,
      email: 'boss@example.com',
      displayName: null,
    });
  });
});

// --- POST /dashboard-users/:id/disable ---

function userDisableDeps(over: Partial<DashboardUserDisableDeps> = {}, user: DashboardUserIdentity | null = OP): DashboardUserDisableDeps {
  return {
    auth: authDeps(user),
    disableUser: (id) =>
      Promise.resolve<DisableOutcome>({ kind: 'disabled', user: userItem({ id, disabled: true }) }),
    ...over,
  };
}

// 認証ユーザー自身の id が UUID 形式となる operator（自己無効化ガードは UUID 事前ガード通過後に評価される）。
const SELF_OP: DashboardUserIdentity = { id: USER_ID, role: 'operator', operatorId: 'op1', agencyId: null };

describe('handleDashboardUserDisable', () => {
  it('UUID 形式でない id は 404 で disableUser 未呼出（存在の探り当てを許さない）', async () => {
    const disableUser = vi.fn((id: string) =>
      Promise.resolve<DisableOutcome>({ kind: 'disabled', user: userItem({ id, disabled: true }) }),
    );
    const res = await handleDashboardUserDisable(userDisableDeps({ disableUser }), {
      authorization: 'Bearer tok',
      id: 'not-a-uuid',
    });
    expect(res.status).toBe(404);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('not_found');
    expect(disableUser).not.toHaveBeenCalled();
  });

  it('自分自身の無効化は 409 self_disable_forbidden で disableUser 未呼出（DB 前・Req 2.1）', async () => {
    const disableUser = vi.fn((id: string) =>
      Promise.resolve<DisableOutcome>({ kind: 'disabled', user: userItem({ id, disabled: true }) }),
    );
    // 認証ユーザー(SELF_OP) 自身の id を対象に無効化を試みる。
    const res = await handleDashboardUserDisable(userDisableDeps({ disableUser }, SELF_OP), {
      authorization: 'Bearer tok',
      id: USER_ID,
    });
    expect(res.status).toBe(409);
    const json = await readJson<ErrorEnvelope>(res);
    expect(json.error.code).toBe('self_disable_forbidden');
    expect(json.error.message).toBe('自分自身は無効化できません');
    // DB 到達前に拒否されるため依存は呼ばれない（対象状態も変えない・Req 2.6）。
    expect(disableUser).not.toHaveBeenCalled();
  });

  it('大文字表記の自己 UUID でも 409 self_disable_forbidden で disableUser 未呼出（正規化して自己判定・Req 2.1）', async () => {
    const disableUser = vi.fn((id: string) =>
      Promise.resolve<DisableOutcome>({ kind: 'disabled', user: userItem({ id, disabled: true }) }),
    );
    // SELF_OP.id は小文字 UUID。同一 UUID を大文字で渡す。UUID_RE は /i で通過するが、
    // PostgreSQL の uuid 比較は大小無視で同一行を指すため、厳密文字列一致だけでは大文字表記で
    // 自己無効化ガードを迂回できてしまう（退行防止）。
    const res = await handleDashboardUserDisable(userDisableDeps({ disableUser }, SELF_OP), {
      authorization: 'Bearer tok',
      id: USER_ID.toUpperCase(),
    });
    expect(res.status).toBe(409);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('self_disable_forbidden');
    expect(disableUser).not.toHaveBeenCalled();
  });

  it('依存が not_found（不在または他運営スコープ）なら 404（存在の秘匿・Req 1.5）', async () => {
    const res = await handleDashboardUserDisable(
      userDisableDeps({ disableUser: () => Promise.resolve<DisableOutcome>({ kind: 'not_found' }) }),
      { authorization: 'Bearer tok', id: USER_ID },
    );
    expect(res.status).toBe(404);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('not_found');
  });

  it('依存が last_operator なら 409（最後の有効な運営の保護・Req 2.3）', async () => {
    const disableUser = vi.fn(() => Promise.resolve<DisableOutcome>({ kind: 'last_operator' }));
    const res = await handleDashboardUserDisable(userDisableDeps({ disableUser }), {
      authorization: 'Bearer tok',
      id: USER_ID,
    });
    expect(res.status).toBe(409);
    const json = await readJson<ErrorEnvelope>(res);
    expect(json.error.code).toBe('last_operator');
    expect(json.error.message).toBe('最後の運営は無効化できないため、先に別の運営を追加してください');
    // ガードは実行され、拒否は DAL 結果由来（DAL が ROLLBACK 済み・対象状態不変・Req 2.6）。
    expect(disableUser).toHaveBeenCalledWith(USER_ID, 'op1');
  });

  it('無効化成功（disabled）は 200・disableUser は (id, operatorId) で呼ばれる（Req 2.4）', async () => {
    const disableUser = vi.fn((id: string) =>
      Promise.resolve<DisableOutcome>({ kind: 'disabled', user: userItem({ id, disabled: true }) }),
    );
    const res = await handleDashboardUserDisable(userDisableDeps({ disableUser }), {
      authorization: 'Bearer tok',
      id: USER_ID,
    });
    expect(res.status).toBe(200);
    expect(disableUser).toHaveBeenCalledWith(USER_ID, 'op1');
    const json = await readJson<{ user: DashboardUserItemJson }>(res);
    expect(json.user.disabled).toBe(true);
    expect(json.user.createdAt).toBe('2026-07-01T12:34:56.000Z');
  });

  it('既に無効の利用者も依存が disabled を返せば 200（冪等・Req 2.4）', async () => {
    const res = await handleDashboardUserDisable(
      userDisableDeps({
        disableUser: (id) =>
          Promise.resolve<DisableOutcome>({ kind: 'disabled', user: userItem({ id, disabled: true }) }),
      }),
      { authorization: 'Bearer tok', id: USER_ID },
    );
    expect(res.status).toBe(200);
    expect((await readJson<{ user: DashboardUserItemJson }>(res)).user.disabled).toBe(true);
  });
});

// --- POST /dashboard-users/:id/enable ---

function userEnableDeps(over: Partial<DashboardUserEnableDeps> = {}, user: DashboardUserIdentity | null = OP): DashboardUserEnableDeps {
  return {
    auth: authDeps(user),
    enableUser: (id) =>
      Promise.resolve<DashboardUserItem | null>(userItem({ id, disabled: false })),
    ...over,
  };
}

describe('handleDashboardUserEnable', () => {
  it('UUID 形式でない id は 404 で enableUser 未呼出（存在の探り当てを許さない）', async () => {
    const enableUser = vi.fn((id: string) =>
      Promise.resolve<DashboardUserItem | null>(userItem({ id, disabled: false })),
    );
    const res = await handleDashboardUserEnable(userEnableDeps({ enableUser }), {
      authorization: 'Bearer tok',
      id: 'not-a-uuid',
    });
    expect(res.status).toBe(404);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('not_found');
    expect(enableUser).not.toHaveBeenCalled();
  });

  it('依存が null（不在または他運営スコープ）なら 404（存在の秘匿・Req 1.5, 4.1）', async () => {
    const enableUser = vi.fn(() => Promise.resolve<DashboardUserItem | null>(null));
    const res = await handleDashboardUserEnable(userEnableDeps({ enableUser }), {
      authorization: 'Bearer tok',
      id: USER_ID,
    });
    expect(res.status).toBe(404);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('not_found');
    // ガードは実行され（operator スコープで引く）、拒否は DAL 結果由来。
    expect(enableUser).toHaveBeenCalledWith(USER_ID, 'op1');
  });

  it('有効化成功（row）は 200・enableUser は (id, operatorId) で呼ばれ disabled=false（Req 1.1）', async () => {
    const enableUser = vi.fn((id: string) =>
      Promise.resolve<DashboardUserItem | null>(userItem({ id, disabled: false })),
    );
    const res = await handleDashboardUserEnable(userEnableDeps({ enableUser }), {
      authorization: 'Bearer tok',
      id: USER_ID,
    });
    expect(res.status).toBe(200);
    expect(enableUser).toHaveBeenCalledWith(USER_ID, 'op1');
    const json = await readJson<{ user: DashboardUserItemJson }>(res);
    expect(json.user.id).toBe(USER_ID);
    expect(json.user.disabled).toBe(false);
    expect(json.user.createdAt).toBe('2026-07-01T12:34:56.000Z');
  });
});

// --- POST /dashboard-users/:id/update（dashboard-user-edit）---

const OTHER_AGENCY_ID = 'a3a3a3a3-3333-4333-8333-333333333333';

function userUpdateDeps(
  over: Partial<DashboardUserUpdateDeps> = {},
  user: DashboardUserIdentity | null = OP,
): DashboardUserUpdateDeps {
  return {
    auth: authDeps(user),
    updateUser: (id) =>
      Promise.resolve<UpdateOutcome>({ kind: 'updated', before: userItem({ id }), user: userItem({ id }) }),
    ...over,
  };
}

// 更新依存のスパイ。呼び出しの引数（id・operatorId・input）を型つきで読むため、関数型を明示する。
function updateUserSpy(
  outcome: UpdateOutcome = { kind: 'updated', before: userItem(), user: userItem() },
) {
  return vi.fn<DashboardUserUpdateDeps['updateUser']>(() => Promise.resolve(outcome));
}

function auditLogSpy() {
  return vi.fn<AuditLogger>(() => Promise.resolve());
}

// 入力エラー（400）になる body の形。いずれも依存と監査に到達させない（Req 1.6）。
const invalidUpdateBodies: { name: string; body: unknown }[] = [
  { name: 'body が null', body: null },
  { name: 'body が配列', body: [{ displayName: '担当' }] },
  { name: 'body が文字列', body: 'displayName' },
  { name: '空のオブジェクト（変更なし）', body: {} },
  {
    name: '読まないキーだけ（変更なし）',
    body: { operatorId: 'HACKED', email: 'evil@example.com', disabled: true },
  },
  { name: 'role が未知の値', body: { role: 'admin' } },
  { name: 'role が null', body: { role: null } },
  { name: '代理店ロールで agencyId が無い', body: { role: 'agency' } },
  { name: '代理店ロールで agencyId が null', body: { role: 'agency', agencyId: null } },
  { name: '代理店ロールで agencyId が UUID 形式でない', body: { role: 'agency', agencyId: 'not-a-uuid' } },
  { name: '運営ロールで agencyId を指定する', body: { role: 'operator', agencyId: AGENCY_ID } },
  { name: 'role 無しで agencyId が null', body: { agencyId: null } },
  { name: 'role 無しで agencyId が UUID 形式でない', body: { agencyId: 'not-a-uuid' } },
  { name: 'role 無しで agencyId が数値', body: { agencyId: 42 } },
  { name: 'displayName が数値', body: { displayName: 42 } },
  { name: 'displayName がオブジェクト', body: { displayName: { value: '担当' } } },
  // 以下は、誤った項目を正しい別の変更と組み合わせた形である。誤った項目だけの body は「変更が無い」の
  // 規則でも 400 になるため、項目ごとの規則を消しても緑のまま通ってしまう。正しい変更を 1 つ添えて、
  // 誤った項目を黙って無視して残りだけを更新する（例: 所属を外すつもりの要求を捨てて表示名だけを
  // 変える）実装を検出する。
  { name: '正しい role と誤った型の displayName', body: { role: 'operator', displayName: false } },
  { name: '未知の role と正しい displayName', body: { role: 'admin', displayName: '担当' } },
  { name: 'role が null で正しい displayName', body: { role: null, displayName: '担当' } },
  { name: 'role 無しで agencyId が null、正しい displayName', body: { agencyId: null, displayName: '担当' } },
  {
    name: 'role 無しで agencyId が UUID 形式でない、正しい displayName',
    body: { agencyId: 'not-a-uuid', displayName: '担当' },
  },
  { name: 'role 無しで agencyId が数値、正しい displayName', body: { agencyId: 42, displayName: '担当' } },
];

// body → 依存へ渡す入力の写像。送らなかった項目はキーごと無い（Req 3.1, 3.4, 1.5）。
const updateBodyMappings: { name: string; body: Record<string, unknown>; input: DashboardUserUpdateInput }[] = [
  {
    name: 'role: operator は運営ロールへの scope',
    body: { role: 'operator' },
    input: { assignment: { kind: 'scope', scope: { role: 'operator', agencyId: null } } },
  },
  {
    name: 'role: operator と agencyId: null も運営ロールへの scope',
    body: { role: 'operator', agencyId: null },
    input: { assignment: { kind: 'scope', scope: { role: 'operator', agencyId: null } } },
  },
  {
    name: 'role: agency と agencyId は代理店ロールへの scope',
    body: { role: 'agency', agencyId: AGENCY_ID },
    input: { assignment: { kind: 'scope', scope: { role: 'agency', agencyId: AGENCY_ID } } },
  },
  {
    name: 'role 無しの agencyId は代理店ロールのまま所属を移す（3.4）',
    body: { agencyId: OTHER_AGENCY_ID },
    input: { assignment: { kind: 'agency', agencyId: OTHER_AGENCY_ID } },
  },
  {
    name: 'displayName は前後の空白を取り除く（1.5）',
    body: { displayName: '  新しい名前  ' },
    input: { displayName: '新しい名前' },
  },
  {
    name: '空白だけの displayName は未設定（null）にする（1.5）',
    body: { displayName: ' \t　' },
    input: { displayName: null },
  },
  {
    name: 'displayName: null は未設定にする（1.5）',
    body: { displayName: null },
    input: { displayName: null },
  },
  {
    name: 'ロールの変更と表示名を同時に送る',
    body: { role: 'agency', agencyId: AGENCY_ID, displayName: '担当' },
    input: {
      assignment: { kind: 'scope', scope: { role: 'agency', agencyId: AGENCY_ID } },
      displayName: '担当',
    },
  },
  {
    name: '所属の移動と表示名の未設定を同時に送る',
    body: { agencyId: OTHER_AGENCY_ID, displayName: null },
    input: { assignment: { kind: 'agency', agencyId: OTHER_AGENCY_ID }, displayName: null },
  },
  {
    name: '読まないキー（operatorId・email・disabled）は無視する',
    body: { displayName: '担当', operatorId: 'HACKED', email: 'evil@example.com', disabled: true },
    input: { displayName: '担当' },
  },
];

// 自分自身に対して拒否する変更（ロールを代理店にする・所属を移す）。行為者は必ず運営なので、
// どちらも自分の権限を変える操作である（Req 2.1）。大文字の ID でもすり抜けさせない（Req 4.6）。
const selfRoleChangeCases = [
  { idLabel: '小文字の ID', id: USER_ID },
  { idLabel: '大文字の ID', id: USER_ID.toUpperCase() },
].flatMap(({ idLabel, id }) =>
  [
    { name: '自分を代理店ロールにする', body: { role: 'agency', agencyId: AGENCY_ID } },
    { name: '自分の所属を移す', body: { agencyId: AGENCY_ID } },
    {
      name: '自分を代理店ロールにし、表示名も変える',
      body: { role: 'agency', agencyId: AGENCY_ID, displayName: '新しい名前' },
    },
  ].map((c) => ({ ...c, idLabel, id })),
);

// DAL の拒否結果 → HTTP の写像。message は内部の詳細を含まない日本語の固定文（Req 4.7）。
const updateRejections: {
  kind: Exclude<UpdateOutcome['kind'], 'updated'>;
  status: number;
  message: string;
}[] = [
  {
    kind: 'last_operator',
    status: 409,
    message: '最後の運営は代理店に変更できないため、先に別の運営を追加してください',
  },
  {
    kind: 'role_changed',
    status: 409,
    message: '他の操作でロールが変わったため、所属代理店を変更できませんでした。画面を再読み込みしてください',
  },
  { kind: 'agency_not_found', status: 404, message: '所属代理店が見つかりません' },
  { kind: 'not_found', status: 404, message: '利用者が見つかりません' },
];

describe('handleDashboardUserUpdate — 入力の検証（Req 1.6, 4.3）', () => {
  it.each(invalidUpdateBodies)(
    '$name は 400 validation_failed で updateUser も監査も呼ばない',
    async ({ body }) => {
      const updateUser = updateUserSpy();
      const auditLog = auditLogSpy();
      const res = await handleDashboardUserUpdate(userUpdateDeps({ updateUser, auditLog }), {
        authorization: 'Bearer tok',
        id: USER_ID,
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toStrictEqual({
        error: { code: 'validation_failed', message: '入力内容が正しくありません' },
      });
      expect(updateUser).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    },
  );

  it('UUID 形式でない id は 404 not_found で updateUser を呼ばない（存在の探り当てを許さない）', async () => {
    const updateUser = updateUserSpy();
    const res = await handleDashboardUserUpdate(userUpdateDeps({ updateUser }), {
      authorization: 'Bearer tok',
      id: 'not-a-uuid',
      body: { displayName: '新しい名前' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toStrictEqual({
      error: { code: 'not_found', message: '利用者が見つかりません' },
    });
    expect(updateUser).not.toHaveBeenCalled();
  });

  // 認証・認可を UUID の検証より先に行う。逆順だと、未認証や代理店ロールにも不正な id で 404 を返し、
  // 管理機能の入力の扱いを運営以外へ見せてしまう（同一の 401/403 で拒否する・Req 4.2）。
  it.each([
    { who: '未認証', user: OP, authorization: undefined, status: 401, code: 'unauthenticated' },
    { who: '代理店ロール', user: AG, authorization: 'Bearer tok', status: 403, code: 'forbidden' },
  ])(
    '$who は id が UUID 形式でなくても $status $code（認証・認可が UUID の検証より先）',
    async ({ user, authorization, status, code }) => {
      const updateUser = updateUserSpy();
      const res = await handleDashboardUserUpdate(userUpdateDeps({ updateUser }, user), {
        authorization,
        id: 'not-a-uuid',
        body: { displayName: '新しい名前' },
      });
      expect(res.status).toBe(status);
      expect((await readJson<ErrorEnvelope>(res)).error.code).toBe(code);
      expect(updateUser).not.toHaveBeenCalled();
    },
  );

  it('UUID 形式でない id は body が不正でも 404（id の検証が body の検証より先）', async () => {
    const res = await handleDashboardUserUpdate(userUpdateDeps(), {
      authorization: 'Bearer tok',
      id: 'not-a-uuid',
      body: {},
    });
    expect(res.status).toBe(404);
  });

  it('自分自身への不正な body は 409 ではなく 400（body の検証が自己判定より先）', async () => {
    const updateUser = updateUserSpy();
    const res = await handleDashboardUserUpdate(userUpdateDeps({ updateUser }, SELF_OP), {
      authorization: 'Bearer tok',
      id: USER_ID,
      body: { role: 'agency' },
    });
    expect(res.status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });
});

describe('handleDashboardUserUpdate — body の写像と依存へ渡す引数（Req 1.5, 3.1, 3.4, 4.1, 4.6）', () => {
  it.each(updateBodyMappings)('$name', async ({ body, input }) => {
    const updateUser = updateUserSpy();
    const res = await handleDashboardUserUpdate(userUpdateDeps({ updateUser }), {
      authorization: 'Bearer tok',
      id: USER_ID,
      body,
    });
    expect(res.status).toBe(200);
    // 送らなかった項目が「undefined の値を持つキー」でもなく、キーごと無いことまで確かめる（toStrictEqual）。
    expect(updateUser.mock.calls).toStrictEqual([[USER_ID, 'op1', input]]);
  });

  it('大文字の id は小文字へ正規化し、operatorId は認証ユーザー由来で updateUser を呼ぶ', async () => {
    const updateUser = updateUserSpy();
    const res = await handleDashboardUserUpdate(userUpdateDeps({ updateUser }), {
      authorization: 'Bearer tok',
      id: USER_ID.toUpperCase(),
      // クライアントが operatorId を詐称しても無視され、認証ユーザーの op1 が使われる（Req 4.1）。
      body: { displayName: '担当', operatorId: 'HACKED' },
    });
    expect(res.status).toBe(200);
    expect(updateUser.mock.calls).toStrictEqual([[USER_ID, 'op1', { displayName: '担当' }]]);
  });
});

describe('handleDashboardUserUpdate — 自分自身の変更（Req 2.1, 2.2, 4.6）', () => {
  it.each(selfRoleChangeCases)(
    '$idLabel: $name は 409 self_role_change_forbidden で updateUser も監査も呼ばない',
    async ({ id, body }) => {
      const updateUser = updateUserSpy();
      const auditLog = auditLogSpy();
      const res = await handleDashboardUserUpdate(userUpdateDeps({ updateUser, auditLog }, SELF_OP), {
        authorization: 'Bearer tok',
        id,
        body,
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toStrictEqual({
        error: { code: 'self_role_change_forbidden', message: '自分自身のロールは変更できません' },
      });
      // DB 到達前に拒否するので、同じ保存に含まれていた表示名の変更も確定しない（Req 2.6）。
      expect(updateUser).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    },
  );

  it.each([
    { idLabel: '小文字の ID', id: USER_ID },
    { idLabel: '大文字の ID', id: USER_ID.toUpperCase() },
  ])('$idLabel: 自分の表示名だけの変更は 200 で、小文字の ID で updateUser を呼ぶ（2.2）', async ({ id }) => {
    const updateUser = updateUserSpy();
    const res = await handleDashboardUserUpdate(userUpdateDeps({ updateUser }, SELF_OP), {
      authorization: 'Bearer tok',
      id,
      body: { displayName: '新しい名前' },
    });
    expect(res.status).toBe(200);
    expect(updateUser.mock.calls).toStrictEqual([[USER_ID, 'op1', { displayName: '新しい名前' }]]);
  });

  it('自分に運営ロールを送る（変化なし）のは拒否しない（2.2）', async () => {
    const updateUser = updateUserSpy();
    const res = await handleDashboardUserUpdate(userUpdateDeps({ updateUser }, SELF_OP), {
      authorization: 'Bearer tok',
      id: USER_ID,
      body: { role: 'operator', agencyId: null, displayName: '新しい名前' },
    });
    expect(res.status).toBe(200);
    expect(updateUser.mock.calls).toStrictEqual([
      [
        USER_ID,
        'op1',
        {
          assignment: { kind: 'scope', scope: { role: 'operator', agencyId: null } },
          displayName: '新しい名前',
        },
      ],
    ]);
  });
});

describe('handleDashboardUserUpdate — 結果の写像（Req 2.6, 3.4, 4.3, 4.4, 4.7）', () => {
  it('依存が updated なら 200 で、更新後の行（before ではない）を返す', async () => {
    const updateUser = updateUserSpy({
      kind: 'updated',
      before: userItem({ displayName: '担当者' }),
      user: userItem({ displayName: '新しい名前' }),
    });
    const res = await handleDashboardUserUpdate(userUpdateDeps({ updateUser }), {
      authorization: 'Bearer tok',
      id: USER_ID,
      body: { displayName: '新しい名前' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({
      user: {
        id: USER_ID,
        role: 'agency',
        operatorId: 'op1',
        agencyId: AGENCY_ID,
        email: 'user@example.com',
        displayName: '新しい名前',
        disabled: false,
        createdAt: '2026-07-01T12:34:56.000Z',
      },
    });
  });

  it.each(updateRejections)(
    '依存が $kind なら $status で、同じコードの固定文を返し監査を書かない',
    async ({ kind, status, message }) => {
      const updateUser = updateUserSpy({ kind });
      const auditLog = auditLogSpy();
      const res = await handleDashboardUserUpdate(userUpdateDeps({ updateUser, auditLog }), {
        authorization: 'Bearer tok',
        id: USER_ID,
        body: { role: 'agency', agencyId: AGENCY_ID, displayName: '新しい名前' },
      });
      expect(res.status).toBe(status);
      // 封筒は code と message だけ（内部の詳細を足さない）。
      expect(await res.json()).toStrictEqual({ error: { code: kind, message } });
      // 拒否の判定は DAL の結果に由来する（ハンドラは依存を呼んでいる）。
      expect(updateUser).toHaveBeenCalledTimes(1);
      expect(auditLog).not.toHaveBeenCalled();
    },
  );

  it('依存の例外は捕まえずに再送出し、監査を書かない（既存の書込と同じ扱い）', async () => {
    const updateUser = vi.fn<DashboardUserUpdateDeps['updateUser']>(() =>
      Promise.reject(new Error('DB_UNAVAILABLE')),
    );
    const auditLog = auditLogSpy();
    await expect(
      handleDashboardUserUpdate(userUpdateDeps({ updateUser, auditLog }), {
        authorization: 'Bearer tok',
        id: USER_ID,
        body: { displayName: '新しい名前' },
      }),
    ).rejects.toThrow('DB_UNAVAILABLE');
    expect(auditLog).not.toHaveBeenCalled();
  });
});

describe('handleDashboardUserUpdate — 監査（Req 5.1, 5.3, 5.4, 5.5）', () => {
  // 監査の 1 行の期待形。表示名の値を含むキーは持たない（Req 5.4）。
  function auditRow(action: AuditLogAction) {
    return {
      actorType: 'operator',
      actorId: 'u1',
      action,
      targetType: 'dashboard_user',
      targetId: USER_ID,
    };
  }

  it('昇格は promoted_to_operator の 1 件で、行為者は認証ユーザー・対象は更新した利用者（5.1）', async () => {
    const auditLog = auditLogSpy();
    const res = await handleDashboardUserUpdate(
      userUpdateDeps({
        updateUser: updateUserSpy({
          kind: 'updated',
          before: userItem({ role: 'agency', agencyId: AGENCY_ID }),
          user: userItem({ role: 'operator', agencyId: null }),
        }),
        auditLog,
      }),
      { authorization: 'Bearer tok', id: USER_ID, body: { role: 'operator' } },
    );
    expect(res.status).toBe(200);
    expect(auditLog.mock.calls).toStrictEqual([[auditRow('dashboard_user_promoted_to_operator')]]);
  });

  it('降格は所属の設定を含めて demoted_to_agency の 1 件だけ（5.3）', async () => {
    const auditLog = auditLogSpy();
    const res = await handleDashboardUserUpdate(
      userUpdateDeps({
        updateUser: updateUserSpy({
          kind: 'updated',
          before: userItem({ role: 'operator', agencyId: null }),
          user: userItem({ role: 'agency', agencyId: AGENCY_ID }),
        }),
        auditLog,
      }),
      { authorization: 'Bearer tok', id: USER_ID, body: { role: 'agency', agencyId: AGENCY_ID } },
    );
    expect(res.status).toBe(200);
    expect(auditLog.mock.calls).toStrictEqual([[auditRow('dashboard_user_demoted_to_agency')]]);
  });

  it('ロールと表示名を同時に変えると、ロール → 表示名の順に 2 件（5.3）', async () => {
    const auditLog = auditLogSpy();
    await handleDashboardUserUpdate(
      userUpdateDeps({
        updateUser: updateUserSpy({
          kind: 'updated',
          before: userItem({ role: 'agency', agencyId: AGENCY_ID, displayName: '担当者' }),
          user: userItem({ role: 'operator', agencyId: null, displayName: '新しい名前' }),
        }),
        auditLog,
      }),
      {
        authorization: 'Bearer tok',
        id: USER_ID,
        body: { role: 'operator', displayName: '新しい名前' },
      },
    );
    expect(auditLog.mock.calls).toStrictEqual([
      [auditRow('dashboard_user_promoted_to_operator')],
      [auditRow('dashboard_user_display_name_updated')],
    ]);
  });

  it('表示名の変更は display_name_updated の 1 件で、表示名の値を監査に渡さない（5.4）', async () => {
    const auditLog = auditLogSpy();
    await handleDashboardUserUpdate(
      userUpdateDeps({
        updateUser: updateUserSpy({
          kind: 'updated',
          before: userItem({ displayName: '担当者' }),
          user: userItem({ displayName: '新しい名前' }),
        }),
        auditLog,
      }),
      { authorization: 'Bearer tok', id: USER_ID, body: { displayName: '新しい名前' } },
    );
    expect(auditLog.mock.calls).toStrictEqual([[auditRow('dashboard_user_display_name_updated')]]);
    // 新旧どちらの値も、監査へ渡した入力のどこにも現れない。
    const recorded = JSON.stringify(auditLog.mock.calls);
    expect(recorded).not.toContain('新しい名前');
    expect(recorded).not.toContain('担当者');
  });

  it('変化なし（before と user が同じ）は 200 で監査 0 件（1.13, 5.5）', async () => {
    const auditLog = auditLogSpy();
    const res = await handleDashboardUserUpdate(
      userUpdateDeps({
        updateUser: updateUserSpy({ kind: 'updated', before: userItem(), user: userItem() }),
        auditLog,
      }),
      { authorization: 'Bearer tok', id: USER_ID, body: { displayName: '担当者' } },
    );
    expect(res.status).toBe(200);
    expect(auditLog).not.toHaveBeenCalled();
  });
});

describe('auditActionsForUserUpdate — 前後の差分 → action（Req 5.2〜5.5）', () => {
  const rules: {
    name: string;
    before: Partial<DashboardUserItem>;
    after: Partial<DashboardUserItem>;
    actions: AuditLogAction[];
  }[] = [
    {
      name: '代理店 → 運営は昇格の 1 件（所属が外れても所属変更を足さない）',
      before: { role: 'agency', agencyId: AGENCY_ID },
      after: { role: 'operator', agencyId: null },
      actions: ['dashboard_user_promoted_to_operator'],
    },
    {
      name: '運営 → 代理店は所属の設定を含めて降格の 1 件（5.3）',
      before: { role: 'operator', agencyId: null },
      after: { role: 'agency', agencyId: AGENCY_ID },
      actions: ['dashboard_user_demoted_to_agency'],
    },
    {
      name: '代理店のまま所属が変わると所属変更の 1 件',
      before: { role: 'agency', agencyId: AGENCY_ID },
      after: { role: 'agency', agencyId: OTHER_AGENCY_ID },
      actions: ['dashboard_user_agency_updated'],
    },
    {
      name: '表示名が変わると表示名変更の 1 件',
      before: { displayName: '担当者' },
      after: { displayName: '新しい名前' },
      actions: ['dashboard_user_display_name_updated'],
    },
    {
      name: '表示名を未設定にしても表示名変更の 1 件',
      before: { displayName: '担当者' },
      after: { displayName: null },
      actions: ['dashboard_user_display_name_updated'],
    },
    {
      name: '未設定の表示名を設定しても表示名変更の 1 件',
      before: { displayName: null },
      after: { displayName: '担当者' },
      actions: ['dashboard_user_display_name_updated'],
    },
    {
      name: '運営のまま表示名だけが変わると表示名変更の 1 件',
      before: { role: 'operator', agencyId: null, displayName: '担当者' },
      after: { role: 'operator', agencyId: null, displayName: '新しい名前' },
      actions: ['dashboard_user_display_name_updated'],
    },
    {
      name: '昇格と表示名の変更は、昇格 → 表示名の順に 2 件',
      before: { role: 'agency', agencyId: AGENCY_ID, displayName: '担当者' },
      after: { role: 'operator', agencyId: null, displayName: '新しい名前' },
      actions: ['dashboard_user_promoted_to_operator', 'dashboard_user_display_name_updated'],
    },
    {
      name: '降格と表示名の変更は、降格 → 表示名の順に 2 件',
      before: { role: 'operator', agencyId: null, displayName: '担当者' },
      after: { role: 'agency', agencyId: AGENCY_ID, displayName: null },
      actions: ['dashboard_user_demoted_to_agency', 'dashboard_user_display_name_updated'],
    },
    {
      name: '所属の変更と表示名の変更は、所属 → 表示名の順に 2 件',
      before: { role: 'agency', agencyId: AGENCY_ID, displayName: null },
      after: { role: 'agency', agencyId: OTHER_AGENCY_ID, displayName: '新しい名前' },
      actions: ['dashboard_user_agency_updated', 'dashboard_user_display_name_updated'],
    },
    {
      name: '代理店のまま何も変わらなければ 0 件（5.5）',
      before: {},
      after: {},
      actions: [],
    },
    {
      name: '運営のまま何も変わらなければ 0 件（5.5）',
      before: { role: 'operator', agencyId: null },
      after: { role: 'operator', agencyId: null },
      actions: [],
    },
    {
      name: 'ロール・所属・表示名以外（無効化の状態・メール）の違いは記録しない',
      before: { disabled: false, email: 'before@example.com' },
      after: { disabled: true, email: 'after@example.com' },
      actions: [],
    },
  ];

  it.each(rules)('$name', ({ before, after, actions }) => {
    expect(auditActionsForUserUpdate(userItem(before), userItem(after))).toStrictEqual(actions);
  });
});
