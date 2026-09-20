// 直近の推移レポートの試験（design.md「Report builders（表示）」の TrendBuilder・
// Requirements 6.1–6.8, 8.3, 8.4, 8.5）。
// - 最新の対象日までの 7 暦日を、日付の昇順に「比較可能・比較不能・取得失敗・行なし」に分けること。
//   終点は渡された最新の行の日付で、今日ではないこと。日付の列挙が実行環境の TZ に依存しないこと
// - 見出しに店舗名と対象期間、footer に詳細画面への導線と帰属表示が入ること
// - 表は日付順の 7 行で、比較不能の日は順位を「—」にし、行なし・取得失敗の日は値を補間しないこと
// - 要約 1 行は取得できた日（比較可能・比較不能の日）の最初と最後を端にし、評価と口コミ総数の変化を出すこと。
//   順位の変化は両端が比較可能なときだけ母数つきで出すこと。取得できた日が 2 日未満なら要約の代わりに不足の注記、
//   最新が取得失敗なら注記を出すこと
// - 詳細画面への導線は LIFF URL に storeId を付けたもので、https の絶対 URL でなければ導線を置かないこと
// - 30KB の検証とスナップショット
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DailySummaryCompetitor, DailySummaryReadRow } from '@fwlm/db';
import { lineColors, lineLayout } from '@fwlm/design-tokens';
import type { LineMessage } from '../../src/line/client.js';
import type {
  FlexBoxComponent,
  FlexBoxContent,
  FlexBubbleContents,
  FlexButtonComponent,
  FlexTextComponent,
} from '../../src/line/flex-types.js';
import {
  TREND_DAYS,
  buildTrendReport,
  classifyTrendDays,
  storeDetailUrlFor,
  type TrendDay,
} from '../../src/report/builders/trend.js';
import {
  ATTRIBUTION_TEXT,
  FLEX_BUBBLE_MAX_BYTES,
  FlexBubbleTooLargeError,
  buildAttributionText,
  fitsFlexBubbleLimit,
  flexBubbleByteLength,
  normalizeReadRow,
  type NormalizedReadRow,
  type ReportContext,
} from '../../src/report/format.js';

const STORE: ReportContext = { storeName: '試験食堂 駅前店' };

// 架空の LIFF URL と店舗 ID。
const LIFF_URL = 'https://liff.line.me/1234567890-AbCdEfGh';
const STORE_ID = 'store-0001';
const DETAIL_URL = `${LIFF_URL}?storeId=${STORE_ID}`;

const TABLE_HEADINGS = ['日付', '順位', '評価', 'クチコミ数'];
const MISSING_LABEL = 'データなし';
const FAILED_LABEL = '取得失敗';
const DETAIL_LINK_LABEL = '30日の推移を詳細画面で見る';
const INSUFFICIENT_NOTE = '取得できた日が2日分に満たないため、推移を判断するにはデータが不足しています。';
const NOT_COMPARABLE_NOTE = '順位が「—」の日は、競合店と比較できないため順位がありません。';

function latestFailedNote(monthDay: string): string {
  return `最新のデータ（${monthDay}分）を取得できませんでした。次のデータの更新の後に、もう一度ご確認ください。`;
}

// --- 行の組立 -----------------------------------------------------------------------
//
// 店名は試験用の架空のもので、実在の店舗を指さない。

function competitor(name: string, rating: number | null, reviewCount: number, starDiff: number | null): DailySummaryCompetitor {
  return { name, rating, reviewCount, starDiff };
}

const RATED_COMPETITORS: readonly DailySummaryCompetitor[] = [
  competitor('試験競合A', 4.5, 300, -0.3),
  competitor('試験競合B', 4.3, 90, -0.1),
  competitor('試験競合C', 4.0, 80, 0.2),
  competitor('試験競合D', 3.8, 40, 0.4),
];

// 新 Go が書く形の、競合比較可能な行（自店 ★4.2・評価を持つ競合 4 店・母数は自店を含めて 5）。
function rawRow(date: string, overrides: Partial<DailySummaryReadRow> = {}): DailySummaryReadRow {
  return {
    summary_date: date,
    status: 'ready',
    rank: 2,
    rank_total: 5,
    rank_prev: 2,
    rating: '4.2',
    review_count: 120,
    rating_prev: '4.2',
    review_count_prev: 119,
    new_review_count: 1,
    new_reviews: [],
    competitors: RATED_COMPETITORS,
    google_maps_reviews_uri: null,
    ...overrides,
  };
}

function row(date: string, overrides: Partial<DailySummaryReadRow> = {}): NormalizedReadRow {
  return normalizeReadRow(rawRow(date, overrides));
}

function comparableRow(date: string, rank: number, rating: string, reviewCount: number): NormalizedReadRow {
  return row(date, { rank, rank_total: 5, rating, review_count: reviewCount });
}

// 自店のデータ取得に失敗した日（Go は値を書かない）。
function failedRow(date: string): NormalizedReadRow {
  return row(date, {
    status: 'failed',
    rank: null,
    rank_total: null,
    rank_prev: null,
    rating: null,
    review_count: null,
    new_review_count: 0,
    competitors: [],
  });
}

// 競合が見つからない日（Go は 1 店中 1 位を書く）。
function noCompetitorsRow(date: string, rating: string, reviewCount: number): NormalizedReadRow {
  return row(date, { status: 'no_competitors', rank: 1, rank_total: 1, rating, review_count: reviewCount, competitors: [] });
}

// 評価を持つ競合がいない日（母数は自店だけの 1）。
function noRatedCompetitorsRow(date: string, rating: string, reviewCount: number): NormalizedReadRow {
  return row(date, {
    rank: 1,
    rank_total: 1,
    rating,
    review_count: reviewCount,
    competitors: [competitor('試験競合E', null, 0, null)],
  });
}

// 自店が未評価の日（新 Go は評価も順位も書かない）。
function selfUnratedRow(date: string, reviewCount: number): NormalizedReadRow {
  return row(date, { rating: null, rank: null, rank_total: null, rank_prev: null, rating_prev: null, review_count: reviewCount });
}

// 4 種類の日を含む 7 日（終点は 9 月 14 日）。9 日は行が無い。
const FOUR_KINDS_ROWS: readonly NormalizedReadRow[] = [
  comparableRow('2026-09-08', 3, '4.1', 118),
  failedRow('2026-09-10'),
  noCompetitorsRow('2026-09-11', '4.1', 119),
  comparableRow('2026-09-12', 3, '4.1', 120),
  noRatedCompetitorsRow('2026-09-13', '4.2', 121),
  comparableRow('2026-09-14', 2, '4.2', 123),
];

const FOUR_KINDS_DAYS: readonly TrendDay[] = [
  { date: '2026-09-08', kind: 'comparable', rank: 3, rankTotal: 5, rating: '4.1', reviewCount: 118 },
  { date: '2026-09-09', kind: 'missing' },
  { date: '2026-09-10', kind: 'failed' },
  { date: '2026-09-11', kind: 'not_comparable', rating: '4.1', reviewCount: 119 },
  { date: '2026-09-12', kind: 'comparable', rank: 3, rankTotal: 5, rating: '4.1', reviewCount: 120 },
  { date: '2026-09-13', kind: 'not_comparable', rating: '4.2', reviewCount: 121 },
  { date: '2026-09-14', kind: 'comparable', rank: 2, rankTotal: 5, rating: '4.2', reviewCount: 123 },
];

function days(endDate: string, rows: readonly NormalizedReadRow[]): TrendDay[] {
  return classifyTrendDays(endDate, rows, TREND_DAYS);
}

// --- Flex の読み取り ----------------------------------------------------------------

function flexOf(message: LineMessage): { readonly altText: string; readonly bubble: FlexBubbleContents } {
  if (message.type !== 'flex') {
    throw new Error(`flex を期待したが ${message.type} だった`);
  }
  return { altText: message.altText, bubble: message.contents as FlexBubbleContents };
}

function bubbleOf(message: LineMessage): FlexBubbleContents {
  return flexOf(message).bubble;
}

function report(trendDays: readonly TrendDay[], latestFailed = false, detailUrl = DETAIL_URL): FlexBubbleContents {
  return bubbleOf(buildTrendReport(STORE, trendDays, latestFailed, detailUrl));
}

// JSON の木を深さ優先でたどり、すべてのオブジェクトを訪ねる。
function walk(node: unknown, visit: (object: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node !== null && typeof node === 'object') {
    const object = node as Record<string, unknown>;
    visit(object);
    for (const value of Object.values(object)) walk(value, visit);
  }
}

function textComponents(node: unknown): FlexTextComponent[] {
  const found: FlexTextComponent[] = [];
  walk(node, (object) => {
    if (object['type'] === 'text' && typeof object['text'] === 'string') {
      found.push(object as unknown as FlexTextComponent);
    }
  });
  return found;
}

function texts(node: unknown): string[] {
  return textComponents(node).map((component) => component.text);
}

function buttons(node: unknown): FlexButtonComponent[] {
  const found: FlexButtonComponent[] = [];
  walk(node, (object) => {
    if (object['type'] === 'button') {
      found.push(object as unknown as FlexButtonComponent);
    }
  });
  return found;
}

function isBox(content: FlexBoxContent): content is FlexBoxComponent {
  return content.type === 'box';
}

// 本文の中の表（先頭の行が列の見出しである box）。
function tableOf(bubble: FlexBubbleContents): FlexBoxComponent {
  const table = bubble.body.contents.find((content): content is FlexBoxComponent => {
    if (!isBox(content)) return false;
    const [first] = content.contents;
    return first !== undefined && isBox(first) && JSON.stringify(texts(first)) === JSON.stringify(TABLE_HEADINGS);
  });
  if (table === undefined) {
    throw new Error('表が見つからなかった');
  }
  return table;
}

// 表の日ごとの行（見出しの行を除く）の text。
function tableRows(bubble: FlexBubbleContents): string[][] {
  return tableOf(bubble)
    .contents.slice(1)
    .map((line) => texts(line));
}

// 本文のうち、表の外に置いた text（要約と注記）。
function textsOutsideTable(bubble: FlexBubbleContents): string[] {
  const table = tableOf(bubble);
  return bubble.body.contents.filter((content) => content !== table).flatMap((content) => texts(content));
}

function summaryTexts(bubble: FlexBubbleContents): string[] {
  return textsOutsideTable(bubble).filter((text) => text.includes('→'));
}

// --- 日の分類 -----------------------------------------------------------------------

describe('classifyTrendDays: 最新の対象日までの 7 暦日を分ける（6.1・6.3・6.4・6.8）', () => {
  it('4 種類の日を、日付の昇順に 7 日ぶん返す', () => {
    expect(days('2026-09-14', FOUR_KINDS_ROWS)).toEqual(FOUR_KINDS_DAYS);
  });

  it('行の無い日は、前後の日の値を使わずに「行なし」とする（補間しない・6.4）', () => {
    const result = days('2026-09-14', [comparableRow('2026-09-08', 3, '4.1', 118), comparableRow('2026-09-10', 2, '4.2', 125)]);
    expect(result[1]).toEqual({ date: '2026-09-09', kind: 'missing' });
    expect(result.slice(3)).toEqual(
      ['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14'].map((date) => ({ date, kind: 'missing' })),
    );
  });

  it('取得失敗の日は値を持たない「取得失敗」とする', () => {
    expect(days('2026-09-14', [failedRow('2026-09-14')]).at(-1)).toEqual({ date: '2026-09-14', kind: 'failed' });
  });

  it.each<[string, NormalizedReadRow, TrendDay]>([
    ['競合なし', noCompetitorsRow('2026-09-14', '4.2', 120), { date: '2026-09-14', kind: 'not_comparable', rating: '4.2', reviewCount: 120 }],
    [
      '評価を持つ競合なし',
      noRatedCompetitorsRow('2026-09-14', '4.2', 120),
      { date: '2026-09-14', kind: 'not_comparable', rating: '4.2', reviewCount: 120 },
    ],
    ['自店が未評価', selfUnratedRow('2026-09-14', 0), { date: '2026-09-14', kind: 'not_comparable', rating: null, reviewCount: 0 }],
  ])('%s の日は、順位を持たない「比較不能」とする（6.8）', (_label, input, expected) => {
    expect(days('2026-09-14', [input]).at(-1)).toEqual(expected);
  });

  it('既存データの評価 0 の自店は、正規化を通して評価も順位も持たない比較不能の日になる（8.5）', () => {
    const legacy = row('2026-09-14', { rating: '0.0', rank: 5, rank_total: 5, review_count: 0 });
    expect(days('2026-09-14', [legacy]).at(-1)).toEqual({
      date: '2026-09-14',
      kind: 'not_comparable',
      rating: null,
      reviewCount: 0,
    });
  });

  it('既存データの評価 0 の競合は母数に数えない（母数が 1 になる日は比較不能・8.5）', () => {
    const legacy = row('2026-09-14', { rank: 1, rank_total: 2, competitors: [competitor('試験競合F', 0, 0, 4.2)] });
    expect(days('2026-09-14', [legacy]).at(-1)).toEqual({
      date: '2026-09-14',
      kind: 'not_comparable',
      rating: '4.2',
      reviewCount: 120,
    });
  });

  it('入力の行の順によらず、日付の昇順に並べる', () => {
    expect(days('2026-09-14', [...FOUR_KINDS_ROWS].reverse())).toEqual(FOUR_KINDS_DAYS);
  });

  it('範囲の外の行は使わない', () => {
    const result = days('2026-09-14', [
      comparableRow('2026-09-07', 1, '4.9', 999),
      comparableRow('2026-09-15', 1, '4.9', 999),
      comparableRow('2026-09-14', 2, '4.2', 123),
    ]);
    expect(result.map((day) => day.date)).toEqual([
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
      '2026-09-14',
    ]);
    expect(result.filter((day) => day.kind !== 'missing')).toEqual([
      { date: '2026-09-14', kind: 'comparable', rank: 2, rankTotal: 5, rating: '4.2', reviewCount: 123 },
    ]);
  });

  it.each<[string, string, readonly string[]]>([
    ['月をまたぐ（平年の 2 月）', '2026-03-03', ['2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03']],
    ['閏年の 2 月 29 日を含む', '2028-03-02', ['2028-02-25', '2028-02-26', '2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02']],
    ['年をまたぐ', '2027-01-03', ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']],
  ])('%s', (_label, endDate, expected) => {
    expect(days(endDate, []).map((day) => day.date)).toEqual(expected);
  });

  it('日数は引数で決まる（1 日なら終点だけ）', () => {
    expect(classifyTrendDays('2026-09-14', [], 1)).toEqual([{ date: '2026-09-14', kind: 'missing' }]);
    expect(TREND_DAYS).toBe(7);
  });

  describe('終点は渡された最新の行の日付で、今日ではない', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('実行時の日付が終点から離れていても、終点までの 7 日を返す', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-12-01T03:00:00Z'));
      const result = days('2026-07-12', [comparableRow('2026-07-12', 2, '4.2', 123)]);
      expect(result.map((day) => day.date)).toEqual([
        '2026-07-06',
        '2026-07-07',
        '2026-07-08',
        '2026-07-09',
        '2026-07-10',
        '2026-07-11',
        '2026-07-12',
      ]);
      expect(result.at(-1)?.kind).toBe('comparable');
    });
  });

  it.each([
    ['暦日として正しくない終点', '2026-02-30', TREND_DAYS],
    ['形の違う終点', '2026/09/14', TREND_DAYS],
    ['0 日', '2026-09-14', 0],
    ['整数でない日数', '2026-09-14', 1.5],
  ])('%s は例外にする（呼出元の誤り）', (_label, endDate, count) => {
    expect(() => classifyTrendDays(endDate, [], count)).toThrow();
  });
});

// --- レポート -----------------------------------------------------------------------

describe('見出しと footer（6.2・6.6・8.1・8.3）', () => {
  it('見出しに店舗名と対象期間を置き、footer に詳細画面への導線と、末尾に帰属表示を 1 つだけ置く', () => {
    const bubble = report(FOUR_KINDS_DAYS);
    expect(texts(bubble.header)).toEqual([STORE.storeName, '9月8日〜9月14日のデータ']);
    expect(bubble.footer.contents).toEqual([
      {
        type: 'button',
        style: 'primary',
        color: lineColors.action,
        height: lineLayout.actionHeight,
        action: { type: 'uri', label: DETAIL_LINK_LABEL, uri: DETAIL_URL },
      },
      buildAttributionText(),
    ]);
    expect(JSON.stringify(bubble).split(ATTRIBUTION_TEXT)).toHaveLength(2);
  });

  it('帰属表示は、ポリシーの範囲の大きさと色で描く（共有の部品）', () => {
    const attribution = report(FOUR_KINDS_DAYS).footer.contents.at(-1) as FlexTextComponent;
    expect(attribution.size).toBe(lineLayout.attributionSize);
    expect(attribution.color).toBe(lineColors.attribution);
  });

  it('altText に店舗名・対象期間・要約・帰属表示を入れる', () => {
    const { altText } = flexOf(buildTrendReport(STORE, FOUR_KINDS_DAYS, false, DETAIL_URL));
    expect(altText).toBe(
      `${STORE.storeName}（9月8日〜9月14日）: 5店中3位→5店中2位、★4.1→★4.2、クチコミ数 +5件（${ATTRIBUTION_TEXT}）`,
    );
  });

  it('要約を出せない期間の altText は、店舗名・対象期間と推移のレポートであることを示す', () => {
    const { altText } = flexOf(buildTrendReport(STORE, days('2026-09-14', [failedRow('2026-09-14')]), true, DETAIL_URL));
    expect(altText).toBe(`${STORE.storeName}（9月8日〜9月14日）: 直近7日の推移（${ATTRIBUTION_TEXT}）`);
  });

  it('LINE が拒否する空の text を 1 つも作らない', () => {
    const inputs: readonly (readonly TrendDay[])[] = [
      FOUR_KINDS_DAYS,
      days('2026-09-14', []),
      days('2026-09-14', [selfUnratedRow('2026-09-14', 0)]),
      days('2026-09-14', [failedRow('2026-09-14')]),
    ];
    for (const input of inputs) {
      const latestFailed = input.at(-1)?.kind === 'failed';
      for (const text of texts(report(input, latestFailed))) {
        expect(text.trim()).not.toBe('');
      }
    }
  });
});

describe('日付順の表（6.2・6.3・6.4・6.8）', () => {
  // 2026-09-19 の実機確認（本番・iPhone）で、見出しの「クチコミ数」が「クチコ…」と切り捨てられた。
  // 値のセル（valueCell）は wrap を持つので折り返せるのに、見出しのセルだけが持っていなかった。
  // 列が何の数字なのかを読めなくするので、見出しも値と同じく折り返す。スナップショットだけでは
  // `-u` で黙って戻せてしまうため、意図をここで明示して固定する。
  it('列の見出しは値と同じく折り返す（幅に収まらないときに切り捨てない）', () => {
    const heading = tableOf(report(FOUR_KINDS_DAYS)).contents[0];
    if (heading === undefined || !isBox(heading)) {
      throw new Error('見出しの行が box ではない');
    }
    const cells = heading.contents.filter((c): c is FlexTextComponent => c.type === 'text');
    // 件数を先に固定する（0 件や 1 件でも「すべて true」は成り立ってしまうため）。
    expect(cells).toHaveLength(TABLE_HEADINGS.length);
    expect(cells.map((c) => c.wrap)).toEqual(TABLE_HEADINGS.map(() => true));
  });

  it('列の見出しの下に、7 日を日付の昇順で 1 行ずつ並べる', () => {
    const bubble = report(FOUR_KINDS_DAYS);
    expect(texts(tableOf(bubble).contents[0])).toEqual(TABLE_HEADINGS);
    expect(tableRows(bubble)).toEqual([
      ['9月8日', '5店中3位', '★4.1', '118件'],
      ['9月9日', MISSING_LABEL],
      ['9月10日', FAILED_LABEL],
      ['9月11日', '—', '★4.1', '119件'],
      ['9月12日', '5店中3位', '★4.1', '120件'],
      ['9月13日', '—', '★4.2', '121件'],
      ['9月14日', '5店中2位', '★4.2', '123件'],
    ]);
  });

  it('行の無い日と取得失敗の日は、前後の日の値で埋めず、その旨だけを出す（6.4・8.4）', () => {
    // 9 日の前後はどちらも値を持つ日である。値を持ち込めば、9 日の行に数字や星が現れる。
    const input = days('2026-09-14', [comparableRow('2026-09-08', 3, '4.1', 118), comparableRow('2026-09-10', 2, '4.2', 125)]);
    const rows = tableRows(report(input));
    expect(rows[1]).toEqual(['9月9日', MISSING_LABEL]);
    for (const line of rows.slice(3)) {
      expect(line).toHaveLength(2);
      expect(line[1]).toBe(MISSING_LABEL);
    }
    const failed = tableRows(report(FOUR_KINDS_DAYS))[2];
    expect(failed).toEqual(['9月10日', FAILED_LABEL]);
  });

  it('比較不能の日は順位を「—」にし、評価（未評価の日は「評価なし」）と口コミ総数を出す（6.8）', () => {
    const input = days('2026-09-14', [
      noCompetitorsRow('2026-09-12', '4.2', 120),
      selfUnratedRow('2026-09-13', 0),
      noRatedCompetitorsRow('2026-09-14', '4.2', 121),
    ]);
    const rows = tableRows(report(input));
    expect(rows.slice(4)).toEqual([
      ['9月12日', '—', '★4.2', '120件'],
      ['9月13日', '—', '評価なし', '0件'],
      ['9月14日', '—', '★4.2', '121件'],
    ]);
    // どの行にも順位の表記（「N店中R位」）が現れない（列の見出しの「順位」は数字を持たない）。
    expect(texts(report(input)).filter((text) => /\d位/.test(text))).toEqual([]);
  });

  it('順位の表記は比較可能な日の数だけ現れる', () => {
    const rankTexts = tableRows(report(FOUR_KINDS_DAYS))
      .flat()
      .filter((text) => /^\d+店中\d+位$/.test(text));
    expect(rankTexts).toEqual(['5店中3位', '5店中3位', '5店中2位']);
  });

  it('比較不能の日があるときだけ、順位の「—」の意味を表の下に添える', () => {
    const withNotComparable = report(FOUR_KINDS_DAYS);
    expect(texts(withNotComparable.body)).toContain(NOT_COMPARABLE_NOTE);
    const allComparable = report(
      days('2026-09-14', [comparableRow('2026-09-13', 3, '4.1', 120), comparableRow('2026-09-14', 2, '4.2', 121)]),
    );
    expect(texts(allComparable.body)).not.toContain(NOT_COMPARABLE_NOTE);
  });

  it('値の欄は取得済みの値だけを出し、読めない口コミ総数は「—」にする（8.4）', () => {
    const input: TrendDay[] = [
      { date: '2026-09-13', kind: 'not_comparable', rating: '4.2', reviewCount: null },
      { date: '2026-09-14', kind: 'comparable', rank: 2, rankTotal: 5, rating: '4.2', reviewCount: null },
    ];
    expect(tableRows(report(input))).toEqual([
      ['9月13日', '—', '★4.2', '—'],
      ['9月14日', '5店中2位', '★4.2', '—'],
    ]);
  });
});

describe('期間の要約と注記（6.2・6.5・7.2）', () => {
  it('取得できた日の最初と最後がどちらも比較可能なら、順位（母数つき）・評価・口コミ総数の変化を 1 行で出す', () => {
    const bubble = report(FOUR_KINDS_DAYS);
    expect(bubble.body.contents[0]).toEqual({
      type: 'text',
      text: '9月8日〜9月14日：5店中3位→5店中2位、★4.1→★4.2、クチコミ数 +5件',
      weight: 'bold',
      size: lineLayout.bodySize,
      color: lineColors.body,
      wrap: true,
    });
    expect(summaryTexts(bubble)).toHaveLength(1);
  });

  it('順位には端ごとの母数を添える（母数が変わっても「3位→2位」と読み違えさせない）', () => {
    const input = days('2026-09-14', [
      row('2026-09-13', { rank: 3, rank_total: 6, rating: '4.1', review_count: 120 }),
      row('2026-09-14', { rank: 2, rank_total: 4, rating: '4.1', review_count: 121 }),
    ]);
    expect(summaryTexts(report(input))).toEqual(['9月13日〜9月14日：6店中3位→4店中2位、★4.1→★4.1、クチコミ数 +1件']);
  });

  it.each<[string, readonly NormalizedReadRow[], string]>([
    [
      '最初の端だけが比較可能',
      [comparableRow('2026-09-12', 3, '4.1', 120), noRatedCompetitorsRow('2026-09-14', '4.2', 121)],
      '9月12日〜9月14日：★4.1→★4.2、クチコミ数 +1件',
    ],
    [
      '最後の端だけが比較可能（取得失敗の日は端にしない）',
      [
        noCompetitorsRow('2026-09-08', '3.9', 100),
        comparableRow('2026-09-10', 4, '4.0', 110),
        comparableRow('2026-09-12', 3, '4.1', 110),
        failedRow('2026-09-14'),
      ],
      '9月8日〜9月12日：★3.9→★4.1、クチコミ数 +10件',
    ],
    [
      '比較可能な日が 1 日だけで、取得できた日は 2 日',
      [noCompetitorsRow('2026-09-13', '4.1', 119), comparableRow('2026-09-14', 2, '4.2', 123)],
      '9月13日〜9月14日：★4.1→★4.2、クチコミ数 +4件',
    ],
    [
      '比較不能の日だけ',
      [noCompetitorsRow('2026-09-12', '4.2', 120), noCompetitorsRow('2026-09-13', '4.2', 121), noCompetitorsRow('2026-09-14', '4.2', 122)],
      '9月12日〜9月14日：★4.2→★4.2、クチコミ数 +2件',
    ],
    [
      '自店が未評価の日だけ',
      [selfUnratedRow('2026-09-12', 0), selfUnratedRow('2026-09-14', 1)],
      '9月12日〜9月14日：評価なし→評価なし、クチコミ数 +1件',
    ],
  ])('%s なら、順位を出さずに評価と口コミ総数の変化を出し、不足の注記を出さない', (_label, rows, expected) => {
    const input = days('2026-09-14', rows);
    const bubble = report(input, input.at(-1)?.kind === 'failed');
    expect(summaryTexts(bubble)).toEqual([expected]);
    expect(texts(bubble.body)).not.toContain(INSUFFICIENT_NOTE);
    // 要約に順位の表記（「N店中R位」）が現れない。
    expect(summaryTexts(bubble).filter((text) => /\d位/.test(text))).toEqual([]);
  });

  it('口コミ総数が減った日は負の差分を出し、読めない値があれば差分を「—」にする', () => {
    const decreased = days('2026-09-14', [comparableRow('2026-09-13', 2, '4.2', 123), comparableRow('2026-09-14', 2, '4.2', 121)]);
    expect(summaryTexts(report(decreased))).toEqual(['9月13日〜9月14日：5店中2位→5店中2位、★4.2→★4.2、クチコミ数 -2件']);
    const unreadable: TrendDay[] = [
      { date: '2026-09-13', kind: 'not_comparable', rating: '4.2', reviewCount: null },
      { date: '2026-09-14', kind: 'comparable', rank: 1, rankTotal: 5, rating: '4.3', reviewCount: 130 },
    ];
    expect(summaryTexts(report(unreadable))).toEqual(['9月13日〜9月14日：★4.2→★4.3、クチコミ数 —']);
  });

  it.each<[string, readonly NormalizedReadRow[]]>([
    ['取得できた日が 1 日（比較可能）', [comparableRow('2026-09-14', 2, '4.2', 123)]],
    ['取得できた日が 1 日（比較不能）', [selfUnratedRow('2026-09-14', 0)]],
    ['比較可能な日が 1 日と取得失敗の日', [comparableRow('2026-09-12', 2, '4.2', 123), failedRow('2026-09-13'), failedRow('2026-09-14')]],
    ['取得失敗の日だけ', [failedRow('2026-09-13'), failedRow('2026-09-14')]],
    ['行が 1 つも無い', []],
  ])('%s なら、要約を出さずに不足の注記を出し、取得済みの値は表に残す（6.5）', (_label, rows) => {
    const input = days('2026-09-14', rows);
    const latestFailed = input.at(-1)?.kind === 'failed';
    const bubble = report(input, latestFailed);
    expect(summaryTexts(bubble)).toEqual([]);
    expect(bubble.body.contents[0]).toMatchObject({ type: 'text', text: INSUFFICIENT_NOTE });
    // 取得済みの日の行は、値を持ったまま表に残る。
    const fetched = tableRows(bubble).filter((line) => line.length === 4);
    expect(fetched).toHaveLength(input.filter((day) => day.kind === 'comparable' || day.kind === 'not_comparable').length);
  });

  it('取得できた日が 2 日以上あれば、比較可能な日の数によらず不足の注記を出さない', () => {
    expect(texts(report(FOUR_KINDS_DAYS).body)).not.toContain(INSUFFICIENT_NOTE);
    const two = days('2026-09-14', [comparableRow('2026-09-08', 3, '4.1', 118), comparableRow('2026-09-14', 2, '4.2', 123)]);
    expect(texts(report(two).body)).not.toContain(INSUFFICIENT_NOTE);
    const notComparable = days('2026-09-14', [selfUnratedRow('2026-09-08', 0), noCompetitorsRow('2026-09-14', '4.2', 3)]);
    expect(texts(report(notComparable).body)).not.toContain(INSUFFICIENT_NOTE);
  });

  it('最新の日が取得失敗なら、その日付を添えて注記を出す（表の失敗の行はそのまま残す）', () => {
    const input = days('2026-09-14', [
      comparableRow('2026-09-12', 3, '4.1', 120),
      comparableRow('2026-09-13', 2, '4.2', 121),
      failedRow('2026-09-14'),
    ]);
    const bubble = report(input, true);
    expect(textsOutsideTable(bubble)).toContain(latestFailedNote('9月14日'));
    expect(tableRows(bubble).at(-1)).toEqual(['9月14日', FAILED_LABEL]);
    // 要約は取得できた日だけから作る。
    expect(summaryTexts(bubble)).toEqual(['9月12日〜9月13日：5店中3位→5店中2位、★4.1→★4.2、クチコミ数 +1件']);
  });

  it('最新の日が取得失敗でなければ、最新の取得失敗の注記を出さない（途中の失敗は表だけで示す）', () => {
    const bubble = report(FOUR_KINDS_DAYS, false);
    expect(textsOutsideTable(bubble).filter((text) => text.startsWith('最新のデータ'))).toEqual([]);
  });

  it('latestFailed と最新の日の分類が食い違う入力は例外にする（呼出元の誤り）', () => {
    expect(() => buildTrendReport(STORE, FOUR_KINDS_DAYS, true, DETAIL_URL)).toThrow(/latestFailed/);
    expect(() => buildTrendReport(STORE, days('2026-09-14', [failedRow('2026-09-14')]), false, DETAIL_URL)).toThrow(
      /latestFailed/,
    );
  });

  it('日が 1 つも無い入力と、日付の昇順でない入力は例外にする', () => {
    expect(() => buildTrendReport(STORE, [], false, DETAIL_URL)).toThrow();
    expect(() => buildTrendReport(STORE, [...FOUR_KINDS_DAYS].reverse(), false, DETAIL_URL)).toThrow();
    // 両端の順は正しく、途中だけが入れ替わった入力（対象期間の表記では検出できない）。
    const swapped = [...FOUR_KINDS_DAYS];
    [swapped[2], swapped[3]] = [FOUR_KINDS_DAYS[3] as TrendDay, FOUR_KINDS_DAYS[2] as TrendDay];
    expect(() => buildTrendReport(STORE, swapped, false, DETAIL_URL)).toThrow(/ascending/);
    // 同じ日付が 2 回現れる入力。
    const duplicated = [...FOUR_KINDS_DAYS.slice(0, 3), FOUR_KINDS_DAYS[2] as TrendDay, ...FOUR_KINDS_DAYS.slice(4)];
    expect(() => buildTrendReport(STORE, duplicated, false, DETAIL_URL)).toThrow(/ascending/);
  });
});

describe('詳細画面の 30 日推移への導線（6.6）', () => {
  it('LIFF URL に店舗のヒント（storeId）を付ける', () => {
    expect(storeDetailUrlFor(LIFF_URL, STORE_ID)).toBe(DETAIL_URL);
  });

  it('クエリを持つ LIFF URL には & で足し、既存の storeId は置き換える（ヒントを 2 つにしない）', () => {
    expect(storeDetailUrlFor(`${LIFF_URL}?from=menu`, STORE_ID)).toBe(`${LIFF_URL}?from=menu&storeId=${STORE_ID}`);
    const replaced = new URL(storeDetailUrlFor(`${LIFF_URL}?storeId=other&from=menu`, STORE_ID));
    expect(replaced.searchParams.getAll('storeId')).toEqual([STORE_ID]);
    expect(replaced.searchParams.get('from')).toBe('menu');
  });

  it('フラグメントの前にクエリを置く', () => {
    expect(storeDetailUrlFor(`${LIFF_URL}#top`, STORE_ID)).toBe(`${LIFF_URL}?storeId=${STORE_ID}#top`);
  });

  it('店舗 ID は符号化して、クエリを分断・増殖させない', () => {
    const storeId = 'a&b=c?d #東京';
    const url = storeDetailUrlFor(LIFF_URL, storeId);
    expect(new URL(url).searchParams.getAll('storeId')).toEqual([storeId]);
    expect(new URL(url).hash).toBe('');
    expect(url).toMatch(/^[\x21-\x7e]+$/);
  });

  it.each([
    ['空文字', ''],
    ['http', 'http://liff.line.me/1234567890-AbCdEfGh'],
    ['スキームの無い形', '//liff.line.me/1234567890-AbCdEfGh'],
    ['URL でない値', 'liff.line.me/1234567890-AbCdEfGh'],
    ['空白を含む', 'https://liff.line.me/1234567890 AbCdEfGh'],
    ['利用者情報を含む', 'https://user@liff.line.me/1234567890-AbCdEfGh'],
    ['上限を超える長さ', `https://liff.line.me/${'a'.repeat(1000)}`],
  ])('LIFF URL が https の絶対 URL でない（%s）なら、空文字を返す', (_label, base) => {
    expect(storeDetailUrlFor(base, STORE_ID)).toBe('');
  });

  it('空の店舗 ID は例外にする（呼出元の誤り）', () => {
    expect(() => storeDetailUrlFor(LIFF_URL, '')).toThrow();
  });

  it.each([
    ['空文字', ''],
    ['http', `http://liff.line.me/1234567890-AbCdEfGh?storeId=${STORE_ID}`],
    ['javascript', 'javascript:alert(1)'],
    ['上限を超える長さ', `https://liff.line.me/${'a'.repeat(1000)}`],
  ])('導線の URL が使えない（%s）なら、導線を置かずに帰属表示だけを残す', (_label, detailUrl) => {
    const bubble = report(FOUR_KINDS_DAYS, false, detailUrl);
    expect(buttons(bubble)).toEqual([]);
    expect(bubble.footer.contents).toEqual([buildAttributionText()]);
  });

  it('上限ちょうどの長さの URL は導線に使う', () => {
    const longest = `${LIFF_URL}?storeId=${'s'.repeat(1000 - `${LIFF_URL}?storeId=`.length)}`;
    expect(longest).toHaveLength(1000);
    expect(buttons(report(FOUR_KINDS_DAYS, false, longest)).map((button) => button.action)).toEqual([
      { type: 'uri', label: DETAIL_LINK_LABEL, uri: longest },
    ]);
  });
});

describe('日付の列挙と表記は実行環境の TZ に依存しない', () => {
  const originalTz = process.env['TZ'];

  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env['TZ'];
    } else {
      process.env['TZ'] = originalTz;
    }
  });

  it.each(['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Etc/GMT+12'])('TZ=%s', (tz) => {
    process.env['TZ'] = tz;
    expect(days('2026-09-14', FOUR_KINDS_ROWS)).toEqual(FOUR_KINDS_DAYS);
    expect(days('2026-03-08', []).map((day) => day.date)).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
    ]);
    const bubble = report(FOUR_KINDS_DAYS);
    expect(texts(bubble.header)[1]).toBe('9月8日〜9月14日のデータ');
    expect(tableRows(bubble).map((line) => line[0])).toEqual(['9月8日', '9月9日', '9月10日', '9月11日', '9月12日', '9月13日', '9月14日']);
  });

  it('試験の前提: TZ の切り替えが実際にこのプロセスの Date に効いている（空振りの防止）', () => {
    process.env['TZ'] = 'America/Los_Angeles';
    expect(new Date('2026-09-14').getDate()).toBe(13);
    process.env['TZ'] = 'Pacific/Kiritimati';
    expect(new Date('2026-09-14T15:30:00Z').getDate()).toBe(15);
  });
});

describe('30KB の検証', () => {
  it('上限いっぱいの値を 7 日並べ、注記をすべて出しても、上限の半分に収まる', () => {
    const longStore: ReportContext = { storeName: '\u{1F363}'.repeat(200) };
    const largest = (date: string): TrendDay => ({
      date,
      kind: 'comparable',
      rank: 999,
      rankTotal: 999,
      rating: '5.0',
      reviewCount: 99_999_999,
    });
    // 要約の両端（8 日と 13 日）を比較可能にし、要約に順位の変化まで入る最も長い形にする。
    const input: TrendDay[] = [
      ...['2026-09-08', '2026-09-09', '2026-09-10'].map(largest),
      { date: '2026-09-11', kind: 'not_comparable', rating: '5.0', reviewCount: 99_999_999 },
      ...['2026-09-12', '2026-09-13'].map(largest),
      { date: '2026-09-14', kind: 'failed' },
    ];
    const longestUrl = `${LIFF_URL}?storeId=${'s'.repeat(1000 - `${LIFF_URL}?storeId=`.length)}`;
    const bubble = bubbleOf(buildTrendReport(longStore, input, true, longestUrl));
    // 試験の前提: 順位つきの要約・最新の取得失敗の注記・「—」の注記・導線がすべて入っている（空振りの防止）。
    expect(summaryTexts(bubble)).toEqual(['9月8日〜9月13日：999店中999位→999店中999位、★5.0→★5.0、クチコミ数 ±0件']);
    expect(textsOutsideTable(bubble)).toContain(latestFailedNote('9月14日'));
    expect(texts(bubble.body)).toContain(NOT_COMPARABLE_NOTE);
    expect(buttons(bubble)).toHaveLength(1);
    expect(tableRows(bubble)).toHaveLength(7);

    expect(fitsFlexBubbleLimit(bubble)).toBe(true);
    expect(flexBubbleByteLength(bubble)).toBeLessThan(FLEX_BUBBLE_MAX_BYTES / 2);
  });

  it('上限を超えるとき（極端に長い店舗名）は FlexBubbleTooLargeError を投げる（誤った形の Reply を送らない）', () => {
    const huge: ReportContext = { storeName: '店'.repeat(FLEX_BUBBLE_MAX_BYTES) };
    expect(() => buildTrendReport(huge, FOUR_KINDS_DAYS, false, DETAIL_URL)).toThrow(FlexBubbleTooLargeError);
  });
});

describe('スナップショット（Flex Message Simulator へ貼って目視する材料）', () => {
  it('4 種類の日を含む 7 日', () => {
    expect(buildTrendReport(STORE, FOUR_KINDS_DAYS, false, DETAIL_URL)).toMatchSnapshot();
  });

  it('最新の日が取得失敗', () => {
    const input = days('2026-09-14', [
      comparableRow('2026-09-08', 3, '4.1', 118),
      noCompetitorsRow('2026-09-10', '4.1', 119),
      comparableRow('2026-09-12', 3, '4.1', 120),
      failedRow('2026-09-14'),
    ]);
    expect(buildTrendReport(STORE, input, true, DETAIL_URL)).toMatchSnapshot();
  });

  it('取得できた日が 2 日未満', () => {
    const input = days('2026-09-14', [failedRow('2026-09-11'), comparableRow('2026-09-14', 2, '4.2', 123)]);
    expect(buildTrendReport(STORE, input, false, DETAIL_URL)).toMatchSnapshot();
  });

  it('要約の端に比較不能の日を含む（順位を要約に出さない）', () => {
    const input = days('2026-09-14', [selfUnratedRow('2026-09-13', 0), comparableRow('2026-09-14', 2, '4.2', 123)]);
    expect(buildTrendReport(STORE, input, false, DETAIL_URL)).toMatchSnapshot();
  });
});
