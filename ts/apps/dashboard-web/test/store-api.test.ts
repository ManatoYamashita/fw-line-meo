import { describe, it, expect, expectTypeOf, vi } from 'vitest';

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
  getStore,
  getOwner,
  getOwners,
  getAgencies,
  getCategories,
  searchStores,
  registerStore,
  suspendStore,
  resumeStore,
  unlinkOwnerLine,
} from '../src/lib/api';
import type { OwnerLineUnlinkResult, OwnerListItem } from '../src/lib/types';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('店舗系 API クライアント', () => {
  // 店舗の詳細・オーナーの詳細の 1 件の取得（agency-dashboard Requirement 11・Issue #526・tasks 9.3）
  const STORE_JSON = {
    id: 'abcdef44-4444-4444-4444-444444444444',
    name: '店A',
    placeStatus: 'confirmed',
    suspendedAt: null,
    competitorConfigured: true,
    ownerId: 'abcdef55-5555-5555-5555-555555555555',
    ownerDisplayName: 'オーナー1',
    agencyId: 'abcdef11-1111-1111-1111-111111111111',
    agencyName: '代理店A',
    createdAt: '2026-01-01T00:00:00Z',
  };

  it('getStore は GET /stores/:id の { store } をアンラップし Bearer を付与する', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { store: STORE_JSON }));
    const result = await getStore(STORE_JSON.id, { getToken: async () => 'tok', fetchImpl });
    expect(result).toEqual({ ok: true, value: STORE_JSON });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url).endsWith(`/stores/${STORE_JSON.id}`)).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('getStore の 404 は not_found の失敗として返す（画面が「見つかりません」と出し分ける・11.9）', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, { error: { code: 'not_found', message: '店舗が見つかりません' } }));
    const result = await getStore(STORE_JSON.id, { getToken: async () => 't', fetchImpl });
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('getStore・getOwner は id を経路の 1 段に閉じ込める（区切りを含む値が別の経路へ化けない）', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, { error: { code: 'not_found', message: '見つかりません' } }));
    await getStore('a/b', { getToken: async () => 't', fetchImpl });
    await getOwner('../x', { getToken: async () => 't', fetchImpl });
    const urls = fetchImpl.mock.calls.map((call) => String((call as [string])[0]));
    expect(urls[0]?.endsWith('/stores/a%2Fb')).toBe(true);
    expect(urls[1]?.endsWith('/owners/..%2Fx')).toBe(true);
  });

  it('getOwner は GET /owners/:id の { owner, stores } をそのまま返す', async () => {
    const owner = {
      id: STORE_JSON.ownerId,
      displayName: 'オーナー1',
      onboardingStatus: 'store_identified',
      createdAt: '2026-01-01T00:00:00Z',
      inviteCode: null,
      agencyId: STORE_JSON.agencyId,
      agencyName: '代理店A',
      lineLink: 'linked',
      menuUnlinkPending: false,
      stores: [{ id: STORE_JSON.id, name: '店A' }],
      takenOverBy: null,
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { owner, stores: [STORE_JSON] }));
    const result = await getOwner(owner.id, { getToken: async () => 't', fetchImpl });
    expect(result).toEqual({ ok: true, value: { owner, stores: [STORE_JSON] } });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(String(url).endsWith(`/owners/${owner.id}`)).toBe(true);
  });

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
        suspendedAt: null,
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
      {
        id: 'o1',
        displayName: 'オーナー1',
        onboardingStatus: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        inviteCode: { id: 'c1', code: 'ABCD2345', disabled: false },
      },
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

  it('searchStores は登録済みの注釈を候補本体から外して持つ（Issue #485）', async () => {
    const candidate = {
      placeId: 'p1',
      name: '店A',
      address: '東京都',
      latitude: 35.6,
      longitude: 139.7,
      types: ['restaurant'],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { candidates: [{ ...candidate, alreadyRegistered: true }] }));
    const result = await searchStores('店A', { getToken: async () => 't', fetchImpl });
    expect(result).toEqual({ ok: true, value: [{ candidate, alreadyRegistered: true }] });
    if (result.ok) expect(result.value[0]!.candidate).not.toHaveProperty('alreadyRegistered');
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

  // 停止・再開（store-suspension tasks 5.2 / design.md「StoreSuspensionControl」）。
  it('suspendStore は POST /stores/:id/suspend を送り、{ store } をアンラップする', async () => {
    const store = { id: 's/1', suspendedAt: '2026-09-23T01:00:00.000Z' };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { store }));
    const result = await suspendStore({ id: 's/1' }, { getToken: async () => 't', fetchImpl });
    expect(result).toEqual({ ok: true, value: store });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url).endsWith('/stores/s%2F1/suspend')).toBe(true);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('resumeStore は POST /stores/:id/resume を送り、{ store } をアンラップする', async () => {
    const store = { id: 's1', suspendedAt: null };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { store }));
    const result = await resumeStore({ id: 's1' }, { getToken: async () => 't', fetchImpl });
    expect(result).toEqual({ ok: true, value: store });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(url).endsWith('/stores/s1/resume')).toBe(true);
    expect(init.method).toBe('POST');
  });

  it('停止・再開の 404 は code をそのまま返す（文言への写像は表示層が持つ）', async () => {
    // Response の本文は 1 度しか読めないので、呼ぶたびに作り直す。
    const fetchImpl = vi.fn(async () =>
      jsonResponse(404, { error: { code: 'not_found', message: '店舗が見つかりません' } }),
    );
    const suspended = await suspendStore({ id: 's1' }, { getToken: async () => 't', fetchImpl });
    const resumed = await resumeStore({ id: 's1' }, { getToken: async () => 't', fetchImpl });
    expect(suspended).toEqual({ ok: false, code: 'not_found', message: '店舗が見つかりません' });
    expect(resumed).toEqual({ ok: false, code: 'not_found', message: '店舗が見つかりません' });
  });
});

// オーナーの一覧の拡張と LINE の解除（owner-line-unlink tasks 5.1・Req 2.1, 3.2）。
// 契約の正典は dashboard-api の owners-list.ts（toJson）と owner-line-unlink.ts（OwnerLineUnlinkResponse）。
describe('オーナーの一覧と LINE の解除の API クライアント', () => {
  // 連携中・解除済み（メニュー未解除）・解除済み（引継ぎあり）の 3 行。応答の項目をすべて持つ。
  const owners = [
    {
      id: 'o1',
      displayName: 'オーナー1',
      onboardingStatus: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      inviteCode: { id: 'c1', code: 'ABCD2345', disabled: false },
      agencyName: '代理店A',
      lineLink: 'linked',
      menuUnlinkPending: false,
      agencyId: 'a1',
      stores: [
        { id: 's1', name: '店A' },
        { id: 's2', name: '店B' },
      ],
      takenOverBy: null,
    },
    {
      id: 'o2',
      displayName: null,
      onboardingStatus: 'store_identified',
      createdAt: '2026-01-02T00:00:00Z',
      inviteCode: null,
      agencyName: '代理店B',
      lineLink: 'unlinked',
      menuUnlinkPending: true,
      agencyId: 'a1',
      stores: [],
      takenOverBy: null,
    },
    {
      id: 'o3',
      displayName: '旧オーナー',
      onboardingStatus: 'active',
      createdAt: '2026-01-03T00:00:00Z',
      inviteCode: null,
      agencyName: '代理店A',
      lineLink: 'unlinked',
      menuUnlinkPending: false,
      agencyId: 'a1',
      stores: [],
      takenOverBy: { ownerId: 'o4', displayName: null },
    },
  ] satisfies OwnerListItem[];

  it('getOwners は代理店を指定しなければクエリを付けずに GET /owners を送り、新しい項目をそのまま返す', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { owners }));
    const result = await getOwners({}, { getToken: async () => 'tok', fetchImpl });
    expect(result).toEqual({ ok: true, value: owners });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    // 運営が代理店を指定しないときは全件（owner-line-unlink で 400 から変更）。空のクエリも付けない。
    expect(String(url).endsWith('/owners')).toBe(true);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('getOwners は代理店の指定をクエリに載せる（既存の呼び出しの要求を変えない）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { owners: [] }));
    await getOwners({ agencyId: 'a9' }, { getToken: async () => 't', fetchImpl });
    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(String(url).endsWith('/owners?agencyId=a9')).toBe(true);
  });

  it('unlinkOwnerLine は本文なしで POST /owners/:id/unlink を送る', async () => {
    const body = { owner: { id: 'o/1', lineLink: 'unlinked', menuUnlinkPending: false }, menu: 'removed' };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body));
    await unlinkOwnerLine({ id: 'o/1' }, { getToken: async () => 'tok', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    // id は 1 つのパスの区間に閉じ込める（区切りを含む値で別のパスへ届かない）。
    expect(String(url).endsWith('/owners/o%2F1/unlink')).toBe(true);
    expect(init.method).toBe('POST');
    // 範囲は利用者の役割からサーバーが決める。本文は送らない（design「OwnerLineUnlinkHandler」）。
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  // メニューの結果の 3 値（外した・外せなかった・外す対象が無かった）を、応答の形のまま返す。
  // 外せなかったときだけ未解除の印が立つ（Req 3.2）。
  it.each([
    ['removed', false],
    ['failed', true],
    ['not_needed', false],
  ] as const)('unlinkOwnerLine はメニューの結果 %s と未解除の印をそのまま返す', async (menu, pending) => {
    const body = { owner: { id: 'o1', lineLink: 'unlinked', menuUnlinkPending: pending }, menu };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, body));
    const result = await unlinkOwnerLine({ id: 'o1' }, { getToken: async () => 't', fetchImpl });
    expect(result).toEqual({
      ok: true,
      value: { owner: { id: 'o1', lineLink: 'unlinked', menuUnlinkPending: pending }, menu },
    });
  });

  it('unlinkOwnerLine の 4xx・5xx は code をそのまま返す（文言への写像は表示層が持つ）', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(404, { error: { code: 'not_found', message: 'オーナーが見つかりません' } }),
      )
      .mockResolvedValueOnce(jsonResponse(403, { error: { code: 'forbidden', message: 'アクセス権がありません' } }))
      .mockResolvedValueOnce(new Response('', { status: 500 }));
    const opts = { getToken: async () => 't', fetchImpl };
    expect(await unlinkOwnerLine({ id: 'o1' }, opts)).toEqual({
      ok: false,
      code: 'not_found',
      message: 'オーナーが見つかりません',
    });
    expect(await unlinkOwnerLine({ id: 'o1' }, opts)).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'アクセス権がありません',
    });
    const failed = await unlinkOwnerLine({ id: 'o1' }, opts);
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.code).toBe('http_500');
  });

  it('型: 一覧の連携状態と、解除の応答のメニューの結果は契約の値に限る', () => {
    // 型検査（tsc）で効く表明。値を広げる・狭める改変は typecheck が赤になる。
    expectTypeOf<OwnerListItem['lineLink']>().toEqualTypeOf<'linked' | 'unlinked'>();
    expectTypeOf<OwnerListItem['menuUnlinkPending']>().toEqualTypeOf<boolean>();
    expectTypeOf<OwnerListItem['agencyName']>().toEqualTypeOf<string>();
    expectTypeOf<OwnerListItem['stores']>().toEqualTypeOf<{ id: string; name: string }[]>();
    expectTypeOf<OwnerListItem['agencyId']>().toEqualTypeOf<string>();
    expectTypeOf<OwnerListItem['takenOverBy']>().toEqualTypeOf<{
      ownerId: string;
      displayName: string | null;
    } | null>();
    expectTypeOf<OwnerLineUnlinkResult['menu']>().toEqualTypeOf<'removed' | 'failed' | 'not_needed'>();
    expectTypeOf<OwnerLineUnlinkResult['owner']>().toEqualTypeOf<{
      id: string;
      lineLink: 'unlinked';
      menuUnlinkPending: boolean;
    }>();
    expectTypeOf(unlinkOwnerLine).returns.resolves.toEqualTypeOf<
      { ok: true; value: OwnerLineUnlinkResult } | { ok: false; code: string; message: string }
    >();
  });
});
