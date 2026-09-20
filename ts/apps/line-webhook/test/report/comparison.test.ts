// 競合店との比較レポートの試験（design.md「Report builders（表示）」の ComparisonBuilder・
// Requirements 5.1–5.8, 8.4, 8.5）。
// - 見出しに店舗名とデータ対象日、footer に帰属表示が入ること
// - 比較可能な日は「近隣 N 店中 R 位」（LINE 面の巨大表示）と、自店の評価・口コミ総数、競合の名称・評価・
//   口コミ総数・星差を出すこと。星差は詳細画面と同じ規則（formatStarDiff）で出すこと
// - 評価のない競合は末尾に置き、「評価なし」と注記を出すこと。星差を出さないこと
// - 既存データの評価 0 の競合を、正規化を通して「評価なし」として扱い、「★0」にも母数の一部にもしないこと
// - 自店が未評価の日は順位と星差を出さず、Issue #255 の文を出すこと
// - 評価を持つ競合が無い日は順位を出さず、自店の評価と、比較に使えるデータが無い旨を出すこと
// - 取得済みの値に無いものを埋めないこと（8.4）
// - 30KB の検証
import { describe, expect, it } from 'vitest';
import type { DailySummaryCompetitor, DailySummaryReadRow } from '@fwlm/db';
import { SELF_UNRATED_RANK_TEXT, UNRATED_EXCLUDED_NOTE } from '@fwlm/db/daily-summary';
import { lineColors, lineLayout } from '@fwlm/design-tokens';
import type { LineMessage } from '../../src/line/client.js';
import type { FlexBoxComponent, FlexBubbleContents, FlexTextComponent } from '../../src/line/flex-types.js';
import { buildComparisonReport } from '../../src/report/builders/comparison.js';
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

const SELF_HEADING = '自店の評価';
const COMPETITORS_HEADING = '競合との比較';
const NO_COMPARABLE_TEXT = '競合店との比較に使えるデータがありません';

// 架空の競合。店名は試験用の架空のもので、実在の店舗を指さない。
function competitor(
  name: string,
  rating: number | null,
  reviewCount: number,
  starDiff: number | null,
): DailySummaryCompetitor {
  return { name, rating, reviewCount, starDiff };
}

// 新 Go が書く形の行（自店 ★4.2・評価を持つ競合 3 店・評価のない競合 1 店。母数は自店を含めて 4）。
function rawRow(overrides: Partial<DailySummaryReadRow> = {}): DailySummaryReadRow {
  return {
    summary_date: '2026-09-14',
    status: 'ready',
    rank: 2,
    rank_total: 4,
    rank_prev: 3,
    rating: '4.2',
    review_count: 120,
    rating_prev: '4.1',
    review_count_prev: 118,
    new_review_count: 2,
    new_reviews: [],
    competitors: [
      competitor('試験競合A', 4.5, 300, -0.3),
      competitor('試験競合B', 4.0, 80, 0.2),
      competitor('試験競合C', 3.8, 40, 0.4),
      competitor('試験競合D', null, 0, null),
    ],
    google_maps_reviews_uri: null,
    ...overrides,
  };
}

function row(overrides: Partial<DailySummaryReadRow> = {}): NormalizedReadRow {
  return normalizeReadRow(rawRow(overrides));
}

function flexOf(message: LineMessage): { readonly altText: string; readonly bubble: FlexBubbleContents } {
  if (message.type !== 'flex') {
    throw new Error(`flex を期待したが ${message.type} だった`);
  }
  return { altText: message.altText, bubble: message.contents as FlexBubbleContents };
}

function bubbleOf(message: LineMessage): FlexBubbleContents {
  return flexOf(message).bubble;
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

function textWith(node: unknown, text: string): FlexTextComponent {
  const found = textComponents(node).find((component) => component.text === text);
  if (found === undefined) {
    throw new Error(`text「${text}」が見つからなかった`);
  }
  return found;
}

// 本文の直下の節（box）のうち、先頭の text が見出しと一致するもの。
function sectionOf(bubble: FlexBubbleContents, heading: string): FlexBoxComponent {
  const section = bubble.body.contents.find(
    (content): content is FlexBoxComponent => content.type === 'box' && texts(content)[0] === heading,
  );
  if (section === undefined) {
    throw new Error(`見出し「${heading}」の節が見つからなかった`);
  }
  return section;
}

// 競合の節に並ぶ競合の枠（節の直下の box）。1 枠が 1 店である。
function competitorRows(bubble: FlexBubbleContents): FlexBoxComponent[] {
  return sectionOf(bubble, COMPETITORS_HEADING).contents.filter(
    (content): content is FlexBoxComponent => content.type === 'box',
  );
}

// 競合の枠ごとの text（店名・評価と口コミ総数・星差）。
function competitorLines(bubble: FlexBubbleContents): string[][] {
  return competitorRows(bubble).map((block) => texts(block));
}

// 本文にある順位の text（「近隣 N 店中 R 位」）。
function rankTexts(bubble: FlexBubbleContents): string[] {
  return texts(bubble.body).filter((text) => /近隣\d+店中/.test(text) || /\d+位/.test(text));
}

function starDiffTexts(bubble: FlexBubbleContents): string[] {
  return texts(bubble.body).filter((text) => text.startsWith('星差'));
}

describe('見出しと帰属表示（5.2・8.1・8.3）', () => {
  it('見出しに店舗名とデータ対象日を置き、footer の末尾に帰属表示を 1 つだけ置く', () => {
    const bubble = bubbleOf(buildComparisonReport(STORE, row()));
    expect(texts(bubble.header)).toEqual([STORE.storeName, '9月14日時点のデータ']);
    expect(bubble.footer.contents[bubble.footer.contents.length - 1]).toEqual(buildAttributionText());
    expect(JSON.stringify(bubble).split(ATTRIBUTION_TEXT)).toHaveLength(2);
  });

  it.each<[string, Partial<DailySummaryReadRow>]>([
    ['比較可能', {}],
    ['自店が未評価', { rating: null, rank: null, rank_total: null, rank_prev: null }],
    ['評価を持つ競合なし', { rank: 1, rank_total: 1, competitors: [competitor('試験競合D', null, 0, null)] }],
    ['競合なし', { status: 'no_competitors', rank: 1, rank_total: 1, competitors: [] }],
  ])('%s でも、店舗名・データ対象日・帰属表示が入る', (_label, overrides) => {
    const { altText, bubble } = flexOf(buildComparisonReport(STORE, row(overrides)));
    expect(texts(bubble.header)).toEqual([STORE.storeName, '9月14日時点のデータ']);
    expect(texts(bubble.footer)).toContain(ATTRIBUTION_TEXT);
    expect(altText).toContain(STORE.storeName);
    expect(altText).toContain('9月14日');
    expect(altText.endsWith(`（${ATTRIBUTION_TEXT}）`)).toBe(true);
  });

  it('LINE が拒否する空の text を 1 つも作らない', () => {
    const inputs = [
      row(),
      row({ rating: null, rank: null, rank_total: null, rank_prev: null }),
      row({ status: 'no_competitors', rank: 1, rank_total: 1, competitors: [] }),
      row({ competitors: [competitor('', 4.0, 10, 0.2), competitor('   ', null, 0, null)] }),
    ];
    for (const input of inputs) {
      for (const text of texts(bubbleOf(buildComparisonReport(STORE, input)))) {
        expect(text.trim()).not.toBe('');
      }
    }
  });
});

describe('比較可能な日（5.1・5.2・5.4）', () => {
  it('本文の先頭に「近隣 N 店中 R 位」を、LINE 面の巨大表示の段で置く（§7.13）', () => {
    const bubble = bubbleOf(buildComparisonReport(STORE, row()));
    const [first] = bubble.body.contents;
    expect(first).toEqual({
      type: 'text',
      text: '近隣4店中 2位',
      weight: 'bold',
      size: lineLayout.displaySize,
      color: lineColors.body,
      adjustMode: 'shrink-to-fit',
    });
    // 巨大表示はこの 1 か所だけである。
    const display = textComponents(bubble).filter((component) => component.size === lineLayout.displaySize);
    expect(display).toHaveLength(1);
  });

  it('自店の評価と口コミ総数を出す', () => {
    const bubble = bubbleOf(buildComparisonReport(STORE, row()));
    expect(texts(sectionOf(bubble, SELF_HEADING))).toEqual([SELF_HEADING, '★4.2（クチコミ 120件）']);
  });

  it('競合の名称・評価・口コミ総数・星差を、評価のある店を順位の順（日次集計の順）に並べる', () => {
    const bubble = bubbleOf(buildComparisonReport(STORE, row()));
    expect(competitorLines(bubble)).toEqual([
      ['試験競合A', '★4.5（クチコミ 300件）', '星差 -0.3'],
      ['試験競合B', '★4.0（クチコミ 80件）', '星差 +0.2'],
      ['試験競合C', '★3.8（クチコミ 40件）', '星差 +0.4'],
      ['試験競合D', '評価なし（クチコミ 0件）'],
    ]);
  });

  it('順位と母数は正規化後の行の rank と rank_total をそのまま使う（5.4）', () => {
    const bubble = bubbleOf(buildComparisonReport(STORE, row({ rank: 5, rank_total: 6 })));
    expect(rankTexts(bubble)).toEqual(['近隣6店中 5位']);
  });

  it('altText に店舗名・データ対象日・順位と母数を入れる', () => {
    const { altText } = flexOf(buildComparisonReport(STORE, row()));
    expect(altText).toBe(`${STORE.storeName}（9月14日時点）: 近隣4店中 2位（${ATTRIBUTION_TEXT}）`);
  });
});

describe('星差は詳細画面と同じ規則で出す（5.8）', () => {
  it.each<[number, string]>([
    [-0.3, '星差 -0.3'],
    [0.2, '星差 +0.2'],
    [1.25, '星差 +1.3'],
    [0, '星差 0.0'],
    // 丸めた結果が 0 なら符号を付けない（-0.0 を出さない）。
    [-0.04, '星差 0.0'],
  ])('星差 %s は「%s」と出す', (starDiff, expected) => {
    const bubble = bubbleOf(
      buildComparisonReport(STORE, row({ competitors: [competitor('試験競合A', 4.0, 10, starDiff)] })),
    );
    expect(starDiffTexts(bubble)).toEqual([expected]);
  });

  it('日次集計に星差が無い競合に、評価から星差を補わない（8.4）', () => {
    // 自店と競合のどちらにも評価があるのに星差が無い行（契約から外れた値）。4.2 − 4.0 を計算して出さない。
    const bubble = bubbleOf(
      buildComparisonReport(STORE, row({ competitors: [competitor('試験競合A', 4.0, 10, null)] })),
    );
    expect(starDiffTexts(bubble)).toEqual([]);
    expect(competitorLines(bubble)).toEqual([['試験競合A', '★4.0（クチコミ 10件）']]);
  });

  it('星差の文字は説明の色で、評価の右に置く', () => {
    const bubble = bubbleOf(buildComparisonReport(STORE, row()));
    const [first] = competitorRows(bubble);
    const diff = textWith(first, '星差 -0.3');
    expect(diff).toMatchObject({ size: lineLayout.descriptionSize, color: lineColors.description, align: 'end' });
  });
});

describe('評価のない競合（5.3・5.7）', () => {
  it('評価のない競合は「評価なし」と出し、星差を出さず、一覧の下に注記を添える', () => {
    const bubble = bubbleOf(buildComparisonReport(STORE, row()));
    const section = sectionOf(bubble, COMPETITORS_HEADING);
    expect(competitorLines(bubble).at(-1)).toEqual(['試験競合D', '評価なし（クチコミ 0件）']);
    // 注記は Issue #255 の文言で、節の最後に 1 つだけ置く。
    expect(texts(section).at(-1)).toBe(UNRATED_EXCLUDED_NOTE);
    expect(texts(bubble).filter((text) => text === UNRATED_EXCLUDED_NOTE)).toHaveLength(1);
  });

  it('日次集計の途中にいる評価のない競合も、一覧の末尾へ置く（評価のある店の順は変えない）', () => {
    const input = row({
      competitors: [
        competitor('試験競合A', 4.5, 300, -0.3),
        competitor('試験競合D', null, 0, null),
        competitor('試験競合B', 4.0, 80, 0.2),
        competitor('試験競合E', null, 3, null),
        competitor('試験競合C', 3.8, 40, 0.4),
      ],
    });
    const names = competitorLines(bubbleOf(buildComparisonReport(STORE, input))).map(([name]) => name);
    expect(names).toEqual(['試験競合A', '試験競合B', '試験競合C', '試験競合D', '試験競合E']);
  });

  it('評価のない競合がいなければ注記を出さない', () => {
    const input = row({ competitors: [competitor('試験競合A', 4.5, 300, -0.3), competitor('試験競合B', 4.0, 80, 0.2)] });
    const bubble = bubbleOf(buildComparisonReport(STORE, input));
    expect(texts(bubble)).not.toContain(UNRATED_EXCLUDED_NOTE);
  });
});

describe('既存データの評価 0 の競合（8.5）', () => {
  // 旧 Go の行: 評価の無い競合を評価 0 で書き、最下位に数えて母数を 1 つ水増ししていた。
  // 自店 ★4.2 は 2 位で、母数 5 は評価 0 の競合 D を含む。星差も 4.2 − 0 で書かれている。
  const legacy = rawRow({
    rank: 2,
    rank_total: 5,
    competitors: [
      competitor('試験競合A', 4.5, 300, -0.3),
      competitor('試験競合B', 4.0, 80, 0.2),
      competitor('試験競合C', 3.8, 40, 0.4),
      competitor('試験競合D', 0, 0, 4.2),
    ],
  });

  it('評価 0 の競合を「評価なし」と出し、「★0」も星差も出さず、母数に数えない', () => {
    const bubble = bubbleOf(buildComparisonReport(STORE, normalizeReadRow(legacy)));
    expect(rankTexts(bubble)).toEqual(['近隣4店中 2位']);
    expect(competitorLines(bubble).at(-1)).toEqual(['試験競合D', '評価なし（クチコミ 0件）']);
    expect(starDiffTexts(bubble)).toEqual(['星差 -0.3', '星差 +0.2', '星差 +0.4']);
    expect(JSON.stringify(bubble)).not.toMatch(/★0(?![.\d])|★0\.0/);
    expect(JSON.stringify(bubble)).not.toContain('+4.2');
    expect(texts(bubble)).toContain(UNRATED_EXCLUDED_NOTE);
  });

  it('評価 0 の競合が日次集計の途中にいても末尾へ置く', () => {
    const input = normalizeReadRow({
      ...legacy,
      competitors: [
        competitor('試験競合A', 4.5, 300, -0.3),
        competitor('試験競合D', 0, 0, 4.2),
        competitor('試験競合B', 4.0, 80, 0.2),
      ],
      rank_total: 4,
    });
    const names = competitorLines(bubbleOf(buildComparisonReport(STORE, input))).map(([name]) => name);
    expect(names).toEqual(['試験競合A', '試験競合B', '試験競合D']);
  });

  it('競合がすべて評価 0 なら、母数を補正した結果として順位を出さず、比較に使えるデータが無い旨を出す（5.6）', () => {
    const input = normalizeReadRow(
      rawRow({
        rank: 1,
        rank_total: 3,
        competitors: [competitor('試験競合D', 0, 0, 4.2), competitor('試験競合E', 0, 0, 4.2)],
      }),
    );
    const bubble = bubbleOf(buildComparisonReport(STORE, input));
    expect(rankTexts(bubble)).toEqual([]);
    expect(texts(bubble.body)).toContain(NO_COMPARABLE_TEXT);
    expect(starDiffTexts(bubble)).toEqual([]);
    expect(JSON.stringify(bubble)).not.toMatch(/★0(?![.\d])|★0\.0/);
  });
});

describe('自店が未評価の日（5.5）', () => {
  it('順位と星差を出さず、本文の先頭に Issue #255 の文を出す。自店は「評価なし」と口コミ総数を出す', () => {
    const input = row({
      rating: null,
      review_count: 0,
      rank: null,
      rank_total: null,
      rank_prev: null,
      competitors: [competitor('試験競合A', 4.5, 300, null), competitor('試験競合D', null, 0, null)],
    });
    const { altText, bubble } = flexOf(buildComparisonReport(STORE, input));
    expect(bubble.body.contents[0]).toMatchObject({ type: 'text', text: SELF_UNRATED_RANK_TEXT, wrap: true });
    expect(rankTexts(bubble)).toEqual([]);
    expect(starDiffTexts(bubble)).toEqual([]);
    expect(texts(sectionOf(bubble, SELF_HEADING))).toEqual([SELF_HEADING, '評価なし（クチコミ 0件）']);
    expect(competitorLines(bubble)).toEqual([
      ['試験競合A', '★4.5（クチコミ 300件）'],
      ['試験競合D', '評価なし（クチコミ 0件）'],
    ]);
    expect(altText).toBe(`${STORE.storeName}（9月14日時点）: ${SELF_UNRATED_RANK_TEXT}（${ATTRIBUTION_TEXT}）`);
  });

  it('既存データの自店の評価 0 の行も、正規化を通して順位と星差を出さない', () => {
    const input = normalizeReadRow(rawRow({ rating: '0.0', review_count: 0, rank: 4, rank_total: 4 }));
    const bubble = bubbleOf(buildComparisonReport(STORE, input));
    expect(texts(bubble.body)[0]).toBe(SELF_UNRATED_RANK_TEXT);
    expect(rankTexts(bubble)).toEqual([]);
    expect(starDiffTexts(bubble)).toEqual([]);
  });

  it('評価の無い自店に順位が残った行（正規化の前の形）でも、順位を出さない', () => {
    // 正規化の不変条件（自店が未評価なら順位は null）が崩れた行。旧 Go は自店の評価 0 を書き、順位も付けていた。
    const unnormalized: NormalizedReadRow = { ...row(), rating: '0.0', rank: 2, rank_total: 4 };
    const bubble = bubbleOf(buildComparisonReport(STORE, unnormalized));
    expect(texts(bubble.body)[0]).toBe(SELF_UNRATED_RANK_TEXT);
    expect(rankTexts(bubble)).toEqual([]);
  });

  it('評価を持つ競合もいなければ、Issue #255 の文に加えて、比較に使えるデータが無い旨も出す', () => {
    const input = row({
      rating: null,
      rank: null,
      rank_total: null,
      rank_prev: null,
      competitors: [competitor('試験競合D', null, 0, null)],
    });
    const bubble = bubbleOf(buildComparisonReport(STORE, input));
    expect(texts(bubble.body)[0]).toBe(SELF_UNRATED_RANK_TEXT);
    expect(texts(sectionOf(bubble, COMPETITORS_HEADING))).toContain(NO_COMPARABLE_TEXT);
  });
});

describe('評価を持つ競合が無い日（5.6）', () => {
  it('競合が見つかっていない日（no_competitors）は、順位を出さず、自店の評価と比較に使えるデータが無い旨を出す', () => {
    const input = row({ status: 'no_competitors', rank: 1, rank_total: 1, competitors: [] });
    const { altText, bubble } = flexOf(buildComparisonReport(STORE, input));
    expect(rankTexts(bubble)).toEqual([]);
    expect(texts(sectionOf(bubble, SELF_HEADING))).toEqual([SELF_HEADING, '★4.2（クチコミ 120件）']);
    expect(texts(sectionOf(bubble, COMPETITORS_HEADING))).toEqual([COMPETITORS_HEADING, NO_COMPARABLE_TEXT]);
    expect(altText).toBe(`${STORE.storeName}（9月14日時点）: ${NO_COMPARABLE_TEXT}（${ATTRIBUTION_TEXT}）`);
  });

  it('評価のない競合だけの日は、順位を出さず、その旨と評価のない競合と注記を出す', () => {
    const input = row({
      rank: 1,
      rank_total: 1,
      competitors: [competitor('試験競合D', null, 0, null), competitor('試験競合E', null, 2, null)],
    });
    const bubble = bubbleOf(buildComparisonReport(STORE, input));
    const section = sectionOf(bubble, COMPETITORS_HEADING);
    expect(rankTexts(bubble)).toEqual([]);
    expect(texts(section)).toEqual([
      COMPETITORS_HEADING,
      NO_COMPARABLE_TEXT,
      '試験競合D',
      '評価なし（クチコミ 0件）',
      '試験競合E',
      '評価なし（クチコミ 2件）',
      UNRATED_EXCLUDED_NOTE,
    ]);
    // その旨は節の中身として本文の色で、注記は補足として説明の色で描く。
    expect(textWith(section, NO_COMPARABLE_TEXT).color).toBe(lineColors.body);
    expect(textWith(section, UNRATED_EXCLUDED_NOTE).color).toBe(lineColors.description);
  });

  it('評価を持つ競合がいれば、その旨を出さない', () => {
    expect(texts(bubbleOf(buildComparisonReport(STORE, row())))).not.toContain(NO_COMPARABLE_TEXT);
  });

  it('評価を持つ競合がいても順位が記録されていない行は、順位を補わず、その旨も出さない（8.4）', () => {
    const { altText, bubble } = flexOf(buildComparisonReport(STORE, row({ rank: null })));
    expect(rankTexts(bubble)).toEqual([]);
    expect(texts(bubble)).not.toContain(NO_COMPARABLE_TEXT);
    expect(texts(bubble.body)[0]).toBe(SELF_HEADING);
    expect(starDiffTexts(bubble)).toEqual(['星差 -0.3', '星差 +0.2', '星差 +0.4']);
    expect(altText).toBe(`${STORE.storeName}（9月14日時点）: 競合店との比較（${ATTRIBUTION_TEXT}）`);
  });
});

describe('値の無い欄は「—」とし、推測で埋めない（8.4）', () => {
  it('自店の口コミ総数が無ければ「—」と出す', () => {
    const bubble = bubbleOf(buildComparisonReport(STORE, row({ review_count: null })));
    expect(texts(sectionOf(bubble, SELF_HEADING))).toEqual([SELF_HEADING, '★4.2（クチコミ —）']);
  });

  it('競合の店名と口コミ総数が読めなければ「—」と出す', () => {
    const broken = { name: '', rating: 4.0, reviewCount: Number.NaN, starDiff: 0.2 };
    const bubble = bubbleOf(buildComparisonReport(STORE, row({ competitors: [broken] })));
    expect(competitorLines(bubble)).toEqual([['—', '★4.0（クチコミ —）', '星差 +0.2']]);
  });
});

describe('取得失敗の行', () => {
  it('取得失敗の行は受け取らない（取得失敗の案内は呼出元が返す・7.2）', () => {
    const failed = row({ status: 'failed', rank: null, rank_total: null, rating: null, review_count: null, competitors: [] });
    expect(() => buildComparisonReport(STORE, failed)).toThrow(/failed/);
  });
});

describe('正規化を通していない行は型で受け取らない', () => {
  // 型の区別は、competitors が読み取り専用の配列かどうかだけに依っている。この区別が消えると、下の
  // 誤りの期待の指示が未使用になって型検査が落ちる。そのときは、正規化を通したことを表す印を
  // NormalizedReadRow に持たせ、読み出したままの行を渡せないことを保つ。
  it('読み出したままの行を渡すと型検査が落ちる', () => {
    const raw: DailySummaryReadRow = rawRow();
    // @ts-expect-error 正規化の前の行（competitors が読み取り専用の配列）は NormalizedReadRow ではない
    expect(() => buildComparisonReport(STORE, raw)).not.toThrow();
  });
});

describe('30KB の検証', () => {
  // Go が固定する競合の上限（go/internal/competitor の MaxCompetitors）。
  const MAX_COMPETITORS = 5;

  it('競合 5 店・4 バイト文字の長い店名・大きな件数でも収まる', () => {
    const longName = (label: string): string => `${label}${'\u{20BB7}'.repeat(200)}`;
    const store: ReportContext = { storeName: longName('試験食堂') };
    const competitors = Array.from({ length: MAX_COMPETITORS }, (_, index) =>
      index === MAX_COMPETITORS - 1
        ? competitor(longName(`試験競合${index}`), null, 999_999, null)
        : competitor(longName(`試験競合${index}`), 4.9 - index / 10, 999_999, -0.7),
    );
    const input = row({ review_count: 999_999, rank: 5, rank_total: 5, competitors });
    const bubble = bubbleOf(buildComparisonReport(store, input));
    expect(fitsFlexBubbleLimit(bubble)).toBe(true);
    // 余裕を持って収まる構成であること（上限の半分に届かない）。
    expect(flexBubbleByteLength(bubble)).toBeLessThan(FLEX_BUBBLE_MAX_BYTES / 2);
    expect(competitorRows(bubble)).toHaveLength(MAX_COMPETITORS);
  });

  it('上限を超えるときは FlexBubbleTooLargeError を投げる（誤った形の Reply を送らない）', () => {
    const huge: ReportContext = { storeName: '店'.repeat(FLEX_BUBBLE_MAX_BYTES) };
    expect(() => buildComparisonReport(huge, row())).toThrow(FlexBubbleTooLargeError);
  });
});

describe('スナップショット（Flex Message Simulator へ貼って目視する材料）', () => {
  it('比較可能: 評価のない競合を含む', () => {
    expect(buildComparisonReport(STORE, row())).toMatchSnapshot();
  });

  it('自店が未評価', () => {
    expect(
      buildComparisonReport(
        STORE,
        row({
          rating: null,
          review_count: 0,
          rank: null,
          rank_total: null,
          rank_prev: null,
          competitors: [competitor('試験競合A', 4.5, 300, null), competitor('試験競合D', null, 0, null)],
        }),
      ),
    ).toMatchSnapshot();
  });

  it('評価を持つ競合なし（既存データの評価 0 の競合）', () => {
    expect(
      buildComparisonReport(
        STORE,
        normalizeReadRow(rawRow({ rank: 1, rank_total: 2, competitors: [competitor('試験競合D', 0, 0, 4.2)] })),
      ),
    ).toMatchSnapshot();
  });

  it('競合なし', () => {
    expect(
      buildComparisonReport(STORE, row({ status: 'no_competitors', rank: 1, rank_total: 1, competitors: [] })),
    ).toMatchSnapshot();
  });
});
