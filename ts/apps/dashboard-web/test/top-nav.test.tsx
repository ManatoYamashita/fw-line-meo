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

// 帯の段組み（docs/design/design-language.md 7.8・Issue #283）。
//
// 携帯端末の幅では、ワードマーク・案内 5 件・ロール・ログアウトが 1 段に収まらない。従来は
// 溢れを案内リストの内部へ閉じて横に捲れるようにしていたが、捲れる手がかりが無いため、
// 画面の外のリンク（実測で 389〜418px 分）は**存在しないように見えていた**。
//
// ここで固定するのは、段組みの切り替えが「広い画面だけの指定」として書かれていることである。
// 実際に 2 段で描かれ、全リンクが画面の中にあることは dashboard-web の E2E が実測する。
describe('帯の段組み（7.8 節・Issue #283）', () => {
  /** 帯そのものと案内リストの class 語。 */
  function bandTokens(): { nav: string[]; list: string[] } {
    const nav = screen.getByRole('navigation');
    const list = nav.querySelector('ul')!;
    const split = (element: Element) =>
      (element.getAttribute('class') ?? '').split(/\s+/).filter((token) => token.length > 0);
    return { nav: split(nav), list: split(list) };
  }

  it('DOM の順はワードマーク → 案内リンク → ロール → ログアウトで、段組みで入れ替えない', () => {
    // 見た目に合わせて DOM を並べ替えると、広い画面の帯で読み上げと焦点の順が逆にずれる。
    ready('operator');
    render(<TopNav />);
    const wordmark = screen.getByText('LINE MEO');
    const firstLink = within(screen.getByRole('navigation')).getAllByRole('link')[0]!;
    const role = screen.getByText('運営');
    const logout = screen.getByRole('button', { name: 'ログアウト' });
    const precedes = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(precedes(wordmark, firstLink)).toBe(true);
    expect(precedes(firstLink, role)).toBe(true);
    expect(precedes(role, logout)).toBe(true);
  });

  it('案内リンクは狭い画面で折り返す（横に捲る指定は広い画面にだけある）', () => {
    ready('operator');
    render(<TopNav />);
    const { list } = bandTokens();
    expect(list, '案内リンクが折り返しません（狭い画面で 1 行に並べると画面の外へ出ます）').toContain(
      'flex-wrap',
    );
    // 捲りの指定を**集合の一致**で見る。前置きの無い overflow-x-auto を足すと、狭い画面でも
    // 捲れる領域が戻り、リンクが画面の外に残ったまま緑になる。
    const overflowTokens = list.filter((token) => /(^|:)overflow-/.test(token));
    expect(overflowTokens).toEqual(['lg:overflow-x-auto']);
  });

  it('帯の高さの固定は広い画面にだけある（狭い画面では段数で高さが決まる）', () => {
    ready('operator');
    render(<TopNav />);
    const { nav } = bandTokens();
    const heightTokens = nav.filter((token) => /(^|:)h-\d+$/.test(token));
    expect(
      heightTokens,
      '狭い画面で高さを固定すると、2 段目が帯の外へはみ出して下の見出しに重なります',
    ).toEqual(['lg:h-20']);
  });
});
