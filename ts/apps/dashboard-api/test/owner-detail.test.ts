import { describe, it, expect, vi } from 'vitest';
import { handleOwnerDetail, type OwnerDetailDeps } from '../src/owner-detail.js';
import type { DashboardUserIdentity, OwnerListItem, StoreListItem } from '@fwlm/db';
import { readJson, type ErrorEnvelope } from './support/json.js';

// GET /owners/:id（agency-dashboard Requirement 11.6・11.7・11.9・11.10・Issue #526・tasks 9.2）。

const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };

const OWNER_ID = '55555555-5555-5555-5555-55555555555b';
const STORE_ID = '44444444-4444-4444-4444-44444444444b';
const CREATED_AT = new Date('2026-07-01T12:34:56.000Z');

function owner(over: Partial<OwnerListItem> = {}): OwnerListItem {
  return {
    id: OWNER_ID,
    displayName: 'オーナー太郎',
    onboardingStatus: 'store_identified',
    createdAt: CREATED_AT,
    inviteCode: { id: '77777777-7777-7777-7777-77777777777b', code: 'ABCD2345', disabled: false },
    agencyId: 'ag1',
    agencyName: '代理店A',
    lineLink: 'linked',
    menuUnlinkPending: false,
    stores: [{ id: STORE_ID, name: '確定の店' }],
    storeNames: ['確定の店'],
    takenOverBy: null,
    ...over,
  };
}

function store(over: Partial<StoreListItem> = {}): StoreListItem {
  return {
    id: STORE_ID,
    name: '確定の店',
    placeStatus: 'confirmed',
    suspendedAt: null,
    competitorConfigured: false,
    ownerId: OWNER_ID,
    ownerDisplayName: 'オーナー太郎',
    agencyId: 'ag1',
    agencyName: '代理店A',
    createdAt: CREATED_AT,
    ...over,
  };
}

function deps(
  over: Partial<OwnerDetailDeps> = {},
  user: DashboardUserIdentity | null = OP,
  disabled = false,
): OwnerDetailDeps {
  return {
    auth: {
      verifier: {
        verifyIdToken: (t) =>
          Promise.resolve({ uid: `uid-${t}`, email: null, emailVerified: false, signInProvider: null }),
      },
      findUser: () => Promise.resolve(user === null ? null : { ...user, disabled }),
      linkByEmail: () => Promise.resolve(null),
    },
    findOwner: () => Promise.resolve(owner()),
    listStores: () => Promise.resolve([store()]),
    ...over,
  };
}

function req(over: Partial<{ authorization: string | undefined; id: string }> = {}) {
  return { authorization: 'Bearer tok', id: OWNER_ID, ...over };
}

describe('handleOwnerDetail', () => {
  it('認証なしは 401・未登録と無効は 403 で、オーナーも店舗も読まない', async () => {
    const findOwner = vi.fn(() => Promise.resolve(owner()));
    const listStores = vi.fn(() => Promise.resolve([store()]));
    const unauth = await handleOwnerDetail(deps({ findOwner, listStores }), req({ authorization: undefined }));
    expect(unauth.status).toBe(401);
    expect((await readJson<ErrorEnvelope>(unauth)).error.code).toBe('unauthenticated');
    expect((await handleOwnerDetail(deps({ findOwner, listStores }, null), req())).status).toBe(403);
    expect((await handleOwnerDetail(deps({ findOwner, listStores }, OP, true), req())).status).toBe(403);
    expect(findOwner).not.toHaveBeenCalled();
    expect(listStores).not.toHaveBeenCalled();
  });

  it('運営は全代理店を範囲に取得し、オーナー一覧の 1 行と同じ形のオーナーと、当該オーナーの店舗を返す（11.6・11.7）', async () => {
    const findOwner = vi.fn(() => Promise.resolve(owner()));
    const listStores = vi.fn(() => Promise.resolve([store()]));
    const res = await handleOwnerDetail(deps({ findOwner, listStores }), req());
    expect(res.status).toBe(200);
    expect(findOwner).toHaveBeenCalledWith({ ownerId: OWNER_ID, agencyId: null });
    expect(listStores).toHaveBeenCalledWith(OWNER_ID);
    expect(await res.json()).toEqual({
      owner: {
        id: OWNER_ID,
        displayName: 'オーナー太郎',
        onboardingStatus: 'store_identified',
        createdAt: '2026-07-01T12:34:56.000Z',
        inviteCode: { id: '77777777-7777-7777-7777-77777777777b', code: 'ABCD2345', disabled: false },
        agencyId: 'ag1',
        agencyName: '代理店A',
        lineLink: 'linked',
        menuUnlinkPending: false,
        stores: [{ id: STORE_ID, name: '確定の店' }],
        storeNames: ['確定の店'],
        takenOverBy: null,
      },
      stores: [
        {
          id: STORE_ID,
          name: '確定の店',
          placeStatus: 'confirmed',
          suspendedAt: null,
          competitorConfigured: false,
          ownerId: OWNER_ID,
          ownerDisplayName: 'オーナー太郎',
          agencyId: 'ag1',
          agencyName: '代理店A',
          createdAt: '2026-07-01T12:34:56.000Z',
        },
      ],
    });
  });

  it('代理店は自代理店を範囲に取得する（11.10）', async () => {
    const findOwner = vi.fn(() => Promise.resolve(owner()));
    await handleOwnerDetail(deps({ findOwner }, AG), req());
    expect(findOwner).toHaveBeenCalledWith({ ownerId: OWNER_ID, agencyId: 'ag1' });
  });

  it('大文字の id の要求でも、店舗は 1 件の取得が返した正規化済みの id で読む', async () => {
    const listStores = vi.fn(() => Promise.resolve([store()]));
    const res = await handleOwnerDetail(deps({ listStores }), req({ id: OWNER_ID.toUpperCase() }));
    expect(res.status).toBe(200);
    expect(listStores).toHaveBeenCalledWith(OWNER_ID);
  });

  it('店舗が 0 件なら stores は空配列', async () => {
    const res = await handleOwnerDetail(deps({ listStores: () => Promise.resolve([]) }), req());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stores: unknown[] }).stores).toEqual([]);
  });

  it('形の不正・不存在・範囲外の 404 は本文まで同じで、範囲外のオーナーの店舗を読まない（11.9・11.10）', async () => {
    const findOwner = vi.fn(() => Promise.resolve(null));
    const listStores = vi.fn(() => Promise.resolve([store()]));
    const malformed = await handleOwnerDetail(deps({ findOwner, listStores }, AG), req({ id: 'not-a-uuid' }));
    expect(findOwner).not.toHaveBeenCalled();
    const missing = await handleOwnerDetail(deps({ findOwner, listStores }, OP), req());
    const outOfScope = await handleOwnerDetail(deps({ findOwner, listStores }, AG), req());
    expect(listStores).not.toHaveBeenCalled();
    expect([malformed.status, missing.status, outOfScope.status]).toEqual([404, 404, 404]);
    const bodies = [await malformed.text(), await missing.text(), await outOfScope.text()];
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({
      error: { code: 'not_found', message: 'オーナーが見つかりません' },
    });
  });

  it('DAL の行に項目が増えても応答へ混ぜない（オーナーは一覧と同じ項目だけを写す）', async () => {
    const withExtra = { ...owner(), lineUserId: 'U0123456789abcdef0123456789abcdef' } as OwnerListItem;
    const res = await handleOwnerDetail(deps({ findOwner: () => Promise.resolve(withExtra) }), req());
    expect(await res.text()).not.toContain('U0123456789abcdef0123456789abcdef');
  });
});
