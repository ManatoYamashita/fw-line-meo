import { describe, it, expect, vi } from 'vitest';
import {
  handleAgenciesList,
  handleAgencyCreate,
  handleDashboardUsersList,
  handleDashboardUserCreate,
  handleDashboardUserDisable,
  type AgenciesListDeps,
  type AgencyCreateDeps,
  type DashboardUsersListDeps,
  type DashboardUserCreateDeps,
  type DashboardUserDisableDeps,
} from '../src/admin.js';
import type { AuthDeps } from '../src/auth.js';
import type { AgencyItem, DashboardUserIdentity, DashboardUserItem, DisableOutcome } from '@fwlm/db';

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

// --- 横断ガード（Req 6.5, 7.1）: 全 5 ハンドラで一様に検証する ---
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
      const res = handleDashboardUserCreate({ auth: authDeps(user, disabled), createUser: dep }, {
        authorization,
        body: { role: 'agency', agencyId: AGENCY_ID, email: 'new@example.com' },
      });
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
];

describe('admin ハンドラ — 横断ガード（Req 6.5, 7.1）', () => {
  it.each(guardCases)('$name: 認証なしは 401 で dep 未呼出', async ({ invoke }) => {
    const { res, dep } = invoke({ user: OP, authorization: undefined });
    const r = await res;
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe('unauthenticated');
    expect(dep).not.toHaveBeenCalled();
  });

  it.each(guardCases)('$name: agency ロールは 403 forbidden で dep 未呼出（6.5）', async ({ invoke }) => {
    const { res, dep } = invoke({ user: AG, authorization: 'Bearer tok' });
    const r = await res;
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('forbidden');
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
    expect((await res.json()).error.code).toBe('validation_failed');
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
    expect((await res.json()).error.code).toBe('validation_failed');
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
    const json = await res.json();
    expect(json.error.code).toBe('email_conflict');
    expect(json.error.message).toBe('既に登録済みのメールアドレスです');
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
    const json = await res.json();
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
    expect((await res.json()).error.code).toBe('not_found');
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
    const json = await res.json();
    expect(json.error.code).toBe('self_disable_forbidden');
    expect(json.error.message).toBe('自分自身は無効化できません');
    // DB 到達前に拒否されるため依存は呼ばれない（対象状態も変えない・Req 2.6）。
    expect(disableUser).not.toHaveBeenCalled();
  });

  it('依存が not_found（不在または他運営スコープ）なら 404（存在の秘匿・Req 1.5）', async () => {
    const res = await handleDashboardUserDisable(
      userDisableDeps({ disableUser: () => Promise.resolve<DisableOutcome>({ kind: 'not_found' }) }),
      { authorization: 'Bearer tok', id: USER_ID },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('依存が last_operator なら 409（最後の有効な運営の保護・Req 2.3）', async () => {
    const disableUser = vi.fn(() => Promise.resolve<DisableOutcome>({ kind: 'last_operator' }));
    const res = await handleDashboardUserDisable(userDisableDeps({ disableUser }), {
      authorization: 'Bearer tok',
      id: USER_ID,
    });
    expect(res.status).toBe(409);
    const json = await res.json();
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
    const json = await res.json();
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
    expect((await res.json()).user.disabled).toBe(true);
  });
});
