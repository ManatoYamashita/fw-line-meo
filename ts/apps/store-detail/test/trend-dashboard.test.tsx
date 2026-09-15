// @vitest-environment jsdom
// store-detail-trend-dashboard（Issue #265）: 推移の節（task 4.1）と競合の節の検索（task 4.2）を、ページ全体で
// 検証する（app/store/page.tsx の TrendSection と CompetitorsSection）。
//
// 推移の節は、期間と指標の状態を節の中だけに持つ。期間の要約・グラフ・現在値・推移の表の 4 つと、節の見出し・
// 表の名前は、1 回だけ切り出した期間の窓から導く（同 spec の research.md の決定 D1・D8、
// docs/design/design-language.md §7.18）。
// - 期間を切り替えると窓が変わり、見出し・表の名前・行・要約・グラフ・現在値がそろって追随する（要件 3.2）。
// - 指標を切り替えると、グラフと現在値だけが変わり、要約と表は変わらない（要件 3.3）。
// - どちらの切替も、ほかの節の表示を変えない（要件 3.8）。取得済みのデータから描き直し、取得をやり直さない（要件 2.5）。
// - 状態は URL にも端末にも残さないので、開き直すと既定（30 日・順位）に戻る（要件 2.3・2.9）。
// - 窓が作れないとき（推移が 0 件、または日付を解釈できる点が 0 件）は、選択肢を出さずに既存の案内を出す（要件 2.8）。
//
// 競合の節は、検索語の状態を節の中だけに持つ（同 spec の research.md の決定 D8）。
// - 検索欄は、当日の競合が 2 店以上のときだけ、一覧の Card の外に出す（要件 4.1・4.2、§7.18）。
// - 一覧は、店名に検索語を含む競合だけを元の順で描く。0 件なら、導線の無い空状態に置き換える（要件 4.3・4.9）。
// - 評価の無い店の注記は、絞り込みの結果ではなく全件から判定する。
// - 検索は、近隣順位とその母数・グラフ・推移の表・期間の要約を変えない（要件 4.10）。
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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

/** 既定（30 日・順位）。 */
const VIEW_30_DAYS_RANK: TrendView = {
  heading: '直近30日の推移',
  tableName: '直近30日の推移',
  rows: ROWS_30_DAYS,
  summary: [
    ['順位', '6位 → 2位'],
    ['評価', '3.9 → 4.4'],
    ['クチコミ増減', '+30件'],
  ],
  chartName: '順位の推移、8月2日から8月31日まで。最初の記録は6位、最後の記録は2位。最高は2位、最低は6位。最新は2位（8月31日）。',
  caption: ['順位の推移（上ほど上位）', '8/2〜8/31', '最新 2位（8/31）'],
};

/** 「7日」を選んだあと（7 日・順位）。 */
const VIEW_7_DAYS_RANK: TrendView = {
  heading: '直近7日の推移',
  tableName: '直近7日の推移',
  rows: ROWS_7_DAYS,
  summary: [
    ['順位', '4位 → 2位'],
    ['評価', '4.1 → 4.4'],
    ['クチコミ増減', '+18件'],
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
  const metricGroup = screen.getByRole('radiogroup', { name: 'グラフの指標' });
  expect(within(periodGroup).getByRole('radio', { checked: true }), '期間').toBe(
    within(periodGroup).getByRole('radio', { name: period }),
  );
  expect(within(metricGroup).getByRole('radio', { checked: true }), 'グラフの指標').toBe(
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
    expect(within(card).getByText('この期間は順位の記録がありません')).toBeDefined();
    expect(definitionPairs(card.querySelector('dl')!)).toEqual([
      ['順位', '—'],
      ['評価', '—'],
      ['クチコミ増減', '+18件'],
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

  it('選択肢を要約のカードの外に置き、グラフを要約の 3 組の下に、表をカードの下に置く（§7.18）', async () => {
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
    // グラフは要約のカードの中で、3 組（dl）の下に置く。
    const figure = within(card).getByRole('figure');
    expect(following(card.querySelector('dl')!, figure)).toBe(true);
    // 表は要約のカードの外、その下に置く。
    const table = within(section).getByRole('table');
    expect(card.contains(table)).toBe(false);
    expect(following(card, table)).toBe(true);
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
const NO_MATCH_TEXT = '該当する競合がいません。店名の一部で探し直すか、検索欄を空にすると一覧に戻ります。';

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
      expect(screen.queryAllByRole('status'), item.name).toHaveLength(0);
      expect(section.textContent ?? '', item.name).not.toMatch(/店のうち\d+店を表示/);
      expect(listedNames(), item.name).toEqual(item.names);
      visited += 1;
      cleanup();
      vi.unstubAllGlobals();
    }
    expect(visited).toBe(cases.length);
  });

  it('当日の競合が 2 店以上なら、一覧の Card の外に、見えるラベル付きの検索欄と件数の文言を出す（要件 4.1・4.7・5.7、§7.18）', async () => {
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
      // 読み上げ領域は、件数の文言の 1 つだけである。
      expect(screen.getAllByRole('status'), item.name).toEqual([status]);

      // 並び: 見出し → 検索欄 → 件数の文言 → 一覧の Card。検索欄と件数の文言は Card の中に入れない（§7.18）。
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
    expect(countText()).toBe('競合5店のうち0店を表示');
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
    // 空状態は通知にしない（件数の文言と二重に読み上げられるのを防ぐ）。読み上げ領域は件数の文言の 1 つだけである。
    expect(state.hasAttribute('role')).toBe(false);
    const status = within(section).getByRole('status');
    expect(screen.getAllByRole('status')).toEqual([status]);
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
      // 注記は、一覧（または空状態）の後の、節の末尾に置いたままである。
      expect(competitorsSection().lastElementChild, query).toBe(notes[0]);
    }

    // 既定の側: 評価の無い店がいない一覧では、どの検索語でも注記を出さない。
    cleanup();
    vi.unstubAllGlobals();
    await renderPage(withCompetitors(FIVE_COMPETITORS.filter((competitor) => competitor.rating !== null)));
    const steps = [
      { query: '店', count: '競合4店のうち2店を表示' },
      { query: NO_MATCH_QUERY, count: '競合4店のうち0店を表示' },
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
      { query: NO_MATCH_QUERY, count: '競合5店のうち0店を表示' },
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
