// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// login/page は useAuth と next/navigation に依存する。両者をモックして純表示を検証する。
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: replaceMock }),
}));

import LoginPage from '../src/app/login/page';

afterEach(cleanup);

describe('LoginPage', () => {
  it('未認証では Google ログインボタンを表示する（Req 1.1）', () => {
    useAuthMock.mockReturnValue({ status: 'signedOut', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<LoginPage />);
    expect(screen.getByRole('button', { name: /Google/ })).toBeTruthy();
  });

  it('status=unregistered で利用資格がない旨を案内し管理データを一切表示しない（Req 1.3）', () => {
    useAuthMock.mockReturnValue({ status: 'unregistered', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<LoginPage />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent ?? '').toContain('利用資格');
    // 店舗一覧などの管理データを描画しないこと。
    expect(screen.queryByText('店舗一覧')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
