// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { announcedText, ownText } from './live-region';

// AuthGuard は useAuth と next/navigation に依存する。両者をモックして純表示と振り分けを
// 検証する（login-page.test / root-page.test と同規約）。
const useAuthMock = vi.fn();
vi.mock('../src/lib/auth-context', () => ({ useAuth: () => useAuthMock() }));

const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: replaceMock }),
}));

import { AuthGuard } from '../src/components/auth-guard';

/** 認可ガードの配下に置かれる管理データの代役。ready 以外では 1 文字も描かれてはならない。 */
const PROTECTED = '保護された管理データ';

function at(status: 'loading' | 'signedOut' | 'unregistered' | 'ready') {
  useAuthMock.mockReturnValue({ status, me: null, signIn: vi.fn(), signOut: vi.fn() });
}

beforeEach(() => {
  useAuthMock.mockReset();
  replaceMock.mockClear();
});
afterEach(cleanup);

describe('AuthGuard（認可ガード）', () => {
  it('ready のときだけ子を描画する（Req 1.1）', () => {
    at('ready');
    render(
      <AuthGuard>
        <p>{PROTECTED}</p>
      </AuthGuard>,
    );
    expect(screen.getByText(PROTECTED)).toBeTruthy();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // 以下 3 件は「一時表示の文言」を固定する。task 2.2 の着手時点で、この 2 つの文言には
  // アサーションが 1 件も無かった（実測）。部品へ移すにあたって、移す前の文言を先に
  // 記録しておかないと「変えていないこと」を後から主張できない。
  it('loading では読み込み中の文言だけを出し、管理データを描画しない', () => {
    at('loading');
    render(
      <AuthGuard>
        <p>{PROTECTED}</p>
      </AuthGuard>,
    );
    // ASCII の 3 点。振り分け画面（app/page.tsx）は U+2026 を使っており、両者は別物である。
    expect(screen.getByText('読み込み中...')).toBeTruthy();
    expect(screen.queryByText('読み込み中…')).toBeNull();
    expect(screen.queryByText(PROTECTED)).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('signedOut は同じ文言を出したまま /login へ寄せる（Req 1.1）', () => {
    at('signedOut');
    render(
      <AuthGuard>
        <p>{PROTECTED}</p>
      </AuthGuard>,
    );
    expect(screen.getByText('読み込み中...')).toBeTruthy();
    expect(screen.queryByText(PROTECTED)).toBeNull();
    expect(replaceMock).toHaveBeenCalledWith('/login');
  });

  it('unregistered は利用資格がない旨を完全一致で案内し /login へ寄せる（Req 1.1）', () => {
    at('unregistered');
    render(
      <AuthGuard>
        <p>{PROTECTED}</p>
      </AuthGuard>,
    );
    expect(
      screen.getByText('このアカウントには利用資格がありません。運営までお問い合わせください。'),
    ).toBeTruthy();
    expect(screen.queryByText(PROTECTED)).toBeNull();
    expect(replaceMock).toHaveBeenCalledWith('/login');
  });

  it('処理中の読み上げ領域は 1 つで、文言は可視テキストのまま残る（Req 1.1, 4.5）', () => {
    at('loading');
    render(
      <AuthGuard>
        <p>{PROTECTED}</p>
      </AuthGuard>,
    );
    // 領域が 2 つになるのは、装飾として添えた Spinner が aria-hidden を失ったとき。
    const regions = screen.getAllByRole('status');
    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    // 直下のテキストノードとして置く。Spinner の aria-label へ移すと文言は sr-only の
    // 子要素へ落ち、動き低減設定でない実ブラウザでは見えなくなる（Req 4.5）。
    expect(ownText(region)).toBe('読み込み中...');
    expect(announcedText(region)).toBe('読み込み中...');
  });

  it('unregistered の案内は通知の部品として読み上げ領域 1 つに載る（Req 1.1）', () => {
    at('unregistered');
    render(
      <AuthGuard>
        <p>{PROTECTED}</p>
      </AuthGuard>,
    );
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(announcedText(alerts[0]!)).toBe(
      'このアカウントには利用資格がありません。運営までお問い合わせください。',
    );
    // 通知と処理中を同時に出さない（同一領域で読み上げ役割が二重にならない）。
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });

  it('ready 以外の一時表示は共通の版面に載り、主要領域を 1 つに保つ（Req 1.5, 3.3）', () => {
    for (const status of ['loading', 'signedOut', 'unregistered'] as const) {
      at(status);
      const { container } = render(
        <AuthGuard>
          <p>{PROTECTED}</p>
        </AuthGuard>,
      );
      const shell = container.querySelector('[data-slot="page-shell"]');
      expect(shell, status).not.toBeNull();
      expect(shell!.tagName, status).toBe('MAIN');
      expect(container.querySelectorAll('main'), status).toHaveLength(1);
      cleanup();
    }
  });

  it('ready では版面も読み上げ領域も持たず、子の構造へ手を入れない（Req 3.3）', () => {
    at('ready');
    const { container } = render(
      <AuthGuard>
        <p>{PROTECTED}</p>
      </AuthGuard>,
    );
    // ready の分岐は子をそのまま返す。ここに版面を足すと、子が持つ主要領域と二重になる。
    expect(container.querySelector('[data-slot="page-shell"]')).toBeNull();
    expect(screen.queryAllByRole('status')).toHaveLength(0);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
});
