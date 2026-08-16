// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

// firebase の認証状態変化を手動で駆動するため、onAuthStateChanged のコールバックを捕捉する。
let authCallback: ((user: unknown) => void | Promise<void>) | null = null;
const signOutMock = vi.fn().mockResolvedValue(undefined);
const signInWithPopupMock = vi.fn().mockResolvedValue({});

vi.mock('../src/lib/firebase', () => ({ getFirebaseAuth: () => ({ name: 'test-auth' }) }));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (user: unknown) => void | Promise<void>) => {
    authCallback = cb;
    return () => {
      authCallback = null;
    };
  },
  signInWithPopup: (...args: unknown[]) => signInWithPopupMock(...args),
  signOut: (...args: unknown[]) => signOutMock(...args),
  GoogleAuthProvider: class {},
}));

// /me の結果は api.getMe をモックして制御する（fetch は間接依存にしない）。
const getMeMock = vi.fn();
vi.mock('../src/lib/api', () => ({ getMe: (...args: unknown[]) => getMeMock(...args) }));

import { AuthProvider, useAuth } from '../src/lib/auth-context';

function Probe(): ReactNode {
  const { status, me, signOut } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="me">{me ? me.role : 'null'}</span>
      <button data-testid="logout" type="button" onClick={() => void signOut()}>
        logout
      </button>
    </div>
  );
}

function signedInUser() {
  return { getIdToken: () => Promise.resolve('id-token') };
}

beforeEach(() => {
  authCallback = null;
  signOutMock.mockClear();
  signInWithPopupMock.mockClear();
  getMeMock.mockReset();
});
afterEach(cleanup);

describe('AuthProvider / useAuth', () => {
  it('サインイン後に /me 200 で status=ready・me を保持する', async () => {
    getMeMock.mockResolvedValue({
      ok: true,
      value: { role: 'operator', agencyId: null, agencyName: null, displayName: '運営太郎' },
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await act(async () => {
      await authCallback!(signedInUser());
    });
    expect(screen.getByTestId('status').textContent).toBe('ready');
    expect(screen.getByTestId('me').textContent).toBe('operator');
  });

  it('/me 403(forbidden) で Firebase signOut を呼び status=unregistered・me は null のまま（Req 1.3）', async () => {
    getMeMock.mockResolvedValue({ ok: false, code: 'forbidden', message: 'アクセス権がありません' });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await act(async () => {
      await authCallback!(signedInUser());
    });
    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('status').textContent).toBe('unregistered');
    expect(screen.getByTestId('me').textContent).toBe('null');
  });

  it('signOut() で status=signedOut に戻る（Req 1.4）', async () => {
    getMeMock.mockResolvedValue({
      ok: true,
      value: { role: 'agency', agencyId: 'a1', agencyName: '代理店A', displayName: null },
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await act(async () => {
      await authCallback!(signedInUser());
    });
    expect(screen.getByTestId('status').textContent).toBe('ready');
    await act(async () => {
      fireEvent.click(screen.getByTestId('logout'));
    });
    expect(signOutMock).toHaveBeenCalled();
    expect(screen.getByTestId('status').textContent).toBe('signedOut');
  });
});
