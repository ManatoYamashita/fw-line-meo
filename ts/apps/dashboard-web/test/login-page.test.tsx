// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { announcedText } from './live-region';

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

  // 以下は task 2.2 の着手時点で固定されていなかった契約を記録する。
  // 主操作の読み上げ名（Req 3.2）・操作要素とリンクの個数（Req 3.3）・案内文の完全一致は
  // どれもアサーションが 1 件も無く、「壊れても誰も気づかない」状態だった。
  it('主操作の読み上げ名は「Google でログイン」の完全一致である（Req 3.2）', () => {
    useAuthMock.mockReturnValue({ status: 'signedOut', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<LoginPage />);
    expect(screen.getByRole('button', { name: 'Google でログイン' })).toBeTruthy();
  });

  it('操作要素は主操作の 1 つだけで、リンクを持たない（Req 3.3）', () => {
    useAuthMock.mockReturnValue({ status: 'signedOut', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<LoginPage />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('主操作は押下で signIn を呼び、状態確定前だけ標準の無効属性で止まる（Req 3.5）', () => {
    const signIn = vi.fn();
    useAuthMock.mockReturnValue({ status: 'signedOut', me: null, signIn, signOut: vi.fn() });
    render(<LoginPage />);
    const button = screen.getByRole('button', { name: 'Google でログイン' });
    // 焦点の到達を止めてよい操作なので、通知手段はブラウザ標準の無効属性である（Req 3.5）。
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(signIn).toHaveBeenCalledTimes(1);

    cleanup();
    useAuthMock.mockReturnValue({ status: 'loading', me: null, signIn, signOut: vi.fn() });
    render(<LoginPage />);
    expect(
      screen.getByRole('button', { name: 'Google でログイン' }).hasAttribute('disabled'),
    ).toBe(true);
  });

  // 題と assert をずらさない。ここは画面全体の読み上げに案内文が含まれることを見る包含判定であり、
  // 文言そのものの完全一致は下の「通知の部品として読み上げ領域 1 つに載る」が toBe で固定する。
  it('通常分岐の案内文が画面の読み上げに含まれる（Req 3.2）', () => {
    useAuthMock.mockReturnValue({ status: 'signedOut', me: null, signIn: vi.fn(), signOut: vi.fn() });
    const { container } = render(<LoginPage />);
    expect(announcedText(container)).toContain(
      '運営・代理店向けダッシュボードです。Google アカウントでログインしてください。',
    );
  });

  it('unregistered の案内文を完全一致で保ち、読み上げ領域を 1 つに保つ（Req 3.2）', () => {
    useAuthMock.mockReturnValue({ status: 'unregistered', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<LoginPage />);
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    // JSX は行末の改行を 1 つの空白へ畳むため、2 文の間に空白が 1 つ入る。
    expect(announcedText(alerts[0]!)).toBe(
      'このアカウントにはダッシュボードの利用資格がありません。 ご利用をご希望の場合は、運営までお問い合わせください。',
    );
    // 資格が無い分岐に主操作は無い（誤って押せる導線を残さない）。
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  // ここから下は意匠の適用そのものを固定する。
  // 版面と主操作の幅は docs/design/design-language.md §7.9 が正典で、ここでは参照するだけである。
  // **分岐ごとに走査する。** この画面は unregistered と通常で別々の return を持つため、
  // 片方だけを見る照合は「もう片方の版面を広い側へ変える」注入を緑のまま通す（実測して修正した）。
  it('どの分岐でも本文系の狭い版面へ置換し、主要領域を 1 つに保つ（Req 1.5, 3.3）', () => {
    for (const status of ['signedOut', 'loading', 'unregistered'] as const) {
      useAuthMock.mockReturnValue({ status, me: null, signIn: vi.fn(), signOut: vi.fn() });
      const { container } = render(<LoginPage />);
      const shell = container.querySelector('[data-slot="page-shell"]');
      expect(shell, status).not.toBeNull();
      // 版面は 2 段しかない。ログインは本文系（狭い方）を使う。
      expect(shell!.getAttribute('data-width'), status).toBe('sm');
      // 既存の main を **置換** する（入れ子にしない）。
      expect(shell!.tagName, status).toBe('MAIN');
      expect(container.querySelectorAll('main'), status).toHaveLength(1);
      cleanup();
    }
  });

  it('主操作は版面いっぱいに広がり、幅を与えるクラスは全幅の 1 つだけである（Req 1.1）', () => {
    useAuthMock.mockReturnValue({ status: 'signedOut', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<LoginPage />);
    const button = screen.getByRole('button', { name: 'Google でログイン' });
    const tokens = button.className.split(/\s+/).filter((token) => token.length > 0);
    // **包含では足りない。** `max-w-*` を足せば全幅の指定は残ったまま実際の幅は縮む。
    // 幅を与えるクラスの集合そのものを完全一致で固定する。
    const widthTokens = tokens.filter((token) => /(^|:)(?:max-|min-)?w-/.test(token));
    expect(widthTokens).toEqual(['w-full']);
  });

  it('通常分岐の案内は通知の部品として読み上げ領域 1 つに載る（Req 1.1）', () => {
    useAuthMock.mockReturnValue({ status: 'signedOut', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<LoginPage />);
    const regions = screen.getAllByRole('status');
    expect(regions).toHaveLength(1);
    expect(announcedText(regions[0]!)).toBe(
      '運営・代理店向けダッシュボードです。Google アカウントでログインしてください。',
    );
    // 案内は緊急ではない。読み上げを中断させる役割（alert）はこの分岐に出さない。
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('どの分岐でもワードマークを装飾専用色の大きい文字として置き、操作の個数を増やさない（Req 1.1, 3.3）', () => {
    for (const status of ['signedOut', 'unregistered'] as const) {
      useAuthMock.mockReturnValue({ status, me: null, signIn: vi.fn(), signOut: vi.fn() });
      render(<LoginPage />);
      // 文字列は帯（top-nav）と同一。§7.4 はブランド色の使い所を帯とログインの 2 箇所に限る。
      const wordmark = screen.getByText('LINE MEO');
      const tokens = wordmark.className.split(/\s+/).filter((token) => token.length > 0);
      // **包含では足りない。** 別の文字色を後ろへ足せば、装飾専用色は宣言に残ったまま実描画では
      // 負ける。文字寸法と文字色を与えるクラスの集合そのものを完全一致で固定する。
      // 装飾専用色は白背景に対して通常文字の閾値へ届かないため、大きい文字としてのみ用いる（§2.2 / §10）。
      const textTokens = tokens.filter((token) => /(^|:)text-/.test(token));
      expect(textTokens, status).toEqual(['text-2xl', 'text-brand']);
      // リンクにも押しボタンにもしない（個数を固定した構造契約・Req 3.3）。
      expect(wordmark.closest('a'), status).toBeNull();
      expect(wordmark.closest('button'), status).toBeNull();
      cleanup();
    }
  });
});
