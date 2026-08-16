// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// app/page は useAuth と next/navigation に依存する。両者をモックして振り分けを検証する
// （login-page.test と同規約）。
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: replaceMock }),
}));

import Home from '../src/app/page';

afterEach(() => {
  cleanup();
  replaceMock.mockClear();
});

describe('Home（ルート振り分け）', () => {
  it('未認証（signedOut）は /login へ replace する（Req 1.1）', () => {
    useAuthMock.mockReturnValue({ status: 'signedOut', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<Home />);
    expect(replaceMock).toHaveBeenCalledWith('/login');
  });

  it('unregistered も /login へ送る（ログイン画面が資格なし案内を表示する・Req 1.3）', () => {
    useAuthMock.mockReturnValue({ status: 'unregistered', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<Home />);
    expect(replaceMock).toHaveBeenCalledWith('/login');
  });

  it('認証済み（ready）は /stores へ replace する（Req 1.2）', () => {
    useAuthMock.mockReturnValue({ status: 'ready', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<Home />);
    expect(replaceMock).toHaveBeenCalledWith('/stores');
  });

  it('状態確定前（loading）は遷移しない', () => {
    useAuthMock.mockReturnValue({ status: 'loading', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<Home />);
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
