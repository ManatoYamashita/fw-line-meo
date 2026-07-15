import { describe, it, expect, vi } from 'vitest';
import { authenticate, canAccessStore, type AuthDeps, type VerifiedToken } from '../src/auth.js';
import type { DashboardUserIdentity, DashboardUserResolution } from '@fwlm/db';

// 純粋ユニット（DB 不要・依存はモック）。認証拡張（初回リンク・無効化）と RBAC の基礎判定を検証する。
const OP_ID: DashboardUserIdentity = { id: 'u1', role: 'operator', operatorId: 'op1', agencyId: null };
const AG_ID: DashboardUserIdentity = { id: 'u2', role: 'agency', operatorId: 'op1', agencyId: 'ag1' };
const RES_OP: DashboardUserResolution = { ...OP_ID, disabled: false };
const RES_AG: DashboardUserResolution = { ...AG_ID, disabled: false };
const RES_DISABLED: DashboardUserResolution = { ...AG_ID, disabled: true };

function token(over: Partial<VerifiedToken> = {}): VerifiedToken {
  return { uid: 'uid-x', email: null, emailVerified: false, signInProvider: null, ...over };
}

function deps(over: Partial<AuthDeps> = {}): AuthDeps {
  return {
    verifier: { verifyIdToken: (t) => Promise.resolve(token({ uid: `uid-${t}` })) },
    findUser: () => Promise.resolve(RES_OP),
    linkByEmail: () => Promise.resolve(null),
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

  it('登録済み・有効ユーザーは authenticated（uid で照合・身元のみ返す）', async () => {
    const findUser = vi.fn(() => Promise.resolve(RES_AG));
    const res = await authenticate(deps({ findUser }), 'Bearer tok');
    expect(res.kind).toBe('authenticated');
    // authenticated の user は id/role/operatorId/agencyId のみ（disabled は含めない）
    if (res.kind === 'authenticated') expect(res.user).toEqual(AG_ID);
    expect(findUser).toHaveBeenCalledWith('uid-tok');
  });

  it('無効化済みユーザーは disabled（403 相当）', async () => {
    const res = await authenticate(deps({ findUser: () => Promise.resolve(RES_DISABLED) }), 'Bearer tok');
    expect(res.kind).toBe('disabled');
  });

  it('未登録 UID + 検証済み Google メールでリンク成功なら authenticated', async () => {
    const linkByEmail = vi.fn(() => Promise.resolve(AG_ID));
    const verifier = {
      verifyIdToken: () =>
        Promise.resolve(token({ uid: 'uid-new', email: 'user@example.com', emailVerified: true, signInProvider: 'google.com' })),
    };
    const res = await authenticate(deps({ findUser: () => Promise.resolve(null), linkByEmail, verifier }), 'Bearer tok');
    expect(res.kind).toBe('authenticated');
    if (res.kind === 'authenticated') expect(res.user).toEqual(AG_ID);
    expect(linkByEmail).toHaveBeenCalledWith('user@example.com', 'uid-new');
  });

  it('未登録 UID + 検証済み Google メールだが保留行なし（link=null）は unregistered', async () => {
    const linkByEmail = vi.fn(() => Promise.resolve(null));
    const verifier = {
      verifyIdToken: () =>
        Promise.resolve(token({ uid: 'uid-new', email: 'user@example.com', emailVerified: true, signInProvider: 'google.com' })),
    };
    const res = await authenticate(deps({ findUser: () => Promise.resolve(null), linkByEmail, verifier }), 'Bearer tok');
    expect(res.kind).toBe('unregistered');
    expect(linkByEmail).toHaveBeenCalledTimes(1);
  });

  it('未登録 UID + Google 以外のプロバイダは linkByEmail を呼ばず unregistered（乗っ取り防止）', async () => {
    const linkByEmail = vi.fn(() => Promise.resolve(AG_ID));
    const verifier = {
      verifyIdToken: () =>
        Promise.resolve(token({ uid: 'uid-new', email: 'user@example.com', emailVerified: true, signInProvider: 'password' })),
    };
    const res = await authenticate(deps({ findUser: () => Promise.resolve(null), linkByEmail, verifier }), 'Bearer tok');
    expect(res.kind).toBe('unregistered');
    expect(linkByEmail).not.toHaveBeenCalled();
  });

  it('未登録 UID + email_verified=false は linkByEmail を呼ばず unregistered（乗っ取り防止）', async () => {
    const linkByEmail = vi.fn(() => Promise.resolve(AG_ID));
    const verifier = {
      verifyIdToken: () =>
        Promise.resolve(token({ uid: 'uid-new', email: 'user@example.com', emailVerified: false, signInProvider: 'google.com' })),
    };
    const res = await authenticate(deps({ findUser: () => Promise.resolve(null), linkByEmail, verifier }), 'Bearer tok');
    expect(res.kind).toBe('unregistered');
    expect(linkByEmail).not.toHaveBeenCalled();
  });

  it('未登録 UID + email 欠落は linkByEmail を呼ばず unregistered', async () => {
    const linkByEmail = vi.fn(() => Promise.resolve(AG_ID));
    const verifier = {
      verifyIdToken: () =>
        Promise.resolve(token({ uid: 'uid-new', email: null, emailVerified: true, signInProvider: 'google.com' })),
    };
    const res = await authenticate(deps({ findUser: () => Promise.resolve(null), linkByEmail, verifier }), 'Bearer tok');
    expect(res.kind).toBe('unregistered');
    expect(linkByEmail).not.toHaveBeenCalled();
  });

  it('linkByEmail へ渡す email は正規化される（trim + 小文字化）', async () => {
    const linkByEmail = vi.fn(() => Promise.resolve(AG_ID));
    const verifier = {
      verifyIdToken: () =>
        Promise.resolve(token({ uid: 'uid-new', email: '  User@Example.COM  ', emailVerified: true, signInProvider: 'google.com' })),
    };
    await authenticate(deps({ findUser: () => Promise.resolve(null), linkByEmail, verifier }), 'Bearer tok');
    expect(linkByEmail).toHaveBeenCalledWith('user@example.com', 'uid-new');
  });
});

describe('canAccessStore', () => {
  it('operator は全店許可', () => {
    expect(canAccessStore(OP_ID, 'ag1')).toBe(true);
    expect(canAccessStore(OP_ID, 'ag2')).toBe(true);
  });

  it('agency は担当代理店の店舗のみ許可', () => {
    expect(canAccessStore(AG_ID, 'ag1')).toBe(true); // 担当
    expect(canAccessStore(AG_ID, 'ag2')).toBe(false); // 他店
  });

  it('agency で agencyId が null なら false（fail-closed）', () => {
    const bad: DashboardUserIdentity = { id: 'u3', role: 'agency', operatorId: 'op1', agencyId: null };
    expect(canAccessStore(bad, 'ag1')).toBe(false);
  });
});
