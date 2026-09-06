// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

// 認証コンテキストはモックし、ready な operator/agency を注入する（他ページテストと同規約）。
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));
// 現在地の判定は usePathname から出る。経路を注入できるよう useAuthMock と同じ遅延クロージャ規約で偽装する。
const usePathnameMock = vi.fn();
vi.mock('next/navigation', () => ({ usePathname: () => usePathnameMock() }));
vi.mock('next/link', () => ({
  // href / children 以外の props（TopNav が現在地へ付ける aria-current と className）も素の a へ透過する。
  // 捨てると帯の現在地表現が DOM に現れず、検証が構造を掴めない。
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

import { TopNav } from '../src/components/top-nav';

function ready(role: 'operator' | 'agency') {
  // ログアウト導線の押下を照合できるよう、注入した signOut を呼び出し側へ返す。
  const signOut = vi.fn();
  useAuthMock.mockReturnValue({
    status: 'ready',
    me: {
      role,
      agencyId: role === 'agency' ? 'a1' : null,
      agencyName: role === 'agency' ? '代理店A' : null,
      displayName: 'テスト',
    },
    signIn: vi.fn(),
    signOut,
  });
  return { signOut };
}

// 現在地の経路を注入する。既定は店舗一覧（ログイン後の既定ランディング）。
function at(pathname: string) {
  usePathnameMock.mockReturnValue(pathname);
}

beforeEach(() => {
  useAuthMock.mockReset();
  usePathnameMock.mockReset();
  at('/stores');
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

// 帯の意匠（Req 1.1 / 1.3 / 3.2 / 3.3）。現在地の示し方は docs/design/design-language.md の 7.8 節、
// ワードマークの色は同 7.4 節と 10 節が正典であり、ここでは結論も数値も転記せず構造だけを固定する。
describe('トップナビの現在地とロールの提示（Req 1.1, 3.2, 3.3）', () => {
  function navLinks(): HTMLElement[] {
    return within(screen.getByRole('navigation')).getAllByRole('link');
  }

  it('operator にはロールとして「運営」を提示し「代理店」は提示しない', () => {
    ready('operator');
    render(<TopNav />);
    const nav = within(screen.getByRole('navigation'));
    expect(nav.getByText('運営')).toBeTruthy();
    expect(nav.queryByText('代理店')).toBeNull();
  });

  it('agency にはロールとして「代理店」を提示し「運営」は提示しない', () => {
    ready('agency');
    render(<TopNav />);
    const nav = within(screen.getByRole('navigation'));
    expect(nav.getByText('代理店')).toBeTruthy();
    expect(nav.queryByText('運営')).toBeNull();
  });

  it('現在地の印はちょうど 1 つで、その経路と読み上げ名が現在の経路と一致する', () => {
    const cases = [
      { pathname: '/invite-codes', label: '招待コード' },
      // 判定を前方一致にすると、この経路では /stores も現在地になり印が 2 つになる。
      { pathname: '/stores/new', label: '店舗登録' },
    ];
    // 経路が 1 件も無いとループごと飛んで緑になる。走査の非空はループの外で要求する（Req 7.4）。
    expect(cases.length).toBeGreaterThan(0);
    for (const { pathname, label } of cases) {
      ready('operator');
      at(pathname);
      render(<TopNav />);
      const links = navLinks();
      // 走査対象が 0 件のまま緑になるのを塞ぐ（Req 7.4）。
      expect(links.length).toBeGreaterThan(0);
      const current = links.filter((link) => link.getAttribute('aria-current') === 'page');
      expect(current, pathname).toHaveLength(1);
      const [marked] = current;
      expect(marked?.getAttribute('href')).toBe(pathname);
      expect(marked?.textContent).toBe(label);
      cleanup();
    }
  });

  it('下線と aria-current は同じ判定から出る（現在地でリンクの class が分岐しない）', () => {
    ready('operator');
    at('/invite-codes');
    render(<TopNav />);
    const links = navLinks();
    // 走査対象が 0 件のまま緑になるのを塞ぐ（Req 7.4）。
    expect(links.length).toBeGreaterThan(0);
    const classes = new Set(links.map((link) => link.getAttribute('class') ?? ''));
    // (1) 現在地だけが別の class を持つなら 2 以上になる。＝「属性は付かないが下線だけ付く」を排除する。
    expect(classes.size).toBe(1);
    const tokens = [...classes][0]?.split(/\s+/).filter((token) => token.length > 0) ?? [];
    expect(tokens.length).toBeGreaterThan(0);
    // (2) 既定の罫は透明。ここが色つきへ変わると、属性の有無に関係なく全リンクへ恒久的に線が出る。
    expect(tokens).toContain('border-transparent');
    // (3) 罫へ色を与える指定の集合そのものを完全一致で固定する。素の border-current を「追加」しても
    //     (1) と (2) は成立しうるため、包含ではなく集合の一致で見る。border-b-* / border-y-* も
    //     下端を塗るので同じ網に入れる（border-b-2 は太さの指定であり、末尾が数字なので入らない）。
    //     これで捕まるのは border-color を与えるクラスの追加・置換までである。text-decoration 系
    //     （underline など）や擬似要素で線を描く手口は class 文字列の照合では捕まえきれない。
    const borderColorTokens = tokens.filter((token) =>
      /(^|:)border-(?:b-|y-)?[a-z]+$/.test(token),
    );
    expect(borderColorTokens).toEqual(['border-transparent', 'aria-[current=page]:border-current']);
  });

  it('ログアウトは帯の中でただ 1 つの押しボタンで、押すと signOut が 1 回呼ばれる', () => {
    const { signOut } = ready('operator');
    render(<TopNav />);
    const nav = within(screen.getByRole('navigation'));
    // 操作要素の個数は構造契約（Req 3.3）。ロールの提示は押せない要素でなければならない。
    const buttons = nav.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    const [logout] = buttons;
    expect(logout).toBe(nav.getByRole('button', { name: 'ログアウト' }));
    expect(signOut).not.toHaveBeenCalled();
    fireEvent.click(logout as HTMLElement);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('案内領域は 1 つ、リンクの本数は従来どおり、ワードマークはリンクではない', () => {
    ready('operator');
    render(<TopNav />);
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    expect(navLinks()).toHaveLength(5);
    // ワードマークをリンクにするとリンクの個数が増え、個数を固定した構造契約が壊れる（Req 3.3）。
    expect(screen.getByText('LINE MEO').closest('a')).toBeNull();

    cleanup();

    ready('agency');
    render(<TopNav />);
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    expect(navLinks()).toHaveLength(3);
    expect(screen.getByText('LINE MEO').closest('a')).toBeNull();
  });
});
