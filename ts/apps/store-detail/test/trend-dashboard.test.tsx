// @vitest-environment jsdom
// store-detail-trend-dashboard（Issue #265）: 推移の節（task 4.1）と競合の節の検索（task 4.2）を、ページ全体で
// 検証する（app/store/page.tsx の TrendSection と CompetitorsSection）。操作の無副作用と、推移の 4 つの表示の
// 一貫性（task 4.3）も、ページ全体でここに置く。
//
// 推移の節は、期間と指標の状態を節の中だけに持つ。期間の要約・グラフ・現在値・推移の表の 4 つと、節の見出し・
// 表の名前は、1 回だけ切り出した期間の窓から導く（同 spec の research.md の決定 D1・D8、
// docs/design/design-language.md §7.19）。
// - 期間を切り替えると窓が変わり、見出し・表の名前・行・要約・グラフ・現在値がそろって追随する（要件 3.2）。
// - 指標を切り替えると、グラフと現在値だけが変わり、要約と表は変わらない（要件 3.3）。
// - どちらの切替も、ほかの節の表示を変えない（要件 3.8）。取得済みのデータから描き直し、取得をやり直さない（要件 2.5）。
// - 状態は URL にも端末にも残さないので、開き直すと既定（30 日・順位）に戻る（要件 2.3・2.9）。
// - 窓が作れないとき（推移が 0 件、または日付を解釈できる点が 0 件）は、選択肢を出さずに既存の案内を出す（要件 2.8）。
//
// 競合の節は、検索語の状態を節の中だけに持つ（同 spec の research.md の決定 D8）。
// - 検索欄は、当日の競合が 2 店以上のときだけ、一覧の Card の外に出す（要件 4.1・4.2、§7.19）。
// - 一覧は、店名に検索語を含む競合だけを元の順で描く。0 件なら、導線の無い空状態に置き換える（要件 4.3・4.9）。
// - 評価の無い店の注記は、絞り込みの結果ではなく全件から判定する。
// - 検索は、近隣順位とその母数・グラフ・推移の表・期間の要約を変えない（要件 4.10）。
//
// 操作の無副作用と表示の一貫性（task 4.3）:
// - 期間・指標・検索をどう操作しても、取得は描画時の GET の 1 回のままで、端末の保存領域・クッキー・閲覧履歴・
//   URL を変えない。帰属表示は 1 箇所に描かれ続ける（要件 7.3・8.1）。
// - 期間の要約・グラフ・現在値・推移の表の 4 つは、表示ごとに照合する相手を固定して確かめる（要件 3.1・3.7・
//   9.3）。表の行の日付はリテラルの窓の日付と、グラフの期間はリテラルの公称の始点〜終点と照合する。要約の
//   始点と終点・グラフの説明文の値・現在値は、表の値のある最初と最後の行と照合する（表示どうしの照合）。
//
// 部品単体の検査は、部品ごとのテストファイル（trend-chart / trend-controls / competitor-search）が持つ。検索語の
// 正規化の網羅は competitor-filter.test.ts が持つ。既定の状態の DOM が現行と同じであること（要件 8.3）と、
// 構造契約の件数は、store-page.test.tsx が持つ。
//
// 足場（LIFF のモックと fetch のスタブ）は、store-page.test.tsx の形に倣ってこのファイルで用意する。札の印の
// クリックは、Base UI が隠し input へ PointerEvent で転送するので、test/pointer-event.ts の互換実装を描画より前に
// 入れる。
//
// 期待する文言・日付・説明文・行は、リテラルで書く。窓の計算をテストの中で組み立て直すと、実装と同じ誤りを
// 期待値へ写しうるためである。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { StoreDetailResponse } from '../lib/contract';
import { UNRATED_COMPETITOR_FROM_GO } from './fixtures/unrated-competitor';
import { announcedText, ownText } from './live-region';
import { installPointerEventPolyfill } from './pointer-event';

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

installPointerEventPolyfill();

// --- fetch のスタブ（store-page.test.tsx の stubFetch と同じ形） ------------------------------

function stubFetch(body: StoreDetailResponse): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

// --- 応答 ----------------------------------------------------------------------------------

/**
 * 推移は 8/22〜8/31 の 10 日。30 日の窓（公称の始点は 8/2）はすべての点を含み、7 日の窓は 8/25〜8/31 になる。
 * 7 日の窓の外にある 3 点の値は、どの指標でも 7 日の窓の最初の値と異なる。そのため、窓を切り替えても要約の
 * 始点・行・グラフの名前が変わらない実装は、ここで赤になる。
 */
const TREND: StoreDetailResponse['trend'] = [
  { capturedOn: '2026-08-22', rank: 6, rating: '3.9', reviewCount: 100 },
  { capturedOn: '2026-08-23', rank: 5, rating: '4.0', reviewCount: 104 },
  { capturedOn: '2026-08-24', rank: 5, rating: '4.0', reviewCount: 108 },
  { capturedOn: '2026-08-25', rank: 4, rating: '4.1', reviewCount: 112 },
  { capturedOn: '2026-08-26', rank: 4, rating: '4.1', reviewCount: 115 },
  { capturedOn: '2026-08-27', rank: 3, rating: '4.2', reviewCount: 118 },
  { capturedOn: '2026-08-28', rank: 3, rating: '4.2', reviewCount: 121 },
  { capturedOn: '2026-08-29', rank: 3, rating: '4.2', reviewCount: 124 },
  { capturedOn: '2026-08-30', rank: 2, rating: '4.3', reviewCount: 127 },
  { capturedOn: '2026-08-31', rank: 2, rating: '4.4', reviewCount: 130 },
];

const SUMMARY: NonNullable<StoreDetailResponse['summary']> = {
  summaryDate: '2026-08-31',
  status: 'ready',
  rank: 2,
  // 近隣の店の数は、推移の最大順位（6 位）より大きくしておく。グラフの順位の軸の下端がこの値で決まる。
  rankTotal: 8,
  rankPrev: 2,
  rating: '4.4',
  ratingPrev: '4.3',
  reviewCount: 130,
  reviewCountPrev: 127,
  newReviewCount: 0,
  newReviews: [],
};

const RESPONSE: StoreDetailResponse = {
  storeId: 'store-1',
  storeName: 'テスト二子玉川店',
  stores: [{ storeId: 'store-1', name: 'テスト二子玉川店' }],
  summary: SUMMARY,
  competitors: [{ name: '競合テスト一号店', rating: 4.1, reviewCount: 90, starDiff: 0.3 }],
  trend: TREND,
};

// --- 期待する表示 --------------------------------------------------------------------------

/** 推移の節の表示。4 つの表示と、節の見出し・表の名前を 1 つにまとめて照合する（同時に変わることを確かめるため）。 */
interface TrendView {
  readonly heading: string;
  readonly tableName: string | null;
  /** 推移の表の行（見出しの行を除く）。各行はセルの読み上げ内容。 */
  readonly rows: readonly (readonly string[])[];
  /** 期間の要約（「表示期間の変化」）の組。 */
  readonly summary: readonly (readonly [string, string])[];
  /** グラフの名前（説明文）。 */
  readonly chartName: string | null;
  /** figcaption の各行。最後の行が現在値（最新の値とその日付）である。 */
  readonly caption: readonly string[];
}

const ROWS_30_DAYS: readonly (readonly string[])[] = [
  ['2026-08-22', '6', '3.9', '100'],
  ['2026-08-23', '5', '4.0', '104'],
  ['2026-08-24', '5', '4.0', '108'],
  ['2026-08-25', '4', '4.1', '112'],
  ['2026-08-26', '4', '4.1', '115'],
  ['2026-08-27', '3', '4.2', '118'],
  ['2026-08-28', '3', '4.2', '121'],
  ['2026-08-29', '3', '4.2', '124'],
  ['2026-08-30', '2', '4.3', '127'],
  ['2026-08-31', '2', '4.4', '130'],
];

const ROWS_7_DAYS: readonly (readonly string[])[] = [
  ['2026-08-25', '4', '4.1', '112'],
  ['2026-08-26', '4', '4.1', '115'],
  ['2026-08-27', '3', '4.2', '118'],
  ['2026-08-28', '3', '4.2', '121'],
  ['2026-08-29', '3', '4.2', '124'],
  ['2026-08-30', '2', '4.3', '127'],
  ['2026-08-31', '2', '4.4', '130'],
];

/**
 * 既定（30 日・順位）。
 *
 * この応答の推移は 8/22〜8/31 の 10 日ぶんしか無いので、30 日の窓では公称の始点（8/2）と、値を読んだ
 * 最初の日（8/22）が食い違う。3 組ともその期間を添える（要件 3.4 の 2026-09-19 訂正・Issue #286 項目 1）。
 * 7 日の窓（VIEW_7_DAYS_RANK）では 8/25〜8/31 が全日そろうので何も添えない。**この 2 つが「添える」と
 * 「添えない」の両端であり、期間の切替のテストが 30 日 ⇄ 7 日を往復するので、1 つのテストで両方が固定される。**
 */
const VIEW_30_DAYS_RANK: TrendView = {
  heading: '直近30日の推移',
  tableName: '直近30日の推移',
  rows: ROWS_30_DAYS,
  summary: [
    ['順位', '6位 → 2位 記録 8/22〜8/31'],
    ['評価', '3.9 → 4.4 記録 8/22〜8/31'],
    ['クチコミ数の増減', '+30件 記録 8/22〜8/31'],
  ],
  chartName: '順位の推移、8月2日から8月31日まで。最初の記録は6位、最後の記録は2位。最高は2位、最低は6位。最新は2位（8月31日）。',
  caption: ['順位の推移（上ほど上位）', '8/2〜8/31', '最新 2位（8/31）'],
};

/**
 * 「7日」を選んだあと（7 日・順位）。
 *
 * 公称の窓（8/25〜8/31）と、値を読んだ日が 3 組とも一致するので、**期間は添えない**。
 * 常に添える実装は、この期待値で赤になる。
 */
const VIEW_7_DAYS_RANK: TrendView = {
  heading: '直近7日の推移',
  tableName: '直近7日の推移',
  rows: ROWS_7_DAYS,
  summary: [
    ['順位', '4位 → 2位'],
    ['評価', '4.1 → 4.4'],
    ['クチコミ数の増減', '+18件'],
  ],
  chartName: '順位の推移、8月25日から8月31日まで。最初の記録は4位、最後の記録は2位。最高は2位、最低は4位。最新は2位（8月31日）。',
  caption: ['順位の推移（上ほど上位）', '8/25〜8/31', '最新 2位（8/31）'],
};

/** 「評価」を選んだあと（30 日・評価）。要約・表・見出し・表の名前は既定のままである。 */
const VIEW_30_DAYS_RATING: TrendView = {
  ...VIEW_30_DAYS_RANK,
  chartName: '評価の推移、8月2日から8月31日まで。最初の記録は3.9、最後の記録は4.4。最高は4.4、最低は3.9。最新は4.4（8月31日）。',
  caption: ['評価の推移', '8/2〜8/31', '最新 4.4（8/31）'],
};

const NO_TREND_TEXT = '推移データはまだありません（毎朝の集計後に表示されます）';

// --- 読み取り ------------------------------------------------------------------------------

/** 推移の節の見出し（期間の日数が入る）。ちょうど 1 つであることも getByRole が確かめる。 */
function trendHeading(): HTMLElement {
  return screen.getByRole('heading', { level: 2, name: /^直近\d+日の推移$/ });
}

function trendSection(): HTMLElement {
  const section = trendHeading().closest('section');
  expect(section, '推移の節').not.toBeNull();
  return section!;
}

/** 要約のカード（「表示期間の変化」を持つカード）。 */
function summaryCard(section: HTMLElement): HTMLElement {
  const card = within(section).getByText('表示期間の変化').closest<HTMLElement>('[data-slot="card"]');
  expect(card, '要約のカード').not.toBeNull();
  return card!;
}

/** dl 直下の各グループを、読み上げられるラベルと値の組として取り出す（store-page.test.tsx と同じ読み方）。 */
function definitionPairs(list: Element): readonly (readonly [string, string])[] {
  return Array.from(list.children).map((group) => {
    const term = group.querySelector('dt');
    const description = group.querySelector('dd');
    expect(term, '指標ラベル').not.toBeNull();
    expect(description, '指標値').not.toBeNull();
    return [announcedText(term!), announcedText(description!)] as const;
  });
}

/** 推移の節の表示を読み取る。グラフ（名前を持つ画像）は節の中にちょうど 1 つあることも確かめる。 */
function readTrendView(): TrendView {
  const section = trendSection();
  const table = within(section).getByRole('table');
  const container = table.closest('[data-slot="table-container"]');
  expect(container, '表の捲りの容器').not.toBeNull();
  const card = summaryCard(section);
  const list = card.querySelector('dl');
  expect(list, '要約の dl').not.toBeNull();
  const charts = within(section).getAllByRole('img');
  expect(charts, 'グラフの画像').toHaveLength(1);
  const caption = within(section).getByRole('figure').querySelector('figcaption');
  expect(caption, 'figcaption').not.toBeNull();

  return {
    heading: announcedText(trendHeading()),
    tableName: container!.getAttribute('aria-label'),
    rows: within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => Array.from(row.querySelectorAll('td')).map((cell) => announcedText(cell))),
    summary: definitionPairs(list!),
    chartName: charts[0]!.getAttribute('aria-label'),
    caption: Array.from(caption!.children).map((line) => announcedText(line)),
  };
}

/**
 * 読み取った表示が期待と一致し、見出し・表の名前・グラフの名前が算出される読み上げ名としても取れることを
 * 確かめる（属性の文字列だけでなく、支援技術が読む名前で掴めること）。
 */
function expectTrendView(expected: TrendView): void {
  expect(readTrendView()).toEqual(expected);
  const section = trendSection();
  expect(screen.getByRole('heading', { level: 2, name: expected.heading })).toBe(trendHeading());
  expect(within(section).getByRole('region', { name: expected.tableName ?? '' })).toBe(
    within(section).getByRole('table').closest('[data-slot="table-container"]'),
  );
  expect(within(section).getByRole('img', { name: expected.chartName ?? '' })).toBeDefined();
}

/** 期間と指標の群で、選択状態の札がちょうど 1 つずつあり、それが期待の札であること。 */
function expectSelected(period: string, metric: string): void {
  const periodGroup = screen.getByRole('radiogroup', { name: '期間' });
  const metricGroup = screen.getByRole('radiogroup', { name: 'グラフに表示する項目' });
  expect(within(periodGroup).getByRole('radio', { checked: true }), '期間').toBe(
    within(periodGroup).getByRole('radio', { name: period }),
  );
  expect(within(metricGroup).getByRole('radio', { checked: true }), 'グラフに表示する項目').toBe(
    within(metricGroup).getByRole('radio', { name: metric }),
  );
}

/** 札を押す（印をクリックする。Base UI が隠し input へ転送する経路）。 */
function choose(name: string): void {
  fireEvent.click(screen.getByRole('radio', { name }));
}

/** 推移の節を除いた、主要領域の直下の表示（店名の見出し・今日のポジション・競合・帰属表示）の読み上げ内容。 */
function otherSurfaceText(): readonly string[] {
  const trend = trendSection();
  return Array.from(screen.getByRole('main').children)
    .filter((child) => child !== trend)
    .map((child) => announcedText(child));
}

async function renderPage(body: StoreDetailResponse): Promise<ReturnType<typeof vi.fn>> {
  const fetchMock = stubFetch(body);
  render(<StorePage />);
  await waitFor(() => {
    expect(screen.getByText('データ提供: Google Maps')).toBeDefined();
  });
  return fetchMock;
}

// --- テスト --------------------------------------------------------------------------------

describe('推移の節の期間と指標（store-detail-trend-dashboard task 4.1・Issue #265）', () => {
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

  it('既定では 30 日・順位を選び、見出し・表の名前・行・要約・グラフ・現在値を 30 日の窓から描く（要件 2.3・3.1）', async () => {
    await renderPage(RESPONSE);

    expectSelected('30日', '順位');
    expectTrendView(VIEW_30_DAYS_RANK);
  });

  it('8 日以上の推移で「7日」を選ぶと、見出し・表の名前・行・要約・グラフの名前・現在値が同時に 7 日の窓へ変わる（要件 2.5・3.1・3.2・3.7・3.8）', async () => {
    const fetchMock = await renderPage(RESPONSE);
    expectTrendView(VIEW_30_DAYS_RANK);
    const others = otherSurfaceText();
    // 店名の見出し・今日のポジション・競合・帰属表示を読み取れていること（空の比較で緑にしないため）。
    expect(others).toHaveLength(4);

    choose('7日');

    expectSelected('7日', '順位');
    expectTrendView(VIEW_7_DAYS_RANK);
    // 30 日の見出しと表の名前は残らない（2 つの期間の表示が並ばない）。
    expect(screen.queryByRole('heading', { name: '直近30日の推移' })).toBeNull();
    expect(screen.queryByRole('region', { name: '直近30日の推移' })).toBeNull();
    // ほかの節は変わらない（要件 3.8）。取得はやり直さず、取得済みのデータから描き直す（要件 2.5）。
    expect(otherSurfaceText()).toEqual(others);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 「30日」へ戻すと、既定の表示へそのまま戻る（片方向にだけ効く実装を通さない）。
    choose('30日');
    expectSelected('30日', '順位');
    expectTrendView(VIEW_30_DAYS_RANK);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('「評価」を選ぶと、グラフの名前・figcaption・現在値だけが変わり、見出し・表の名前・要約・表は変わらない（要件 3.3・3.8）', async () => {
    const fetchMock = await renderPage(RESPONSE);
    const before = readTrendView();
    expect(before).toEqual(VIEW_30_DAYS_RANK);
    const others = otherSurfaceText();
    expect(others).toHaveLength(4);

    choose('評価');

    expectSelected('30日', '評価');
    const after = readTrendView();
    expect(after).toEqual(VIEW_30_DAYS_RATING);
    // 変わったのはグラフの名前と figcaption（現在値を含む）だけであることを、差として確かめる。
    expect({ ...after, chartName: before.chartName, caption: before.caption }).toEqual(before);
    expect(after.chartName).not.toBe(before.chartName);
    expect(after.caption.at(-1)).not.toBe(before.caption.at(-1));
    expect(otherSurfaceText()).toEqual(others);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('選択中の指標の値が 7 日の窓に無いとき、「7日」を選ぶと現在値も窓に従って消え、記録が無い旨に替わる（要件 1.10・3.2）', async () => {
    // 窓の終点は両方の期間で同じなので、値のある最後の日が 7 日の窓にあれば、現在値は 30 日と同じ値になる。
    // 現在値が窓から導かれていることは、値のある最後の日が 7 日の窓の外にある推移でだけ見分けられる。
    const unratedLastWeek: StoreDetailResponse = {
      ...RESPONSE,
      summary: { ...SUMMARY, rank: null, rankPrev: null, rankTotal: null, rating: null, ratingPrev: null },
      trend: TREND.map((point) => (point.capturedOn >= '2026-08-25' ? { ...point, rank: null, rating: null } : point)),
    };
    await renderPage(unratedLastWeek);

    const figure = within(summaryCard(trendSection())).getByRole('figure');
    expect(Array.from(figure.querySelector('figcaption')!.children).map((line) => announcedText(line))).toEqual([
      '順位の推移（上ほど上位）',
      '8/2〜8/31',
      '最新 5位（8/24）',
    ]);

    choose('7日');

    const card = summaryCard(trendSection());
    expect(within(card).queryByRole('figure')).toBeNull();
    expect(within(card).queryAllByRole('img')).toHaveLength(0);
    // 文言は窓の期間（7 日なので 8/25〜8/31）を持ち、空状態の部品で描かれる（2026-09-18 の画面レビュー）。
    const noRecords = within(card).getByText(
      'この期間（8/25〜8/31）は順位の記録がありません。ほかの項目や期間に切り替えると表示できることがあります。',
    );
    expect(noRecords.closest('[data-slot="empty-state"]')).not.toBeNull();
    expect(definitionPairs(card.querySelector('dl')!)).toEqual([
      ['順位', '—'],
      ['評価', '—'],
      ['クチコミ数の増減', '+18件'],
    ]);
    expect(within(trendSection()).getAllByRole('row').slice(1)).toHaveLength(ROWS_7_DAYS.length);
  });

  it('グラフの順位の軸の下端に当日サマリーの近隣の店の数を使い、サマリーが無ければ期間内の最大順位で決める', async () => {
    // 推移の最大順位は 6 位、近隣の店の数は 8。8 位の目盛りは、近隣の店の数が軸へ届いたときにだけ現れる。
    const cases = [
      { name: '近隣の店の数あり', body: RESPONSE, present: ['8位'], absent: [] },
      { name: 'サマリー無し', body: { ...RESPONSE, summary: null }, present: ['6位'], absent: ['8位'] },
    ] as const;

    let visited = 0;
    for (const item of cases) {
      await renderPage(item.body);
      const text = within(trendSection()).getByRole('figure').textContent ?? '';
      for (const label of item.present) {
        expect(text, `${item.name}: ${label}`).toContain(label);
      }
      for (const label of item.absent) {
        expect(text, `${item.name}: ${label}`).not.toContain(label);
      }
      visited += 1;
      cleanup();
      vi.unstubAllGlobals();
    }
    expect(visited).toBe(cases.length);
  });

  it('選択肢を要約のカードの外に置き、グラフを要約の 3 組の上に、表をカードの下に置く（§7.19）', async () => {
    await renderPage(RESPONSE);

    const section = trendSection();
    const card = summaryCard(section);
    // 期間の群と指標の群（群ごとの中身は trend-controls.test.tsx が固定している）。
    const groups = within(section).getAllByRole('radiogroup');
    expect(groups).toHaveLength(2);
    const following = (earlier: Node, later: Node): boolean =>
      (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

    for (const group of groups) {
      // 選択肢は要約のカードの中に入れない。カードより前（見出しの後）に置く。
      expect(card.contains(group)).toBe(false);
      expect(following(trendHeading(), group)).toBe(true);
      expect(following(group, card)).toBe(true);
    }
    // グラフは要約のカードの中で、3 組（dl）の**上**に置く（2026-09-18 の画面レビュー）。指標の札が効く先は
    // グラフだけなので、間に指標が効かない 3 組を挟むと、押した結果が画面のずっと下に出る。
    // 要約は「表の前」という §7.17 の定めのまま、グラフの下・表の上に残る。
    const figure = within(card).getByRole('figure');
    expect(following(figure, card.querySelector('dl')!)).toBe(true);
    // 表は要約のカードの外、その下に置く。
    const table = within(section).getByRole('table');
    expect(card.contains(table)).toBe(false);
    expect(following(card, table)).toBe(true);
  });

  // 2026-09-18 の画面レビュー（要件 9.7）で入れた網。
  //
  // 指標の札が効く先はグラフだけであり、グラフは role="img" の名前でしか内容を持たない。名前は読み上げ
  // 領域ではないので、この領域が無いと、順位 → 評価の切替は読み上げ利用者に何も届かない。**この検査を
  // 外すと、領域を消す改変も、領域ごと差し替える改変も、どのテストからも赤くならない。**
  it('指標と期間を切り替えると、選択の結果を伝える読み上げ領域の文字だけが変わる（要件 9.7）', async () => {
    const fetchMock = await renderPage(RESPONSE);

    const section = trendSection();
    const statuses = within(section).getAllByRole('status');
    expect(statuses).toHaveLength(1);
    const status = statuses[0]!;

    // 見えない領域である（同じ内容は figcaption とグラフの名前が見える形で持つので、二重に見せない）。
    expect(status.getAttribute('class')?.split(/\s+/)).toContain('sr-only');
    // 通知の強さと範囲は status の役割の既定に任せる（割り込まない・文言の全体を読む）。
    expect(status.hasAttribute('aria-live')).toBe(false);
    expect(status.hasAttribute('aria-atomic')).toBe(false);
    expect(ownText(status)).toBe('順位の推移、直近30日。最新 2位（8/31）。');

    // 指標を切り替えると、**要素は同じまま文字だけが変わる**。要素ごと差し替わると、読み上げは挿入として
    // 扱われて安定しない。
    choose('評価');
    expect(within(section).getByRole('status')).toBe(status);
    expect(ownText(status)).toBe('評価の推移、直近30日。最新 4.4（8/31）。');

    // 期間を切り替えても同じ要素のまま、期間の部分が追随する。
    choose('7日');
    expect(within(section).getByRole('status')).toBe(status);
    expect(ownText(status)).toBe('評価の推移、直近7日。最新 4.4（8/31）。');

    // 読み上げのための領域であって、取得も描画の面も増やさない。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('開き直すと、前回の選択を復元せず既定の選択で描く（要件 2.9）', async () => {
    await renderPage(RESPONSE);
    choose('7日');
    choose('評価');
    expectSelected('7日', '評価');

    cleanup();
    vi.unstubAllGlobals();
    await renderPage(RESPONSE);

    expectSelected('30日', '順位');
    expectTrendView(VIEW_30_DAYS_RANK);
  });

  it('推移が 0 件、または日付を解釈できる点が 0 件なら、選択肢もグラフも出さずに既存の案内を出す（要件 2.8）', async () => {
    const cases = [
      { name: '推移 0 件', trend: [] },
      {
        name: '日付を解釈できる点が 0 件',
        trend: [{ capturedOn: '2026/08/31', rank: 2, rating: '4.4', reviewCount: 130 }],
      },
    ] as const;

    let visited = 0;
    for (const item of cases) {
      await renderPage({ ...RESPONSE, trend: item.trend });
      const section = trendSection();
      expect(announcedText(trendHeading()), item.name).toBe('直近30日の推移');
      const states = Array.from(section.querySelectorAll('[data-slot="empty-state"]'));
      expect(states.map((state) => announcedText(state)), item.name).toEqual([NO_TREND_TEXT]);
      expect(within(section).queryAllByRole('radiogroup'), item.name).toHaveLength(0);
      expect(within(section).queryAllByRole('radio'), item.name).toHaveLength(0);
      expect(section.querySelectorAll('input'), item.name).toHaveLength(0);
      expect(within(section).queryByRole('figure'), item.name).toBeNull();
      expect(within(section).queryByRole('table'), item.name).toBeNull();
      visited += 1;
      cleanup();
      vi.unstubAllGlobals();
    }
    expect(visited).toBe(cases.length);
  });
});

// --- 競合の節の検索（task 4.2） -------------------------------------------------------------

/** 検索欄の見えるラベル（competitor-search.tsx）。入力欄の名前にもなる。 */
const SEARCH_LABEL = '店名で絞り込む';

/** 絞り込みの結果が 0 件のときの案内（design.md「CompetitorsSection」）。 */
const NO_MATCH_TEXT = '該当する競合がいません。店名の一部で絞り込み直すか、入力を消すと一覧に戻ります。';

/**
 * 0 件のときの件数の文言。回復方法（＝空状態と同じ文言）が続く（2026-09-18 の画面レビュー）。
 * 入力欄に留まったままの利用者へ、出口を読み上げで届けるためである。
 */
const zeroCount = (total: number): string => `競合${total}店のうち0店を表示。${NO_MATCH_TEXT}`;

/** 評価の無い店の注記（`@fwlm/db/daily-summary` の UNRATED_EXCLUDED_NOTE と同じ文言）。 */
const UNRATED_NOTE = '評価のない店は順位に含めていません';

/** どの競合にも当たらない、長い英字列の検索語（e2e の「検索 0 件」の状態と同じ種類の入力）。 */
const NO_MATCH_QUERY = 'nomatchingcompetitornamewhatsoeverzzzzzzzzzzzzzzzz';

/**
 * 5 店の競合（架空の店名。公開リポジトリなので実在の店名を使わない）。並びは応答の順（rank 順）である。
 * - 「店」は 1 店目と 4 店目に当たる。間に当たらない店を挟むので、元の順を保つかを見分けられ、絞り込み後の
 *   位置が元の位置とずれる行もできる。
 * - 「さんぷる」は、ひらがなで打っても 2 店目のカタカナの店名に当たる（面が正規化つきの絞り込みを使うこと）。
 * - 3 店目は Go が書く評価の無い店で、「サンプル」では外れる（注記を全件から判定するかを見分ける）。
 */
const FIVE_COMPETITORS: StoreDetailResponse['competitors'] = [
  { name: 'テスト珈琲 本店', rating: 4.5, reviewCount: 210, starDiff: -0.1 },
  { name: 'サンプル食堂', rating: 4.2, reviewCount: 88, starDiff: 0.2 },
  UNRATED_COMPETITOR_FROM_GO,
  { name: 'ためし軒 駅前店', rating: 3.9, reviewCount: 45, starDiff: 0.5 },
  { name: 'Example Bistro', rating: 4.0, reviewCount: 130, starDiff: 0.4 },
];

/** 5 店の店名（応答の順）。 */
const FIVE_NAMES: readonly string[] = [
  'テスト珈琲 本店',
  'サンプル食堂',
  UNRATED_COMPETITOR_FROM_GO.name,
  'ためし軒 駅前店',
  'Example Bistro',
];

/** 競合だけを差し替えた応答を作る（推移と当日サマリーは既定の応答のまま）。 */
function withCompetitors(
  competitors: StoreDetailResponse['competitors'],
  patch: Partial<StoreDetailResponse> = {},
): StoreDetailResponse {
  return { ...RESPONSE, ...patch, competitors };
}

function competitorsSection(): HTMLElement {
  const section = screen.getByRole('heading', { level: 2, name: '競合との比較' }).closest('section');
  expect(section, '競合の節').not.toBeNull();
  return section!;
}

/** 一覧の行の店名（行の先頭の段落の、見える文字）。 */
function rowName(row: Element): string {
  const name = row.querySelector('p');
  expect(name, '店名の段落').not.toBeNull();
  return ownText(name!);
}

/** 一覧に描かれた店名（描かれた順）。 */
function listedNames(): readonly string[] {
  return within(competitorsSection())
    .queryAllByRole('listitem')
    .map((row) => rowName(row));
}

/** 店名から行を引く対応表（描かれた順）。同じ店名の行があると表が縮むので、行の数と突き合わせる。 */
function rowsByName(): ReadonlyMap<string, HTMLElement> {
  const rows = within(competitorsSection()).queryAllByRole('listitem');
  const map = new Map(rows.map((row) => [rowName(row), row] as const));
  expect(map.size, '店名の重複').toBe(rows.length);
  return map;
}

function searchBox(): HTMLInputElement {
  const input = within(competitorsSection()).getByRole('searchbox', { name: SEARCH_LABEL });
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('検索欄が input 要素ではありません');
  }
  return input;
}

function typeQuery(value: string): void {
  fireEvent.change(searchBox(), { target: { value } });
}

/** 件数の文言（節の中の状態通知の要素の、見える文字）。 */
function countText(): string {
  return ownText(within(competitorsSection()).getByRole('status'));
}

/** 競合の節の中の、評価の無い店の注記の段落。 */
function unratedNotes(): readonly HTMLElement[] {
  return Array.from(competitorsSection().querySelectorAll('p')).filter((p) => announcedText(p) === UNRATED_NOTE);
}

/** 今日のポジションの組（近隣順位とその母数）。 */
function positionPairs(): readonly (readonly [string, string])[] {
  const heading = screen.getByRole('heading', { level: 2, name: /今日のポジション/ });
  const list = heading.parentElement?.querySelector('dl') ?? null;
  expect(list, '今日のポジションの dl').not.toBeNull();
  return definitionPairs(list!);
}

/** 競合の節を除いた、主要領域の直下の表示（店名の見出し・今日のポジション・推移・帰属表示）の読み上げ内容。 */
function textOutsideCompetitors(): readonly string[] {
  const competitors = competitorsSection();
  return Array.from(screen.getByRole('main').children)
    .filter((child) => child !== competitors)
    .map((child) => announcedText(child));
}

/** earlier が文書の順で later より前にあること。 */
function precedes(earlier: Node, later: Node): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('競合の節の検索（store-detail-trend-dashboard task 4.2・Issue #265）', () => {
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

  it('当日の競合が 1 店以下なら、検索欄も件数の文言も出さず、一覧をそのまま描く（要件 4.2）', async () => {
    const cases = [
      { name: '競合 0 店', competitors: [], names: [] },
      { name: '競合 1 店', competitors: FIVE_COMPETITORS.slice(0, 1), names: ['テスト珈琲 本店'] },
    ] as const;

    let visited = 0;
    for (const item of cases) {
      await renderPage(withCompetitors(item.competitors));
      const section = competitorsSection();
      expect(screen.queryAllByRole('searchbox'), item.name).toHaveLength(0);
      expect(section.querySelectorAll('input'), item.name).toHaveLength(0);
      expect(screen.queryByText(SEARCH_LABEL), item.name).toBeNull();
      // 読み上げ領域を競合の節の中で数える。面全体で数えないのは、推移の節が選択の結果を伝える領域を
      // 1 つ持つからである（2026-09-18 の画面レビュー・下の「指標を切り替えたときに…」で固定している）。
      expect(within(section).queryAllByRole('status'), item.name).toHaveLength(0);
      expect(section.textContent ?? '', item.name).not.toMatch(/店のうち\d+店を表示/);
      expect(listedNames(), item.name).toEqual(item.names);
      visited += 1;
      cleanup();
      vi.unstubAllGlobals();
    }
    expect(visited).toBe(cases.length);
  });

  it('当日の競合が 2 店以上なら、一覧の Card の外に、見えるラベル付きの検索欄と件数の文言を出す（要件 4.1・4.7・5.7、§7.19）', async () => {
    const cases = [
      {
        name: '競合 2 店',
        competitors: FIVE_COMPETITORS.slice(0, 2),
        names: ['テスト珈琲 本店', 'サンプル食堂'],
        count: '競合2店のうち2店を表示',
      },
      { name: '競合 5 店', competitors: FIVE_COMPETITORS, names: FIVE_NAMES, count: '競合5店のうち5店を表示' },
    ] as const;

    let visited = 0;
    for (const item of cases) {
      await renderPage(withCompetitors(item.competitors));
      const section = competitorsSection();
      const box = searchBox();
      // 検索語は空から始め、一覧はすべての競合を元の順で描く（要件 4.5・4.11）。
      expect(box.value, item.name).toBe('');
      expect(listedNames(), item.name).toEqual(item.names);
      const status = within(section).getByRole('status');
      expect(ownText(status), item.name).toBe(item.count);
      // 競合の節の読み上げ領域は、件数の文言の 1 つだけである（節の中で数える。面全体では、推移の節が
      // 選択の結果を伝える領域をもう 1 つ持つ）。
      expect(within(section).getAllByRole('status'), item.name).toEqual([status]);

      // 並び: 見出し → 検索欄 → 件数の文言 → 一覧の Card。検索欄と件数の文言は Card の中に入れない（§7.19）。
      const cards = Array.from(section.querySelectorAll<HTMLElement>('[data-slot="card"]'));
      expect(cards, item.name).toHaveLength(1);
      const card = cards[0]!;
      expect(card.contains(box), item.name).toBe(false);
      expect(card.contains(status), item.name).toBe(false);
      expect(within(card).getAllByRole('listitem'), item.name).toHaveLength(item.names.length);
      const heading = within(section).getByRole('heading', { level: 2, name: '競合との比較' });
      expect(precedes(heading, box), item.name).toBe(true);
      expect(precedes(box, status), item.name).toBe(true);
      expect(precedes(status, card), item.name).toBe(true);
      visited += 1;
      cleanup();
      vi.unstubAllGlobals();
    }
    expect(visited).toBe(cases.length);
  });

  it('検索語を入れると、店名に検索語を含む競合だけを元の順で残し、件数の文言が追随する（要件 4.3・4.4・4.5・4.7）', async () => {
    await renderPage(withCompetitors(FIVE_COMPETITORS));
    // 絞り込む前の各行の読み上げ内容を、店名ごとに控える。絞り込んだ後の行が、同じ店の中身のまま描かれることを
    // 確かめるため（行の描き方は Issue #266 のまま変えない）。
    const rowTexts = new Map(Array.from(rowsByName()).map(([name, row]) => [name, announcedText(row)] as const));
    expect(Array.from(rowTexts.keys())).toEqual(FIVE_NAMES);

    const steps = [
      { query: '店', names: ['テスト珈琲 本店', 'ためし軒 駅前店'], count: '競合5店のうち2店を表示' },
      { query: 'さんぷる', names: ['サンプル食堂'], count: '競合5店のうち1店を表示' },
      { query: '', names: FIVE_NAMES, count: '競合5店のうち5店を表示' },
    ] as const;
    for (const step of steps) {
      typeQuery(step.query);
      expect(searchBox().value, step.query).toBe(step.query);
      expect(listedNames(), step.query).toEqual(step.names);
      expect(countText(), step.query).toBe(step.count);
      for (const [name, row] of rowsByName()) {
        expect(announcedText(row), `${step.query}: ${name}`).toBe(rowTexts.get(name));
      }
    }
  });

  it('絞り込みの結果が 0 件なら、一覧の Card を導線の無い空状態に置き換え、検索欄と件数の文言は残す（要件 4.9・7.5）', async () => {
    // 店舗の切替リンクを 1 つ持つ応答にして、リンクの個数と読み上げ名が検索で変わらないことも確かめる（要件 7.5）。
    await renderPage(
      withCompetitors(FIVE_COMPETITORS, {
        stores: [
          { storeId: 'store-1', name: 'テスト二子玉川店' },
          { storeId: 'store-2', name: 'テスト三軒茶屋店' },
        ],
      }),
    );
    const linkNames = (): readonly string[] => screen.queryAllByRole('link').map((link) => announcedText(link));
    expect(linkNames()).toEqual(['店舗を切り替える']);

    typeQuery(NO_MATCH_QUERY);

    const section = competitorsSection();
    expect(countText()).toBe(zeroCount(5));
    // 一覧の Card ごと空状態に置き換わる。
    expect(section.querySelectorAll('[data-slot="card"]')).toHaveLength(0);
    expect(within(section).queryAllByRole('list')).toHaveLength(0);
    expect(within(section).queryAllByRole('listitem')).toHaveLength(0);
    const states = Array.from(section.querySelectorAll<HTMLElement>('[data-slot="empty-state"]'));
    expect(states.map((state) => announcedText(state))).toEqual([NO_MATCH_TEXT]);
    const state = states[0]!;
    // 導線を置かない。空状態の中を走査し（走査した要素が 1 件以上あることも確かめる）、リンク・押しボタン・
    // 入力・役割を持つ要素・焦点を受け取る要素が 0 件であること。
    expect(state.querySelectorAll('*').length).toBeGreaterThan(0);
    expect(state.querySelectorAll('a, button, input, [role], [tabindex]')).toHaveLength(0);
    // 空状態は通知にしない（件数の文言と二重に読み上げられるのを防ぐ）。競合の節の読み上げ領域は
    // 件数の文言の 1 つだけである（面全体では、推移の節が選択の結果を伝える領域をもう 1 つ持つ）。
    expect(state.hasAttribute('role')).toBe(false);
    const status = within(section).getByRole('status');
    expect(within(section).getAllByRole('status')).toEqual([status]);
    // 節の中にリンクは無く、面のリンクの個数と読み上げ名は変わらない。
    expect(within(section).queryAllByRole('link')).toHaveLength(0);
    expect(linkNames()).toEqual(['店舗を切り替える']);
    // 検索欄は Card と一緒に消えずに残り、空状態は検索欄と件数の文言の後に置く。
    expect(searchBox().value).toBe(NO_MATCH_QUERY);
    expect(precedes(searchBox(), status)).toBe(true);
    expect(precedes(status, state)).toBe(true);

    // 案内の文言が約束するとおり、店名の一部で探し直すと一覧が現れ、検索欄を空にすると一覧が元の順で戻る。
    typeQuery('サンプル');
    expect(listedNames()).toEqual(['サンプル食堂']);
    expect(competitorsSection().querySelectorAll('[data-slot="empty-state"]')).toHaveLength(0);
    typeQuery(NO_MATCH_QUERY);
    expect(listedNames()).toEqual([]);
    typeQuery('');
    expect(listedNames()).toEqual(FIVE_NAMES);
    expect(competitorsSection().querySelectorAll('[data-slot="empty-state"]')).toHaveLength(0);
    expect(countText()).toBe('競合5店のうち5店を表示');
  });

  it('評価の無い店の注記は、絞り込みの結果ではなく全件から判定する（その店が外れても残し、いなければ出さない）', async () => {
    await renderPage(withCompetitors(FIVE_COMPETITORS));
    expect(listedNames()).toContain(UNRATED_COMPETITOR_FROM_GO.name);
    expect(unratedNotes()).toHaveLength(1);

    for (const query of ['サンプル', NO_MATCH_QUERY]) {
      typeQuery(query);
      // 対照: 評価の無い店は、一覧から外れている。
      expect(listedNames(), query).not.toContain(UNRATED_COMPETITOR_FROM_GO.name);
      const notes = unratedNotes();
      expect(notes, query).toHaveLength(1);
      // 注記は、一覧（または空状態）の後の、末尾に置いたままである。節は 2 つの束（見出しと検索欄／
      // 一覧と注記）に分かれているので（2026-09-18 の画面レビュー）、末尾は後ろの束の末尾で見る。
      const listGroup = competitorsSection().lastElementChild;
      expect(listGroup, query).not.toBeNull();
      expect(listGroup!.lastElementChild, query).toBe(notes[0]);
    }

    // 既定の側: 評価の無い店がいない一覧では、どの検索語でも注記を出さない。
    cleanup();
    vi.unstubAllGlobals();
    await renderPage(withCompetitors(FIVE_COMPETITORS.filter((competitor) => competitor.rating !== null)));
    const steps = [
      { query: '店', count: '競合4店のうち2店を表示' },
      { query: NO_MATCH_QUERY, count: zeroCount(4) },
      { query: '', count: '競合4店のうち4店を表示' },
    ] as const;
    for (const step of steps) {
      typeQuery(step.query);
      // 対照: 検索は効いている。
      expect(countText(), step.query).toBe(step.count);
      expect(unratedNotes(), step.query).toHaveLength(0);
    }
  });

  it('検索しても、近隣順位とその母数・グラフ・推移の表・期間の要約を変えない（要件 4.10）', async () => {
    const fetchMock = await renderPage(withCompetitors(FIVE_COMPETITORS));
    const position = [['近隣8店中', '2位 前日比: → 変動なし']];
    expect(positionPairs()).toEqual(position);
    expectTrendView(VIEW_30_DAYS_RANK);
    const outside = textOutsideCompetitors();
    // 店名の見出し・今日のポジション・推移・帰属表示を読み取れていること（空の比較で緑にしないため）。
    expect(outside).toHaveLength(4);

    const steps = [
      { query: '店', count: '競合5店のうち2店を表示' },
      { query: NO_MATCH_QUERY, count: zeroCount(5) },
      { query: '', count: '競合5店のうち5店を表示' },
    ] as const;
    for (const step of steps) {
      typeQuery(step.query);
      // 対照: 検索は効いている（件数の文言が変わった）。
      expect(countText(), step.query).toBe(step.count);
      expect(positionPairs(), step.query).toEqual(position);
      expect(readTrendView(), step.query).toEqual(VIEW_30_DAYS_RANK);
      expectSelected('30日', '順位');
      expect(textOutsideCompetitors(), step.query).toEqual(outside);
    }
    // 取得はやり直さず、取得済みのデータから描き直す。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('期間と指標を切り替えても、検索語と絞り込みの結果は保たれる（2 つの節の状態は互いに独立する・決定 D8）', async () => {
    await renderPage(withCompetitors(FIVE_COMPETITORS));
    typeQuery('店');
    expect(listedNames()).toEqual(['テスト珈琲 本店', 'ためし軒 駅前店']);

    choose('7日');
    choose('評価');

    // 対照: 切替は効いている。
    expectSelected('7日', '評価');
    expect(announcedText(trendHeading())).toBe('直近7日の推移');
    expect(searchBox().value).toBe('店');
    expect(listedNames()).toEqual(['テスト珈琲 本店', 'ためし軒 駅前店']);
    expect(countText()).toBe('競合5店のうち2店を表示');
  });

  it('絞り込みの前後で表示され続ける店の行は、作り直さずに同じ要素のまま残る（一覧の key に絞り込み後の位置を含めない）', async () => {
    await renderPage(withCompetitors(FIVE_COMPETITORS));

    // 各段で、前後の両方に表示されている店の行が、同じ要素のままであることを確かめる。「店」と「サンプル」では、
    // 残る店の絞り込み後の位置が元の位置からずれる（4 店目が 2 行目へ、2 店目が 1 行目へ）。key が絞り込み後の
    // 位置を含むと、同じ店に別の key が付き、行が作り直される。
    const steps = [
      { query: '店', names: ['テスト珈琲 本店', 'ためし軒 駅前店'] },
      { query: '', names: FIVE_NAMES },
      { query: 'サンプル', names: ['サンプル食堂'] },
      { query: '', names: FIVE_NAMES },
    ] as const;
    for (const step of steps) {
      const before = rowsByName();
      typeQuery(step.query);
      const after = rowsByName();
      expect(Array.from(after.keys()), step.query).toEqual(step.names);
      const kept = Array.from(after).filter(([name]) => before.has(name));
      // 空振り対策: 比べた行が 1 つ以上あること。
      expect(kept.length, step.query).toBeGreaterThan(0);
      for (const [name, row] of kept) {
        expect(row, `${step.query}: ${name}`).toBe(before.get(name));
      }
    }
  });

  it('同じ店名の競合が 2 店あっても、行を取り違えず、key の重複の警告も出さない', async () => {
    // 店名は Places の表示名で、一意ではない（同じ名前の系列店が近隣に 2 つある場合）。
    const duplicated: StoreDetailResponse['competitors'] = [
      { name: 'テスト珈琲', rating: 4.5, reviewCount: 210, starDiff: -0.1 },
      { name: 'サンプル食堂', rating: 4.2, reviewCount: 88, starDiff: 0.2 },
      { name: 'テスト珈琲', rating: 3.8, reviewCount: 12, starDiff: 0.6 },
    ];
    const FIRST = 'テスト珈琲評価★4.5クチコミ210件星差-0.1';
    const SECOND = 'サンプル食堂評価★4.2クチコミ88件星差+0.2';
    const THIRD = 'テスト珈琲評価★3.8クチコミ12件星差+0.6';
    const rows = (): readonly string[] =>
      within(competitorsSection())
        .queryAllByRole('listitem')
        .map((row) => announcedText(row));

    // React は、兄弟の key の重複を console.error で警告する。描画の前から記録し、最後に 0 件であることを確かめる。
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await renderPage(withCompetitors(duplicated));
      expect(rows()).toEqual([FIRST, SECOND, THIRD]);

      typeQuery('テスト');
      expect(rows()).toEqual([FIRST, THIRD]);
      expect(countText()).toBe('競合3店のうち2店を表示');

      typeQuery('');
      expect(rows()).toEqual([FIRST, SECOND, THIRD]);
      expect(errors.mock.calls).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });

  it('開き直すと、空の検索語から始め、一覧をすべて描く（要件 4.11）', async () => {
    await renderPage(withCompetitors(FIVE_COMPETITORS));
    typeQuery('サンプル');
    expect(listedNames()).toEqual(['サンプル食堂']);

    cleanup();
    vi.unstubAllGlobals();
    await renderPage(withCompetitors(FIVE_COMPETITORS));

    expect(searchBox().value).toBe('');
    expect(listedNames()).toEqual(FIVE_NAMES);
    expect(countText()).toBe('競合5店のうち5店を表示');
  });
});

// --- 操作の無副作用（task 4.3） -------------------------------------------------------------

/** 帰属表示の文言（page.tsx の GOOGLE_ATTRIBUTION_TEXT。Flex の帰属表示と同じ文言）。 */
const ATTRIBUTION_TEXT = 'データ提供: Google Maps';

/**
 * 帰属表示の要素。完全一致の文言で、面の中にちょうど 1 箇所あることを確かめてから返す（要件 8.1）。
 * 文言を消しても、2 箇所に増やしても赤になる。
 */
function soleAttribution(step: string): HTMLElement {
  const found = screen.queryAllByText(ATTRIBUTION_TEXT);
  expect(found, `${step}: 帰属表示の数`).toHaveLength(1);
  expect(ownText(found[0]!), `${step}: 帰属表示の文言`).toBe(ATTRIBUTION_TEXT);
  return found[0]!;
}

/** 端末の保存領域の中身（キーと値の組を、キーの順に並べたもの）。 */
function storageEntries(storage: Storage): readonly (readonly [string, string | null])[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) {
      keys.push(key);
    }
  }
  return keys.sort().map((key) => [key, storage.getItem(key)] as const);
}

/** URL・閲覧履歴・クッキー・端末の保存領域の、その時点の状態。 */
interface DeviceState {
  readonly href: string;
  readonly historyLength: number;
  readonly cookie: string;
  readonly localStorage: readonly (readonly [string, string | null])[];
  readonly sessionStorage: readonly (readonly [string, string | null])[];
}

function deviceState(): DeviceState {
  return {
    href: window.location.href,
    historyLength: window.history.length,
    cookie: document.cookie,
    localStorage: storageEntries(window.localStorage),
    sessionStorage: storageEntries(window.sessionStorage),
  };
}

/** 付けた見張りを外す関数を、付けた順に積む。 */
type Restorers = (() => void)[];

/**
 * 見張りを付けたらすぐ、外す関数を積む。後の spyOn が投げても、それまでに付けた見張りは finally で外せる。
 */
function track<S extends { mockRestore(): void }>(restorers: Restorers, spy: S): S {
  restorers.push(() => spy.mockRestore());
  return spy;
}

/**
 * 端末の保存領域・クッキー・閲覧履歴を書き換える API の見張り。元の働きはそのまま通し、呼ばれた記録だけを取る。
 * jsdom はこれらを各 interface の prototype に定義している（localStorage と sessionStorage は同じ
 * Storage.prototype を共有する）ので、見張りも prototype に付ける。見張りが面のコードと同じ入口の呼び出しを
 * 実際に捉えることは、テストの末尾の対照で確かめる。
 */
function watchWrites(restorers: Restorers) {
  return {
    setItem: track(restorers, vi.spyOn(Storage.prototype, 'setItem')),
    removeItem: track(restorers, vi.spyOn(Storage.prototype, 'removeItem')),
    clear: track(restorers, vi.spyOn(Storage.prototype, 'clear')),
    cookie: track(restorers, vi.spyOn(Document.prototype, 'cookie', 'set')),
    pushState: track(restorers, vi.spyOn(History.prototype, 'pushState')),
    replaceState: track(restorers, vi.spyOn(History.prototype, 'replaceState')),
  };
}

/**
 * console.error の記録を、各呼び出しの最初の引数の 1 行目に直したもの。
 *
 * jsdom は、ハッシュだけの変更を除くページの遷移（location.href への代入・location.assign・location.replace）
 * を実装していない。遷移を求められても URL を変えずに捨て、「Not implemented: navigation (except hash
 * changes)」を持つ Error の stack を console.error へ出す。このため、遷移は URL の比較では捕まらず、この
 * 記録でだけ捕まる。window.open など、jsdom が実装していないほかの副作用も同じ形で記録に出る。
 */
function consoleErrorLines(spy: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }): readonly string[] {
  return spy.mock.calls.map(([first]) => String(first).split('\n')[0] ?? '');
}

/** jsdom が遷移を捨てたときに console.error へ出す行（not-implemented の Error の stack の 1 行目）。 */
const JSDOM_NAVIGATION_DROPPED = 'Error: Not implemented: navigation (except hash changes)';

/** 見張りごとの、呼ばれた回数。 */
function callCounts(watch: ReturnType<typeof watchWrites>): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.entries(watch).map(([name, spy]) => [name, spy.mock.calls.length]));
}

describe('操作の無副作用（store-detail-trend-dashboard task 4.3・Issue #265）', () => {
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

  it('期間・指標・検索を操作しても、取得は GET の 1 回のまま、端末の保存領域・クッキー・閲覧履歴・URL を変えず、帰属表示を 1 箇所に描き続ける（要件 7.3・8.1・8.6）', async () => {
    // 競合 5 店の応答にして、検索欄も出す（期間・指標・検索の 3 つの操作をすべて行うため）。
    const fetchMock = await renderPage(withCompetitors(FIVE_COMPETITORS));
    const attribution = soleAttribution('描画の直後');
    // 操作の前の状態を控える。描画時の取得（1 回）は、この時点で済んでいる。
    const before = deviceState();

    // 見張りは try の中で付ける。付ける途中で投げても、付けた分は finally で外れる。
    const restorers: Restorers = [];
    try {
      const writes = watchWrites(restorers);
      // ページの遷移を捕まえるための記録（consoleErrorLines の説明を参照）。元の働きは通すので、想定外の出力も
      // そのまま表に出る。
      const consoleError = track(restorers, vi.spyOn(console, 'error'));

      // 各段で操作し、操作が効いたこと（対照）と、帰属表示が同じ 1 箇所に残っていることを確かめる。
      // 操作が効かないまま無副作用を確かめると、空振りで緑になるためである。
      const steps: readonly {
        readonly name: string;
        readonly run: () => void | Promise<void>;
        readonly check: () => void;
      }[] = [
        {
          name: '期間「7日」を押す',
          run: () => choose('7日'),
          check: () => {
            expectSelected('7日', '順位');
            expect(announcedText(trendHeading())).toBe('直近7日の推移');
          },
        },
        { name: '指標「評価」を押す', run: () => choose('評価'), check: () => expectSelected('7日', '評価') },
        { name: '指標「クチコミ数」を押す', run: () => choose('クチコミ数'), check: () => expectSelected('7日', 'クチコミ数') },
        {
          name: '期間の群で矢印キーを押す',
          run: async () => {
            const seven = within(screen.getByRole('radiogroup', { name: '期間' })).getByRole('radio', { name: '7日' });
            // jsdom では札を押しても焦点が移らないので、群が矢印キーの起点にする札（Base UI の highlightedIndex）は、
            // 描画時に選ばれていた「30日」のまま残っている。焦点を当てて起点を「7日」へ移す更新を、act の中で描画まで
            // 流し切ってから矢印キーを押す（流さないと、古い起点から数えて「7日」へ戻り、選択が変わらない）。
            await act(async () => {
              seven.focus();
            });
            expect(document.activeElement).toBe(seven);
            // Base UI は、矢印キーで次の札へ焦点を移す処理を queueMicrotask で後に回す。act の中で流し切る。
            await act(async () => {
              fireEvent.keyDown(seven, { key: 'ArrowRight' });
            });
          },
          check: () => {
            expectSelected('30日', 'クチコミ数');
            expect(announcedText(trendHeading())).toBe('直近30日の推移');
          },
        },
        { name: '検索語「店」を入れる', run: () => typeQuery('店'), check: () => expect(countText()).toBe('競合5店のうち2店を表示') },
        {
          name: '0 件になる検索語を入れる',
          run: () => typeQuery(NO_MATCH_QUERY),
          check: () => expect(countText()).toBe(zeroCount(5)),
        },
        { name: '検索欄を空にする', run: () => typeQuery(''), check: () => expect(countText()).toBe('競合5店のうち5店を表示') },
        { name: '指標「順位」を押す', run: () => choose('順位'), check: () => expectSelected('30日', '順位') },
      ];

      let visited = 0;
      for (const step of steps) {
        await step.run();
        step.check();
        expect(soleAttribution(step.name), `${step.name}: 帰属表示が同じ要素のまま残る`).toBe(attribution);
        visited += 1;
      }
      expect(visited).toBe(steps.length);

      // 取得は、描画時の 1 回のまま。その 1 回は /api/detail への GET で、本文を持たない（要件 7.3・7.6）。
      // 入力した検索語は、要求の URL にも本文にも載らず、下の検査のとおり端末にも残らない（要件 8.6）。
      expect(fetchMock.mock.calls).toHaveLength(1);
      const call = fetchMock.mock.calls[0] ?? [];
      const init = call[1] as RequestInit | undefined;
      expect(call[0]).toBe('/api/detail');
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();

      // 端末の保存領域・クッキー・閲覧履歴を書き換える API は、1 度も呼ばれない（要件 7.3）。
      expect(callCounts(writes)).toEqual({
        setItem: 0,
        removeItem: 0,
        clear: 0,
        cookie: 0,
        pushState: 0,
        replaceState: 0,
      });
      // 状態そのものも変わらない。見張りを通らない経路のうち、localStorage へのプロパティの代入と、ハッシュだけの
      // 変更（location.hash への代入）は、ここで捕まる。ハッシュ以外への遷移（location.href への代入・
      // location.assign・location.replace）は、jsdom が実行せずに URL をそのまま残すので、この比較では捕まらない。
      expect(deviceState()).toEqual(before);
      // ページの遷移を求めていない。jsdom が捨てた遷移は console.error の記録にだけ残るので、記録が 0 件である
      // ことで確かめる。jsdom が実装していないほかの副作用（window.open など）も、同じ記録に出る。
      expect(consoleErrorLines(consoleError), 'console.error の記録').toEqual([]);

      // 対照: 見張りは、面のコードが通るのと同じ入口（window の localStorage と sessionStorage、document.cookie、
      // window.history）の呼び出しを実際に捉える。何も捉えない見張りでは、上の 0 回が空振りでも緑になる。
      // 対照の呼び出しは元の働きへ通さないので、端末の状態は変わらない。
      for (const spy of Object.values(writes)) {
        spy.mockImplementation(() => {});
      }
      window.localStorage.setItem('probe', '1');
      window.sessionStorage.setItem('probe', '1');
      window.localStorage.removeItem('probe');
      window.sessionStorage.clear();
      document.cookie = 'probe=1';
      window.history.pushState(null, '', '/probe');
      window.history.replaceState(null, '', '/probe');
      expect(callCounts(writes)).toEqual({
        setItem: 2,
        removeItem: 1,
        clear: 1,
        cookie: 1,
        pushState: 1,
        replaceState: 1,
      });
      expect(writes.setItem.mock.contexts[0]).toBe(window.localStorage);
      expect(writes.setItem.mock.contexts[1]).toBe(window.sessionStorage);

      // 対照: console.error の記録は、ページの遷移を実際に捉える。一方、jsdom は遷移を捨てるので URL は変わらず、
      // 状態の比較だけでは遷移を見られない。遷移を捕まえるのがこの記録だけであることを、ここで確かめる。
      consoleError.mockImplementation(() => {});
      window.location.assign('/probe');
      expect(consoleErrorLines(consoleError), '遷移を求めたときの console.error の記録').toEqual([
        JSDOM_NAVIGATION_DROPPED,
      ]);
      expect(window.location.href, '遷移を求めても URL は変わらない').toBe(before.href);
      expect(deviceState()).toEqual(before);
    } finally {
      // 付けた順の逆に外す。
      for (const restore of [...restorers].reverse()) {
        restore();
      }
    }
  });
});

// --- 表示の一貫性（task 4.3） ---------------------------------------------------------------

/**
 * 一貫性の検査に使う推移（9/6〜9/13 の 8 日）。「7日」を選ぶと、窓は終点の 9/13 を含めて遡った暦日の 7 日、
 * つまり 9/7〜9/13 になる。
 * - 窓の外の点は、9/6 の 1 点だけである。その値は、どの指標でも窓の最初の点（9/7）の値と異なる。表示のどれかを
 *   窓ではなく推移の全体から作ると、始点の値がずれて見分けられる。
 * - 選択中の指標（既定の順位）は、末尾の点（9/13）で null である。評価も同じ日に null にした（自店の評価が
 *   無い日は順位も持たない・Issue #255）。クチコミ数は末尾の点にも値がある。このため、窓の終点（9/13）と、
 *   順位の値のある最後の日（9/12）が食い違う。現在値を窓の終点から作ると見分けられる（2 つの出どころが
 *   食い違う fixture を置く規律）。
 * - 順位は、値のある最初の日と次の日（6 位と 5 位）、値のある最後の日と前の日（3 位と 2 位）で値を変えた。
 *   1 日ずれた点を読む誤りが、同じ値に隠れないためである。
 */
const CONSISTENCY_TREND: StoreDetailResponse['trend'] = [
  { capturedOn: '2026-09-06', rank: 8, rating: '3.7', reviewCount: 60 },
  { capturedOn: '2026-09-07', rank: 6, rating: '3.9', reviewCount: 64 },
  { capturedOn: '2026-09-08', rank: 5, rating: '4.0', reviewCount: 66 },
  { capturedOn: '2026-09-09', rank: 5, rating: '4.0', reviewCount: 69 },
  { capturedOn: '2026-09-10', rank: 4, rating: '4.1', reviewCount: 71 },
  { capturedOn: '2026-09-11', rank: 3, rating: '4.1', reviewCount: 74 },
  { capturedOn: '2026-09-12', rank: 2, rating: '4.2', reviewCount: 76 },
  { capturedOn: '2026-09-13', rank: null, rating: null, reviewCount: 79 },
];

/** 窓の外の点の日付。 */
const OUTSIDE_DATE = '2026-09-06';

/** 「7日」の窓の日付（リテラル）。公称の始点は先頭、終点は末尾である。 */
const WINDOW_DATES: readonly string[] = [
  '2026-09-07',
  '2026-09-08',
  '2026-09-09',
  '2026-09-10',
  '2026-09-11',
  '2026-09-12',
  '2026-09-13',
];

/** 「7日」の窓の公称の始点と終点を、グラフの説明文の書式（読み上げ用）と figcaption の書式で書いたもの。 */
const NOMINAL_SPOKEN = { start: '9月7日', end: '9月13日' } as const;
const NOMINAL_SHORT = '9/7〜9/13';

/**
 * 一貫性の検査の応答。当日サマリーは無しにする（推移の日付と食い違う当日サマリーを置かないため。グラフの順位の
 * 軸の下端は、期間内の最大順位で決まる）。
 */
const CONSISTENCY_RESPONSE: StoreDetailResponse = { ...RESPONSE, summary: null, trend: CONSISTENCY_TREND };

/** 推移の表の列の位置（日付の列が 0）。列見出しの並び（日付・順位・評価・クチコミ数）と同じである。 */
const COLUMN = { date: 0, rank: 1, rating: 2, reviewCount: 3 } as const;

/** 値の無いセルの記号（page.tsx の推移の表）。 */
const NO_VALUE = '—';

interface ValuedRow {
  readonly date: string;
  readonly value: string;
}

/**
 * 推移の表の行のうち、列に値のある（「—」でない）最初の行と最後の行の、日付とセルの値。値のある行が 1 つも
 * 無ければ赤にする（照合が空振りしないため）。
 */
function valuedEnds(
  rows: readonly (readonly string[])[],
  column: number,
  label: string,
): { readonly first: ValuedRow; readonly last: ValuedRow } {
  const valued = rows.flatMap((row) => {
    const date = row[COLUMN.date];
    const value = row[column];
    return date === undefined || value === undefined || value === NO_VALUE ? [] : [{ date, value }];
  });
  expect(valued.length, `${label}の列に値のある行`).toBeGreaterThan(0);
  return { first: valued[0]!, last: valued.at(-1)! };
}

/** 'YYYY-MM-DD' を、月と日の数に分ける。形式が違えば赤にする。 */
function monthDayOf(date: string): { readonly month: number; readonly day: number } {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  expect(match, `日付の形式: ${date}`).not.toBeNull();
  return { month: Number(match![1]), day: Number(match![2]) };
}

/** figcaption の日付の書式（'9/12'）。 */
function shortDateOf(date: string): string {
  const { month, day } = monthDayOf(date);
  return `${month}/${day}`;
}

/** グラフの説明文の日付の書式（'9月12日'）。figcaption とは書式が違うので、別に作る。 */
function spokenDateOf(date: string): string {
  const { month, day } = monthDayOf(date);
  return `${month}月${day}日`;
}

/**
 * 順位のグラフの説明文（describeMetric の文）を、期間の始点と終点・最初と最後の記録・最新の値と日付に分ける。
 * 文の全体を前後の端まで照合するので、文の形が変わると（分けられないと）赤になる。
 */
function parseRankDescription(name: string | null): {
  readonly start: string;
  readonly end: string;
  readonly first: string;
  readonly last: string;
  readonly latestValue: string;
  readonly latestDate: string;
} {
  const match =
    /^順位の推移、(.+?)から(.+?)まで。最初の記録は(.+?)、最後の記録は(.+?)。最高は.+?、最低は.+?。最新は(.+?)（(.+?)）。$/.exec(
      name ?? '',
    );
  expect(match, `グラフの説明文の形: ${name}`).not.toBeNull();
  const [, start = '', end = '', first = '', last = '', latestValue = '', latestDate = ''] = match!;
  return { start, end, first, last, latestValue, latestDate };
}

/**
 * figcaption の行から、期間の行（「9/7〜9/13」）と現在値の行（「最新 2位（9/12）」）を取り出す。どちらも
 * ちょうど 1 行であることを確かめる。
 */
function parseCaption(lines: readonly string[]): {
  readonly period: string;
  readonly currentValue: string;
  readonly currentDate: string;
} {
  const periods = lines.filter((line) => /^\d+\/\d+〜\d+\/\d+$/.test(line));
  expect(periods, `figcaption の期間の行: ${lines.join(' / ')}`).toHaveLength(1);
  const currents = lines.flatMap((line) => {
    const match = /^最新 (.+)（(.+)）$/.exec(line);
    return match === null ? [] : [{ currentValue: match[1] ?? '', currentDate: match[2] ?? '' }];
  });
  expect(currents, `figcaption の現在値の行: ${lines.join(' / ')}`).toHaveLength(1);
  return { period: periods[0]!, ...currents[0]! };
}

/**
 * 一貫性の応答で面を開き、「7日」を選んでから、推移の節の表示を読み取る。
 * 選択が効いたことと、応答の形（末尾の点で順位が null）が表まで届いていることを先に確かめる。
 */
async function readSevenDayConsistencyView(): Promise<TrendView> {
  await renderPage(CONSISTENCY_RESPONSE);
  choose('7日');
  // 対照: 切替が効いている（既定の 30 日のまま読むと、照合が意図しない窓を相手にする）。
  expectSelected('7日', '順位');
  const view = readTrendView();
  expect(view.heading).toBe('直近7日の推移');
  // 応答の形が表まで届いている: 末尾の行は窓の終点で、その順位のセルは値が無い。
  expect(view.rows.at(-1)?.[COLUMN.date]).toBe(WINDOW_DATES.at(-1));
  expect(view.rows.at(-1)?.[COLUMN.rank]).toBe(NO_VALUE);
  return view;
}

describe('表示の一貫性（store-detail-trend-dashboard task 4.3・Issue #265）', () => {
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

  it('一貫性の検査の応答と読み取りの補助が、照合の前提を満たす（応答と補助の自己検証）', () => {
    const dates = CONSISTENCY_TREND.map((point) => point.capturedOn);
    // 推移は 8 日以上で、窓の外の点はちょうど 1 つ（9/6）。窓の日付は、推移のうち窓の外の点を除いた日付と一致する。
    expect(dates.length).toBeGreaterThanOrEqual(8);
    expect(dates.filter((date) => date < WINDOW_DATES[0]!)).toEqual([OUTSIDE_DATE]);
    expect(dates.filter((date) => date >= WINDOW_DATES[0]!)).toEqual(WINDOW_DATES);
    // 窓は、終点を含めて遡った暦日の 7 日である（リテラルどうしの照合）。
    expect(WINDOW_DATES).toHaveLength(7);
    expect([spokenDateOf(WINDOW_DATES[0]!), spokenDateOf(WINDOW_DATES.at(-1)!)]).toEqual([
      NOMINAL_SPOKEN.start,
      NOMINAL_SPOKEN.end,
    ]);
    expect(`${shortDateOf(WINDOW_DATES[0]!)}〜${shortDateOf(WINDOW_DATES.at(-1)!)}`).toBe(NOMINAL_SHORT);

    // 選択中の指標（順位）は、末尾の点で null。
    expect(CONSISTENCY_TREND.at(-1)?.rank).toBeNull();
    // 窓の最初の点の値は、どの指標でも窓の外の点の値と異なる。
    const outside = CONSISTENCY_TREND.find((point) => point.capturedOn === OUTSIDE_DATE);
    const first = CONSISTENCY_TREND.find((point) => point.capturedOn === WINDOW_DATES[0]);
    expect(outside).toBeDefined();
    expect(first).toBeDefined();
    expect(first!.rank).not.toBe(outside!.rank);
    expect(first!.rating).not.toBe(outside!.rating);
    expect(first!.reviewCount).not.toBe(outside!.reviewCount);

    // 読み取りの補助の自己検証（既知の表示から、既知の部分を取り出せる）。
    expect(parseRankDescription(VIEW_7_DAYS_RANK.chartName)).toEqual({
      start: '8月25日',
      end: '8月31日',
      first: '4位',
      last: '2位',
      latestValue: '2位',
      latestDate: '8月31日',
    });
    expect(parseCaption(VIEW_7_DAYS_RANK.caption)).toEqual({
      period: '8/25〜8/31',
      currentValue: '2位',
      currentDate: '8/31',
    });
    // 値のある行の最後は、「—」の行を飛ばした行になる。
    expect(
      valuedEnds(
        [
          ['2026-09-11', '3', '4.1', '74'],
          ['2026-09-12', '2', '4.2', '76'],
          ['2026-09-13', NO_VALUE, NO_VALUE, '79'],
        ],
        COLUMN.rank,
        '順位',
      ),
    ).toEqual({ first: { date: '2026-09-11', value: '3' }, last: { date: '2026-09-12', value: '2' } });
    expect(shortDateOf('2026-09-07')).toBe('9/7');
    expect(spokenDateOf('2026-09-07')).toBe('9月7日');
  });

  it('照合 1（表）: 表の行の日付の集合が、窓の日付の集合と一致する（要件 3.1・3.2）', async () => {
    const view = await readSevenDayConsistencyView();

    const dates = view.rows.map((row) => row[COLUMN.date]);
    expect(dates, '表の行の数').toHaveLength(WINDOW_DATES.length);
    expect(new Set(dates), '表の行の日付の集合').toEqual(new Set(WINDOW_DATES));
  });

  it('照合 2（要約）: 要約の始点と終点が表の値のある最初と最後の行と一致し、公称の期間と食い違う組にだけ期間が添う（要件 3.1・3.4）', async () => {
    const view = await readSevenDayConsistencyView();

    const rank = valuedEnds(view.rows, COLUMN.rank, '順位');
    const rating = valuedEnds(view.rows, COLUMN.rating, '評価');
    const reviewCount = valuedEnds(view.rows, COLUMN.reviewCount, 'クチコミ数');
    // 順位と評価は、末尾の行（値なし）を飛ばした行が終点になる。クチコミ数は末尾の行が終点になる。
    expect([rank.last.date, rating.last.date, reviewCount.last.date]).toEqual([
      '2026-09-12',
      '2026-09-12',
      '2026-09-13',
    ]);
    // クチコミ数だけが公称の窓（WINDOW_DATES の両端）と一致する。これが「添えない」側の前提であり、
    // ここが崩れたまま下の期待値が緑になることを防ぐ。
    expect([reviewCount.first.date, reviewCount.last.date], 'クチコミ数は公称の窓と一致する').toEqual([
      WINDOW_DATES[0],
      WINDOW_DATES.at(-1),
    ]);
    // 添える期間も、実装からではなく表の行から導く。
    const note = (ends: {
      readonly first: { readonly date: string };
      readonly last: { readonly date: string };
    }): string => ` 記録 ${shortDateOf(ends.first.date)}〜${shortDateOf(ends.last.date)}`;
    const reviewCountDiff = Number(reviewCount.last.value) - Number(reviewCount.first.value);
    expect(view.summary, '要約の 3 組').toEqual([
      ['順位', `${rank.first.value}位 → ${rank.last.value}位${note(rank)}`],
      ['評価', `${rating.first.value} → ${rating.last.value}${note(rating)}`],
      // 公称の窓と一致するので、この組にだけ期間が付かない。1 つの画面の中で組ごとに判定が分かれることの、
      // 直接の対照である。
      ['クチコミ数の増減', `${reviewCountDiff > 0 ? '+' : ''}${reviewCountDiff}件`],
    ]);
  });

  it('照合 3（グラフ）: 説明文と figcaption の期間が公称の始点〜終点と一致し、説明文の始点と終点の値が表の値のある最初と最後の行と一致する（要件 3.1・3.7・5.1）', async () => {
    const view = await readSevenDayConsistencyView();

    const rank = valuedEnds(view.rows, COLUMN.rank, '順位');
    const description = parseRankDescription(view.chartName);
    expect(description.start, '説明文の期間の始点').toBe(NOMINAL_SPOKEN.start);
    expect(description.end, '説明文の期間の終点').toBe(NOMINAL_SPOKEN.end);
    expect(parseCaption(view.caption).period, 'figcaption の期間').toBe(NOMINAL_SHORT);
    expect(description.first, '説明文の最初の記録').toBe(`${rank.first.value}位`);
    expect(description.last, '説明文の最後の記録').toBe(`${rank.last.value}位`);
  });

  it('照合 4（現在値）: 現在値が、表の値のある最後の行の値と日付に一致する（要件 3.1・3.6）', async () => {
    const view = await readSevenDayConsistencyView();

    const rank = valuedEnds(view.rows, COLUMN.rank, '順位');
    const caption = parseCaption(view.caption);
    expect(caption.currentValue, '現在値').toBe(`${rank.last.value}位`);
    expect(caption.currentDate, '現在値の日付').toBe(shortDateOf(rank.last.date));
    // グラフの説明文が読み上げる現在値も、同じ行を指す。
    const description = parseRankDescription(view.chartName);
    expect(description.latestValue, '説明文の現在値').toBe(`${rank.last.value}位`);
    expect(description.latestDate, '説明文の現在値の日付').toBe(spokenDateOf(rank.last.date));
  });
});
