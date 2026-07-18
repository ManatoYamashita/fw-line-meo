import { describe, it, expect, vi } from 'vitest';

// api.ts は './firebase'（初期化＋Auth）を取り込むため、firebase 実 SDK を発火させないよう
// firebase/app・firebase/auth をモックする。実 fetch はテスト毎に注入する（api.test.ts と同規約）。
vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({ name: 'test-app' })),
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({ name: 'test-app' })),
}));
vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => ({ currentUser: null })),
}));

import {
  getStores,
  getOwners,
  getAgencies,
  getCategories,
  searchStores,
  registerStore,
} from '../src/lib/api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('店舗系 API クライアント', () => {
  it('getStores は { stores } を配列へアンラップし Bearer を付与する', async () => {
    const stores = [
      {
        id: 's1',
        name: '店A',
        placeStatus: 'confirmed',
        competitorConfigured: true,
        ownerId: 'o1',
        ownerDisplayName: null,
        agencyId: 'a1',
        agencyName: '代理店A',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { stores }));
    const result = await getStores({}, { getToken: async () => 'tok', fetchImpl });
    expect(result).toEqual({ ok: true, value: stores });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/stores');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('getStores は operator の agencyId をクエリに付与する', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { stores: [] }));
    await getStores({ agencyId: 'a9' }, { getToken: async () => 't', fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(String(url)).toContain('agencyId=a9');
  });

  it('getOwners は { owners } をアンラップする', async () => {
    const owners = [
      { id: 'o1', displayName: 'オーナー1', onboardingStatus: 'active', createdAt: '2026-01-01T00:00:00Z' },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { owners }));
    const result = await getOwners({}, { getToken: async () => 't', fetchImpl });
    expect(result).toEqual({ ok: true, value: owners });
  });

  it('getAgencies / getCategories をアンラップする', async () => {
    const fa = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, {
          agencies: [{ id: 'a1', operatorId: 'op1', name: '代理店A', createdAt: '2026-01-01T00:00:00Z' }],
        }),
      );
    const ra = await getAgencies({ getToken: async () => 't', fetchImpl: fa });
    expect(ra.ok && ra.value.length).toBe(1);
    const fc = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { categories: [{ code: 'izakaya', label: '居酒屋' }] }));
    const rc = await getCategories({ getToken: async () => 't', fetchImpl: fc });
    expect(rc.ok && rc.value[0]?.code).toBe('izakaya');
  });

  it('searchStores は POST で query を送り { candidates } をアンラップ、0 件は空配列', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { candidates: [] }));
    const result = await searchStores('鳥貴族', { getToken: async () => 't', fetchImpl });
    expect(result).toEqual({ ok: true, value: [] });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ query: '鳥貴族' });
  });

  it('searchStores は 502 places_error を { ok:false, code } に写す', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(502, { error: { code: 'places_error', message: '検索に失敗' } }));
    const result = await searchStores('x', { getToken: async () => 't', fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('places_error');
  });

  it('registerStore は POST で本文を送り 201 { storeId } を返す', async () => {
    const candidate = {
      placeId: 'p1',
      name: '店A',
      address: '住所',
      latitude: 1,
      longitude: 2,
      types: ['restaurant'],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { storeId: 'store-1' }));
    const result = await registerStore(
      { ownerId: 'o1', candidate, categoryCode: 'izakaya' },
      { getToken: async () => 't', fetchImpl },
    );
    expect(result).toEqual({ ok: true, value: { storeId: 'store-1' } });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ ownerId: 'o1', candidate, categoryCode: 'izakaya' });
  });

  it('registerStore は 409 place_already_registered を返す', async () => {
    const candidate = {
      placeId: 'p1',
      name: '店A',
      address: '住所',
      latitude: 1,
      longitude: 2,
      types: [],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(409, { error: { code: 'place_already_registered', message: '登録済み' } }),
      );
    const result = await registerStore(
      { ownerId: 'o1', candidate },
      { getToken: async () => 't', fetchImpl },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('place_already_registered');
  });
});
