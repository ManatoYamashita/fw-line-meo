// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// firebase の認証状態変化を手動で駆動するため、onAuthStateChanged のコールバックを捕捉する。
let authCallback: ((user: unknown) => void | Promise<void>) | null = null;
const signOutMock = vi.fn().mockResolvedValue(undefined);
const signInWithRedirectMock = vi.fn().mockResolvedValue(undefined);
const getRedirectResultMock = vi.fn().mockResolvedValue(null);
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
  signInWithRedirect: (...args: unknown[]) => signInWithRedirectMock(...args),
  getRedirectResult: (...args: unknown[]) => getRedirectResultMock(...args),
  signOut: (...args: unknown[]) => signOutMock(...args),
  GoogleAuthProvider: class {},
}));

// /me の結果は api.getMe をモックして制御する（fetch は間接依存にしない）。
const getMeMock = vi.fn();
vi.mock('../src/lib/api', async () =>
  (await import('./deferred-mocks')).deferResolution({
    getMe: (...args: unknown[]) => getMeMock(...args),
  }),
);

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
  signInWithRedirectMock.mockReset().mockResolvedValue(undefined);
  getRedirectResultMock.mockReset().mockResolvedValue(null);
  window.sessionStorage.clear();
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

  it('ログインを押すと同じタブで Google へ移り、移るまで処理中を保ち、重複した要求を送らない', async () => {
    // 本物はページごと移るので解決しない。移るまでの間を模す。
    signInWithRedirectMock.mockReturnValue(new Promise<void>(() => {}));
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByTestId('login'));
    fireEvent.click(screen.getByTestId('login'));
    expect(screen.getByTestId('signing-in').textContent).toBe('true');
    expect(signInWithRedirectMock).toHaveBeenCalledTimes(1);
    // 戻ってきたときに「押したログインの戻り」と分かるよう、タブに印を残す。
    expect(window.sessionStorage.getItem('fwlm-sign-in-pending')).toBe('1');
  });

  it('Google から戻ってきて /me が成功すると成功を通知し、印を消す', async () => {
    window.sessionStorage.setItem('fwlm-sign-in-pending', '1');
    getMeMock.mockResolvedValue({
      ok: true,
      value: { role: 'operator', agencyId: null, agencyName: null, displayName: '運営太郎' },
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    // 戻ってきた直後は /me が確定するまで処理中を表示する。
    expect(screen.getByTestId('signing-in').textContent).toBe('true');
    await act(async () => {
      await authCallback!(signedInUser());
    });
    expect(notifyActionSuccessMock).toHaveBeenCalledWith({ title: 'ログインしました。' });
    expect(screen.getByTestId('signing-in').textContent).toBe('false');
    expect(window.sessionStorage.getItem('fwlm-sign-in-pending')).toBeNull();
  });

  it('印が無い読み込み（初回のセッション復元）では成功を通知しない', async () => {
    getMeMock.mockResolvedValue({
      ok: true,
      value: { role: 'operator', agencyId: null, agencyName: null, displayName: '運営太郎' },
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByTestId('signing-in').textContent).toBe('false');
    await act(async () => {
      await authCallback!(signedInUser());
    });
    expect(screen.getByTestId('status').textContent).toBe('ready');
    expect(notifyActionSuccessMock).not.toHaveBeenCalled();
  });

  it('Google の画面から「戻る」で帰ってきた（ユーザー無し）場合は、失敗を通知せず処理中と印を解く', async () => {
    window.sessionStorage.setItem('fwlm-sign-in-pending', '1');
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByTestId('signing-in').textContent).toBe('true');
    await act(async () => {
      await authCallback!(null);
    });
    expect(screen.getByTestId('signing-in').textContent).toBe('false');
    expect(screen.getByTestId('status').textContent).toBe('signedOut');
    expect(window.sessionStorage.getItem('fwlm-sign-in-pending')).toBeNull();
    expect(notifyActionErrorMock).not.toHaveBeenCalled();
  });

  it('戻ってきた後の失敗（getRedirectResult）は内部文言を出さずに通知し、処理中と印を解く', async () => {
    window.sessionStorage.setItem('fwlm-sign-in-pending', '1');
    getRedirectResultMock.mockRejectedValue({
      code: 'auth/network-request-failed',
      message: 'Firebase: Error (auth/network-request-failed).',
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(notifyActionErrorMock).toHaveBeenCalledTimes(1));
    const copy = notifyActionErrorMock.mock.calls[0]?.[0] as { title: string; description: string };
    expect(copy.title).toBe('ログインできませんでした');
    expect(JSON.stringify(copy)).not.toContain('auth/network-request-failed');
    expect(screen.getByTestId('signing-in').textContent).toBe('false');
    expect(window.sessionStorage.getItem('fwlm-sign-in-pending')).toBeNull();
  });

  it('利用者が取り消した戻り（auth/redirect-cancelled-by-user）は失敗として通知しない', async () => {
    getRedirectResultMock.mockRejectedValue({ code: 'auth/redirect-cancelled-by-user', message: 'cancelled' });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(getRedirectResultMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(notifyActionErrorMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('signing-in').textContent).toBe('false');
  });

  it('保存領域の失敗は内部エラーを出さず、空き容量と再起動を案内する', async () => {
    const internalMessage = 'IO error: /private/000471.ldb: Unable to create writable file';
    signInWithRedirectMock.mockRejectedValue({ code: 'auth/internal-error', message: internalMessage });
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
