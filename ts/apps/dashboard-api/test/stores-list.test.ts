import { describe, it, expect, vi } from 'vitest';
import { handleStoresList, type StoresListDeps } from '../src/stores-list.js';
import type { DashboardUserIdentity, StoreListItem } from '@fwlm/db';

const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };

const CREATED_AT = new Date('2026-07-01T12:34:56.000Z');

function item(over: Partial<StoreListItem> = {}): StoreListItem {
  return {
    id: '44444444-4444-4444-4444-444444444444',
    name: 'テスト店',
    placeStatus: 'confirmed',
    competitorConfigured: true,
    ownerId: 'ow1',
    ownerDisplayName: 'オーナー太郎',
    agencyId: 'ag1',
    agencyName: 'テスト代理店',
    createdAt: CREATED_AT,
    ...over,
  };
}

function deps(
  over: Partial<StoresListDeps> = {},
  user: DashboardUserIdentity | null = OP,
  disabled = false,
): StoresListDeps {
  return {
    auth: {
      verifier: {
        verifyIdToken: (t) =>
          Promise.resolve({ uid: `uid-${t}`, email: null, emailVerified: false, signInProvider: null }),
      },
      findUser: () => Promise.resolve(user === null ? null : { ...user, disabled }),
      linkByEmail: () => Promise.resolve(null),
    },
    listStores: () => Promise.resolve([item()]),
    ...over,
  };
}

function req(over: Partial<{ authorization: string | undefined; agencyId: string | undefined }> = {}) {
  return { authorization: 'Bearer tok', agencyId: undefined, ...over };
}

describe('handleStoresList', () => {
  it('認証なしは 401（unauthenticated 封筒）', async () => {
    const res = await handleStoresList(deps(), req({ authorization: undefined }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });

  it('未登録 UID は 403', async () => {
    const res = await handleStoresList(deps({}, null), req());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
  });

  it('agency が他代理店を指定したら 403 で、listStores は呼ばれない（データアクセス前に遮断）', async () => {
    const listStores = vi.fn(() => Promise.resolve([item()]));
    const res = await handleStoresList(deps({ listStores }, AG), req({ agencyId: 'ag2' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(listStores).not.toHaveBeenCalled();
  });

  it('operator の未指定は全代理店（フィルタなしで listStores 呼び出し）', async () => {
    const listStores = vi.fn(() => Promise.resolve([item()]));
    const res = await handleStoresList(deps({ listStores }), req());
    expect(res.status).toBe(200);
    expect(listStores).toHaveBeenCalledWith({});
  });

  it('operator の agencyId 指定はその代理店で絞り込む', async () => {
    const listStores = vi.fn(() => Promise.resolve([item({ agencyId: 'ag2', agencyName: '別代理店' })]));
    const res = await handleStoresList(deps({ listStores }), req({ agencyId: 'ag2' }));
    expect(res.status).toBe(200);
    expect(listStores).toHaveBeenCalledWith({ agencyId: 'ag2' });
  });

  it('agency の未指定は常に自代理店で絞り込む', async () => {
    const listStores = vi.fn(() => Promise.resolve([item()]));
    const res = await handleStoresList(deps({ listStores }, AG), req());
    expect(res.status).toBe(200);
    expect(listStores).toHaveBeenCalledWith({ agencyId: 'ag1' });
  });

  it('0 件は 200 で空配列（404 にしない・UI が 4.4 の案内を出す）', async () => {
    const res = await handleStoresList(deps({ listStores: () => Promise.resolve([]) }), req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stores: [] });
  });

  it('各店舗に店舗特定・競合設定ステータスと代理店名を同梱し、createdAt は ISO 文字列', async () => {
    const res = await handleStoresList(deps(), req());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual({
      stores: [
        {
          id: '44444444-4444-4444-4444-444444444444',
          name: 'テスト店',
          placeStatus: 'confirmed',
          competitorConfigured: true,
          ownerId: 'ow1',
          ownerDisplayName: 'オーナー太郎',
          agencyId: 'ag1',
          agencyName: 'テスト代理店',
          createdAt: '2026-07-01T12:34:56.000Z',
        },
      ],
    });
  });
});
