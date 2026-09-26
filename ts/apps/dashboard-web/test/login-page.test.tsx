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

  it('主操作は押下で signIn を呼び、処理中も焦点を残して重複押下を止める（Req 3.5）', () => {
    const signIn = vi.fn();
    useAuthMock.mockReturnValue({ status: 'signedOut', me: null, signIn, signOut: vi.fn() });
    render(<LoginPage />);
    const button = screen.getByRole('button', { name: 'Google でログイン' });
    // 通常時は無効ではない。
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(signIn).toHaveBeenCalledTimes(1);

    cleanup();
    useAuthMock.mockReturnValue({ status: 'loading', me: null, signIn, signOut: vi.fn() });
    render(<LoginPage />);
    const pendingButton = screen.getByRole('button', { name: 'Google でログイン' });
    expect(pendingButton.hasAttribute('disabled')).toBe(false);
    expect(pendingButton.getAttribute('aria-disabled')).toBe('true');
    expect(pendingButton.getAttribute('aria-busy')).toBe('true');
    expect(pendingButton.querySelector('[data-slot="spinner"]')).not.toBeNull();
  });

  // 題と assert をずらさない。ここは画面全体の読み上げに案内文が含まれることを見る包含判定であり、
  // 文言そのものの完全一致は下の「主見出しの説明文として置き」が toBe で固定する。
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

  // 案内文は画面の説明であって、状態の変化を知らせる通知ではない（design-language 7.9 節・9 節）。
  // 通知の部品で描くと、枠のある箱が入力欄のように見えるうえ、変化しない文言が読み上げ領域に載る。
  it('通常分岐の案内は主見出しの説明文として置き、通知にも読み上げ領域にも載せない（Req 1.1）', () => {
    useAuthMock.mockReturnValue({ status: 'signedOut', me: null, signIn: vi.fn(), signOut: vi.fn() });
    const { container } = render(<LoginPage />);
    const description = container.querySelector('[data-slot="page-header-description"]');
    expect(description).not.toBeNull();
    expect(announcedText(description!)).toBe(
      '運営・代理店向けダッシュボードです。Google アカウントでログインしてください。',
    );
    expect(description!.closest('[data-slot="alert"]')).toBeNull();
    expect(screen.queryAllByRole('status')).toHaveLength(0);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('どの分岐でも主見出しは見出し周りの部品が描き、第 1 見出しは「ログイン」の 1 つだけである（Req 1.1）', () => {
    for (const status of ['signedOut', 'loading', 'unregistered'] as const) {
      useAuthMock.mockReturnValue({ status, me: null, signIn: vi.fn(), signOut: vi.fn() });
      const { container } = render(<LoginPage />);
      const headings = screen.getAllByRole('heading', { level: 1 });
      expect(headings, status).toHaveLength(1);
      expect(headings[0]!.textContent, status).toBe('ログイン');
      expect(headings[0]!.closest('[data-slot="page-header"]'), status).not.toBeNull();
      expect(container.querySelectorAll('[data-slot="page-header"]'), status).toHaveLength(1);
      cleanup();
    }
  });

  it('どの分岐でもワードマークの面の役割を装飾専用色の大きい文字として置き、操作の個数を増やさない（Req 1.1, 3.3）', () => {
    for (const status of ['signedOut', 'unregistered'] as const) {
      useAuthMock.mockReturnValue({ status, me: null, signIn: vi.fn(), signOut: vi.fn() });
      render(<LoginPage />);
      // 文字列は帯（top-nav）と同一。§7.4 はブランド色の使い所を帯とログインの 2 箇所に限る。
      const wordmark = screen.getByText('Firstweb 集客AIアシスタント');
      // **包含では足りない。** 別の文字色を後ろへ足せば、宣言した色は残ったまま実描画では負ける。
      // 文字寸法と文字色を与えるクラスの集合そのものを完全一致で固定する。
      // アプリ名は補足の色の小さい文字で添える。装飾専用色は小さい文字に使えない（§2.2 / §10）。
      const textOf = (el: HTMLElement) => el.className.split(/\s+/).filter((t) => /(^|:)text-/.test(t)).sort();
      expect(textOf(wordmark), status).toEqual(['text-muted-foreground', 'text-xs']);
      // 面の役割を装飾専用色の大きい文字で置く（§7.4 はブランド色を 1 画面 1〜2 箇所に限る）。
      // 装飾専用色は白背景に対して通常文字の閾値へ届かないため、大きい文字としてのみ用いる。
      // 20px（text-xl）の太字は WCAG の大きい文字（14pt の太字＝約 18.66px 以上）に入る。
      // 太字を外すと大きい文字でなくなるので、太さも併せて固定する。
      const surface = screen.getByText('管理用ダッシュボード');
      expect(textOf(surface), status).toEqual(['text-brand', 'text-xl']);
      expect(surface.className.split(/\s+/), status).toContain('font-bold');
      // 上の段がアプリ名、下の段が面の役割（読み上げの順も同じ）。
      expect(wordmark.compareDocumentPosition(surface) & Node.DOCUMENT_POSITION_FOLLOWING, status).toBeTruthy();
      // アイコンは名前と同じことを言う装飾なので読み上げない。
      const icons = wordmark.closest('[data-slot="wordmark"]')!.querySelectorAll('img');
      expect(icons, status).toHaveLength(1);
      expect(icons[0]!.getAttribute('alt'), status).toBe('');
      expect(icons[0]!.getAttribute('src'), status).toBe('/brand-icon.png');
      // 最初から見える位置にあるので遅延読み込みにしない。
      expect(icons[0]!.getAttribute('loading'), status).toBe('eager');
      // リンクにも押しボタンにもしない（個数を固定した構造契約・Req 3.3）。
      expect(wordmark.closest('a'), status).toBeNull();
      expect(wordmark.closest('button'), status).toBeNull();
      cleanup();
    }
  });

  // 「Google でログイン」ボタンは Sign in with Google の規定（Light）で描く（Issue #146・design-language 7.9 節）。
  // G ロゴを規定外の背景（アクション色の塗り）へ置くことは規定が禁じている。
  it('主操作は Google の規定色で塗り、アクション色を使わない', () => {
    useAuthMock.mockReturnValue({ status: 'signedOut', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<LoginPage />);
    const tokens = screen.getByRole('button', { name: 'Google でログイン' }).className.split(/\s+/);
    for (const required of [
      'bg-google-sign-in-fill',
      'border-google-sign-in-border',
      'text-google-sign-in-foreground',
    ]) {
      expect(tokens, required).toContain(required);
    }
    // 塗り・文字の色を与えるクラスは規定のトークンだけ（hover を含む）。アクション色や outline の hover 色が
    // 残ると、G ロゴがその色の上に載る。
    const colorTokens = tokens.filter((t) => /(^|:)(bg|text)-(?!sm$|xs$|base$|lg$|xl$|2xl$|clip-)/.test(t));
    expect(colorTokens.every((t) => /google-sign-in-/.test(t)), colorTokens.join(' ')).toBe(true);
  });

  it('G ロゴは公式素材を 20px で置き、装飾として読み上げない', () => {
    useAuthMock.mockReturnValue({ status: 'signedOut', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<LoginPage />);
    const button = screen.getByRole('button', { name: 'Google でログイン' });
    const images = button.querySelectorAll('img');
    expect(images).toHaveLength(1);
    const logo = images[0]!;
    expect(logo.getAttribute('src')).toBe('/google-g-logo.png');
    expect(logo.getAttribute('alt')).toBe('');
    expect(logo.getAttribute('width')).toBe('20');
    expect(logo.getAttribute('height')).toBe('20');
    // ロゴは文字より前（左）に置く（規定の並び）。
    expect(button.firstElementChild).toBe(logo);
  });
});
