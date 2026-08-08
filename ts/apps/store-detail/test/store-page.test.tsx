// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import type { StoreDetailResponse, StoreRef } from '../lib/contract';

// Task 5.3: 詳細閲覧画面（実データ描画・LIFF 認可・エラー分岐・no-write 構造保証）を検証する。
// task 2.3 のプレースホルダ検証を置き換える（プレースホルダ文言は本タスクで撤去済み）が、
// 「書込操作を一切含まない」というコア保証は本ファイルでも維持・強化して検証する。
//
// task 5.4（Issue #61）: 多店舗オーナー向けの店舗選択・店舗名表示・切替導線を追加検証する。
// 選択はリンク（<a>）で行い <button> を導入しないため、上記 no-write 保証は無改変で維持される。

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

/** テスト中の URL（?storeId ヒント）を制御する。afterEach で必ず /store へ戻す。 */
function setUrl(search: string): void {
  window.history.replaceState({}, '', `/store${search}`);
}

const SINGLE_STORE: StoreRef[] = [{ storeId: 'store-1', name: 'テスト自由が丘店' }];
const MULTI_STORES: StoreRef[] = [
  { storeId: 'store-1', name: 'テスト自由が丘店' },
  { storeId: 'store-2', name: 'テスト中目黒駅前店' },
];

const mockResult: StoreDetailResponse = {
  storeId: 'store-1',
  storeName: 'テスト自由が丘店',
  stores: SINGLE_STORE,
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
  // competitors は Go 日次バッチが jsonb へ書く値であり、rating / starDiff は数値
  // （go/internal/repo/summaries.go の float64）。文字列を置くと本番と違う形の
  // データで検証してしまうため、DailySummaryCompetitor の型どおり数値にする。
  competitors: [{ name: '競合A', rating: 4.2, reviewCount: 80, starDiff: 0.3 }],
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
    // URL はテスト間で共有される。戻し忘れると後続テストが前のヒントを引き継ぎ、
    // 偽陽性・偽陰性の両方を生むため必ずリセットする。
    setUrl('');
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
    const emptyResult: StoreDetailResponse = {
      storeId: 'store-1',
      storeName: 'テスト自由が丘店',
      stores: SINGLE_STORE,
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

  it('404（owner 不在・confirmed 店舗0件）応答時に「店舗情報を取得できませんでした」を表示する', async () => {
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
      // storeId ヒントはクエリに載りうるが、パスとメソッドは不変であること自体が保証の本体。
      expect(new URL(url, 'http://localhost').pathname).toBe('/api/detail');
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

  // --- task 5.4（Issue #61）: 多店舗オーナーの店舗選択 ------------------------------------

  describe('多店舗オーナーの店舗選択（Issue #61）', () => {
    const selectionBody = {
      error: { code: 'STORE_SELECTION_REQUIRED', message: '表示する店舗を選んでください' },
      stores: MULTI_STORES,
    };

    it('409 応答時は候補をリンクとして提示する（エラー画面にしない）', async () => {
      stubFetch({ ok: false, status: 409, body: selectionBody });

      const { container } = render(<StorePage />);

      await waitFor(() => {
        expect(screen.getByText('テスト自由が丘店')).toBeDefined();
      });
      expect(screen.getByText('テスト中目黒駅前店')).toBeDefined();

      const links = container.querySelectorAll('a');
      expect(links).toHaveLength(2);
      expect(links[0]!.getAttribute('href')).toBe('/store?storeId=store-1');
      expect(links[1]!.getAttribute('href')).toBe('/store?storeId=store-2');

      // 選択が必要なだけで異常ではないため、エラー文言（role="alert"）は出さない。
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('409 応答時も /api/detail への GET 1 回のみで、クエリを付けずに問い合わせている', async () => {
      const fn = stubFetch({ ok: false, status: 409, body: selectionBody });

      render(<StorePage />);

      await waitFor(() => {
        expect(screen.getByText('テスト自由が丘店')).toBeDefined();
      });

      expect(fn.mock.calls).toHaveLength(1);
      expect(fn.mock.calls[0]![0]).toBe('/api/detail');
    });

    it('URL に storeId があればヒントとして /api/detail へ引き継ぐ', async () => {
      setUrl('?storeId=store-2');
      const fn = stubFetch({ ok: true, status: 200, body: mockResult });

      render(<StorePage />);

      await waitFor(() => {
        expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
      });

      expect(fn.mock.calls[0]![0]).toBe('/api/detail?storeId=store-2');
    });

    it('storeId に URL 特殊文字が含まれてもエンコードして送る（クエリ汚染を作らない）', async () => {
      setUrl(`?storeId=${encodeURIComponent('a&b=c?d 東京')}`);
      const fn = stubFetch({ ok: true, status: 200, body: mockResult });

      render(<StorePage />);

      await waitFor(() => {
        expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
      });

      const requested = new URL(fn.mock.calls[0]![0] as string, 'http://localhost');
      // 送信 URL 上でパラメータが増殖・分断していないこと、値が原文どおり復元できること。
      expect([...requested.searchParams.keys()]).toEqual(['storeId']);
      expect(requested.searchParams.get('storeId')).toBe('a&b=c?d 東京');
    });

    it('表示中の店舗名を見出しに出す（要件 4.7）', async () => {
      stubFetch({ ok: true, status: 200, body: mockResult });

      render(<StorePage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('テスト自由が丘店');
      });
    });

    it('複数店舗を持つ場合は「店舗を切り替える」リンクを出す', async () => {
      stubFetch({ ok: true, status: 200, body: { ...mockResult, stores: MULTI_STORES } });

      const { container } = render(<StorePage />);

      await waitFor(() => {
        expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
      });

      const switchLink = screen.getByText('店舗を切り替える');
      expect(switchLink.getAttribute('href')).toBe('/store');
      // 切替リンクは storeId を持たないため、遷移先で再び 409 → 選択画面へ戻る。
      expect(container.querySelectorAll('a')).toHaveLength(1);
    });

    it('単一店舗の場合は「店舗を切り替える」リンクを出さない', async () => {
      stubFetch({ ok: true, status: 200, body: mockResult });

      const { container } = render(<StorePage />);

      await waitFor(() => {
        expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
      });

      expect(screen.queryByText('店舗を切り替える')).toBeNull();
      expect(container.querySelectorAll('a')).toHaveLength(0);
    });

    it('選択画面にも書込操作を一切含まない（新経路を no-write 保証と同格にする）', async () => {
      stubFetch({ ok: false, status: 409, body: selectionBody });

      const { container } = render(<StorePage />);

      await waitFor(() => {
        expect(screen.getByText('テスト自由が丘店')).toBeDefined();
      });

      expect(container.querySelectorAll('form, button, input, textarea, select')).toHaveLength(0);
    });
  });
});
