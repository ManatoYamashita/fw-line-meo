import { describe, it, expect, vi } from 'vitest';
import {
  handleInviteCodesList,
  handleInviteCodeIssue,
  handleInviteCodeDisable,
  type InviteCodesListDeps,
  type InviteCodeIssueDeps,
  type InviteCodeDisableDeps,
} from '../src/invite-codes.js';
import type { AuthDeps } from '../src/auth.js';
import type { DashboardUserIdentity, InviteCodeItem } from '@fwlm/db';

const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };

const CREATED_AT = new Date('2026-07-01T12:34:56.000Z');
const CODE_ID = '77777777-7777-7777-7777-777777777777';

function codeItem(over: Partial<InviteCodeItem> = {}): InviteCodeItem {
  return {
    id: CODE_ID,
    agencyId: 'ag1',
    code: 'ABCD2345',
    disabled: false,
    createdAt: CREATED_AT,
    ...over,
  };
}

// authenticate 依存のモック（owners-list.test.ts と同型）。user=null で未登録、disabled で無効化。
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

// --- GET /invite-codes ---

function listDeps(
  over: Partial<InviteCodesListDeps> = {},
  user: DashboardUserIdentity | null = OP,
  disabled = false,
): InviteCodesListDeps {
  return {
    auth: authDeps(user, disabled),
    listInviteCodes: () => Promise.resolve([codeItem()]),
    ...over,
  };
}

describe('handleInviteCodesList', () => {
  it('認証なしは 401（unauthenticated 封筒）', async () => {
    const res = await handleInviteCodesList(listDeps(), {
      authorization: undefined,
      agencyId: undefined,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });

  it('未登録 UID と無効化済みは同一の 403 封筒（存在を漏らさない）', async () => {
    const resUnregistered = await handleInviteCodesList(listDeps({}, null), {
      authorization: 'Bearer tok',
      agencyId: undefined,
    });
    const resDisabled = await handleInviteCodesList(listDeps({}, AG, true), {
      authorization: 'Bearer tok',
      agencyId: undefined,
    });
    expect(resUnregistered.status).toBe(403);
    expect(resDisabled.status).toBe(403);
    expect(await resUnregistered.json()).toEqual(await resDisabled.json());
  });

  it('agency が他代理店を指定したら 403 で、listInviteCodes は呼ばれない（2.3）', async () => {
    const listInviteCodes = vi.fn(() => Promise.resolve([codeItem()]));
    const res = await handleInviteCodesList(listDeps({ listInviteCodes }, AG), {
      authorization: 'Bearer tok',
      agencyId: 'ag2',
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(listInviteCodes).not.toHaveBeenCalled();
  });

  it('agency の未指定は自代理店のコード一覧（5.1）', async () => {
    const listInviteCodes = vi.fn(() => Promise.resolve([codeItem()]));
    const res = await handleInviteCodesList(listDeps({ listInviteCodes }, AG), {
      authorization: 'Bearer tok',
      agencyId: undefined,
    });
    expect(res.status).toBe(200);
    expect(listInviteCodes).toHaveBeenCalledWith('ag1');
  });

  it('operator の agencyId 指定はその代理店のコード一覧（5.4）', async () => {
    const listInviteCodes = vi.fn(() => Promise.resolve([codeItem({ agencyId: 'ag2' })]));
    const res = await handleInviteCodesList(listDeps({ listInviteCodes }), {
      authorization: 'Bearer tok',
      agencyId: 'ag2',
    });
    expect(res.status).toBe(200);
    expect(listInviteCodes).toHaveBeenCalledWith('ag2');
  });

  it('operator の agencyId 未指定は 400（招待コードは代理店単位）で、listInviteCodes は呼ばれない', async () => {
    const listInviteCodes = vi.fn(() => Promise.resolve([codeItem()]));
    const res = await handleInviteCodesList(listDeps({ listInviteCodes }), {
      authorization: 'Bearer tok',
      agencyId: undefined,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(listInviteCodes).not.toHaveBeenCalled();
  });

  it('0 件は 200 で空配列（404 にしない）', async () => {
    const res = await handleInviteCodesList(
      listDeps({ listInviteCodes: () => Promise.resolve([]) }, AG),
      { authorization: 'Bearer tok', agencyId: undefined },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inviteCodes: [] });
  });

  it('各コードの createdAt は ISO 文字列・disabled の別を含む（5.1）', async () => {
    const res = await handleInviteCodesList(
      listDeps(
        { listInviteCodes: () => Promise.resolve([codeItem(), codeItem({ disabled: true })]) },
        AG,
      ),
      { authorization: 'Bearer tok', agencyId: undefined },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual({
      inviteCodes: [
        {
          id: CODE_ID,
          agencyId: 'ag1',
          code: 'ABCD2345',
          disabled: false,
          createdAt: '2026-07-01T12:34:56.000Z',
        },
        {
          id: CODE_ID,
          agencyId: 'ag1',
          code: 'ABCD2345',
          disabled: true,
          createdAt: '2026-07-01T12:34:56.000Z',
        },
      ],
    });
  });
});

// --- POST /invite-codes ---

function issueDeps(
  over: Partial<InviteCodeIssueDeps> = {},
  user: DashboardUserIdentity | null = OP,
  disabled = false,
): InviteCodeIssueDeps {
  return {
    auth: authDeps(user, disabled),
    issueCode: (agencyId: string) => Promise.resolve(codeItem({ agencyId })),
    ...over,
  };
}

describe('handleInviteCodeIssue', () => {
  it('認証なしは 401', async () => {
    const res = await handleInviteCodeIssue(issueDeps(), { authorization: undefined, body: {} });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });

  it('agency の agencyId 省略は自代理店へ発行して 201（5.2）', async () => {
    const issueCode = vi.fn((agencyId: string) => Promise.resolve(codeItem({ agencyId })));
    const res = await handleInviteCodeIssue(issueDeps({ issueCode }, AG), {
      authorization: 'Bearer tok',
      body: {},
    });
    expect(res.status).toBe(201);
    expect(issueCode).toHaveBeenCalledWith('ag1');
    expect(await res.json()).toEqual({
      inviteCode: {
        id: CODE_ID,
        agencyId: 'ag1',
        code: 'ABCD2345',
        disabled: false,
        createdAt: '2026-07-01T12:34:56.000Z',
      },
    });
  });

  it('agency が自代理店の agencyId を明示しても 201', async () => {
    const issueCode = vi.fn((agencyId: string) => Promise.resolve(codeItem({ agencyId })));
    const res = await handleInviteCodeIssue(issueDeps({ issueCode }, AG), {
      authorization: 'Bearer tok',
      body: { agencyId: 'ag1' },
    });
    expect(res.status).toBe(201);
    expect(issueCode).toHaveBeenCalledWith('ag1');
  });

  it('agency が他代理店の agencyId を指定したら 403 で、issueCode は呼ばれない（2.3）', async () => {
    const issueCode = vi.fn((agencyId: string) => Promise.resolve(codeItem({ agencyId })));
    const res = await handleInviteCodeIssue(issueDeps({ issueCode }, AG), {
      authorization: 'Bearer tok',
      body: { agencyId: 'ag2' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(issueCode).not.toHaveBeenCalled();
  });

  it('operator の agencyId 未指定は 400 で、issueCode は呼ばれない', async () => {
    const issueCode = vi.fn((agencyId: string) => Promise.resolve(codeItem({ agencyId })));
    const res = await handleInviteCodeIssue(issueDeps({ issueCode }), {
      authorization: 'Bearer tok',
      body: {},
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(issueCode).not.toHaveBeenCalled();
  });

  it('operator の agencyId 指定は当該代理店へ発行して 201（5.4）', async () => {
    const issueCode = vi.fn((agencyId: string) => Promise.resolve(codeItem({ agencyId })));
    const res = await handleInviteCodeIssue(issueDeps({ issueCode }), {
      authorization: 'Bearer tok',
      body: { agencyId: 'ag2' },
    });
    expect(res.status).toBe(201);
    expect(issueCode).toHaveBeenCalledWith('ag2');
  });

  it('body が無い（undefined）場合も agency は自代理店へ発行できる', async () => {
    const issueCode = vi.fn((agencyId: string) => Promise.resolve(codeItem({ agencyId })));
    const res = await handleInviteCodeIssue(issueDeps({ issueCode }, AG), {
      authorization: 'Bearer tok',
      body: undefined,
    });
    expect(res.status).toBe(201);
    expect(issueCode).toHaveBeenCalledWith('ag1');
  });

  it('agencyId が文字列でない body は 400 で、issueCode は呼ばれない', async () => {
    const issueCode = vi.fn((agencyId: string) => Promise.resolve(codeItem({ agencyId })));
    const res = await handleInviteCodeIssue(issueDeps({ issueCode }), {
      authorization: 'Bearer tok',
      body: { agencyId: 123 },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(issueCode).not.toHaveBeenCalled();
  });

  it('発行依存が投げたら 500 internal（衝突リトライ尽き等・7.4）', async () => {
    const issueCode = vi.fn(() => Promise.reject(new Error('exhausted')));
    const res = await handleInviteCodeIssue(issueDeps({ issueCode }, AG), {
      authorization: 'Bearer tok',
      body: {},
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('internal');
  });
});

// --- POST /invite-codes/:id/disable ---

function disableDeps(
  over: Partial<InviteCodeDisableDeps> = {},
  user: DashboardUserIdentity | null = OP,
  disabled = false,
): InviteCodeDisableDeps {
  return {
    auth: authDeps(user, disabled),
    disableCode: (id: string, agencyId: string) =>
      Promise.resolve(codeItem({ id, agencyId, disabled: true })),
    ...over,
  };
}

describe('handleInviteCodeDisable', () => {
  it('認証なしは 401', async () => {
    const res = await handleInviteCodeDisable(disableDeps(), {
      authorization: undefined,
      id: CODE_ID,
      body: undefined,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });

  it('UUID 形式でない id は 404 で、disableCode は呼ばれない（存在の探り当てを許さない）', async () => {
    const disableCode = vi.fn((id: string, agencyId: string) =>
      Promise.resolve(codeItem({ id, agencyId, disabled: true })),
    );
    const res = await handleInviteCodeDisable(disableDeps({ disableCode }, AG), {
      authorization: 'Bearer tok',
      id: 'not-a-uuid',
      body: undefined,
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    expect(disableCode).not.toHaveBeenCalled();
  });

  it('依存が null（不在またはスコープ不一致）なら 404（存在の秘匿・5.3）', async () => {
    const res = await handleInviteCodeDisable(
      disableDeps({ disableCode: () => Promise.resolve(null) }, AG),
      { authorization: 'Bearer tok', id: CODE_ID, body: undefined },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('agency は body なしで自代理店スコープの無効化になる（5.3）', async () => {
    const disableCode = vi.fn((id: string, agencyId: string) =>
      Promise.resolve(codeItem({ id, agencyId, disabled: true })),
    );
    const res = await handleInviteCodeDisable(disableDeps({ disableCode }, AG), {
      authorization: 'Bearer tok',
      id: CODE_ID,
      body: undefined,
    });
    expect(res.status).toBe(200);
    expect(disableCode).toHaveBeenCalledWith(CODE_ID, 'ag1');
    expect(await res.json()).toEqual({
      inviteCode: {
        id: CODE_ID,
        agencyId: 'ag1',
        code: 'ABCD2345',
        disabled: true,
        createdAt: '2026-07-01T12:34:56.000Z',
      },
    });
  });

  it('agency が他代理店の agencyId を指定したら 403 で、disableCode は呼ばれない（2.3）', async () => {
    const disableCode = vi.fn((id: string, agencyId: string) =>
      Promise.resolve(codeItem({ id, agencyId, disabled: true })),
    );
    const res = await handleInviteCodeDisable(disableDeps({ disableCode }, AG), {
      authorization: 'Bearer tok',
      id: CODE_ID,
      body: { agencyId: 'ag2' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(disableCode).not.toHaveBeenCalled();
  });

  it('operator の agencyId 未指定は 400 で、disableCode は呼ばれない', async () => {
    const disableCode = vi.fn((id: string, agencyId: string) =>
      Promise.resolve(codeItem({ id, agencyId, disabled: true })),
    );
    const res = await handleInviteCodeDisable(disableDeps({ disableCode }), {
      authorization: 'Bearer tok',
      id: CODE_ID,
      body: undefined,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(disableCode).not.toHaveBeenCalled();
  });

  it('operator は agencyId 指定で当該代理店スコープの無効化ができる（5.4）', async () => {
    const disableCode = vi.fn((id: string, agencyId: string) =>
      Promise.resolve(codeItem({ id, agencyId, disabled: true })),
    );
    const res = await handleInviteCodeDisable(disableDeps({ disableCode }), {
      authorization: 'Bearer tok',
      id: CODE_ID,
      body: { agencyId: 'ag2' },
    });
    expect(res.status).toBe(200);
    expect(disableCode).toHaveBeenCalledWith(CODE_ID, 'ag2');
  });

  it('既に無効のコードも依存が現状値を返せば 200（冪等）', async () => {
    const res = await handleInviteCodeDisable(
      disableDeps(
        { disableCode: (id, agencyId) => Promise.resolve(codeItem({ id, agencyId, disabled: true })) },
        AG,
      ),
      { authorization: 'Bearer tok', id: CODE_ID, body: undefined },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.inviteCode.disabled).toBe(true);
  });
});
