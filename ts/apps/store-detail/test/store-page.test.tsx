// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import type { StoreDetailResponse, StoreRef } from '../lib/contract';
import { announcedText, ownText } from './live-region';
import { UNRATED_COMPETITOR_FROM_GO } from './fixtures/unrated-competitor';

// Task 5.3: 詳細閲覧画面（実データ描画・LIFF 認可・エラー分岐・no-write 構造保証）を検証する。
// task 2.3 のプレースホルダ検証を置き換える（プレースホルダ文言は本タスクで撤去済み）が、
// 「書込操作を一切含まない」というコア保証は本ファイルでも維持・強化して検証する。
//
// task 5.4（Issue #61）: 多店舗オーナー向けの店舗選択・店舗名表示・切替導線を追加検証する。
// 選択はリンク（<a>）で行い <button> を導入しないため、上記 no-write 保証は無改変で維持される。
//
// store-detail-trend-dashboard task 1.3（Issue #265）: 構造契約を「書込要素 0 件」の許可リスト方式へ
// 改定した（同 spec の design.md「構造契約（改定後）」）。書込の手段（form・button・textarea・select・
// contenteditable・操作系の role・form 属性・name を持つ input・許可リストの外の input）は引き続き
// 1 つも描かない。入力は競合の検索欄と、指標・期間の選択肢が描く隠し radio の 2 種類に限り、件数を
// 状態ごとに完全一致で固定する。検査は末尾の describe「構造契約（許可リスト方式）」の専用の状態表が持つ。

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

/** class 属性を空白で割ったトークン集合。**包含ではなく集合の完全一致**で固定するために使う。 */
function classTokens(element: Element): readonly string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/).filter((token) => token.length > 0);
}

/**
 * 「読み上げられる内容」で段落を掴む（ui-airbnb-surfaces task 3.2）。
 *
 * 巨大表示のため順位の数値を子要素へ切り出したので、**直下のテキストノードだけを見る**
 * `getByText` ではこの段落へ届かなくなった。読み上げられる内容そのものは 1 文字も変わって
 * いないため、そちらを鍵にする。ちょうど 1 つであることを毎回照合するのは、同じ文字列を
 * 読み上げる段落が 2 つに増える改変（節の複製・分岐の取り違え）を緑のまま通さないためである。
 */
function soleParagraphAnnouncing(container: HTMLElement, expected: string): HTMLElement {
  const found = Array.from(container.querySelectorAll('p')).filter((p) => announcedText(p) === expected);
  expect(found, `読み上げ内容が "${expected}" の段落`).toHaveLength(1);
  return found[0]!;
}

/** dl 直下の各グループを、読み上げられるラベルと値の組として取り出す。 */
function definitionPairs(list: Element): readonly (readonly [string, string])[] {
  return Array.from(list.children).map((group) => {
    const term = group.querySelector('dt');
    const description = group.querySelector('dd');
    expect(term, '指標ラベル').not.toBeNull();
    expect(description, '指標値').not.toBeNull();
    return [announcedText(term!), announcedText(description!)] as const;
  });
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

    const { container } = render(<StorePage />);

    // ローディング状態がまず表示される。
    expect(screen.getByText('読み込み中です…')).toBeDefined();

    // Issue #258 で順位は文章ではなくラベルと値の組へ移した。描画完了はその主指標で待つ。
    await waitFor(() => {
      expect(screen.getByText('近隣5店中')).toBeDefined();
      expect(screen.getByText('前日比: ↑ 上昇')).toBeDefined();
    });

    expect(screen.getByText('★4.5')).toBeDefined();
    expect(soleParagraphAnnouncing(container, '2件の新着クチコミ')).toBeDefined();
    expect(screen.getByText('競合A')).toBeDefined();
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
    expect(screen.getByText('推移データはまだありません（毎朝の集計後に表示されます）')).toBeDefined();
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

  // 正常系の書込要素 0 件の検査は、Issue #265 で末尾の「構造契約（許可リスト方式）」の状態表へ置き換えた。
  // 正常系は入力（検索欄・選択肢）を持ちうるので、input 0 件ではなく許可リストの件数で固定する。

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
  // **着手時点で無検証だった契約をここで先に固定する。** 着手時点で上にあった 20 件は「実データが
  // 出ること」と「書込操作が無いこと」を見ていたが、意匠の適用で壊れうる次の契約はどれも押さえて
  // いなかった（Issue #265 で、そのうち正常系の書込要素 0 件の検査を末尾の「構造契約（許可リスト方式）」へ移した）。
  //
  //   - 主見出しの読み上げ名と階層（正常分岐を除く 3 分岐にアサーションが 1 件も無かった）
  //   - 主要領域がちょうど 1 つであること（4 分岐とも 0 件）
  //   - 読み込み中の分岐の書込操作 0 件・リンク 0 件（この分岐だけ抜けていた。書込操作の側は、
  //     Issue #265 以降は末尾の「構造契約（許可リスト方式）」が 7 状態で固定する）
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
        // 単一店舗なので切替リンクは出ない（上の「単一店舗の場合は「店舗を切り替える」リンクを出さない」が
        // 0 件を固定している）。
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

    // 4 分岐の書込要素 0 件の検査は、Issue #265 で末尾の「構造契約（許可リスト方式）」へ置き換えた。
    // 正常の分岐を推移と競合の有無で 4 通りに分けて回すため、この 4 分岐の表には足さず専用の表を持つ
    // （この表へ足すと、見出し・主要領域・リンク・版面の検査の網羅まで変わってしまう）。

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
    // ここでは結論も数値も転記せず参照する。**面は色を書かない**（色は部品側のトークン由来）。唯一の例外は
    // 推移グラフの部品で（§7.18・Issue #265）、その色の語彙は test/trend-chart.test.tsx が完全一致で固定する。

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
      // 危険を伝える変種であること。色は部品側のトークンが解決する（面の側は通知に色を書かない）。
      expect(alert.className).toContain('text-destructive');
      // 変種そのものが読み上げ役割 alert を持つ。内側へ role を重ねると領域が 2 つになる。
      expect(alert.querySelectorAll('[role="alert"], [role="status"]')).toHaveLength(0);
      // 文言は説明の受け口へ置く（タイトルを新設して文言を分割しない）。
      const description = alert.querySelector('[data-slot="alert-description"]');
      expect(description).not.toBeNull();
      expect(ownText(description!)).toBe('店舗情報を取得できませんでした。');
    });
  });

  // --- ui-airbnb-surfaces task 3.2 / 3.3 -------------------------------------------------
  //
  // 3.2 の着手時点で 3.1 までにあった 33 件（Issue #265 で、そのうち書込要素 0 件の 2 件を末尾の
  // 「構造契約（許可リスト方式）」へ置き換えた）は版面・主見出し・処理中・失敗・リンクを見ていたが、
  // **この面の中身**（順位・自店の評価・新着・競合・推移）は存在の部分一致が数点あるだけで、
  // 意匠の適用で壊れうる契約はどれも押さえていなかった。**先に固定してから意匠を当てる。**
  //
  //   - 節の見出し（h2 4 種・h3 2 種）の読み上げ名と階層 …… 0 件
  //   - 順位指標が読み上げる内容（上昇・下降・変動なし・前日欠損・順位欠損・母数欠損）…… 0 件
  //   - 自店評価の指標が読み上げる内容（上昇・下降・同値・前日欠損・評価欠損・件数欠損）…… 0 件
  //   - 新着クチコミの件数表記・各行の文字列・0 件の文言 …… 0 件
  //   - 競合の各行の文字列 …… 存在の部分一致 `/競合A/` のみ
  //   - 推移の列見出し 4 つ・scope・行数・セルの値 …… **要件 2.2 が守る対象が丸ごと 0 件**
  //   - サマリーが取得できない 2 分岐の文言 …… 失敗の分岐は到達そのものが 0 件
  //   - 競合・新着・店舗選択の一覧が list / listitem として読めること（要件 2.1）…… 0 件
  describe('中身の契約と意匠の適用（task 3.2 / 3.3）', () => {
    const BASE_SUMMARY = mockResult.summary as NonNullable<StoreDetailResponse['summary']>;

    const SELECTION_BODY = {
      error: { code: 'STORE_SELECTION_REQUIRED', message: '表示する店舗を選んでください' },
      stores: MULTI_STORES,
    };

    /** 当日サマリーだけを差し替えた応答を作る。 */
    function withSummary(patch: Partial<typeof BASE_SUMMARY>): StoreDetailResponse {
      return { ...mockResult, summary: { ...BASE_SUMMARY, ...patch } };
    }

    interface ResponseCase {
      /** 失敗メッセージへ出す分岐名。どの分岐が壊れたのかを名指しさせる。 */
      readonly name: string;
      readonly body: StoreDetailResponse;
    }

    /**
     * 応答ごとに 1 回ずつ描画して検査する。
     *
     * **走査した件数を返して母数と突き合わせる**（回らないループは何も検査しないまま緑になる）。
     * 反復のたびに fetch のスタブを張り直す。liff のモックは beforeEach が armed のまま残る。
     */
    async function forEachResponse<T extends ResponseCase>(
      cases: readonly T[],
      inspect: (item: T, container: HTMLElement) => void,
    ): Promise<number> {
      let visited = 0;
      for (const item of cases) {
        stubFetch({ ok: true, status: 200, body: item.body });
        const { container } = render(<StorePage />);
        await waitFor(() => {
          expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
        });
        inspect(item, container);
        visited += 1;
        cleanup();
        vi.unstubAllGlobals();
      }
      return visited;
    }

    // --- 段 1: 着手前に無検証だった中身の契約 --------------------------------------------

    it('順位をラベルと値の組として 6 分岐で固定する（Issue #258, Req 4.7）', async () => {
      const cases = [
        { name: '上昇', body: withSummary({ rank: 2, rankPrev: 3 }), pair: ['近隣5店中', '2位 前日比: ↑ 上昇'] },
        { name: '下降', body: withSummary({ rank: 4, rankPrev: 3 }), pair: ['近隣5店中', '4位 前日比: ↓ 下降'] },
        { name: '変動なし', body: withSummary({ rank: 3, rankPrev: 3 }), pair: ['近隣5店中', '3位 前日比: → 変動なし'] },
        { name: '前日なし', body: withSummary({ rankPrev: null }), pair: ['近隣5店中', '2位'] },
        { name: '順位なし', body: withSummary({ rank: null }), pair: ['近隣5店中', '順位情報がありません'] },
        { name: '母数なし', body: withSummary({ rankTotal: null }), pair: ['近隣順位', '順位情報がありません 前日比: ↑ 上昇'] },
      ] as const;

      const visited = await forEachResponse(cases, (item, container) => {
        const heading = screen.getByRole('heading', { level: 2, name: /今日のポジション/ });
        const list = heading.parentElement!.querySelector('dl');
        expect(list, item.name).not.toBeNull();
        expect(definitionPairs(list!), item.name).toEqual([item.pair]);
        expect(list!.querySelectorAll('[data-slot="badge"]'), item.name).toHaveLength(item.pair[1].includes('前日比') ? 1 : 0);
        expect(container.querySelectorAll('dl').length, item.name).toBeGreaterThan(0);
      });
      expect(visited).toBe(cases.length);
    });

    it('自店の評価を独立した指標として 6 分岐で固定する（Issue #258, Req 4.7）', async () => {
      const cases = [
        { name: '上昇', body: withSummary({ rating: '4.5', ratingPrev: '4.4' }), pairs: [['Google 評価', '★4.5'], ['クチコミ', '120件'], ['評価の前日比', '+0.1'], ['クチコミの前日比', '+5件']] },
        { name: '下降', body: withSummary({ rating: '4.3', ratingPrev: '4.5' }), pairs: [['Google 評価', '★4.3'], ['クチコミ', '120件'], ['評価の前日比', '-0.2'], ['クチコミの前日比', '+5件']] },
        { name: '同値', body: withSummary({ rating: '4.5', ratingPrev: '4.5' }), pairs: [['Google 評価', '★4.5'], ['クチコミ', '120件'], ['クチコミの前日比', '+5件']] },
        { name: '前日なし', body: withSummary({ ratingPrev: null }), pairs: [['Google 評価', '★4.5'], ['クチコミ', '120件'], ['クチコミの前日比', '+5件']] },
        { name: '評価なし', body: withSummary({ rating: null }), pairs: [['Google 評価', '評価なし'], ['クチコミ', '120件'], ['クチコミの前日比', '+5件']] },
        { name: '件数なし', body: withSummary({ reviewCount: null }), pairs: [['Google 評価', '★4.5'], ['クチコミ', '—'], ['評価の前日比', '+0.1']] },
      ] as const;

      const visited = await forEachResponse(cases, (item) => {
        const heading = screen.getByRole('heading', { level: 3, name: '自店の評価' });
        const list = heading.parentElement!.querySelector('dl');
        expect(list, item.name).not.toBeNull();
        expect(definitionPairs(list!), item.name).toEqual(item.pairs);
      });
      expect(visited).toBe(cases.length);
    });

    it('新着クチコミの件数表記と 0 件の文言を固定する（Req 3.2）', async () => {
      const cases = [
        {
          name: '2 件',
          body: mockResult,
          present: '2件の新着クチコミ',
          absent: '新着なし（前回の集計以降、新しいクチコミはありません）',
        },
        {
          name: '0 件',
          body: withSummary({ newReviewCount: 0, newReviews: [] }),
          present: '新着なし（前回の集計以降、新しいクチコミはありません）',
          absent: '2件の新着クチコミ',
        },
      ] as const;

      const visited = await forEachResponse(cases, (item, container) => {
        expect(soleParagraphAnnouncing(container, item.present), item.name).toBeDefined();
        expect(Array.from(container.querySelectorAll('p')).some((p) => announcedText(p) === item.absent), item.name).toBe(false);
      });
      expect(visited).toBe(cases.length);
    });

    it('競合と新着の一覧を list / listitem として読め、行の文字列を変えない（Req 2.1, 3.2）', async () => {
      const NEW_REVIEW_ROW = '山田太郎さん ★5「とても美味しかったです」';
      const cases = [
        { name: '新着 1 行・競合 1 行', body: mockResult, lists: 2, items: [NEW_REVIEW_ROW, '競合A評価★4.2クチコミ80件星差+0.3'] },
        { name: '新着 0 件', body: withSummary({ newReviewCount: 0, newReviews: [] }), lists: 1, items: ['競合A評価★4.2クチコミ80件星差+0.3'] },
        { name: '競合 0 件', body: { ...mockResult, competitors: [] }, lists: 1, items: [NEW_REVIEW_ROW] },
      ] as const;

      const visited = await forEachResponse(cases, (item, container) => {
        // カードの並びへ置き換えると list / listitem の役割が消える（正典 7.2 節と同じ規律）。
        expect(screen.getAllByRole('list'), item.name).toHaveLength(item.lists);
        expect(screen.getAllByRole('listitem').map((li) => announcedText(li)), item.name).toEqual(item.items);
        expect(container.querySelectorAll('li'), item.name).toHaveLength(item.items.length);
        const competitor = screen.queryByText('競合A')?.closest('li');
        if (competitor) {
          expect(definitionPairs(competitor.querySelector('dl')!), item.name).toEqual([
            ['評価', '★4.2'],
            ['クチコミ', '80件'],
            ['星差', '+0.3'],
          ]);
        }
      });
      expect(visited).toBe(cases.length);
    });

    // Issue #255: Google に評価が無い店（クチコミ 0 件）。応答は読込時に正規化済み（評価なしは null・
    // 自店が未評価なら順位と星差も null）で届く。Flex と同じ規則・同じ文言で描く。
    it('評価の無い競合を「評価なし」と描き、星差を出さず、順位に含めていない旨を添える（Issue #255）', async () => {
      const EXCLUDED_NOTE = '評価のない店は順位に含めていません';
      const cases = [
        {
          name: '評価の無い競合あり',
          body: {
            ...mockResult,
            // Go が実際に書く評価なしの形（cross-runtime.e2e.test.ts が同じ定数で実データと照合する）。
            competitors: [{ name: '競合A', rating: 4.2, reviewCount: 80, starDiff: 0.3 }, UNRATED_COMPETITOR_FROM_GO],
          },
          rows: {
            競合A: [
              ['評価', '★4.2'],
              ['クチコミ', '80件'],
              ['星差', '+0.3'],
            ],
            [UNRATED_COMPETITOR_FROM_GO.name]: [
              ['評価', '評価なし'],
              ['クチコミ', '0件'],
            ],
          },
          note: true,
        },
        {
          // 条件つきの分岐は既定側も固定しないと、無条件に出す実装が素通りする。
          name: '全店に評価あり',
          body: mockResult,
          rows: {
            競合A: [
              ['評価', '★4.2'],
              ['クチコミ', '80件'],
              ['星差', '+0.3'],
            ],
          },
          note: false,
        },
      ] as const;

      const visited = await forEachResponse(cases, (item, container) => {
        for (const [name, pairs] of Object.entries(item.rows)) {
          const row = screen.getByText(name).closest('li');
          expect(row, `${item.name}: ${name}`).not.toBeNull();
          expect(definitionPairs(row!.querySelector('dl')!), `${item.name}: ${name}`).toEqual(pairs);
        }
        expect(container.textContent ?? '', item.name).not.toContain('★0');
        const notes = Array.from(container.querySelectorAll('p')).filter((p) => announcedText(p) === EXCLUDED_NOTE);
        expect(notes, item.name).toHaveLength(item.note ? 1 : 0);
      });
      expect(visited).toBe(cases.length);
    });

    it('自店が未評価の日は、取得失敗ではなく評価が無いため順位を出せない旨を描く（Issue #255）', async () => {
      const body: StoreDetailResponse = {
        ...withSummary({
          rank: null,
          rankTotal: null,
          rankPrev: null,
          rating: null,
          ratingPrev: null,
          reviewCount: 0,
          reviewCountPrev: 0,
        }),
        competitors: [{ name: '競合A', rating: 4.2, reviewCount: 80, starDiff: null }],
      };

      const visited = await forEachResponse([{ name: '自店が未評価', body }], (item) => {
        const position = screen.getByRole('heading', { level: 2, name: /今日のポジション/ }).parentElement!.querySelector('dl');
        expect(definitionPairs(position!), item.name).toEqual([['近隣順位', 'まだ Google の評価が無いため、順位は出せません']]);

        const own = screen.getByRole('heading', { level: 3, name: '自店の評価' }).parentElement!.querySelector('dl');
        expect(definitionPairs(own!)[0], item.name).toEqual(['Google 評価', '評価なし']);

        // 競合自身の評価は出し、自店と比べられない星差は出さない。
        const row = screen.getByText('競合A').closest('li');
        expect(definitionPairs(row!.querySelector('dl')!), item.name).toEqual([
          ['評価', '★4.2'],
          ['クチコミ', '80件'],
        ]);
      });
      expect(visited).toBe(1);
    });

    it('推移の列見出し・scope・行数・セルの値を固定する（Req 2.1, 2.2）', async () => {
      const HEADERS = ['日付', '順位', '評価', 'クチコミ数'];
      const cases = [
        {
          name: '2 点',
          body: mockResult,
          rows: [
            ['2026-07-10', '3', '4.4', '115'],
            ['2026-07-11', '2', '4.5', '120'],
          ],
        },
        {
          name: '欠損値',
          body: { ...mockResult, trend: [{ capturedOn: '2026-07-12', rank: null, rating: null, reviewCount: null }] },
          rows: [['2026-07-12', '—', '—', '—']],
        },
      ] as const;

      const visited = await forEachResponse(cases, (item) => {
        const headers = screen.getAllByRole('columnheader');
        // 要件 2.2 が守るのは「列見出しとして読み上げられる文字列」そのものである。
        expect(headers.map((cell) => announcedText(cell)), item.name).toEqual(HEADERS);
        expect(headers.map((cell) => cell.getAttribute('scope')), item.name).toEqual(['col', 'col', 'col', 'col']);

        const rows = screen.getAllByRole('row');
        expect(rows, item.name).toHaveLength(item.rows.length + 1);
        expect(
          rows.slice(1).map((row) => Array.from(row.querySelectorAll('td')).map((cell) => announcedText(cell))),
          item.name,
        ).toEqual(item.rows);
      });
      expect(visited).toBe(cases.length);
    });

    it('サマリーが取得できない 2 分岐の文言を完全一致で固定する（Req 3.2）', async () => {
      const cases = [
        {
          name: 'サマリー無し',
          body: { ...mockResult, summary: null },
          text: '本日分のデータはまだ準備中です。しばらくしてから再度お試しください。',
        },
        { name: 'サマリー失敗', body: withSummary({ status: 'failed' }), text: '本日のポジションを取得できませんでした。' },
      ] as const;

      const visited = await forEachResponse(cases, (item, container) => {
        soleParagraphAnnouncing(container, item.text);
        // この 2 分岐は順位も自店の評価も新着も持たない（データが無いのだから当然だが、
        // 「取得できなかったときにそれらしい値を描かない」ことは 7.4 の規律そのものである）。
        expect(screen.queryByText(/新着クチコミ/), item.name).toBeNull();
        expect(screen.queryByText(/自店の評価/), item.name).toBeNull();
      });
      expect(visited).toBe(cases.length);
    });

    it('節の見出しの読み上げ名と階層を分岐ごとに固定する（Req 3.2）', async () => {
      const cases = [
        {
          name: '正常',
          body: mockResult,
          h2: ['今日のポジション（2026-07-11）', '競合との比較', '直近30日の推移'],
          h3: ['自店の評価', '新着クチコミ'],
        },
        {
          name: 'サマリー無し',
          body: { ...mockResult, summary: null },
          h2: ['今日のポジション', '競合との比較', '直近30日の推移'],
          h3: [],
        },
        {
          name: 'サマリー失敗',
          body: withSummary({ status: 'failed' }),
          h2: ['今日のポジション（2026-07-11）', '競合との比較', '直近30日の推移'],
          h3: [],
        },
      ] as const;

      const visited = await forEachResponse(cases, (item) => {
        expect(screen.getAllByRole('heading', { level: 2 }).map((h) => announcedText(h)), item.name).toEqual(item.h2);
        expect(screen.queryAllByRole('heading', { level: 3 }).map((h) => announcedText(h)), item.name).toEqual(item.h3);
        // 算出される読み上げ名まで固定する（縦積みで子要素が箱になると区切りの空白が入り、
        // textContent は一致したまま読み上げ名だけがずれる）。
        for (const name of [...item.h2, ...item.h3]) {
          expect(screen.getByRole('heading', { name }), `${item.name} / ${name}`).toBeDefined();
        }
      });
      expect(visited).toBe(cases.length);
    });

    it('店舗選択待ちの節の見出しを読み上げ名と階層で固定する（Req 3.2）', async () => {
      stubFetch({ ok: false, status: 409, body: SELECTION_BODY });

      render(<StorePage />);
      await waitFor(() => {
        expect(screen.getByText('テスト中目黒駅前店')).toBeDefined();
      });

      const headings = screen.getAllByRole('heading', { level: 2 });
      expect(headings).toHaveLength(1);
      expect(announcedText(headings[0]!)).toBe('表示する店舗を選んでください');
      expect(screen.getByRole('heading', { level: 2, name: '表示する店舗を選んでください' })).toBe(headings[0]);
    });

    // --- 段 2: 意匠の適用そのものを固定する ----------------------------------------------
    //
    // 巨大表示の段は docs/design/design-language.md 7.3 節、前日比の示し方は 7.7 節、
    // 表の扱いは 7.2 節、見出しの階層は 6 節が正典であり、ここでは結論も数値も転記せず参照する。

    it('4 分岐すべてで節の見出しを共通の見出し部品から描く（Req 1.1, 1.2）', async () => {
      /** 描画された全見出しが部品を通り、タグの階層と部品へ渡した階層が一致すること。 */
      function inspectHeadings(where: string): void {
        const headings = screen.getAllByRole('heading');
        expect(headings.length, where).toBeGreaterThan(1);
        for (const heading of headings) {
          expect(heading.getAttribute('data-slot'), `${where} / ${heading.textContent}`).toBe('heading');
          expect(heading.getAttribute('data-level'), `${where} / ${heading.textContent}`).toBe(
            heading.tagName.slice(1),
          );
        }
      }

      const cases = [
        { name: '正常', body: mockResult },
        { name: 'サマリー無し', body: { ...mockResult, summary: null } },
        { name: 'サマリー失敗', body: withSummary({ status: 'failed' }) },
      ] as const;
      const visited = await forEachResponse(cases, (item) => {
        inspectHeadings(item.name);
      });
      expect(visited).toBe(cases.length);

      // 店舗選択待ちの h2 はどのタスクにも割り当てられていなかった（task 3.1 の報告 → 3.3 へ）。
      // 5 つが部品になるのに 1 つだけ素のタグが残ると、同一役割が同じ面の中で 2 通りに描かれる。
      stubFetch({ ok: false, status: 409, body: SELECTION_BODY });
      render(<StorePage />);
      await waitFor(() => {
        expect(screen.getByText('テスト中目黒駅前店')).toBeDefined();
      });
      inspectHeadings('店舗選択待ち');
    });

    it('順位の数値を文字サイズの最大段で描き、任意の値を書かない（Req 1.3, 4.7）', async () => {
      stubFetch({ ok: true, status: 200, body: mockResult });
      const { container } = render(<StorePage />);
      await waitFor(() => {
        expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
      });

      const display = screen.getByText('近隣5店中').parentElement!.querySelector('.text-2xl')!;
      expect(display.closest('dd')?.textContent).toContain('前日比: ↑ 上昇');
      expect(ownText(display)).toBe('2');
      // **集合の完全一致で固定する。** 包含では `text-[64px]` のような任意値や色ユーティリティを
      // 後ろへ足す改変が通る。段は正典 7.3 節が指す 6 節の最大段であり、面は値を持たない。
      expect(classTokens(display)).toEqual(['text-2xl', 'font-bold', 'tabular-nums']);

      // 完了条件「巨大表示に任意の値を書いていない」を、巨大表示だけでなく**面が自分で書く
      // 要素すべて**へ広げる。走査から外すのは `data-slot` を持つ要素（＝共通部品の描く要素）で、
      // 角括弧記法は部品の内部実装が正当に使っている（`[--card-spacing:--spacing(4)]` 等）。
      // 部品が面へ渡す受け口については、直後に差分で押さえる。
      const arbitrary = Array.from(container.querySelectorAll('[class]:not([data-slot])')).filter((element) =>
        classTokens(element).some((token) => token.includes('[')),
      );
      expect(arbitrary.map((element) => element.getAttribute('class'))).toEqual([]);

      // 面が部品の受け口へ渡したトークンを、**渡していない受け口との差分**で取り出す。
      // 部品側の内部クラスをテストへ書き写さずに、面が足した分だけを完全一致で固定できる
      // （書き写すと部品を直した瞬間に面の検査が理由もなく壊れる）。
      const contents = Array.from(container.querySelectorAll('[data-slot="card-content"]'));
      const untouched = new Set(classTokens(contents[3]!));
      expect(contents.map((element) => classTokens(element).filter((token) => !untouched.has(token)))).toEqual([
        ['flex', 'flex-col', 'gap-4'],
        ['flex', 'flex-col', 'gap-4'],
        ['flex', 'flex-col', 'gap-4'],
        [],
        ['flex', 'flex-col', 'gap-4'],
      ]);
    });

    it('順位・自店の評価・新着・競合を情報の容器へ載せる（Req 1.1）', async () => {
      stubFetch({ ok: true, status: 200, body: mockResult });
      const { container } = render(<StorePage />);
      await waitFor(() => {
        expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
      });

      const cards = Array.from(container.querySelectorAll('[data-slot="card"]'));
      expect(cards).toHaveLength(5);

      // 見出しは容器の**外**に置く。容器は内容だけを持つ（面の中で規則を 1 つに保つため、
      // 空状態の部品が容器をそのまま置き換えられる形にしてある）。
      for (const card of cards) {
        expect(card.querySelectorAll('[data-slot="heading"]'), card.textContent ?? '').toHaveLength(0);
      }

      const inCard = [
        screen.getByText('近隣5店中'),
        screen.getByText('Google 評価'),
        soleParagraphAnnouncing(container, '2件の新着クチコミ'),
        screen.getByText('競合A'),
        screen.getByText('表示期間の変化'),
      ];
      expect(inCard.map((element) => cards.indexOf(element.closest('[data-slot="card"]')!))).toEqual([0, 1, 2, 3, 4]);

      // 見出しと対応する内容を近い間隔でまとめ、各グループの間をその 2 倍以上空ける。
      // 見出しと前のカードが等距離になると、どちらの内容を説明しているかが曖昧になる。
      const summary = screen.getByRole('heading', { level: 2, name: /今日のポジション/ }).closest('section')!;
      expect(classTokens(summary)).toEqual(['flex', 'flex-col', 'gap-6']);
      const groups = Array.from(summary.children);
      expect(groups).toHaveLength(3);
      expect(groups.map((group) => classTokens(group))).toEqual([
        ['flex', 'flex-col', 'gap-2'],
        ['flex', 'flex-col', 'gap-2'],
        ['flex', 'flex-col', 'gap-2'],
      ]);
      expect(groups.map((group) => group.querySelector('[data-slot="heading"]')?.textContent)).toEqual([
        '今日のポジション（2026-07-11）',
        '自店の評価',
        '新着クチコミ',
      ]);
    });

    it('推移を表の部品へ移し、横方向の捲りを表の外側に置く（Req 2.1, 2.5）', async () => {
      stubFetch({ ok: true, status: 200, body: mockResult });
      const { container } = render(<StorePage />);
      await waitFor(() => {
        expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
      });

      const table = screen.getByRole('table');
      expect(table.getAttribute('data-slot')).toBe('table');
      expect(classTokens(table)).toContain('min-w-sm');
      for (const cell of screen.getAllByRole('columnheader')) {
        expect(cell.getAttribute('data-slot'), cell.textContent ?? '').toBe('table-header-cell');
      }

      // 捲りは表の **外側** が持つ（tbody の内側には置けない）。
      const scroller = table.parentElement!;
      expect(scroller.getAttribute('data-slot')).toBe('table-container');
      expect(classTokens(scroller)).toContain('overflow-x-auto');
      expect(classTokens(table)).not.toContain('overflow-x-auto');
      // 捲りを担う領域はキーボードで到達できなければ、隠れた列が失われる（WCAG 2.1.1）。
      expect(scroller.getAttribute('tabindex')).toBe('0');
      expect(scroller.getAttribute('role')).toBe('region');
      expect(scroller.getAttribute('aria-label')).toBe('直近30日の推移');
      // 捲れる領域はこの面に 1 つだけ。e2e（store-surface.spec.ts）の宣言と同じ数である。
      expect(container.querySelectorAll('[data-slot="table-container"]')).toHaveLength(1);

      const overview = screen.getByText('表示期間の変化').closest('[data-slot="card"]')!;
      expect(definitionPairs(overview.querySelector('dl')!)).toEqual([
        ['順位', '3位 → 2位'],
        ['評価', '4.4 → 4.5'],
        ['クチコミ増減', '+5件'],
      ]);

      // 数値の列だけ右寄せ＋等幅数字にする（正典 7.2 節）。日付の列は既定のまま。
      const firstRow = screen.getAllByRole('row')[1]!;
      expect(Array.from(firstRow.querySelectorAll('td')).map((cell) => cell.getAttribute('data-numeric'))).toEqual([
        null,
        'true',
        'true',
        'true',
      ]);
    });

    it('0 件の案内を空状態の部品へ載せ、導線を 1 つも足さない（Req 2.3, 3.1, 3.3）', async () => {
      const cases = [
        {
          name: '競合 0 件・推移 0 件・サマリー無し',
          body: { ...mockResult, summary: null, competitors: [], trend: [] },
          texts: [
            '競合が見つかっていません（自店のみの計測です）',
            '推移データはまだありません（毎朝の集計後に表示されます）',
          ],
        },
        {
          name: '新着 0 件',
          body: withSummary({ newReviewCount: 0, newReviews: [] }),
          texts: ['新着なし（前回の集計以降、新しいクチコミはありません）'],
        },
      ] as const;

      const visited = await forEachResponse(cases, (item, container) => {
        const states = Array.from(container.querySelectorAll('[data-slot="empty-state"]'));
        expect(states.map((state) => announcedText(state)), item.name).toEqual(item.texts);
        for (const state of states) {
          // **導線は足さない。** 要件 2.3 は「次に取れる操作への導線」も求めるが、この面には
          // 0 件の状態を解消する操作そのものが存在しない。要件 3.1 / 3.3 は、その不在を構造で保証する。
          // 空状態の部品へ children を渡さないことで、存在しない操作を見せかけることも防ぐ。
          expect(state.querySelectorAll('a, button'), item.name).toHaveLength(0);
        }
      });
      expect(visited).toBe(cases.length);
    });

    it('面の側が節と一覧に書く className はレイアウトと文字サイズだけである（Req 1.3, 1.5）', async () => {
      stubFetch({ ok: true, status: 200, body: mockResult });
      const { container } = render(<StorePage />);
      await waitFor(() => {
        expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
      });

      // この検査が見るのは、面が自分で class を書く要素のうち節と一覧である（版面は task 3.1 が別途固定している）。
      // **集合の完全一致**で押さえるのは、色ユーティリティを後ろへ足す改変を通さないためである。
      // 店舗詳細の面で色を書くのは推移グラフの部品だけであり（§7.18・Issue #265）、その色の語彙は
      // test/trend-chart.test.tsx が完全一致で固定する。グラフは節も一覧も描かないので、この検査の範囲は変えない。
      expect(Array.from(container.querySelectorAll('section')).map((element) => classTokens(element))).toEqual([
        ['flex', 'flex-col', 'gap-6'],
        ['flex', 'flex-col', 'gap-4'],
        ['flex', 'flex-col', 'gap-4'],
      ]);
      expect(Array.from(container.querySelectorAll('ul')).map((element) => classTokens(element))).toEqual([
        ['divide-y'],
        ['divide-y'],
      ]);
    });
  });

  // --- store-detail-trend-dashboard task 1.3（Issue #265）---------------------------------
  //
  // 正典は同 spec の design.md「構造契約（改定後）」、判断の根拠は research.md の決定 D7 である。
  // competitive-daily-summary 要件 4.2 が禁じているのは書込操作であり、入力そのものではない。
  // そこで「input 0 件」をやめ、次の 2 段で固定する。
  //
  //   - 書込の手段になる要素は、どの状態でも 0 件を保つ。
  //   - 入力は許可リストの 2 種類（検索欄・選択肢の隠し radio）に限り、状態ごとに件数を完全一致で固定する。
  //
  // 許可リストなので、ほかの種類の入力を足せば必ず赤になる。件数を完全一致にするのは、許可した種類の
  // 入力を別の状態・別の場所へ増やす改変も通さないためである。
  describe('構造契約（許可リスト方式）（Issue #265）', () => {
    /** 入力を受け付ける要素のうち、許すものの件数（許可リスト）。 */
    interface AllowedInputCounts {
      /** 競合の検索欄。`@fwlm/ui` の Input が data-slot="input" を描く。 */
      readonly searchBox: number;
      /** 指標・期間の選択肢。Base UI の Radio が描く隠し input で、焦点も読み上げも受けない。 */
      readonly hiddenRadio: number;
    }

    /** 走査の結果。0 件を保つものは規則ごとに鍵を分け、赤の差分がどの規則に当たったのかを名指しさせる。 */
    interface InputSurfaceCounts extends AllowedInputCounts {
      readonly form: number;
      readonly button: number;
      readonly textarea: number;
      readonly select: number;
      readonly contentEditable: number;
      readonly interactiveRole: number;
      readonly formAttribute: number;
      readonly namedInput: number;
      readonly inputOutsideAllowlist: number;
    }

    const ALLOWED_INPUT_SELECTORS: Readonly<Record<keyof AllowedInputCounts, string>> = {
      searchBox: 'input[type="search"][data-slot="input"]',
      hiddenRadio: 'input[type="radio"][aria-hidden="true"][tabindex="-1"]',
    };

    /**
     * 操作系の role（design.md の列挙どおり）。
     *
     * 後半の 9 つは 2026-09-14 に足した。input 要素でなく role だけで入力を名乗る要素（例: 自前の
     * `div role="searchbox"`）は、input の許可リストを素通りするためである。radio / radiogroup は
     * 選択肢の部品が描くので含めない。
     */
    const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
      'button',
      'textbox',
      'combobox',
      'checkbox',
      'switch',
      'slider',
      'spinbutton',
      'searchbox',
      'listbox',
      'option',
      'menu',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'tab',
      'treeitem',
    ]);

    /** どの状態でも 0 件を保つもの。 */
    const KEPT_AT_ZERO: Omit<InputSurfaceCounts, keyof AllowedInputCounts> = {
      form: 0,
      button: 0,
      textarea: 0,
      select: 0,
      contentEditable: 0,
      interactiveRole: 0,
      formAttribute: 0,
      namedInput: 0,
      inputOutsideAllowlist: 0,
    };

    /** role は空白区切りの並び（代替の指定）を取りうる。大文字小文字の違いで取りこぼさないよう小文字に揃える。 */
    function roleTokens(element: Element): readonly string[] {
      return (element.getAttribute('role') ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length > 0);
    }

    /**
     * root の子孫を 1 つずつ走査し、許可リストの件数と、0 件を保つ規則ごとの件数を数える。
     *
     * 1 つの要素が複数の規則に当たれば、それぞれで数える。たとえば name を持つ隠し radio は
     * hiddenRadio と namedInput の両方に数える（name の規則が単独で効くようにするため）。
     */
    function scanInputSurface(root: Element): { readonly scanned: readonly Element[]; readonly counts: InputSurfaceCounts } {
      const scanned = Array.from(root.querySelectorAll('*'));
      const count = (matches: (element: Element) => boolean): number => scanned.filter(matches).length;
      const isAllowedInput = (element: Element): boolean =>
        Object.values(ALLOWED_INPUT_SELECTORS).some((selector) => element.matches(selector));
      return {
        scanned,
        counts: {
          searchBox: count((element) => element.matches(ALLOWED_INPUT_SELECTORS.searchBox)),
          hiddenRadio: count((element) => element.matches(ALLOWED_INPUT_SELECTORS.hiddenRadio)),
          form: count((element) => element.localName === 'form'),
          button: count((element) => element.localName === 'button'),
          textarea: count((element) => element.localName === 'textarea'),
          select: count((element) => element.localName === 'select'),
          contentEditable: count((element) => element.hasAttribute('contenteditable')),
          interactiveRole: count((element) => roleTokens(element).some((role) => INTERACTIVE_ROLES.has(role))),
          formAttribute: count((element) => element.hasAttribute('form')),
          namedInput: count((element) => element.localName === 'input' && element.hasAttribute('name')),
          inputOutsideAllowlist: count((element) => element.localName === 'input' && !isAllowedInput(element)),
        },
      };
    }

    interface StructureState {
      /** 失敗メッセージへ出す状態名。design.md の構造契約表の行と 1 対 1 に対応させる。 */
      readonly name: string;
      /** その状態へ到達させる（liff / fetch のモックを整える）。 */
      readonly arrange: () => void;
      /** その状態が描画され切るまで待ち、宣言した状態へ実際に着いたことを確かめる。 */
      readonly settle: (container: HTMLElement) => Promise<void>;
      /** 許可リストの件数。状態ごとに完全一致で固定する。 */
      readonly inputs: AllowedInputCounts;
    }

    const SELECTION_BODY = {
      error: { code: 'STORE_SELECTION_REQUIRED', message: '表示する店舗を選んでください' },
      stores: MULTI_STORES,
    };

    // 競合の件数は、検索欄を出す境界の両側にそろえる（1 店以下の代表は 1 店、2 店以上の代表は 2 店）。
    const TWO_COMPETITORS: StoreDetailResponse['competitors'] = [
      ...mockResult.competitors,
      { name: '競合B', rating: 4.1, reviewCount: 60, starDiff: 0.4 },
    ];

    /** 正常の分岐の状態を作る。推移と競合の有無は応答で決まる。 */
    function readyState(name: string, body: StoreDetailResponse, inputs: AllowedInputCounts): StructureState {
      return {
        name,
        arrange: () => {
          stubFetch({ ok: true, status: 200, body });
        },
        settle: async (container) => {
          await waitFor(() => {
            expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
          });
          // 応答を取り違えて 4 通りが同じ画面になると、状態を分けた意味が無いまま緑になる。
          // 推移の表の有無と競合の件数で、宣言した状態へ着いたことを確かめる。
          expect(container.querySelectorAll('table'), name).toHaveLength(body.trend.length > 0 ? 1 : 0);
          const competitorsHeading = screen.getByRole('heading', { level: 2, name: '競合との比較' });
          expect(competitorsHeading.closest('section')!.querySelectorAll('li'), name).toHaveLength(body.competitors.length);
        },
        inputs,
      };
    }

    // 状態は design.md の構造契約表の全行である。見出し・主要領域・リンク・版面を検査する
    // 4 分岐の表（SURFACE_BRANCHES）には足さない。あちらの網羅を変えないためである。
    //
    // 件数は design.md の構造契約表の値であり、節への組み込みのタスクごとに表の値へ上げた（Migration
    // Strategy の手順 5）。推移ありの状態の隠し radio（期間と指標の札）は task 4.1 で、競合 2 店以上の
    // 状態の検索欄は task 4.2 で上げた。推移の有無に依らず、競合 2 店以上なら検索欄は 1 件である。
    // どちらも、上げる変更を先に書いて赤を見てから、実装で緑にした。
    const STRUCTURE_STATES: readonly StructureState[] = [
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
          expect(screen.getByText('読み込み中です…')).toBeDefined();
        },
        inputs: { searchBox: 0, hiddenRadio: 0 },
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
        inputs: { searchBox: 0, hiddenRadio: 0 },
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
        inputs: { searchBox: 0, hiddenRadio: 0 },
      },
      readyState('正常・推移 0 件・競合 1 店以下', { ...mockResult, trend: [] }, { searchBox: 0, hiddenRadio: 0 }),
      readyState(
        '正常・推移 0 件・競合 2 店以上',
        { ...mockResult, trend: [], competitors: TWO_COMPETITORS },
        { searchBox: 1, hiddenRadio: 0 },
      ),
      readyState('正常・推移あり・競合 1 店以下', mockResult, { searchBox: 0, hiddenRadio: 5 }),
      readyState(
        '正常・推移あり・競合 2 店以上',
        { ...mockResult, competitors: TWO_COMPETITORS },
        { searchBox: 1, hiddenRadio: 5 },
      ),
    ];

    /** 1 つのテストの中で状態を回すので、beforeEach と同じ初期状態へ毎回戻す。 */
    function armLiff(): void {
      liffMocks.init.mockReset().mockResolvedValue(undefined);
      liffMocks.isLoggedIn.mockReset().mockReturnValue(true);
      liffMocks.getIDToken.mockReset().mockReturnValue('test-id-token');
      liffMocks.login.mockReset();
    }

    it('7 状態すべてで書込の手段を 0 件に保ち、入力を許可リストの件数に限る（Req 7.1, 7.2, 7.4, 7.7）', async () => {
      // 状態の数は 7 で固定する（design の構造契約表の 1 行目が、読み込み中・失敗・店舗選択待ちの
      // 3 状態をまとめているので、表の行数は 5・状態は 7 である）。状態を消す改変を緑のまま通さない。
      expect(STRUCTURE_STATES).toHaveLength(7);

      let visited = 0;
      for (const state of STRUCTURE_STATES) {
        armLiff();
        state.arrange();
        const { container } = render(<StorePage />);
        await state.settle(container);
        // 走査の範囲は document.body とする。container の外へ描く要素（portal）も取りこぼさないためである。
        const scan = scanInputSurface(document.body);
        // 空振り対策: 走査した要素が 1 件以上あり、その中に描いた画面の主要領域が含まれること。
        expect(scan.scanned.length, state.name).toBeGreaterThan(0);
        expect(scan.scanned, state.name).toContain(container.querySelector('main'));
        expect(scan.counts, state.name).toEqual({ ...KEPT_AT_ZERO, ...state.inputs });
        visited += 1;
        cleanup();
        vi.unstubAllGlobals();
      }
      // 回らないループは何も検査しないまま緑になる。回った数を母数と突き合わせる。
      expect(visited).toBe(7);
    });

    it('走査器は許可リストの内外と、0 件を保つ規則を 1 件ずつ数え分ける（走査器の自己検証・Req 7.7）', () => {
      // 画面への変異で確かめられるのは、注入した一部の規則だけである。すべての規則が効くことはここで確かめる。
      // 走査が末尾の要素まで届くことも確かめるため、最後に 0 件を保つ規則の要素を置く。
      const root = document.createElement('div');
      root.innerHTML = [
        '<form></form>',
        '<button type="button"></button>',
        '<select></select>',
        '<div contenteditable="true"></div>',
        '<span role="button"></span>',
        '<span role="textbox"></span>',
        '<span role="combobox"></span>',
        '<span role="checkbox"></span>',
        // 大文字で書かれた role も、代替の並びの 2 つ目に置かれた role も数える。
        '<span role="SWITCH"></span>',
        '<span role="none slider"></span>',
        '<span role="spinbutton"></span>',
        // 2026-09-14 に足した 9 つも、1 つずつ置いて数える（列挙の書き違いを捕まえるため）。
        '<div role="searchbox" tabindex="0"></div>',
        '<span role="listbox"></span>',
        '<span role="option"></span>',
        '<span role="menu"></span>',
        '<span role="menuitem"></span>',
        '<span role="menuitemcheckbox"></span>',
        '<span role="menuitemradio"></span>',
        '<span role="tab"></span>',
        '<span role="treeitem"></span>',
        // 操作系ではない role は数えない（選択肢の部品は role="radio" の span を描く）。
        '<span role="radio"></span>',
        '<span role="radiogroup"></span>',
        '<div form="f"></div>',
        '<input type="search" data-slot="input">',
        '<input type="radio" aria-hidden="true" tabindex="-1">',
        '<input type="radio" aria-hidden="true" tabindex="-1" name="x">',
        // 許可リストに似ているが、属性が 1 つ欠けるか違うので外にある input。
        '<input type="search">',
        '<input type="radio" tabindex="-1">',
        '<input type="radio" aria-hidden="true">',
        '<input type="text" data-slot="input">',
        '<input>',
        '<textarea></textarea>',
      ].join('');

      expect(scanInputSurface(root).counts).toEqual({
        searchBox: 1,
        hiddenRadio: 2,
        form: 1,
        button: 1,
        textarea: 1,
        select: 1,
        contentEditable: 1,
        interactiveRole: 16,
        formAttribute: 1,
        namedInput: 1,
        inputOutsideAllowlist: 5,
      });
    });
  });
});
