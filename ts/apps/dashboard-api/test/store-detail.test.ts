import { describe, it, expect, vi } from 'vitest';
import { handleStoreDetail, type StoreDetailDeps } from '../src/store-detail.js';
import type { DashboardUserIdentity, StoreListItem } from '@fwlm/db';
import { readJson, type ErrorEnvelope } from './support/json.js';

// GET /stores/:id（agency-dashboard Requirement 11.1・11.9・11.10・Issue #526・tasks 9.2）。

const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };

const STORE_ID = '44444444-4444-4444-4444-44444444444a';
const CREATED_AT = new Date('2026-07-01T12:34:56.000Z');

function item(over: Partial<StoreListItem> = {}): StoreListItem {
  return {
    id: STORE_ID,
    name: 'テスト店',
    placeStatus: 'confirmed',
    suspendedAt: null,
    competitorConfigured: true,
    ownerId: '55555555-5555-5555-5555-55555555555a',
    ownerDisplayName: 'オーナー太郎',
    agencyId: 'ag1',
    agencyName: 'テスト代理店',
    createdAt: CREATED_AT,
    ...over,
  };
}

function deps(
  over: Partial<StoreDetailDeps> = {},
  user: DashboardUserIdentity | null = OP,
  disabled = false,
): StoreDetailDeps {
  return {
    auth: {
      verifier: {
        verifyIdToken: (t) =>
          Promise.resolve({ uid: `uid-${t}`, email: null, emailVerified: false, signInProvider: null }),
      },
      findUser: () => Promise.resolve(user === null ? null : { ...user, disabled }),
      linkByEmail: () => Promise.resolve(null),
    },
    findStore: () => Promise.resolve(item()),
    ...over,
  };
}

function req(over: Partial<{ authorization: string | undefined; id: string }> = {}) {
  return { authorization: 'Bearer tok', id: STORE_ID, ...over };
}

describe('handleStoreDetail', () => {
  it('認証なしは 401 で、店舗を読まない', async () => {
    const findStore = vi.fn(() => Promise.resolve(item()));
    const res = await handleStoreDetail(deps({ findStore }), req({ authorization: undefined }));
    expect(res.status).toBe(401);
    expect((await readJson<ErrorEnvelope>(res)).error.code).toBe('unauthenticated');
    expect(findStore).not.toHaveBeenCalled();
  });

  it('未登録・無効の利用者は 403 で、店舗を読まない', async () => {
    const findStore = vi.fn(() => Promise.resolve(item()));
    const unregistered = await handleStoreDetail(deps({ findStore }, null), req());
    expect(unregistered.status).toBe(403);
    const disabled = await handleStoreDetail(deps({ findStore }, OP, true), req());
    expect(disabled.status).toBe(403);
    expect(findStore).not.toHaveBeenCalled();
  });

  it('運営は全代理店（agencyId: null）を範囲にして取得し、一覧の 1 行と同じ形で返す（11.1）', async () => {
    const findStore = vi.fn(() => Promise.resolve(item({ suspendedAt: new Date('2026-07-02T00:00:00.000Z') })));
    const res = await handleStoreDetail(deps({ findStore }), req());
    expect(res.status).toBe(200);
    expect(findStore).toHaveBeenCalledWith({ storeId: STORE_ID, agencyId: null });
    expect(await res.json()).toEqual({
      store: {
        id: STORE_ID,
        name: 'テスト店',
        placeStatus: 'confirmed',
        suspendedAt: '2026-07-02T00:00:00.000Z',
        competitorConfigured: true,
        ownerId: '55555555-5555-5555-5555-55555555555a',
        ownerDisplayName: 'オーナー太郎',
        agencyId: 'ag1',
        agencyName: 'テスト代理店',
        createdAt: '2026-07-01T12:34:56.000Z',
      },
    });
  });

  it('代理店は自代理店を範囲にして取得する（11.10）', async () => {
    const findStore = vi.fn(() => Promise.resolve(item()));
    const res = await handleStoreDetail(deps({ findStore }, AG), req());
    expect(res.status).toBe(200);
    expect(findStore).toHaveBeenCalledWith({ storeId: STORE_ID, agencyId: 'ag1' });
  });

  it('形の不正・不存在・範囲外の 404 は、本文まで同じで区別できない（11.9）', async () => {
    const findStore = vi.fn(() => Promise.resolve(null));
    const malformed = await handleStoreDetail(deps({ findStore }, AG), req({ id: 'not-a-uuid' }));
    // 形の不正は DB へ問い合わせない
    expect(findStore).not.toHaveBeenCalled();
    const missing = await handleStoreDetail(deps({ findStore }, OP), req());
    const outOfScope = await handleStoreDetail(deps({ findStore }, AG), req());
    expect([malformed.status, missing.status, outOfScope.status]).toEqual([404, 404, 404]);
    const bodies = [await malformed.text(), await missing.text(), await outOfScope.text()];
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({
      error: { code: 'not_found', message: '店舗が見つかりません' },
    });
  });
});
