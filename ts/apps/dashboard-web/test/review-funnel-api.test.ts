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

import { getStoreReviewFunnel } from '../src/lib/api';

// QR パネルの実績の取得（Issue #401・store-qr-issuance-ui Requirement 8）。

const STORE_ID = '11111111-2222-3333-4444-555555555555';
const MONTHS = [
  { month: '2026-09', responses: 12, reviewLinkOpens: 7 },
  { month: '2026-08', responses: 0, reviewLinkOpens: 0 },
];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('getStoreReviewFunnel', () => {
  it('対象店舗の実績を月の配列として返し、トークンは Authorization ヘッダにだけ載せる', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json(200, { months: MONTHS }));
    const result = await getStoreReviewFunnel(STORE_ID, { getToken: async () => 'secret-token', fetchImpl });

    expect(result).toEqual({ ok: true, value: MONTHS });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain(`/stores/${STORE_ID}/review-funnel`);
    expect(String(url)).not.toContain('secret-token');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
  });

  it('サーバのエラー code をそのまま返す（403 と 404 の写像は表示層が持つ）', async () => {
    for (const [status, code] of [
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [500, 'internal'],
    ] as const) {
      const fetchImpl = vi.fn().mockResolvedValue(json(status, { error: { code, message: 'm' } }));
      const result = await getStoreReviewFunnel(STORE_ID, { getToken: async () => 'tok', fetchImpl });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(code);
    }
  });

  it('2xx でも形の欠けた本文は失敗として返す（欠けた値を 0 件として描かせない）', async () => {
    const broken: unknown[] = [
      {},
      { months: null },
      { months: [{ month: '2026-09', responses: 1 }] },
      { months: [{ month: '2026-09', responses: '1', reviewLinkOpens: 0 }] },
      { months: [null] },
    ];
    for (const body of broken) {
      const fetchImpl = vi.fn().mockResolvedValue(json(200, body));
      const result = await getStoreReviewFunnel(STORE_ID, { getToken: async () => 'tok', fetchImpl });
      expect(result).toMatchObject({ ok: false, code: 'invalid_response' });
    }
  });

  it('通信できないときは network を返す', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await getStoreReviewFunnel(STORE_ID, { getToken: async () => 'tok', fetchImpl });
    expect(result).toMatchObject({ ok: false, code: 'network' });
  });
});
