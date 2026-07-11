import { describe, it, expect, vi } from 'vitest';
import { authenticate, canAccessStore, type AuthDeps } from '../src/auth.js';
import type { DashboardUserIdentity } from '@fwlm/db';

const OP: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };

function deps(over: Partial<AuthDeps> = {}): AuthDeps {
  return {
    verifier: { verifyIdToken: (t) => Promise.resolve({ uid: `uid-${t}` }) },
    findUser: () => Promise.resolve(OP),
    ...over,
  };
}

describe('authenticate', () => {
  it('トークン無しは unauthenticated', async () => {
    expect((await authenticate(deps(), undefined)).kind).toBe('unauthenticated');
  });

  it('Bearer 形式でないヘッダは unauthenticated', async () => {
    expect((await authenticate(deps(), 'Basic abc')).kind).toBe('unauthenticated');
  });

  it('空の Bearer トークンは unauthenticated', async () => {
    expect((await authenticate(deps(), 'Bearer ')).kind).toBe('unauthenticated');
  });

  it('トークン検証失敗は unauthenticated', async () => {
    const verifier = { verifyIdToken: () => Promise.reject(new Error('invalid')) };
    expect((await authenticate(deps({ verifier }), 'Bearer bad')).kind).toBe('unauthenticated');
  });

  it('有効トークンだが未登録 UID は unregistered', async () => {
    const res = await authenticate(deps({ findUser: () => Promise.resolve(null) }), 'Bearer good');
    expect(res.kind).toBe('unregistered');
  });

  it('登録済みユーザーは authenticated（uid で照合）', async () => {
    const findUser = vi.fn(() => Promise.resolve(AG));
    const res = await authenticate(deps({ findUser }), 'Bearer tok');
    expect(res.kind).toBe('authenticated');
    if (res.kind === 'authenticated') expect(res.user).toEqual(AG);
    expect(findUser).toHaveBeenCalledWith('uid-tok');
  });
});

describe('canAccessStore', () => {
  it('operator は全店許可', () => {
    expect(canAccessStore(OP, 'ag1')).toBe(true);
    expect(canAccessStore(OP, 'ag2')).toBe(true);
  });

  it('agency は担当代理店の店舗のみ許可', () => {
    expect(canAccessStore(AG, 'ag1')).toBe(true); // 担当
    expect(canAccessStore(AG, 'ag2')).toBe(false); // 他店
  });

  it('agency で agencyId が null なら false（fail-closed）', () => {
    const bad: DashboardUserIdentity = { id: 'u3', role: 'agency', operatorId: 'op1', agencyId: null };
    expect(canAccessStore(bad, 'ag1')).toBe(false);
  });
});
