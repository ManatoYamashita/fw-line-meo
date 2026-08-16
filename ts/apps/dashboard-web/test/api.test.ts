import { describe, it, expect, vi } from 'vitest';

// api.ts は './firebase'（初期化＋Auth）を取り込むため、firebase 実 SDK を発火させないよう
// firebase/app・firebase/auth をモックする。実 fetch はテスト毎に注入する。
vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({ name: 'test-app' })),
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({ name: 'test-app' })),
}));
vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => ({ currentUser: null })),
}));

import { apiFetch, getMe } from '../src/lib/api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiFetch', () => {
  it('2xx 応答を { ok: true, value } として返す', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { user: { role: 'operator' } }));
    const result = await apiFetch<{ user: { role: string } }>('/me', {
      getToken: async () => 'tok',
      fetchImpl,
    });
    expect(result).toEqual({ ok: true, value: { user: { role: 'operator' } } });
  });

  it('403 のエラー封筒 { error: { code, message } } を { ok: false, code, message } に写す', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(403, { error: { code: 'forbidden', message: 'アクセス権がありません' } }));
    const result = await apiFetch('/stores', { getToken: async () => 'tok', fetchImpl });
    expect(result).toEqual({ ok: false, code: 'forbidden', message: 'アクセス権がありません' });
  });

  it('解釈不能なエラーボディでもフォールバックの code/message で { ok: false } を返す', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<<not json>>', { status: 500 }));
    const result = await apiFetch('/stores', { getToken: async () => 'tok', fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code.length).toBeGreaterThan(0);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('注入トークンを Authorization: Bearer ヘッダに載せ Content-Type を付ける', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await apiFetch('/me', { getToken: async () => 'my-token', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/me');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer my-token');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('ネットワーク例外を { ok: false, code: "network" } に写す', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));
    const result = await apiFetch('/me', { getToken: async () => 'tok', fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('network');
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe('getMe', () => {
  it('200 の { user } を value にアンラップする', async () => {
    const me = { id: 'u1', role: 'agency', agencyId: 'a1', agencyName: '代理店A', displayName: null };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { user: me }));
    const result = await getMe({ getToken: async () => 'tok', fetchImpl });
    expect(result).toEqual({ ok: true, value: me });
  });

  it('403 はそのまま { ok: false, code: "forbidden" } を返す', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(403, { error: { code: 'forbidden', message: 'アクセス権がありません' } }));
    const result = await getMe({ getToken: async () => 'tok', fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('forbidden');
  });
});
