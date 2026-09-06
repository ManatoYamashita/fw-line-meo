// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Alert } from '@fwlm/ui/components/alert';
import { buttonVariants } from '@fwlm/ui/components/button';
import { markAnswered } from '../src/app/s/[storeId]/answered-flag';
import { announcedText, ownText } from './live-region';

// 葉コンポーネントはモックし、シェルの状態遷移と API 呼出を独立に検証する。
vi.mock('../src/app/s/[storeId]/survey-form', () => ({
  SurveyForm: (props: {
    onSubmit: (a: { star: number; aspectCodes: string[] }) => void;
    submitting: boolean;
  }) => (
    <button
      data-testid="submit"
      disabled={props.submitting}
      onClick={() => props.onSubmit({ star: 5, aspectCodes: ['taste'] })}
    >
      submit
    </button>
  ),
}));
vi.mock('../src/app/s/[storeId]/draft-panel', () => ({
  DraftPanel: (props: {
    draft: string;
    regenerationsLeft: number;
    generationFailed: boolean;
    googleReviewUrl: string;
    onRegenerate: () => void;
  }) => (
    <div>
      <span data-testid="draft">{props.draft}</span>
      <span data-testid="left">{props.regenerationsLeft}</span>
      <span data-testid="failed">{String(props.generationFailed)}</span>
      <a data-testid="review-link" href={props.googleReviewUrl}>
        Google のクチコミを書く
      </a>
      <button data-testid="regen" onClick={() => props.onRegenerate()}>
        regen
      </button>
    </div>
  ),
}));

import { SurveyShell } from '../src/app/s/[storeId]/survey-shell';

const STORE = '44444444-4444-4444-4444-444444444444';

interface RouteResp {
  ok?: boolean;
  body: unknown;
}

function stubFetch(routes: Record<string, RouteResp>): ReturnType<typeof vi.fn> {
  const fn = vi.fn((url: string) => {
    const r = routes[url];
    return Promise.resolve({ ok: r?.ok ?? true, json: () => Promise.resolve(r?.body ?? {}) });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderShell() {
  return render(
    <SurveyShell
      storeId={STORE}
      storeName="テスト店"
      aspects={[{ code: 'taste', label: '味' }]}
      pageToken="PT"
      googleReviewUrl="https://review/ChIJ"
    />,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SurveyShell', () => {
  it('回答フェーズでフォームを表示する', () => {
    stubFetch({});
    renderShell();
    expect(screen.getByTestId('submit')).toBeDefined();
  });

  it('送信後に /api/responses を呼び下書きフェーズへ遷移する', async () => {
    const fetchFn = stubFetch({
      '/api/responses': { body: { generation: 'ok', draft: 'D1', sessionToken: 'T1', regenerationsLeft: 3 } },
    });
    renderShell();
    fireEvent.click(screen.getByTestId('submit'));
    const draft = await screen.findByTestId('draft');
    expect(draft.textContent).toBe('D1');
    expect(fetchFn).toHaveBeenCalledWith('/api/responses', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse((fetchFn.mock.calls[0]?.[1] as { body: string }).body);
    expect(body).toMatchObject({ pageToken: 'PT', storeId: STORE, star: 5, aspectCodes: ['taste'] });
  });

  it('再生成で /api/drafts を呼び下書きと残数を更新する', async () => {
    stubFetch({
      '/api/responses': { body: { generation: 'ok', draft: 'D1', sessionToken: 'T1', regenerationsLeft: 3 } },
      '/api/drafts': { body: { generation: 'ok', draft: 'D2', sessionToken: 'T2', regenerationsLeft: 2 } },
    });
    renderShell();
    fireEvent.click(screen.getByTestId('submit'));
    await screen.findByTestId('draft');
    fireEvent.click(screen.getByTestId('regen'));
    const draft = await screen.findByText('D2');
    expect(draft.textContent).toBe('D2');
    expect(screen.getByTestId('left').textContent).toBe('2');
  });

  it('回答済み(24h以内)は回答済み画面＋投稿導線を表示する', async () => {
    markAnswered(STORE);
    stubFetch({});
    renderShell();
    expect(await screen.findByText(/ご回答ありがとうございました/)).toBeDefined();
    const link = screen.getByRole('link', { name: /クチコミを書く/ });
    expect(link.getAttribute('href')).toBe('https://review/ChIJ');
    // フォームは表示しない
    expect(screen.queryByTestId('submit')).toBeNull();
  });

  it('生成失敗(200 failed)でも下書きフェーズへ遷移し投稿導線を維持する（3.9）', async () => {
    stubFetch({
      '/api/responses': { body: { generation: 'failed', draft: null, sessionToken: 'T1', regenerationsLeft: 3 } },
    });
    renderShell();
    fireEvent.click(screen.getByTestId('submit'));
    expect((await screen.findByTestId('failed')).textContent).toBe('true');
    // 投稿導線は失敗時も維持される
    expect(screen.getByTestId('review-link').getAttribute('href')).toBe('https://review/ChIJ');
  });

  it('送信が非 200 なら回答フェーズに留まりエラーを表示する', async () => {
    stubFetch({ '/api/responses': { ok: false, body: { error: { code: 'RATE_LIMITED' } } } });
    renderShell();
    fireEvent.click(screen.getByTestId('submit'));
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByTestId('submit')).toBeDefined(); // フォーム維持
    expect(screen.queryByTestId('draft')).toBeNull();
  });
});

// ---- ここから ui-airbnb-surfaces task 4.3 が追加した検証 ----

/** 回答済み画面の通知文言。`renderShell` が渡す店名を前置した完全な文字列。 */
const THANKS = 'テスト店へのご回答ありがとうございました。';
/** 送信が非 200 だったときの文言（`survey-shell.tsx` が持つ値と 1 文字も違わない）。 */
const SUBMIT_FAILED = '送信に失敗しました。時間をおいて再度お試しください。';
/** `renderShell` が渡す投稿先。既存 2 件が href の完全一致で固定している値と同一。 */
const REVIEW_URL = 'https://review/ChIJ';

function classesOf(element: Element): string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/).filter((value) => value.length > 0);
}

/** 高さ・内側余白・文字寸法。正典 7.10 が「面の側に書かない」と定めたもの。 */
const DIMENSION = /^(?:min-|max-)?h-|^p[xytrbles]?-|^text-(?:xs|sm|base|lg|[2-9]?xl)$/;

/** 通知の部品が変種ごとに持つユーティリティを、部品を素で描いて読み取る（実値を転記しない）。 */
function alertUtilities(variant?: 'success' | 'destructive'): string[] {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(variant === undefined ? <Alert /> : <Alert variant={variant} />, { container: host });
  const classes = classesOf(host.querySelector('[data-slot="alert"]')!);
  host.remove();
  return classes;
}

/**
 * 指定の変種**だけ**が持つユーティリティ（既定の変種との差分）。
 * 変種を取り違えるとこれらが欠けるので、実値を転記せずに取り違えを落とせる。
 */
function variantOnlyAlertUtilities(variant: 'success' | 'destructive'): string[] {
  const base = alertUtilities();
  return alertUtilities(variant).filter((utility) => !base.includes(utility));
}

/**
 * 面に描かれている通知の部品をちょうど 1 つに解決する。0 個でも 2 個でも例外になる。
 *
 * 着手前はどちらの通知も素の段落だったので、この関数は 0 個で落ちる。
 */
function theNotice(): HTMLElement {
  const notices = Array.from(document.body.querySelectorAll('[data-slot="alert"]'));
  expect(
    notices,
    `通知の部品が ${notices.length} 個あります（この面では常にちょうど 1 つ）`,
  ).toHaveLength(1);
  return notices[0] as HTMLElement;
}

/**
 * 通知が部品を通り、変種と読み上げ強度が design.md「Error Handling」の割り当てどおりであること。
 *
 * 実値を 1 つも書かない。変種の固有ユーティリティは部品を素で描いた差分から算出する。
 * 手書きで固定すると、部品の側が変わったときに検査だけが古びたまま緑になる。
 */
function expectNoticeThroughComponent(
  notice: HTMLElement,
  variant: 'success' | 'destructive',
  role: 'status' | 'alert',
  text: string,
): void {
  expect(notice.getAttribute('data-slot'), '通知が部品を通っていません').toBe('alert');
  expect(notice.getAttribute('role'), `通知の読み上げ役割が ${role} ではありません`).toBe(role);

  const variantOnly = variantOnlyAlertUtilities(variant);
  // **否定の前に非空アンカーを置く。** 差分が空だと以下の包含は 1 つも検査しない。
  expect(
    variantOnly,
    `変種 ${variant} の固有ユーティリティを 1 つも取り出せていません`,
  ).not.toEqual([]);
  for (const utility of variantOnly) {
    expect(classesOf(notice), `変種 ${variant} のユーティリティ ${utility} がありません`).toContain(
      utility,
    );
  }

  const description = notice.querySelector('[data-slot="alert-description"]');
  expect(description, '通知の説明文が部品を通っていません').not.toBeNull();
  // 文言は説明文の直下のテキストのまま。読み上げ専用の子要素へ落とすと可視の文字が消える。
  expect(ownText(description!), '通知の可視文言').toBe(text);
  // 読み上げが二重にならないこと。領域の入れ子や読み上げ専用の複写が入るとここが伸びる。
  expect(announcedText(notice), '通知の読み上げ文字列').toBe(text);

  // 寸法は部品の領分（正典 7.10）。上の包含が通っている時点で差し引きの非空は担保済み。
  const own = new Set(alertUtilities(variant));
  const extras = classesOf(notice).filter((utility) => !own.has(utility));
  expect(
    extras.filter((utility) => DIMENSION.test(utility)),
    `面の側が通知へ足したユーティリティ: ${extras.join(' ')}`,
  ).toEqual([]);
}

/** 投稿導線の「面をまたいで一致していなければならない部分」だけを取り出す。 */
function reviewLinkShape(link: Element): Record<string, string | null> {
  return {
    tagName: link.tagName,
    className: link.getAttribute('class'),
    target: link.getAttribute('target'),
    rel: link.getAttribute('rel'),
  };
}

/**
 * 実物の下書きパネル。**このファイルは葉をモックしている**ため、投稿導線の同一性を確かめるには
 * モックを迂回して実体を取り出す必要がある。モックした偽物どうしを比べても何も言えない。
 */
async function renderRealDraftPanel(): Promise<void> {
  const actual = await vi.importActual<typeof import('../src/app/s/[storeId]/draft-panel')>(
    '../src/app/s/[storeId]/draft-panel',
  );
  render(
    <actual.DraftPanel
      draft="下書き"
      generationFailed={false}
      regenerationsLeft={3}
      googleReviewUrl={REVIEW_URL}
      onRegenerate={() => {}}
      regenerating={false}
    />,
  );
}

async function renderAnsweredScreen(): Promise<void> {
  markAnswered(STORE);
  stubFetch({});
  renderShell();
  expect(await screen.findByText(THANKS)).toBeDefined();
}

async function renderSubmitFailure(): Promise<void> {
  stubFetch({ '/api/responses': { ok: false, body: { error: { code: 'RATE_LIMITED' } } } });
  renderShell();
  fireEvent.click(screen.getByTestId('submit'));
  expect(await screen.findByText(SUBMIT_FAILED)).toBeDefined();
}

// 着手前、この面の通知は 2 つとも素の段落で、片方は読み上げ役割を手書きしていた。
// 既存 6 件が見ているのは「文言が現れること」「`getByRole('alert')` が単数で解決すること」
// 「リンクの href」だけで、**通知が部品を通ることも、変種も、強度の分岐も、1 件も見ていない**。
describe('回答済み画面と回答フェーズ: 通知が部品を通る（着手前は無検証）', () => {
  it('感謝の通知は成功の変種の通知部品で描かれる（design.md「Error Handling」）', async () => {
    await renderAnsweredScreen();
    expectNoticeThroughComponent(theNotice(), 'success', 'status', THANKS);
  });

  it('送信失敗の通知は危険の変種の通知部品で描かれる（design.md「Error Handling」）', async () => {
    await renderSubmitFailure();
    expectNoticeThroughComponent(theNotice(), 'destructive', 'alert', SUBMIT_FAILED);
  });

  // 変種を取り違えると役割も一緒にずれる。片側だけを書くと取り違えが素通りするので、
  // 「成功が中断させないこと」と「危険が中断させること」を **両方向** で固定する。
  // 個数で書くのは、役割の等値だけだと領域がもう 1 つ増える改変を落とせないためである。
  it('通知の読み上げ強度の分岐は両方向に固定されている（成功は中断させない）', async () => {
    await renderAnsweredScreen();
    expect(screen.queryAllByRole('status'), '回答済み画面の穏やかな読み上げ領域').toHaveLength(1);
    expect(
      screen.queryAllByRole('alert'),
      '回答済み画面に進行中の読み上げを中断させる通知があります',
    ).toHaveLength(0);

    cleanup();
    localStorage.clear();

    await renderSubmitFailure();
    expect(screen.queryAllByRole('alert'), '送信失敗の中断させる通知').toHaveLength(1);
    expect(
      screen.queryAllByRole('status'),
      '送信失敗が穏やかな読み上げで出ています（中断させる必要があります）',
    ).toHaveLength(0);
  });
});

// 正典 `docs/design/design-language.md` の §7.9 / §7.10 を面の側から守る。
// この面の投稿導線は下書きパネルのものと同一でなければならない（同じ役割が 2 通りに描かれない）。
// 2 箇所に書き下されているのは、面ごとに境界を分けたためである。共有モジュールへ切り出す代わりに
// 同一性をここで機械強制する。
describe('回答済み画面: 投稿導線が面をまたいだ相等になる', () => {
  it('投稿導線は下書き画面のものと面をまたいだ相等になる（正典 7.9 / 7.10）', async () => {
    // 手書きの文字列で固定すると、部品の側が変わったときに両方が古びたまま緑になる。
    const expected = buttonVariants({ variant: 'outline', size: 'lg', className: 'w-full' });
    expect(expected, '期待値を算出できていません').not.toBe('');

    await renderAnsweredScreen();
    const answered = reviewLinkShape(screen.getByRole('link', { name: /クチコミを書く/ }));
    expect(answered, '回答済み画面の投稿導線が部品の算出結果と一致しません').toEqual({
      tagName: 'A',
      className: expected,
      target: '_blank',
      rel: 'noopener noreferrer',
    });

    cleanup();
    localStorage.clear();

    await renderRealDraftPanel();
    const drafting = reviewLinkShape(screen.getByRole('link', { name: /クチコミを書く/ }));
    expect(drafting, '下書き画面の投稿導線が回答済み画面のものと食い違っています').toEqual(answered);
  });

  it('投稿導線はちょうど 1 つで、面の側が寸法を足さない（正典 7.10・完了条件）', async () => {
    await renderAnsweredScreen();

    const links = screen.getAllByRole('link');
    expect(links, '回答済み画面のリンクの個数').toHaveLength(1);
    const named = screen.getAllByRole('link', { name: /クチコミを書く/ });
    expect(named, '投稿導線の個数が 1 つではありません').toHaveLength(1);

    const link = named[0]!;
    expect(link.getAttribute('href'), '投稿導線の href').toBe(REVIEW_URL);
    expect(link.getAttribute('target'), '投稿導線の target').toBe('_blank');
    expect(link.getAttribute('rel'), '投稿導線の rel').toBe('noopener noreferrer');

    // 部品が variant / size から自分で作るぶんを差し引き、**面が足した分**だけを見る。
    const own = new Set(
      buttonVariants({ variant: 'outline', size: 'lg' })
        .split(/\s+/)
        .filter((value) => value.length > 0),
    );
    const extras = classesOf(link).filter((utility) => !own.has(utility));
    // **否定の前に非空アンカーを置く。** 差し引きが壊れて空配列になると下の判定は何も検査しない。
    expect(extras, '面の側が足したユーティリティを 1 つも読み取れていません').toContain('w-full');
    expect(
      extras.filter((utility) => DIMENSION.test(utility)),
      `面の側が投稿導線へ足したユーティリティ: ${extras.join(' ')}`,
    ).toEqual([]);
  });
});
