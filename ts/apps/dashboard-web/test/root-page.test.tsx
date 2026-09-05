// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { announcedText, ownText } from './live-region';

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

  // 一時表示の文言には task 2.2 の着手時点でアサーションが 1 件も無かった（実測）。
  // 部品へ移す前の文言をここで固定する。この画面の三点リーダは **U+2026** であり、
  // 認可ガード（components/auth-guard.tsx）の ASCII 3 点とは別の文字である。
  // 見た目がほぼ同じなので、一括置換で揃えると誰も気づかないまま文言が変わる（Req 3.2）。
  it('状態確定前は「読み込み中…」を提示する（三点リーダは U+2026）', () => {
    useAuthMock.mockReturnValue({ status: 'loading', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<Home />);
    expect(screen.getByText('読み込み中…')).toBeTruthy();
    expect(screen.queryByText('読み込み中...')).toBeNull();
  });

  it('処理中の読み上げ領域は 1 つで、文言は可視テキストのまま残る（Req 1.1, 4.5）', () => {
    useAuthMock.mockReturnValue({ status: 'loading', me: null, signIn: vi.fn(), signOut: vi.fn() });
    render(<Home />);
    // 領域が 2 つになるのは、装飾として添えた Spinner が aria-hidden を失ったとき。
    // Spinner のラッパは自身が role="status" を持つため、外し忘れると読み上げが二重になる。
    const regions = screen.getAllByRole('status');
    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    // 直下のテキストノードとして置く。Spinner の aria-label へ移すと文言は sr-only の
    // 子要素へ落ち、動き低減設定でない実ブラウザでは見えなくなる（Req 4.5）。
    expect(ownText(region)).toBe('読み込み中…');
    // 読み上げられるのはこの文言だけである。
    expect(announcedText(region)).toBe('読み込み中…');
  });

  it('一時表示は共通の版面に載り、主要領域を 1 つに保つ（Req 1.5, 3.3）', () => {
    useAuthMock.mockReturnValue({ status: 'loading', me: null, signIn: vi.fn(), signOut: vi.fn() });
    const { container } = render(<Home />);
    const shell = container.querySelector('[data-slot="page-shell"]');
    expect(shell).not.toBeNull();
    expect(shell!.tagName).toBe('MAIN');
    expect(container.querySelectorAll('main')).toHaveLength(1);
  });
});
