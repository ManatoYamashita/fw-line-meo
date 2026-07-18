import { describe, it, expect, vi } from 'vitest';
import {
  handleStoreSearch,
  handleStoreRegister,
  type StoreSearchDeps,
  type StoreRegistrationDeps,
} from '../src/store-registration.js';
import type { DashboardUserIdentity, StoreCandidate } from '@fwlm/db';

const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };

const OWNER_ID = '55555555-5555-5555-5555-555555555555';

const CANDIDATE: StoreCandidate = {
  placeId: 'ChIJtest-place-123',
  name: 'テスト食堂',
  address: '東京都品川区1-2-3',
  latitude: 35.6,
  longitude: 139.7,
  types: ['restaurant'],
};

function authOf(user: DashboardUserIdentity | null, disabled = false) {
  return {
    verifier: {
      verifyIdToken: (t: string) =>
        Promise.resolve({ uid: `uid-${t}`, email: null, emailVerified: false, signInProvider: null }),
    },
    findUser: () => Promise.resolve(user === null ? null : { ...user, disabled }),
    linkByEmail: () => Promise.resolve(null),
  };
}

// --- POST /stores/search ---

function searchDeps(
  over: Partial<StoreSearchDeps> = {},
  user: DashboardUserIdentity | null = AG,
): StoreSearchDeps {
  return {
    auth: authOf(user),
    searchCandidates: () => Promise.resolve({ kind: 'found', candidates: [CANDIDATE] }),
    ...over,
  };
}

describe('handleStoreSearch', () => {
  it('認証なしは 401（unauthenticated 封筒）', async () => {
    const res = await handleStoreSearch(searchDeps(), {
      authorization: undefined,
      body: { query: 'テスト' },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });

  it('未登録 UID は 403（同一封筒）', async () => {
    const res = await handleStoreSearch(searchDeps({}, null), {
      authorization: 'Bearer tok',
      body: { query: 'テスト' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
  });

  it('query が空文字なら 400 で、searchCandidates は呼ばれない', async () => {
    const searchCandidates = vi.fn(() => Promise.resolve({ kind: 'empty' as const }));
    const res = await handleStoreSearch(searchDeps({ searchCandidates }), {
      authorization: 'Bearer tok',
      body: { query: '' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(searchCandidates).not.toHaveBeenCalled();
  });

  it('query が空白のみでも 400 で、searchCandidates は呼ばれない', async () => {
    const searchCandidates = vi.fn(() => Promise.resolve({ kind: 'empty' as const }));
    const res = await handleStoreSearch(searchDeps({ searchCandidates }), {
      authorization: 'Bearer tok',
      body: { query: '   ' },
    });
    expect(res.status).toBe(400);
    expect(searchCandidates).not.toHaveBeenCalled();
  });

  it('body が object でない・query が文字列でないときも 400', async () => {
    for (const body of [undefined, null, 'テスト', { query: 42 }, {}]) {
      const res = await handleStoreSearch(searchDeps(), { authorization: 'Bearer tok', body });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('validation_failed');
    }
  });

  it('found は 200 で候補一覧（最大 10 件は adapter が強制）を返す（3.4）', async () => {
    const searchCandidates = vi.fn(() =>
      Promise.resolve({ kind: 'found' as const, candidates: [CANDIDATE] }),
    );
    const res = await handleStoreSearch(searchDeps({ searchCandidates }), {
      authorization: 'Bearer tok',
      body: { query: '  テスト食堂  ' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [CANDIDATE] });
    // トリム済みの店名で検索する
    expect(searchCandidates).toHaveBeenCalledWith('テスト食堂');
  });

  it('empty は 200 で空配列（UI が 3.5 の再検索案内を出す）', async () => {
    const res = await handleStoreSearch(
      searchDeps({ searchCandidates: () => Promise.resolve({ kind: 'empty' }) }),
      { authorization: 'Bearer tok', body: { query: 'テスト' } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [] });
  });

  it('error は 502（places_error・日本語の再試行案内）（3.6）', async () => {
    const res = await handleStoreSearch(
      searchDeps({ searchCandidates: () => Promise.resolve({ kind: 'error' }) }),
      { authorization: 'Bearer tok', body: { query: 'テスト' } },
    );
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.code).toBe('places_error');
    expect(json.error.message).toContain('再試行');
  });
});

// --- POST /stores ---

function registerDeps(
  over: Partial<StoreRegistrationDeps> = {},
  user: DashboardUserIdentity | null = AG,
): StoreRegistrationDeps {
  return {
    auth: authOf(user),
    findOwner: () => Promise.resolve({ id: OWNER_ID, agencyId: 'ag1' }),
    isValidCategory: () => Promise.resolve(true),
    registerStore: () =>
      Promise.resolve({ kind: 'confirmed', storeId: '66666666-6666-6666-6666-666666666666' }),
    ...over,
  };
}

function registerBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ownerId: OWNER_ID, candidate: { ...CANDIDATE }, ...over };
}

describe('handleStoreRegister', () => {
  it('認証なしは 401（unauthenticated 封筒）', async () => {
    const res = await handleStoreRegister(registerDeps(), {
      authorization: undefined,
      body: registerBody(),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });

  it('body が object でないときは 400 で、registerStore は呼ばれない', async () => {
    const registerStore = vi.fn(() =>
      Promise.resolve({ kind: 'confirmed' as const, storeId: 's1' }),
    );
    for (const body of [undefined, null, 'x', []]) {
      const res = await handleStoreRegister(registerDeps({ registerStore }), {
        authorization: 'Bearer tok',
        body,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('validation_failed');
    }
    expect(registerStore).not.toHaveBeenCalled();
  });

  it('candidate の形状不正（緯度が文字列・types に非文字列等）は 400 で、registerStore は呼ばれない（2.4 再検証）', async () => {
    const registerStore = vi.fn(() =>
      Promise.resolve({ kind: 'confirmed' as const, storeId: 's1' }),
    );
    const badCandidates: unknown[] = [
      undefined,
      null,
      'not-an-object',
      { ...CANDIDATE, placeId: '' },
      { ...CANDIDATE, name: 42 },
      { ...CANDIDATE, address: undefined },
      { ...CANDIDATE, latitude: '35.6' },
      { ...CANDIDATE, longitude: Number.NaN },
      { ...CANDIDATE, types: 'restaurant' },
      { ...CANDIDATE, types: ['restaurant', 42] },
    ];
    for (const candidate of badCandidates) {
      const res = await handleStoreRegister(registerDeps({ registerStore }), {
        authorization: 'Bearer tok',
        body: registerBody({ candidate }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('validation_failed');
    }
    expect(registerStore).not.toHaveBeenCalled();
  });

  it('ownerId が UUID 形式でないときは 404 で、findOwner は呼ばれない（DB 到達前の事前ガード・存在の秘匿）', async () => {
    const findOwner = vi.fn(() => Promise.resolve({ id: OWNER_ID, agencyId: 'ag1' }));
    const res = await handleStoreRegister(registerDeps({ findOwner }), {
      authorization: 'Bearer tok',
      body: registerBody({ ownerId: 'not-a-uuid' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    expect(findOwner).not.toHaveBeenCalled();
  });

  it('オーナー不在は 404（not_found 封筒）', async () => {
    const res = await handleStoreRegister(registerDeps({ findOwner: () => Promise.resolve(null) }), {
      authorization: 'Bearer tok',
      body: registerBody(),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('agency が他代理店のオーナーを指定したら 403 で、registerStore は呼ばれない（2.3, 2.4）', async () => {
    const registerStore = vi.fn(() =>
      Promise.resolve({ kind: 'confirmed' as const, storeId: 's1' }),
    );
    const res = await handleStoreRegister(
      registerDeps(
        { registerStore, findOwner: () => Promise.resolve({ id: OWNER_ID, agencyId: 'ag2' }) },
        AG,
      ),
      { authorization: 'Bearer tok', body: registerBody() },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(registerStore).not.toHaveBeenCalled();
  });

  it('operator は任意の代理店のオーナーに登録できる（3.2）', async () => {
    const res = await handleStoreRegister(
      registerDeps({ findOwner: () => Promise.resolve({ id: OWNER_ID, agencyId: 'ag2' }) }, OP),
      { authorization: 'Bearer tok', body: registerBody() },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ storeId: '66666666-6666-6666-6666-666666666666' });
  });

  it('categoryCode が存在しないコードなら 400 で、registerStore は呼ばれない', async () => {
    const registerStore = vi.fn(() =>
      Promise.resolve({ kind: 'confirmed' as const, storeId: 's1' }),
    );
    const isValidCategory = vi.fn(() => Promise.resolve(false));
    const res = await handleStoreRegister(registerDeps({ registerStore, isValidCategory }), {
      authorization: 'Bearer tok',
      body: registerBody({ categoryCode: 'no-such-category' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(isValidCategory).toHaveBeenCalledWith('no-such-category');
    expect(registerStore).not.toHaveBeenCalled();
  });

  it('categoryCode が文字列でないときは 400（形状検証）', async () => {
    const res = await handleStoreRegister(registerDeps(), {
      authorization: 'Bearer tok',
      body: registerBody({ categoryCode: 42 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
  });

  it('確定成功は 201 { storeId }。categoryCode 未指定は null で registerStore へ渡す（3.8, 3.10）', async () => {
    const registerStore = vi.fn(() =>
      Promise.resolve({ kind: 'confirmed' as const, storeId: '66666666-6666-6666-6666-666666666666' }),
    );
    const res = await handleStoreRegister(registerDeps({ registerStore }), {
      authorization: 'Bearer tok',
      body: registerBody(),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ storeId: '66666666-6666-6666-6666-666666666666' });
    expect(registerStore).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      candidate: CANDIDATE,
      categoryCode: null,
    });
  });

  it('categoryCode 指定時は検証のうえ registerStore へそのまま渡す（3.7）', async () => {
    const registerStore = vi.fn(() =>
      Promise.resolve({ kind: 'confirmed' as const, storeId: '66666666-6666-6666-6666-666666666666' }),
    );
    const isValidCategory = vi.fn(() => Promise.resolve(true));
    const res = await handleStoreRegister(registerDeps({ registerStore, isValidCategory }), {
      authorization: 'Bearer tok',
      body: registerBody({ categoryCode: 'izakaya' }),
    });
    expect(res.status).toBe(201);
    expect(isValidCategory).toHaveBeenCalledWith('izakaya');
    expect(registerStore).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      candidate: CANDIDATE,
      categoryCode: 'izakaya',
    });
  });

  it('登録済み Place は 409（place_already_registered・日本語 message）（3.9）', async () => {
    const res = await handleStoreRegister(
      registerDeps({
        registerStore: () => Promise.resolve({ kind: 'place_already_registered' }),
      }),
      { authorization: 'Bearer tok', body: registerBody() },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('place_already_registered');
    expect(json.error.message).toContain('登録');
  });
});
