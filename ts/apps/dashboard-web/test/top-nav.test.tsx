// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

// 認証コンテキストはモックし、ready な operator/agency を注入する（他ページテストと同規約）。
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import { TopNav } from '../src/components/top-nav';

function ready(role: 'operator' | 'agency') {
  useAuthMock.mockReturnValue({
    status: 'ready',
    me: {
      role,
      agencyId: role === 'agency' ? 'a1' : null,
      agencyName: role === 'agency' ? '代理店A' : null,
      displayName: 'テスト',
    },
    signIn: vi.fn(),
    signOut: vi.fn(),
  });
}

beforeEach(() => {
  useAuthMock.mockReset();
});
afterEach(cleanup);

describe('トップナビの管理メニュー（Req 6.5）', () => {
  it('operator は代理店管理・利用者管理リンクを見る', () => {
    ready('operator');
    render(<TopNav />);
    const nav = within(screen.getByRole('navigation'));
    expect(nav.getByRole('link', { name: '代理店管理' }).getAttribute('href')).toBe('/admin/agencies');
    expect(nav.getByRole('link', { name: '利用者管理' }).getAttribute('href')).toBe('/admin/users');
  });

  it('agency は代理店管理・利用者管理リンクを見ない', () => {
    ready('agency');
    render(<TopNav />);
    const nav = within(screen.getByRole('navigation'));
    expect(nav.queryByRole('link', { name: '代理店管理' })).toBeNull();
    expect(nav.queryByRole('link', { name: '利用者管理' })).toBeNull();
  });
});
