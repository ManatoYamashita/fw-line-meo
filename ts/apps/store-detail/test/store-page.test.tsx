// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import type { StoreDetailResponse, StoreRef } from '../lib/contract';
import { announcedText, ownText } from './live-region';

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

  // --- ui-airbnb-surfaces task 3.1: 版面・主見出し・帰属・処理中と通知 --------------------
  //
  // **着手時点で無検証だった契約をここで先に固定する。** 上の 20 件は「実データが出ること」と
  // 「書込操作が無いこと」を見ているが、意匠の適用で壊れうる次の契約はどれも押さえていなかった。
  //
  //   - 主見出しの読み上げ名と階層（正常分岐を除く 3 分岐にアサーションが 1 件も無かった）
  //   - 主要領域がちょうど 1 つであること（4 分岐とも 0 件）
  //   - 読み込み中の分岐の書込操作 0 件・リンク 0 件（この分岐だけ抜けていた）
  //   - 失敗の文言の完全一致（既存は toContain の部分一致で、末尾を削っても緑のまま通る）
  //   - 読み込み中の文言が **可視のテキスト**であること（sr-only へ落ちても getByText は緑）
  //   - 帰属の文言が完全一致でちょうど 1 箇所であること
  //   - リンクの読み上げ名（文言の一致は見ていたが、算出される名前は見ていなかった）
  //
  // 分岐ごとに走査する。片方の分岐だけを見る照合は「もう一方の版面を広い側へ変える」型の
  // 改変を緑のまま通す（dashboard-web の task 2.2 / 2.3 で実測されている）。
  describe('意匠の適用が構造を変えていないこと（task 3.1）', () => {
    interface SurfaceBranch {
      /** 失敗メッセージへ出す分岐名。どの分岐が壊れたのかを名指しさせる。 */
      readonly name: string;
      /** その分岐へ到達させる（liff / fetch のモックを整える）。 */
      readonly arrange: () => void;
      /** その分岐が描画され切るまで待つ。 */
      readonly settle: () => Promise<void>;
      /** 主見出しとして読み上げられる文字列。 */
      readonly headingName: string;
      /** その分岐に存在するリンクの読み上げ名（順序も含めて固定する）。 */
      readonly linkNames: readonly string[];
    }

    const SELECTION_BODY = {
      error: { code: 'STORE_SELECTION_REQUIRED', message: '表示する店舗を選んでください' },
      stores: MULTI_STORES,
    };

    const SURFACE_BRANCHES: readonly SurfaceBranch[] = [
      {
        name: '読み込み中',
        // 未ログインだと liff.login() がリダイレクトを開始し、状態は loading のまま留まる。
        arrange: () => {
          liffMocks.isLoggedIn.mockReturnValue(false);
          stubFetch({ ok: true, status: 200, body: mockResult });
        },
        settle: async () => {
          await waitFor(() => {
            expect(liffMocks.login).toHaveBeenCalled();
          });
        },
        headingName: '店舗詳細',
        linkNames: [],
      },
      {
        name: '失敗',
        arrange: () => {
          stubFetch({ ok: false, status: 404, body: { error: { code: 'STORE_NOT_FOUND', message: 'x' } } });
        },
        settle: async () => {
          await waitFor(() => {
            expect(screen.getByRole('alert')).toBeDefined();
          });
        },
        headingName: '店舗詳細',
        linkNames: [],
      },
      {
        name: '店舗選択待ち',
        arrange: () => {
          stubFetch({ ok: false, status: 409, body: SELECTION_BODY });
        },
        settle: async () => {
          await waitFor(() => {
            expect(screen.getByText('テスト中目黒駅前店')).toBeDefined();
          });
        },
        headingName: '店舗詳細',
        linkNames: ['テスト自由が丘店', 'テスト中目黒駅前店'],
      },
      {
        name: '正常',
        arrange: () => {
          stubFetch({ ok: true, status: 200, body: mockResult });
        },
        settle: async () => {
          await waitFor(() => {
            expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
          });
        },
        headingName: 'テスト自由が丘店',
        // 単一店舗なので切替リンクは出ない（既存の 20 件が 0 件を固定している）。
        linkNames: [],
      },
    ];

    /** beforeEach と同じ初期状態へ戻す（1 つのテストの中で分岐を回すため）。 */
    function armLiff(): void {
      liffMocks.init.mockReset().mockResolvedValue(undefined);
      liffMocks.isLoggedIn.mockReset().mockReturnValue(true);
      liffMocks.getIDToken.mockReset().mockReturnValue('test-id-token');
      liffMocks.login.mockReset();
    }

    /**
     * 4 分岐を順に描画し、分岐ごとに検査させる。
     *
     * 走査した分岐の数を数えて返し、呼び出し側が母数と突き合わせる。**回らないループは
     * 何も検査しないまま緑になる**ため、件数の照合を省かない（要件 7.4 と同型の規律）。
     */
    async function forEachBranch(
      inspect: (branch: SurfaceBranch, container: HTMLElement) => void,
    ): Promise<number> {
      let visited = 0;
      for (const branch of SURFACE_BRANCHES) {
        armLiff();
        branch.arrange();
        const { container } = render(<StorePage />);
        await branch.settle();
        inspect(branch, container);
        visited += 1;
        cleanup();
        vi.unstubAllGlobals();
      }
      return visited;
    }

    it('4 分岐すべてで主見出しの読み上げ名と階層を変えない（Req 3.2）', async () => {
      const visited = await forEachBranch((branch) => {
        const headings = screen.getAllByRole('heading', { level: 1 });
        // 主見出しは 1 つ。装飾や日付を別要素として足すと 2 つになる。
        expect(headings, branch.name).toHaveLength(1);
        expect(headings[0]!.textContent, branch.name).toBe(branch.headingName);
        // 算出される読み上げ名まで固定する。縦積みで子要素が箱になると区切りの空白が
        // 入り、textContent は一致したまま読み上げ名だけがずれる（登録ウィザード 5.1 の先例）。
        expect(
          screen.getByRole('heading', { level: 1, name: branch.headingName }),
          branch.name,
        ).toBe(headings[0]);
      });
      expect(visited).toBe(SURFACE_BRANCHES.length);
    });

    it('4 分岐すべてで主要領域をちょうど 1 つに保つ（Req 3.3）', async () => {
      const visited = await forEachBranch((branch, container) => {
        expect(container.querySelectorAll('main'), branch.name).toHaveLength(1);
        expect(screen.getAllByRole('main'), branch.name).toHaveLength(1);
      });
      expect(visited).toBe(SURFACE_BRANCHES.length);
    });

    it('4 分岐すべてで書込操作の要素を 1 つも描画しない（Req 3.1）', async () => {
      const visited = await forEachBranch((branch, container) => {
        expect(
          container.querySelectorAll('form, button, input, textarea, select'),
          branch.name,
        ).toHaveLength(0);
      });
      expect(visited).toBe(SURFACE_BRANCHES.length);
    });

    it('4 分岐すべてでリンクの個数と読み上げ名を変えない（Req 3.2, 3.3）', async () => {
      const visited = await forEachBranch((branch, container) => {
        expect(container.querySelectorAll('a'), branch.name).toHaveLength(branch.linkNames.length);
        const names = screen.queryAllByRole('link').map((link) => link.textContent);
        expect(names, branch.name).toEqual(branch.linkNames);
      });
      expect(visited).toBe(SURFACE_BRANCHES.length);
    });

    it('5 種の失敗の文言を完全一致で固定し、読み上げ役割をちょうど 1 つに保つ（Req 3.2, 3.5）', async () => {
      const failures: readonly { readonly name: string; readonly arrange: () => void; readonly message: string }[] = [
        {
          name: '401',
          arrange: () => stubFetch({ ok: false, status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x' } } }),
          message: '認証に失敗しました。LINE アプリを開き直してください。',
        },
        {
          name: '404',
          arrange: () => stubFetch({ ok: false, status: 404, body: { error: { code: 'STORE_NOT_FOUND', message: 'x' } } }),
          message: '店舗情報を取得できませんでした。',
        },
        {
          name: '500',
          arrange: () => stubFetch({ ok: false, status: 500, body: { error: { code: 'INTERNAL', message: 'x' } } }),
          message: 'サーバーエラーが発生しました。時間をおいて再度お試しください。',
        },
        {
          name: '通信断',
          arrange: () => {
            vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))));
          },
          message: '通信に失敗しました。時間をおいて再度お試しください。',
        },
        {
          name: 'LIFF 初期化失敗',
          arrange: () => {
            liffMocks.init.mockReset().mockRejectedValue(new Error('liff init failed'));
            stubFetch({ ok: true, status: 200, body: mockResult });
          },
          message: 'LINE 連携でエラーが発生しました。LINE アプリからこの画面を開き直してください。',
        },
      ];

      let visited = 0;
      for (const failure of failures) {
        armLiff();
        failure.arrange();
        render(<StorePage />);
        await waitFor(() => {
          expect(screen.getByRole('alert')).toBeDefined();
        });
        const alerts = screen.getAllByRole('alert');
        // 読み上げを中断する役割は 1 つだけ。通知の部品の内側へ role を重ねると 2 つになる。
        expect(alerts, failure.name).toHaveLength(1);
        // 既存の照合は toContain（部分一致）なので、末尾を削っても緑のまま通る。完全一致で固定する。
        expect(announcedText(alerts[0]!), failure.name).toBe(failure.message);
        visited += 1;
        cleanup();
        vi.unstubAllGlobals();
      }
      expect(visited).toBe(failures.length);
    });

    it('読み込み中の文言は可視のテキストとして置かれる（Req 4.5）', async () => {
      liffMocks.isLoggedIn.mockReturnValue(false);
      stubFetch({ ok: true, status: 200, body: mockResult });

      render(<StorePage />);
      await waitFor(() => {
        expect(liffMocks.login).toHaveBeenCalled();
      });

      const loading = screen.getByText('読み込み中です…');
      // 直下のテキストノードとして置く。`<Spinner aria-label="…" />` の 1 要素へ畳むと
      // 文言は sr-only の子要素へ落ち、動き低減設定でない実ブラウザでは見えなくなる。
      // **getByText はその差し替えを緑のまま通す**ので、ここが唯一の網である。
      expect(ownText(loading)).toBe('読み込み中です…');
      // 三点リーダは U+2026。見た目のほぼ同じ ASCII 3 点へ置き換わっても気づけるようにする。
      expect(screen.queryByText('読み込み中...')).toBeNull();
    });

    it('帰属の文言は完全一致でちょうど 1 箇所に描かれる（Req 3.2）', async () => {
      stubFetch({ ok: true, status: 200, body: mockResult });

      render(<StorePage />);
      await waitFor(() => {
        expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
      });

      // Google のデータを表示する面の必須表示であり、意匠の都合で削っても縮めてもいけない。
      const attributions = screen.getAllByText('データ提供: Google Maps');
      expect(attributions).toHaveLength(1);
      expect(ownText(attributions[0]!)).toBe('データ提供: Google Maps');
    });

    it('切替リンクは読み上げ名の完全一致で掴める（Req 3.2, 3.3）', async () => {
      stubFetch({ ok: true, status: 200, body: { ...mockResult, stores: MULTI_STORES } });

      const { container } = render(<StorePage />);
      await waitFor(() => {
        expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
      });

      // 既存の照合は getByText（直下テキストの一致）だけで、算出される読み上げ名は見ていない。
      const link = screen.getByRole('link', { name: '店舗を切り替える' });
      expect(link.getAttribute('href')).toBe('/store');
      expect(container.querySelectorAll('a')).toHaveLength(1);
    });

    it('店舗選択待ちには通知の役割を持ち込まない（Req 3.5）', async () => {
      stubFetch({ ok: false, status: 409, body: SELECTION_BODY });

      render(<StorePage />);
      await waitFor(() => {
        expect(screen.getByText('テスト中目黒駅前店')).toBeDefined();
      });

      // 選択が必要なだけで異常ではない。読み上げを中断する alert はもちろん、
      // 通知の部品（既定の変種は role="status"）もこの分岐へは置かない。
      expect(screen.queryAllByRole('alert')).toHaveLength(0);
      expect(screen.queryAllByRole('status')).toHaveLength(0);
    });

    // --- ここから下は意匠の適用そのものを固定する ----------------------------------------
    //
    // 版面の段は docs/design/design-language.md §7.9、見出しの階層は §6、余白は §3 が正典であり、
    // ここでは結論も数値も転記せず参照する。**面は色を 1 つも書かない**（色は部品側のトークン由来）。

    it('4 分岐すべてを本文系の狭い版面へ置換し、主要領域を二重にしない（Req 1.1, 1.5, 3.3）', async () => {
      const visited = await forEachBranch((branch, container) => {
        const shell = container.querySelector('[data-slot="page-shell"]');
        expect(shell, branch.name).not.toBeNull();
        // 版面は 2 段しかない。店舗詳細は本文系（狭い方）を使う。
        expect(shell!.getAttribute('data-width'), branch.name).toBe('sm');
        // 既存の main を **置換** する（入れ子にすると主要領域が 2 つになる）。
        expect(shell!.tagName, branch.name).toBe('MAIN');
        expect(container.querySelectorAll('main'), branch.name).toHaveLength(1);
        // **包含では足りない。** `max-w-*` を後ろへ足せば data-width は sm のまま実効の版面だけが変わる。
        // 幅を与えるクラスの集合そのものを完全一致で固定する。
        const tokens = shell!.className.split(/\s+/).filter((token) => token.length > 0);
        const widthTokens = tokens.filter((token) => /(^|:)(?:max-|min-)?w-/.test(token));
        expect(widthTokens, branch.name).toEqual(['w-full', 'max-w-xl']);
      });
      expect(visited).toBe(SURFACE_BRANCHES.length);
    });

    it('4 分岐すべてで主見出しを共通の見出し部品から描く（Req 1.1）', async () => {
      const visited = await forEachBranch((branch) => {
        const heading = screen.getByRole('heading', { level: 1 });
        expect(heading.getAttribute('data-slot'), branch.name).toBe('heading');
        // 支援技術に通知される階層と、部品へ渡した階層が一致していること。
        expect(heading.getAttribute('data-level'), branch.name).toBe('1');
      });
      expect(visited).toBe(SURFACE_BRANCHES.length);
    });

    it('処理中は共通部品を装飾として添え、読み上げ領域を 1 つに保つ（Req 1.1, 4.5）', async () => {
      armLiff();
      liffMocks.isLoggedIn.mockReturnValue(false);
      stubFetch({ ok: true, status: 200, body: mockResult });

      render(<StorePage />);
      await waitFor(() => {
        expect(liffMocks.login).toHaveBeenCalled();
      });

      // 領域が 2 つになるのは、装飾として添えた Spinner が aria-hidden を失ったとき。
      // Spinner のラッパは自身が role="status" を持つため、外し忘れると読み上げが二重になる。
      const regions = screen.getAllByRole('status');
      expect(regions).toHaveLength(1);
      const region = regions[0]!;
      expect(ownText(region)).toBe('読み込み中です…');
      expect(announcedText(region)).toBe('読み込み中です…');
      // 回転する図形は共通部品から来る。面の側で描くと意匠が面ごとにずれる。
      const spinner = region.querySelector('[data-slot="spinner"]');
      expect(spinner).not.toBeNull();
      expect(spinner!.getAttribute('aria-hidden')).toBe('true');
      // 読み込み中は異常ではない。読み上げを中断する役割はこの分岐に出さない。
      expect(screen.queryAllByRole('alert')).toHaveLength(0);
    });

    it('失敗は危険を伝える通知の部品へ載せ、読み上げ領域を二重にしない（Req 1.1, 3.5）', async () => {
      stubFetch({ ok: false, status: 404, body: { error: { code: 'STORE_NOT_FOUND', message: 'x' } } });

      render(<StorePage />);
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeDefined();
      });

      const alert = screen.getByRole('alert');
      expect(alert.getAttribute('data-slot')).toBe('alert');
      // 危険を伝える変種であること。色は部品側のトークンが解決する（面は色を書かない）。
      expect(alert.className).toContain('text-destructive');
      // 変種そのものが読み上げ役割 alert を持つ。内側へ role を重ねると領域が 2 つになる。
      expect(alert.querySelectorAll('[role="alert"], [role="status"]')).toHaveLength(0);
      // 文言は説明の受け口へ置く（タイトルを新設して文言を分割しない）。
      const description = alert.querySelector('[data-slot="alert-description"]');
      expect(description).not.toBeNull();
      expect(ownText(description!)).toBe('店舗情報を取得できませんでした。');
    });
  });
});
