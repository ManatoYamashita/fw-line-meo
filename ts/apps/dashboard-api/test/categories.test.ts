import { describe, it, expect } from 'vitest';
import { handleCategories, type CategoriesDeps } from '../src/categories.js';
import type { DashboardUserIdentity } from '@fwlm/db';

const AG: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };

const CATEGORIES = [
  { code: 'izakaya', label: '居酒屋' },
  { code: 'ramen', label: 'ラーメン' },
];

function deps(
  over: Partial<CategoriesDeps> = {},
  user: DashboardUserIdentity | null = AG,
  disabled = false,
): CategoriesDeps {
  return {
    auth: {
      verifier: {
        verifyIdToken: (t) =>
          Promise.resolve({ uid: `uid-${t}`, email: null, emailVerified: false, signInProvider: null }),
      },
      findUser: () => Promise.resolve(user === null ? null : { ...user, disabled }),
      linkByEmail: () => Promise.resolve(null),
    },
    listCategories: () => Promise.resolve(CATEGORIES),
    ...over,
  };
}

describe('handleCategories', () => {
  it('認証なしは 401（unauthenticated 封筒）', async () => {
    const res = await handleCategories(deps(), { authorization: undefined });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });

  it('未登録 UID は 403（同一封筒）', async () => {
    const res = await handleCategories(deps({}, null), { authorization: 'Bearer tok' });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
  });

  it('認証済みなら 200 でカテゴリ一覧（DAL＝seed が単一情報源）を返す', async () => {
    const res = await handleCategories(deps(), { authorization: 'Bearer tok' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual({ categories: CATEGORIES });
  });
});
