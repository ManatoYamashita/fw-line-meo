// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// firebase の認証状態変化を手動で駆動するため、onAuthStateChanged のコールバックを捕捉する。
let authCallback: ((user: unknown) => void | Promise<void>) | null = null;
const signOutMock = vi.fn().mockResolvedValue(undefined);
const signInWithPopupMock = vi.fn().mockResolvedValue({});
const notifyActionErrorMock = vi.fn();
const notifyActionSuccessMock = vi.fn();

vi.mock('../src/lib/action-feedback', () => ({
  notifyActionError: (...args: unknown[]) => notifyActionErrorMock(...args),
  notifyActionSuccess: (...args: unknown[]) => notifyActionSuccessMock(...args),
}));

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
  const { status, me, isSigningIn, signIn, signOut } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="me">{me ? me.role : 'null'}</span>
      <span data-testid="signing-in">{String(isSigningIn)}</span>
      <button data-testid="login" type="button" onClick={() => void signIn()}>
        login
      </button>
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
  signInWithPopupMock.mockReset().mockResolvedValue({});
  notifyActionErrorMock.mockReset();
  notifyActionSuccessMock.mockReset();
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

  it('signInWithPopup の待機中は処理中を保ち、重複したログイン要求を送らない', async () => {
    let resolvePopup!: () => void;
    signInWithPopupMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolvePopup = resolve;
      }),
    );
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByTestId('login'));
    fireEvent.click(screen.getByTestId('login'));
    expect(screen.getByTestId('signing-in').textContent).toBe('true');
    expect(signInWithPopupMock).toHaveBeenCalledTimes(1);

    await act(async () => resolvePopup());
    // ポップアップが解決しても /me が確定するまでは処理中を保つ。
    expect(screen.getByTestId('signing-in').textContent).toBe('true');
  });

  it('ポップアップを利用者が閉じた場合は失敗を通知せず処理中を解除する', async () => {
    signInWithPopupMock.mockRejectedValue({
      code: 'auth/popup-closed-by-user',
      message: 'The popup has been closed by the user.',
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByTestId('login'));
    await waitFor(() => expect(screen.getByTestId('signing-in').textContent).toBe('false'));
    expect(notifyActionErrorMock).not.toHaveBeenCalled();
  });

  it('保存領域の失敗は内部エラーを出さず、空き容量と再起動を案内する', async () => {
    const internalMessage = 'IO error: /private/000471.ldb: Unable to create writable file';
    signInWithPopupMock.mockRejectedValue({ code: 'auth/internal-error', message: internalMessage });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByTestId('login'));
    await waitFor(() => expect(notifyActionErrorMock).toHaveBeenCalledTimes(1));
    const copy = notifyActionErrorMock.mock.calls[0]?.[0] as {
      title: string;
      description: string;
    };
    expect(copy.title).toBe('ログイン情報を保存できませんでした');
    expect(copy.description).toContain('空き容量');
    expect(JSON.stringify(copy)).not.toContain(internalMessage);
    expect(screen.getByTestId('signing-in').textContent).toBe('false');
  });

  it('ログイン操作後に /me が成功すると成功を通知し、処理中を解除する', async () => {
    getMeMock.mockResolvedValue({
      ok: true,
      value: { role: 'operator', agencyId: null, agencyName: null, displayName: '運営太郎' },
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByTestId('login'));
    await act(async () => {
      await authCallback!(signedInUser());
    });
    expect(notifyActionSuccessMock).toHaveBeenCalledWith({ title: 'ログインしました。' });
    expect(screen.getByTestId('signing-in').textContent).toBe('false');
    expect(screen.getByTestId('status').textContent).toBe('ready');
  });

  it('/me の失敗は API の内部文言を出さず、再試行方法を通知する', async () => {
    const internalMessage = 'database connection refused';
    getMeMock.mockResolvedValue({ ok: false, code: 'internal', message: internalMessage });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await act(async () => {
      await authCallback!(signedInUser());
    });
    expect(screen.getByTestId('status').textContent).toBe('signedOut');
    expect(notifyActionErrorMock).toHaveBeenCalledTimes(1);
    const copy = notifyActionErrorMock.mock.calls[0]?.[0];
    expect(JSON.stringify(copy)).not.toContain(internalMessage);
    expect(JSON.stringify(copy)).toContain('時間をおいて');
  });
});
