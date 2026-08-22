import { describe, it, expect, vi } from 'vitest';

// api.ts は './firebase'（初期化＋Auth）を取り込むため、firebase 実 SDK を発火させないよう
// firebase/app・firebase/auth をモックする（store-api.test.ts と同規約）。
vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({ name: 'test-app' })),
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({ name: 'test-app' })),
}));
vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => ({ currentUser: null })),
}));

import { apiFetchBinary, getStoreQr } from '../src/lib/api';

const STORE_ID = '11111111-2222-3333-4444-555555555555';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngResponse(bytes: Uint8Array<ArrayBuffer>): Response {
  // Uint8Array は lib の総称化により BodyInit へ直接載らないため Blob を経由する。
  return new Response(new Blob([bytes]), {
    status: 200,
    headers: { 'Content-Type': 'image/png' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('QR 取得 API クライアント', () => {
  it('getStoreQr は対象店舗の PNG をバイト列と content type として返す', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(pngResponse(PNG_BYTES));
    const result = await getStoreQr(STORE_ID, { getToken: async () => 'tok', fetchImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.from(result.value.bytes)).toEqual(Array.from(PNG_BYTES));
    expect(result.value.contentType).toBe('image/png');
  });

  it('getStoreQr は印刷用途に固定したサイズを要求する（2.7）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(pngResponse(PNG_BYTES));
    await getStoreQr(STORE_ID, { getToken: async () => 'tok', fetchImpl });

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(String(url)).toContain(`/stores/${STORE_ID}/qr.png`);
    expect(String(url)).toContain('size=1024');
  });

  it('トークンは Authorization ヘッダにのみ現れ URL には現れない（5.1）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(pngResponse(PNG_BYTES));
    await getStoreQr(STORE_ID, { getToken: async () => 'secret-token', fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
    expect(String(url)).not.toContain('secret-token');
  });

  it('body を送らないため Content-Type ヘッダを付けない', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(pngResponse(PNG_BYTES));
    await getStoreQr(STORE_ID, { getToken: async () => 'tok', fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it.each([
    [401, 'UNAUTHENTICATED', 'ログインが必要です'],
    [403, 'FORBIDDEN', 'この店舗へのアクセス権がありません'],
    [404, 'NOT_FOUND', '店舗が見つかりません'],
    [409, 'PLACE_NOT_CONFIRMED', '店舗の場所が未確定です。先に確定してください'],
  ])('サーバの %i 応答の code と message をそのまま保つ（3.3, 4.1, 4.2）', async (status, code, message) => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(status, code, message));
    const result = await getStoreQr(STORE_ID, { getToken: async () => 'tok', fetchImpl });

    expect(result).toEqual({ ok: false, code, message });
  });

  it('2xx でも本文が空なら失敗として返す（4.5）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(pngResponse(new Uint8Array([])));
    const result = await getStoreQr(STORE_ID, { getToken: async () => 'tok', fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('empty_response');
  });

  it('fetch が拒否されたときは network として返す（4.3）', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await getStoreQr(STORE_ID, { getToken: async () => 'tok', fetchImpl });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('network');
  });

  it('エラー封筒を解釈できない非 2xx は http_<status> に写す（4.3）', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>500</html>', { status: 500 }));
    const result = await apiFetchBinary('/stores/x/qr.png', {
      getToken: async () => 'tok',
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('http_500');
  });

  it('応答本文を失敗時の message へ流し込まない（500 の本文が漏れない）', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('SECRET-BODY-DO-NOT-LEAK', { status: 500 }));
    const result = await apiFetchBinary('/stores/x/qr.png', {
      getToken: async () => 'tok',
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain('SECRET-BODY-DO-NOT-LEAK');
  });

  it('トークンが無い場合でも Authorization を付けずに要求する', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(pngResponse(PNG_BYTES));
    await getStoreQr(STORE_ID, { getToken: async () => null, fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
