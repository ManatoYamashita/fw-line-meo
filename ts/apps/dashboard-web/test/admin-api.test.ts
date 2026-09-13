import { describe, it, expect, vi } from 'vitest';

// api.ts は './firebase' を取り込むため、firebase 実 SDK を発火させないようモックする。
// 実 fetch はテスト毎に注入する（store-api.test と同規約）。
vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({ name: 'test-app' })),
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({ name: 'test-app' })),
}));
vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => ({ currentUser: null })),
}));

import {
  createAgency,
  getDashboardUsers,
  createDashboardUser,
  disableDashboardUser,
  enableDashboardUser,
  updateDashboardUser,
  type DashboardUserChanges,
} from '../src/lib/api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const agency = { id: 'a1', operatorId: 'op1', name: '代理店A', createdAt: '2026-01-01T00:00:00Z' };
const user = {
  id: 'u2',
  role: 'agency' as const,
  operatorId: 'op1',
  agencyId: 'a1',
  email: 'x@example.com',
  displayName: null,
  disabled: false,
  createdAt: '2026-01-01T00:00:00Z',
};

describe('管理 API クライアント', () => {
  it('createAgency は POST /agencies で name を送り { agency } をアンラップし Bearer を付与する', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { agency }));
    const result = await createAgency({ name: '代理店A' }, { getToken: async () => 'tok', fetchImpl });
    expect(result).toEqual({ ok: true, value: agency });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/agencies');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ name: '代理店A' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('createAgency は 400 validation_failed を { ok:false, code } に写す', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(400, { error: { code: 'validation_failed', message: '代理店名を入力してください' } }),
      );
    const result = await createAgency({ name: '' }, { getToken: async () => 't', fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('validation_failed');
  });

  it('getDashboardUsers は { users } を配列へアンラップする', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { users: [user] }));
    const result = await getDashboardUsers({ getToken: async () => 't', fetchImpl });
    expect(result).toEqual({ ok: true, value: [user] });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(String(url)).toContain('/dashboard-users');
  });

  it('createDashboardUser は role=agency のとき agencyId を送る', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { user }));
    const result = await createDashboardUser(
      { role: 'agency', agencyId: 'a1', email: 'x@example.com', displayName: '花子' },
      { getToken: async () => 't', fetchImpl },
    );
    expect(result).toEqual({ ok: true, value: user });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      role: 'agency',
      email: 'x@example.com',
      agencyId: 'a1',
      displayName: '花子',
    });
  });

  it('createDashboardUser は role=operator のとき agencyId を送らない（Req 6.3）', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(201, { user: { ...user, role: 'operator', agencyId: null } }));
    await createDashboardUser({ role: 'operator', email: 'op@example.com' }, { getToken: async () => 't', fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ role: 'operator', email: 'op@example.com' });
    expect('agencyId' in body).toBe(false);
  });

  it('createDashboardUser は 409 email_conflict を { ok:false, code } に写す', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(409, { error: { code: 'email_conflict', message: '既に登録済みのメールアドレスです' } }),
      );
    const result = await createDashboardUser(
      { role: 'operator', email: 'dup@example.com' },
      { getToken: async () => 't', fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('email_conflict');
  });

  it('disableDashboardUser は POST /dashboard-users/:id/disable を呼び { user } をアンラップする', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { user: { ...user, disabled: true } }));
    const result = await disableDashboardUser({ id: 'u2' }, { getToken: async () => 't', fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.disabled).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/dashboard-users/u2/disable');
    expect(init.method).toBe('POST');
  });

  it('enableDashboardUser は POST /dashboard-users/:id/enable を呼び { user } をアンラップする', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { user: { ...user, disabled: false } }));
    const result = await enableDashboardUser({ id: 'u2' }, { getToken: async () => 't', fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.disabled).toBe(false);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/dashboard-users/u2/enable');
    expect(init.method).toBe('POST');
  });
});

// 利用者の属性更新（dashboard-user-edit / Requirements 3.1, 3.4）。
// body は JSON.parse してから toStrictEqual で比べ、キーの集合の完全一致を固定する。
// JSON を経由した body に値が undefined のキーは残らないので、送ってはならないキー（運営にするときの
// agencyId・所属の移動のときの role・変えていない表示名）の混入は、必ず値を持つキーとして現れて赤になる。
describe('updateDashboardUser（利用者の属性更新）', () => {
  const AGENCY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
  const AGENCY_B = '0b0b0b0b-0000-4000-8000-00000000000b';

  it('POST /dashboard-users/:id/update へ id を URL 符号化して送り、Bearer を付け、{ user } をアンラップする', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { user }));
    const result = await updateDashboardUser(
      { id: 'a/b?c d', changes: { displayName: '花子' } },
      { getToken: async () => 'tok', fetchImpl, baseUrl: 'https://api.test' },
    );
    expect(result).toStrictEqual({ ok: true, value: user });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    // 期待値は encodeURIComponent で導かずに文字で書く（実装と同じ式で期待値を作ると、符号化の欠落を検出できない）。
    expect(String(url)).toBe('https://api.test/dashboard-users/a%2Fb%3Fc%20d/update');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  // 3 形の割り当て × 表示名の有無。表示名を変えていない行は displayName キーを持たないことまで固定する（3.1）。
  const cases: ReadonlyArray<{
    name: string;
    changes: DashboardUserChanges;
    expected: Record<string, unknown>;
  }> = [
    {
      name: '運営にする: role だけを送り、agencyId も displayName も含めない',
      changes: { assignment: { kind: 'scope', role: 'operator' } },
      expected: { role: 'operator' },
    },
    {
      name: '代理店にする: role と agencyId を送り、displayName を含めない',
      changes: { assignment: { kind: 'scope', role: 'agency', agencyId: AGENCY_A } },
      expected: { role: 'agency', agencyId: AGENCY_A },
    },
    {
      name: '代理店ロールのまま所属を移す: agencyId だけを送り、role も displayName も含めない（3.4）',
      changes: { assignment: { kind: 'agency', agencyId: AGENCY_B } },
      expected: { agencyId: AGENCY_B },
    },
    {
      name: '表示名だけを変える: displayName だけを送る',
      changes: { displayName: '花子' },
      expected: { displayName: '花子' },
    },
    {
      name: '表示名を未設定にする: null をそのまま送る',
      changes: { displayName: null },
      expected: { displayName: null },
    },
    {
      name: '運営にしつつ表示名を変える',
      changes: { assignment: { kind: 'scope', role: 'operator' }, displayName: '花子' },
      expected: { role: 'operator', displayName: '花子' },
    },
    {
      name: '代理店にしつつ表示名を未設定にする',
      changes: { assignment: { kind: 'scope', role: 'agency', agencyId: AGENCY_A }, displayName: null },
      expected: { role: 'agency', agencyId: AGENCY_A, displayName: null },
    },
    {
      name: '所属を移しつつ表示名を変える: role は含めない（3.4）',
      changes: { assignment: { kind: 'agency', agencyId: AGENCY_B }, displayName: '花子' },
      expected: { agencyId: AGENCY_B, displayName: '花子' },
    },
  ];

  it.each(cases)('$name', async ({ changes, expected }) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { user }));
    await updateDashboardUser({ id: 'u2', changes }, { getToken: async () => 't', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toStrictEqual(expected);
  });

  it('409 role_changed を { ok:false, code, message } のまま返す（画面がコードから文言を選ぶ・3.4）', async () => {
    const message = '他の操作でロールが変わったため、所属代理店を変更できませんでした。画面を再読み込みしてください';
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: { code: 'role_changed', message } }));
    const result = await updateDashboardUser(
      { id: 'u2', changes: { assignment: { kind: 'agency', agencyId: AGENCY_B } } },
      { getToken: async () => 't', fetchImpl },
    );
    expect(result).toStrictEqual({ ok: false, code: 'role_changed', message });
  });
});
