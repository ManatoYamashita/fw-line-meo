// 通知の判定と組立（line-on-demand-report tasks 4.1・Requirements 1.1〜1.6, 8.1）の単体試験。
//
// 入力は Issue #255 の正規化（@fwlm/db/daily-summary の normalizeSummaryRatings）を通した行である。
// 試験も生の行を作ってから同じ正規化を通し、未評価の扱いを本モジュールの外の規則だけで決める。
// 店舗名・競合名はすべて架空である。

import { describe, expect, it } from 'vitest';
import type { DailySummaryCompetitor, DailySummaryStatus } from '@fwlm/db';
import { normalizeSummaryRatings } from '@fwlm/db/daily-summary';
import { lineColors, lineLayout } from '@fwlm/design-tokens';
import { REPORT_LABELS } from '@fwlm/line-report';
import {
  ALT_TEXT_MAX_LENGTH,
  FlexBubbleTooLargeError,
  buildChangeNotification,
  decideNotification,
  isComparable,
  type NotificationDecision,
  type NotificationSubject,
  type NotificationToday,
  type NotifiedChanges,
} from '../src/notification.js';

const STORE_NAME = 'テスト食堂 駅前店';
const ATTRIBUTION = 'データ提供: Google Maps';
const ALT_ATTRIBUTION = `（${ATTRIBUTION}）`;

/** LINE のバブルの上限。30 KB の小さい方の読み（30,000 バイト）で固定する。 */
const BUBBLE_LIMIT_BYTES = 30_000;

// --- 行の組立 ------------------------------------------------------------------------

/** 日次集計の行のうち、判定が読む列と、判定が読んではならない列（rank_prev）を持つ形。 */
interface SummaryRow {
  readonly status: DailySummaryStatus;
  readonly rating: string | null;
  readonly rating_prev: string | null;
  readonly rank: number | null;
  readonly rank_total: number | null;
  readonly rank_prev: number | null;
  readonly review_count_prev: number | null;
  readonly new_review_count: number;
  readonly competitors: readonly DailySummaryCompetitor[];
}

const RATED_COMPETITORS: readonly DailySummaryCompetitor[] = [
  { name: '架空の喫茶A', rating: 4.5, reviewCount: 200, starDiff: -0.3 },
  { name: '架空の喫茶B', rating: 4.0, reviewCount: 60, starDiff: 0.2 },
  { name: '架空の喫茶C', rating: 3.9, reviewCount: 80, starDiff: 0.3 },
];

/** 正規化を通した行。既定は「自店 ★4.2・近隣 4 店中 2 位・前日の集計あり・新着なし」。 */
function row(overrides: Partial<SummaryRow> = {}): SummaryRow {
  const raw: SummaryRow = {
    status: 'ready',
    rating: '4.2',
    rating_prev: '4.1',
    rank: 2,
    rank_total: 4,
    rank_prev: 2,
    review_count_prev: 120,
    new_review_count: 0,
    competitors: RATED_COMPETITORS,
    ...overrides,
  };
  return { ...raw, ...normalizeSummaryRatings(raw) };
}

/** 前日の行（判定は status・rank・rank_total だけを読む）。 */
function yesterdayRow(overrides: Partial<SummaryRow> = {}): NotificationSubject {
  return row(overrides);
}

function notifyChanges(decision: NotificationDecision): NotifiedChanges {
  if (decision.kind !== 'notify') {
    throw new Error(`expected notify, got skip (${decision.reason})`);
  }
  return decision.changes;
}

// --- Flex の走査 ---------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** JSON の木のすべての節（オブジェクト）を集める。構造の位置に依らない検査に使う。 */
function collectNodes(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    return node.flatMap(collectNodes);
  }
  if (!isRecord(node)) {
    return [];
  }
  return [node, ...Object.values(node).flatMap(collectNodes)];
}

function textsOf(node: unknown): string[] {
  return collectNodes(node)
    .filter((n) => n.type === 'text' && typeof n.text === 'string')
    .map((n) => n.text as string);
}

function bytesOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

// 対になっていない UTF-16 のサロゲート（altText を途中で割ったときに生じる）。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

// =====================================================================================
// isComparable
// =====================================================================================

describe('isComparable（競合比較可能）', () => {
  it.each<[string, NotificationSubject, boolean]>([
    ['取得できていて母数 4 の 2 位', { status: 'ready', rank: 2, rank_total: 4 }, true],
    ['母数 2（下限）', { status: 'ready', rank: 1, rank_total: 2 }, true],
    ['母数 1（評価を持つ競合がいない）', { status: 'ready', rank: 1, rank_total: 1 }, false],
    ['競合なし（1 店中 1 位）', { status: 'no_competitors', rank: 1, rank_total: 1 }, false],
    ['順位が無い（自店が未評価）', { status: 'ready', rank: null, rank_total: null }, false],
    ['母数だけが無い', { status: 'ready', rank: 2, rank_total: null }, false],
    ['順位だけが無い', { status: 'ready', rank: null, rank_total: 4 }, false],
    ['取得失敗（順位の値が残っていても）', { status: 'failed', rank: 2, rank_total: 4 }, false],
  ])('%s → %s', (_label, subject, expected) => {
    expect(isComparable(subject)).toBe(expected);
  });
});

// =====================================================================================
// decideNotification（規則表の全分岐）
// =====================================================================================

describe('decideNotification: 当日が比較可能でない（1.5）', () => {
  // どの行も、比較可能でさえあれば新着と順位変動の両方が成り立つ材料を持たせる。判定が比較可能性より
  // 先に変化を見る誤りを、「送ってしまう」形で捕まえるため。
  const changedYesterday = yesterdayRow({ rank: 3, rank_total: 4 });

  it('当日の自店の取得失敗は not_comparable', () => {
    const today = row({ status: 'failed', rating: null, rank: null, rank_total: null, new_review_count: 2 });
    expect(decideNotification(today, changedYesterday)).toEqual({ kind: 'skip', reason: 'not_comparable' });
  });

  it('当日が取得失敗なら、順位の値が残っていても not_comparable', () => {
    const today: NotificationToday = {
      status: 'failed',
      rank: 2,
      rank_total: 4,
      review_count_prev: 120,
      new_review_count: 2,
    };
    expect(decideNotification(today, changedYesterday)).toEqual({ kind: 'skip', reason: 'not_comparable' });
  });

  it('競合なし（1 店中 1 位）は not_comparable', () => {
    const today = row({ status: 'no_competitors', rank: 1, rank_total: 1, competitors: [], new_review_count: 2 });
    expect(decideNotification(today, yesterdayRow({ rank: 2, rank_total: 4 }))).toEqual({
      kind: 'skip',
      reason: 'not_comparable',
    });
  });

  it('評価を持つ競合がいない日（評価 0 の旧来の競合だけ）は、正規化で母数 1 になり not_comparable', () => {
    // 旧 Go は評価の無い競合を評価 0 として比較集合の最下位に数えていた（1 位・母数 3）。
    const today = row({
      rank: 1,
      rank_total: 3,
      new_review_count: 2,
      competitors: [
        { name: '架空の新店D', rating: 0, reviewCount: 0, starDiff: 4.2 },
        { name: '架空の新店E', rating: 0, reviewCount: 0, starDiff: 4.2 },
      ],
    });
    expect(today.rank_total).toBe(1);
    expect(decideNotification(today, yesterdayRow({ rank: 2, rank_total: 4 }))).toEqual({
      kind: 'skip',
      reason: 'not_comparable',
    });
  });

  it('自店が未評価（評価 0 の旧来の行）は、正規化で順位が消え not_comparable', () => {
    const today = row({ rating: '0.0', rank: 3, rank_total: 4, new_review_count: 2 });
    expect(today.rank).toBeNull();
    expect(decideNotification(today, changedYesterday)).toEqual({ kind: 'skip', reason: 'not_comparable' });
  });

  it('自店が未評価（評価 null）も not_comparable', () => {
    const today = row({ rating: null, rank: null, rank_total: null, new_review_count: 2 });
    expect(decideNotification(today, changedYesterday)).toEqual({ kind: 'skip', reason: 'not_comparable' });
  });
});

describe('decideNotification: 前日の集計が無い・使えない（1.4）', () => {
  it('前日の行が無く、前日の自店の値も無ければ no_change', () => {
    const today = row({ review_count_prev: null, rating_prev: null, rank_prev: null, new_review_count: 0 });
    expect(decideNotification(today, null)).toEqual({ kind: 'skip', reason: 'no_change' });
  });

  it('前日の自店の値（review_count_prev）が無ければ、新着件数が 1 以上でも新着として扱わない', () => {
    // 新着は前日の集計から増えた口コミである（4.7）。前日が無い日の件数は判定の根拠にならない。
    const today = row({ review_count_prev: null, rating_prev: null, rank_prev: null, new_review_count: 2 });
    expect(decideNotification(today, null)).toEqual({ kind: 'skip', reason: 'no_change' });
  });

  it('前日の行が取得失敗なら順位変動にしない（順位の値が残っていても）', () => {
    const today = row({ rank: 2, review_count_prev: null, new_review_count: 0 });
    const failedYesterday: NotificationSubject = { status: 'failed', rank: 3, rank_total: 4 };
    expect(decideNotification(today, failedYesterday)).toEqual({ kind: 'skip', reason: 'no_change' });
  });

  it('前日の行が取得失敗（順位なし）で、前日の自店の値も無ければ no_change', () => {
    const today = row({ rank: 2, review_count_prev: null, new_review_count: 2 });
    const failedYesterday: NotificationSubject = { status: 'failed', rank: null, rank_total: null };
    expect(decideNotification(today, failedYesterday)).toEqual({ kind: 'skip', reason: 'no_change' });
  });

  it('前日が未評価（正規化で前日の順位が消える）なら順位変動にしない', () => {
    const yesterday = yesterdayRow({ rating: null, rank: 3, rank_total: 4 });
    expect(yesterday.rank).toBeNull();
    expect(decideNotification(row({ rank: 2, new_review_count: 0 }), yesterday)).toEqual({
      kind: 'skip',
      reason: 'no_change',
    });
  });

  it('前日が未評価でも、前日の自店の値があれば新着だけを知らせる', () => {
    const yesterday = yesterdayRow({ rating: '0.0', rank: 3, rank_total: 4 });
    const today = row({ rank: 2, review_count_prev: 0, new_review_count: 1 });
    expect(notifyChanges(decideNotification(today, yesterday))).toEqual({ newReviewCount: 1, rank: null });
  });

  it('前日の母数が 1（評価を持つ競合がいない日）なら順位変動にしない', () => {
    const yesterday = yesterdayRow({ rank: 1, rank_total: 1 });
    expect(decideNotification(row({ rank: 2, new_review_count: 0 }), yesterday)).toEqual({
      kind: 'skip',
      reason: 'no_change',
    });
  });

  it('前日の行が無くても、前日の自店の値（review_count_prev）があれば新着だけを知らせる', () => {
    // 新着の判定の根拠は review_count_prev である（新着口コミのレポートの 4.8 の判定と同じ）。
    // 前日の行が無いので順位変動にはしない。
    const today = row({ rank: 2, review_count_prev: 118, new_review_count: 2 });
    expect(notifyChanges(decideNotification(today, null))).toEqual({ newReviewCount: 2, rank: null });
  });
});

describe('decideNotification: 変化の有無（1.1〜1.4）', () => {
  it('順位が同じで新着が 0 件なら no_change', () => {
    expect(decideNotification(row({ rank: 2, new_review_count: 0 }), yesterdayRow({ rank: 2 }))).toEqual({
      kind: 'skip',
      reason: 'no_change',
    });
  });

  it('順位が同じなら、母数が変わっても順位変動にしない', () => {
    const today = row({ rank: 3, rank_total: 4, new_review_count: 0 });
    expect(decideNotification(today, yesterdayRow({ rank: 3, rank_total: 5 }))).toEqual({
      kind: 'skip',
      reason: 'no_change',
    });
  });

  it('新着だけ（1.1）', () => {
    const today = row({ rank: 2, review_count_prev: 120, new_review_count: 3 });
    expect(notifyChanges(decideNotification(today, yesterdayRow({ rank: 2 })))).toEqual({
      newReviewCount: 3,
      rank: null,
    });
  });

  it('順位だけ・上昇（1.2）', () => {
    const today = row({ rank: 2, new_review_count: 0 });
    expect(notifyChanges(decideNotification(today, yesterdayRow({ rank: 3 })))).toEqual({
      newReviewCount: null,
      rank: { from: 3, to: 2 },
    });
  });

  it('順位だけ・下降（1.2）', () => {
    const today = row({ rank: 2, new_review_count: 0 });
    expect(notifyChanges(decideNotification(today, yesterdayRow({ rank: 1 })))).toEqual({
      newReviewCount: null,
      rank: { from: 1, to: 2 },
    });
  });

  it('両方を 1 つの通知にまとめる（1.3）', () => {
    const today = row({ rank: 2, review_count_prev: 118, new_review_count: 2 });
    expect(notifyChanges(decideNotification(today, yesterdayRow({ rank: 3 })))).toEqual({
      newReviewCount: 2,
      rank: { from: 3, to: 2 },
    });
  });
});

describe('decideNotification: 順位変動は前日の行の順位を採り、当日の行の rank_prev を使わない', () => {
  // rank_prev は Go が当日の競合集合で前日の値を計算し直したもので、オーナーが前日のレポートで見た順位と
  // 食い違いうる。判定と文言は、前日の行の rank（前日のレポートの順位）と当日の rank を比べる。

  it('再計算値は「変動なし」でも、前日の行の順位と違えば順位変動として知らせる', () => {
    const today = row({ rank: 2, rank_prev: 2, new_review_count: 0 });
    const yesterday = yesterdayRow({ rank: 3 });
    const changes = notifyChanges(decideNotification(today, yesterday));
    expect(changes).toEqual({ newReviewCount: null, rank: { from: 3, to: 2 } });
    expect(textsOf(buildChangeNotification(STORE_NAME, changes).contents)).toContain(
      `「${STORE_NAME}」の近隣での順位が3位から2位に上がりました。`,
    );
  });

  it('再計算値が違っても、前日の行の順位と同じなら知らせない', () => {
    const today = row({ rank: 2, rank_prev: 4, new_review_count: 0 });
    expect(today.rank_prev).toBe(4);
    expect(decideNotification(today, yesterdayRow({ rank: 2 }))).toEqual({ kind: 'skip', reason: 'no_change' });
  });

  it('再計算値と前日の行の順位が両方とも当日と違うとき、起点は前日の行の順位', () => {
    const today = row({ rank: 2, rank_prev: 5, review_count_prev: 118, new_review_count: 2 });
    const changes = notifyChanges(decideNotification(today, yesterdayRow({ rank: 1 })));
    expect(changes.rank).toEqual({ from: 1, to: 2 });
    const message = buildChangeNotification(STORE_NAME, changes);
    expect(message.altText).toContain('1位から2位に下がりました');
    expect(message.altText).not.toContain('5位');
  });
});

// =====================================================================================
// buildChangeNotification（1.6・8.1）
// =====================================================================================

const MENU_NEW_REVIEWS = `「${REPORT_LABELS.new_reviews}」`;
const MENU_COMPARISON = `「${REPORT_LABELS.comparison}」`;

describe('buildChangeNotification: 文', () => {
  it.each<[string, NotifiedChanges, string, string]>([
    [
      '新着だけ',
      { newReviewCount: 3, rank: null },
      `「${STORE_NAME}」で新着口コミが3件ありました。`,
      `メニューの${MENU_NEW_REVIEWS}からご確認いただけます。`,
    ],
    [
      '順位だけ・上昇',
      { newReviewCount: null, rank: { from: 3, to: 2 } },
      `「${STORE_NAME}」の近隣での順位が3位から2位に上がりました。`,
      `メニューの${MENU_COMPARISON}からご確認いただけます。`,
    ],
    [
      '順位だけ・下降',
      { newReviewCount: null, rank: { from: 2, to: 4 } },
      `「${STORE_NAME}」の近隣での順位が2位から4位に下がりました。`,
      `メニューの${MENU_COMPARISON}からご確認いただけます。`,
    ],
    [
      '両方',
      { newReviewCount: 2, rank: { from: 3, to: 2 } },
      `「${STORE_NAME}」で新着口コミが2件あり、近隣での順位が3位から2位に上がりました。`,
      `メニューの${MENU_NEW_REVIEWS}${MENU_COMPARISON}からご確認いただけます。`,
    ],
  ])('%s: 本文は店舗名と変化の 1 文と、メニューの導線の 1 文', (_label, changes, first, second) => {
    const message = buildChangeNotification(STORE_NAME, changes);
    const bodyTexts = textsOf(message.contents.body);
    expect(bodyTexts).toEqual([first, second]);
    // 1〜2 文（1.6）: 本文の文は 2 つで、それぞれ 1 文である。
    expect(bodyTexts.join('').split('。').filter((s) => s.length > 0)).toHaveLength(2);
    // altText は同じ 2 文と帰属表示。
    expect(message.altText).toBe(`${first}${second}${ALT_ATTRIBUTION}`);
  });

  it('メニューの導線の語は、リッチメニューのラベル（REPORT_LABELS）と一致する', () => {
    const both = buildChangeNotification(STORE_NAME, { newReviewCount: 1, rank: { from: 2, to: 1 } });
    const guide = textsOf(both.contents.body)[1];
    expect(guide).toContain(REPORT_LABELS.new_reviews);
    expect(guide).toContain(REPORT_LABELS.comparison);
    expect(guide).not.toContain(REPORT_LABELS.trend);
  });

  it('毎日の定期配信を約束する語を含まない', () => {
    const message = buildChangeNotification(STORE_NAME, { newReviewCount: 2, rank: { from: 3, to: 2 } });
    const all = [...textsOf(message.contents), message.altText].join('\n');
    for (const word of ['毎日', '毎朝', '日次', '定期']) {
      expect(all).not.toContain(word);
    }
  });
});

describe('buildChangeNotification: 帰属表示とバブルの形（8.1）', () => {
  const message = buildChangeNotification(STORE_NAME, { newReviewCount: 2, rank: { from: 3, to: 2 } });

  it('Flex のメッセージで、kilo のバブルに見出しを持たず、footer の上に線を引く', () => {
    expect(message.type).toBe('flex');
    expect(message.contents.type).toBe('bubble');
    expect(message.contents.size).toBe(lineLayout.bubbleSize);
    expect(message.contents.styles).toEqual({ footer: { separator: true } });
    expect('header' in message.contents).toBe(false);
  });

  it('footer は帰属表示の text 部品 1 つだけ（レポートと同じ書式）', () => {
    const footer = message.contents.footer;
    expect(footer.contents).toHaveLength(1);
    expect(footer.contents[0]).toEqual({
      type: 'text',
      text: ATTRIBUTION,
      size: lineLayout.attributionSize,
      color: lineColors.attribution,
      wrap: false,
      align: 'center',
    });
  });

  it('帰属表示の大きさと色は帰属のトークン（caption・muted ではない）', () => {
    const attribution = collectNodes(message.contents).filter((n) => n.type === 'text' && n.text === ATTRIBUTION);
    expect(attribution).toHaveLength(1);
    expect(attribution[0]?.size).toBe(lineLayout.attributionSize);
    expect(attribution[0]?.color).toBe(lineColors.attribution);
    expect(attribution[0]?.size).not.toBe(lineLayout.captionSize);
    expect(attribution[0]?.color).not.toBe(lineColors.muted);
  });

  it('ボタンも操作も置かない（誘導先はリッチメニュー）', () => {
    const nodes = collectNodes(message.contents);
    expect(nodes.filter((n) => n.type === 'button')).toHaveLength(0);
    expect(nodes.filter((n) => 'action' in n)).toHaveLength(0);
    // 部品は本文の 2 つの文と帰属表示の 3 つだけ（type を持たない styles の節は数えない）。
    const components = nodes.filter((n) => typeof n.type === 'string' && n.type !== 'box' && n.type !== 'bubble');
    expect(components.map((n) => n.type)).toEqual(['text', 'text', 'text']);
  });

  it('本文の 2 つの文は折り返し、段と色で主従を分ける', () => {
    const [first, second] = message.contents.body.contents;
    expect(first).toMatchObject({ size: lineLayout.bodySize, color: lineColors.body, wrap: true });
    expect(second).toMatchObject({ size: lineLayout.descriptionSize, color: lineColors.description, wrap: true });
  });

  it('altText の末尾に帰属表示を付ける', () => {
    expect(message.altText.endsWith(ALT_ATTRIBUTION)).toBe(true);
  });
});

describe('buildChangeNotification: 上限（altText 400・バブル 30KB）', () => {
  const changes: NotifiedChanges = { newReviewCount: 12, rank: { from: 10, to: 9 } };

  it('短い店舗名では altText を切らない', () => {
    const message = buildChangeNotification(STORE_NAME, changes);
    expect(message.altText.length).toBeLessThan(ALT_TEXT_MAX_LENGTH);
    expect(message.altText).not.toContain('…');
  });

  it('長い店舗名では altText の店舗名だけを縮め、変化・導線・帰属表示を切らない', () => {
    // BMP の外の漢字（UTF-16 で 2 単位）を混ぜ、UTF-16 の単位で数えていることと、サロゲートを割らないことを確かめる。
    // 先頭の「架空」の 2 単位は、UTF-16 の単位でそのまま切ると店舗名の枠の末尾がサロゲートの組の途中に
    // 来るように置いている（書記素の境目で切らない実装を、対になっていないサロゲートとして捕まえる）。
    const longName = `架空${'𠮷野の架空の料理店'.repeat(60)}`;
    expect(longName.length).toBeGreaterThan(ALT_TEXT_MAX_LENGTH);
    const message = buildChangeNotification(longName, changes);

    expect(ALT_TEXT_MAX_LENGTH).toBe(400);
    expect(message.altText.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
    expect(message.altText.length).toBeGreaterThan(ALT_TEXT_MAX_LENGTH - 5);
    expect(message.altText).not.toMatch(LONE_SURROGATE);
    expect(message.altText.startsWith('「架空𠮷野の架空の料理店')).toBe(true);
    expect(message.altText).toContain('…」で新着口コミが12件あり、近隣での順位が10位から9位に上がりました。');
    expect(message.altText.endsWith(`メニューの${MENU_NEW_REVIEWS}${MENU_COMPARISON}からご確認いただけます。${ALT_ATTRIBUTION}`)).toBe(
      true,
    );

    // バブルの本文では店舗名を省略しない（3.8・3.9）。
    expect(textsOf(message.contents.body)[0]).toBe(
      `「${longName}」で新着口コミが12件あり、近隣での順位が10位から9位に上がりました。`,
    );
    expect(bytesOf(message.contents)).toBeLessThanOrEqual(BUBBLE_LIMIT_BYTES);
  });

  it('現実的に最も長い店舗名でもバブルは 30KB に収まる', () => {
    const message = buildChangeNotification('架空'.repeat(500), changes);
    expect(bytesOf(message.contents)).toBeLessThanOrEqual(BUBBLE_LIMIT_BYTES);
  });

  it('バブルが 30KB を超える店舗名では FlexBubbleTooLargeError を投げる（壊れたメッセージを送らない）', () => {
    expect(() => buildChangeNotification('架'.repeat(10_500), changes)).toThrow(FlexBubbleTooLargeError);
  });
});

describe('buildChangeNotification: 呼出元の誤り', () => {
  it.each<[string, string, NotifiedChanges]>([
    ['変化が 1 つも無い', STORE_NAME, { newReviewCount: null, rank: null }],
    ['新着件数が 0', STORE_NAME, { newReviewCount: 0, rank: null }],
    ['新着件数が整数でない', STORE_NAME, { newReviewCount: 1.5, rank: null }],
    ['順位が変わっていない', STORE_NAME, { newReviewCount: null, rank: { from: 2, to: 2 } }],
    ['順位が 1 未満', STORE_NAME, { newReviewCount: null, rank: { from: 0, to: 2 } }],
    ['店舗名が空', '', { newReviewCount: 1, rank: null }],
  ])('%s なら例外にする', (_label, storeName, changes) => {
    expect(() => buildChangeNotification(storeName, changes)).toThrow(Error);
  });
});
