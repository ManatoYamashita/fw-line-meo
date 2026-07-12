// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import type { StoreDetailResult } from '../lib/data';

// Task 5.3: 詳細閲覧画面（実データ描画・LIFF 認可・エラー分岐・no-write 構造保証）を検証する。
// task 2.3 のプレースホルダ検証を置き換える（プレースホルダ文言は本タスクで撤去済み）が、
// 「書込操作を一切含まない」というコア保証は本ファイルでも維持・強化して検証する。

// --- @line/liff のモック（vi.hoisted でモジュール初期化前に参照可能にする） -----------------
const liffMocks = vi.hoisted(() => ({
  init: vi.fn(),
  isLoggedIn: vi.fn(),
  getIDToken: vi.fn(),
  login: vi.fn(),
}));

vi.mock('@line/liff', () => ({
  default: liffMocks,
}));

import StorePage from '../app/store/page';

// --- fetch のモック（survey-web/test/survey-shell.test.tsx の stubFetch パターンに倣う） -----

interface RouteResp {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

function stubFetch(resp: RouteResp): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() =>
    Promise.resolve({
      ok: resp.ok,
      status: resp.status,
      json: () => Promise.resolve(resp.body),
    }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

const mockResult: StoreDetailResult = {
  storeId: 'store-1',
  summary: {
    summaryDate: '2026-07-11',
    status: 'ready',
    rank: 2,
    rankTotal: 5,
    rankPrev: 3,
    rating: '4.5',
    reviewCount: 120,
    ratingPrev: '4.4',
    reviewCountPrev: 115,
    newReviewCount: 2,
    newReviews: [
      { authorName: '山田太郎', publishTime: '2026-07-11T08:00:00Z', rating: 5, textExcerpt: 'とても美味しかったです' },
    ],
  },
  competitors: [{ name: '競合A', rating: '4.2', reviewCount: 80, starDiff: '+0.3' }],
  trend: [
    { capturedOn: '2026-07-10', rank: 3, rating: '4.4', reviewCount: 115 },
    { capturedOn: '2026-07-11', rank: 2, rating: '4.5', reviewCount: 120 },
  ],
};

describe('store detail page', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_LIFF_ID = 'test-liff-id';
    liffMocks.init.mockReset().mockResolvedValue(undefined);
    liffMocks.isLoggedIn.mockReset().mockReturnValue(true);
    liffMocks.getIDToken.mockReset().mockReturnValue('test-id-token');
    liffMocks.login.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_LIFF_ID;
  });

  it('読み込み中の表示のあと実データ（順位・自店評価・競合・Google帰属）を描画する', async () => {
    stubFetch({ ok: true, status: 200, body: mockResult });

    render(<StorePage />);

    // ローディング状態がまず表示される。
    expect(screen.getByText('読み込み中です…')).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText(/近隣5店中\s*2位/)).toBeDefined();
    });

    expect(screen.getByText(/★4\.5/)).toBeDefined();
    expect(screen.getByText(/2件の新着クチコミ/)).toBeDefined();
    expect(screen.getByText(/競合A/)).toBeDefined();
    expect(screen.getByText('データ提供: Google Maps')).toBeDefined();

    // LIFF ID トークンを Authorization ヘッダに載せて GET している。
    expect(fetch).toHaveBeenCalledWith(
      '/api/detail',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer test-id-token' },
      }),
    );
  });

  it('競合0件・当日サマリー無しでもクラッシュせず適切な文言を表示する', async () => {
    const emptyResult: StoreDetailResult = {
      storeId: 'store-1',
      summary: null,
      competitors: [],
      trend: [],
    };
    stubFetch({ ok: true, status: 200, body: emptyResult });

    render(<StorePage />);

    await waitFor(() => {
      expect(screen.getByText('本日分のデータはまだ準備中です。しばらくしてから再度お試しください。')).toBeDefined();
    });
    expect(screen.getByText('競合が見つかっていません（自店のみの計測です）')).toBeDefined();
    expect(screen.getByText('推移データがありません')).toBeDefined();
    expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
  });

  it('401 応答時にクラッシュせず日本語のエラーメッセージを表示する', async () => {
    stubFetch({ ok: false, status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x' } } });

    render(<StorePage />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('認証に失敗しました');
    });
  });

  it('404（店舗未特定・AMBIGUOUS_STORE 双方が該当しうる）応答時に「店舗情報を取得できませんでした」を表示する', async () => {
    stubFetch({ ok: false, status: 404, body: { error: { code: 'STORE_NOT_FOUND', message: 'x' } } });

    render(<StorePage />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('店舗情報を取得できませんでした');
    });
  });

  it('500 応答時にクラッシュせず日本語のエラーメッセージを表示する', async () => {
    stubFetch({ ok: false, status: 500, body: { error: { code: 'INTERNAL', message: 'x' } } });

    render(<StorePage />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('サーバーエラー');
    });
  });

  it('fetch が例外を投げてもクラッシュせず通信エラーの文言を表示する', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('network down')));
    vi.stubGlobal('fetch', fn);

    render(<StorePage />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('通信に失敗しました');
    });
  });

  it('書込操作（フォーム・ボタン等）を一切含まない（正常系・エラー系いずれも）', async () => {
    stubFetch({ ok: true, status: 200, body: mockResult });
    const { container } = render(<StorePage />);

    await waitFor(() => {
      expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
    });

    // task 5.3 の必須境界（zero form / button[type=submit] / input / textarea / select）。
    expect(
      container.querySelectorAll('form, button[type="submit"], input, textarea, select'),
    ).toHaveLength(0);
    // task 2.3 由来の元の保証（button 全般も無し）を維持し、より厳格に検証する。
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('エラー画面にも書込操作を一切含まない', async () => {
    stubFetch({ ok: false, status: 404, body: { error: { code: 'STORE_NOT_FOUND', message: 'x' } } });
    const { container } = render(<StorePage />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });

    expect(container.querySelectorAll('form, button, input, textarea, select')).toHaveLength(0);
  });

  it('POST/PUT/DELETE/PATCH の fetch 呼出を一切行わない（/api/detail への GET のみ）', async () => {
    const fn = stubFetch({ ok: true, status: 200, body: mockResult });

    render(<StorePage />);

    await waitFor(() => {
      expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
    });

    expect(fn.mock.calls.length).toBeGreaterThan(0);
    for (const call of fn.mock.calls) {
      const url = call[0] as string;
      const init = call[1] as RequestInit | undefined;
      expect(url).toBe('/api/detail');
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });

  it('liff.init() が例外を投げた場合はクラッシュせず LIFF 連携エラーの文言を表示する', async () => {
    liffMocks.init.mockReset().mockRejectedValue(new Error('liff init failed'));
    const fn = stubFetch({ ok: true, status: 200, body: mockResult });

    render(<StorePage />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('LINE 連携でエラー');
    });
    // 認可が失敗した以上、/api/detail への通信は一切発生しない。
    expect(fn).not.toHaveBeenCalled();
  });

  it('liff.getIDToken() が空値を返した場合はクラッシュせず LIFF 連携エラーの文言を表示する', async () => {
    liffMocks.getIDToken.mockReset().mockReturnValue(null);
    const fn = stubFetch({ ok: true, status: 200, body: mockResult });

    render(<StorePage />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('LINE 連携でエラー');
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('未ログインの場合は liff.login() を呼びリダイレクト待ちのため読み込み中のまま留まる', async () => {
    liffMocks.isLoggedIn.mockReturnValue(false);
    const fn = stubFetch({ ok: true, status: 200, body: mockResult });

    render(<StorePage />);

    await waitFor(() => {
      expect(liffMocks.login).toHaveBeenCalled();
    });
    // リダイレクト待ちのため /api/detail は呼ばれず、エラーにも遷移しない。
    expect(fn).not.toHaveBeenCalled();
    expect(screen.getByText('読み込み中です…')).toBeDefined();
  });
});
