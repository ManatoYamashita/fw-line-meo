import { describe, it, expect, vi } from 'vitest';
import { handleMe, type MeDeps } from '../src/me.js';
import type { DashboardUserIdentity } from '@fwlm/db';

const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };

function deps(
  over: Partial<MeDeps> = {},
  user: DashboardUserIdentity | null = OP,
  disabled = false,
): MeDeps {
  return {
    auth: {
      verifier: {
        verifyIdToken: (t) =>
          Promise.resolve({ uid: `uid-${t}`, email: null, emailVerified: false, signInProvider: null }),
      },
      findUser: () => Promise.resolve(user === null ? null : { ...user, disabled }),
      linkByEmail: () => Promise.resolve(null),
    },
    findAgencyName: (agencyId) => Promise.resolve(agencyId === 'ag1' ? 'テスト代理店' : null),
    findDisplayName: () => Promise.resolve('山田太郎'),
    ...over,
  };
}

function req(over: Partial<{ authorization: string | undefined }> = {}) {
  return { authorization: 'Bearer tok', ...over };
}

describe('handleMe', () => {
  it('認証なしは 401（unauthenticated 封筒）', async () => {
    const res = await handleMe(deps(), req({ authorization: undefined }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthenticated');
    expect(typeof body.error.message).toBe('string');
  });

  it('未登録 UID は 403（forbidden 封筒）', async () => {
    const res = await handleMe(deps({}, null), req());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
  });

  it('無効化済みは 403（未登録と完全に同一の封筒・存在有無を漏らさない）', async () => {
    const unregistered = await handleMe(deps({}, null), req());
    const disabled = await handleMe(deps({}, AG, true), req());
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toEqual(await unregistered.json());
  });

  it('operator は 200 で agencyId/agencyName が null', async () => {
    const findAgencyName = vi.fn(() => Promise.resolve('呼ばれないはず'));
    const res = await handleMe(deps({ findAgencyName }), req());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual({
      user: { role: 'operator', agencyId: null, agencyName: null, displayName: '山田太郎' },
    });
    // operator に代理店は無いので名前解決を呼ばない（不要な DB アクセスをしない）
    expect(findAgencyName).not.toHaveBeenCalled();
  });

  it('agency は 200 で自代理店の agencyId と解決済み agencyName を返す', async () => {
    const res = await handleMe(deps({}, AG), req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { role: 'agency', agencyId: 'ag1', agencyName: 'テスト代理店', displayName: '山田太郎' },
    });
  });
});
