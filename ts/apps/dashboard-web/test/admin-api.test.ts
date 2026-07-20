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
