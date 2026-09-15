// @vitest-environment jsdom
// store-detail-trend-dashboard task 4.1（Issue #265）: 推移の節（app/store/page.tsx の TrendSection）を、
// ページ全体で検証する。
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
// 部品単体の検査は、部品ごとのテストファイル（trend-chart / trend-controls）が持つ。既定の状態の DOM が現行と
// 同じであること（要件 8.3）と、構造契約の件数は、store-page.test.tsx が持つ。
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
import { announcedText } from './live-region';
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
