// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { textLinkVariants } from '@fwlm/ui/components/text-link';

const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & import('react').ComponentProps<'a'>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { AgencyName, EntityLink } from '../src/components/entity-link';

// 一覧の名前から詳細への導線（agency-dashboard Requirement 10.1–10.4・10.8・Issue #526・tasks 9.3）。

const AGENCY_ID = 'abcdef22-2222-2222-2222-222222222222';

function asRole(role: 'operator' | 'agency') {
  useAuthMock.mockReturnValue({
    status: 'ready',
    me: { role, agencyId: role === 'agency' ? AGENCY_ID : null, agencyName: null, displayName: null },
  });
}

afterEach(() => {
  cleanup();
  useAuthMock.mockReset();
});

describe('EntityLink', () => {
  it('名前を、渡した経路への文字のリンクとして描く（10.8）', () => {
    render(<EntityLink href="/stores/x">テスト店</EntityLink>);
    const link = screen.getByRole('link', { name: 'テスト店' });
    expect(link.getAttribute('href')).toBe('/stores/x');
    // 下線の見た目は textLinkVariants の 1 か所で決まる（§7.21）
    expect(link.className).toBe(textLinkVariants());
  });
});

describe('AgencyName', () => {
  it('運営には、代理店の詳細へのリンクとして描く（10.3）', () => {
    asRole('operator');
    render(<AgencyName agencyId={AGENCY_ID} name="テスト代理店" />);
    const link = screen.getByRole('link', { name: 'テスト代理店' });
    expect(link.getAttribute('href')).toBe(`/admin/agencies/${AGENCY_ID}`);
  });

  it('代理店ロールには、リンクにせず素の文字で描く（10.4）', () => {
    asRole('agency');
    render(<AgencyName agencyId={AGENCY_ID} name="テスト代理店" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('テスト代理店')).toBeTruthy();
  });

  it('利用者の情報が無いあいだもリンクにしない（運営と確かめるまで導線を出さない）', () => {
    useAuthMock.mockReturnValue({ status: 'loading', me: null });
    render(<AgencyName agencyId={AGENCY_ID} name="テスト代理店" />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
