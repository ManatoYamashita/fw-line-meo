// レポート共通の表示部品の試験（design.md「Report builders（表示）」・Requirements 3.8, 8.1, 8.3）。
// - データ対象日と対象期間の表記が `M月D日` で、実行環境の TZ に依存しないこと
// - 見出しに店舗名（省略しない）とデータ対象日（推移は対象期間）が入ること
// - 帰属表示が同じバブルの footer の末尾に 1 行で入り、文言を改変せず、トークンの色と大きさを使うこと
// - 30KB の検証が JSON の UTF-8 のバイト数で行われ、境界の 30,000 バイトを受理し 30,001 バイトを拒否すること
// - altText が 400 字（UTF-16 の単位）に収まり、末尾の帰属表示が切れないこと
// - 正規化済みの行と、競合比較可能の判定
import { afterEach, describe, expect, it } from 'vitest';
import type { DailySummaryReadRow } from '@fwlm/db';
import { lineColors, lineLayout } from '@fwlm/design-tokens';
import type { FlexBoxComponent, FlexBoxContent, FlexBubbleContents, FlexTextComponent } from '../../src/line/flex-types.js';
import {
  ALT_TEXT_MAX_LENGTH,
  ATTRIBUTION_TEXT,
  FLEX_BUBBLE_MAX_BYTES,
  FlexBubbleTooLargeError,
  attributionFooter,
  buildAttributionText,
  buildReportBubble,
  buildReportHeader,
  codePointLength,
  fitText,
  fitsFlexBubbleLimit,
  flexBubbleByteLength,
  formatDataDate,
  formatDataSpan,
  formatPeriod,
  isComparableRow,
  normalizeReadRow,
  splitGraphemes,
  toReportMessage,
  type ReportDataSpan,
} from '../../src/report/format.js';

const STORE = { storeName: '試験食堂 駅前店' };
const DATE_SPAN: ReportDataSpan = { kind: 'date', date: '2026-09-14' };
const PERIOD_SPAN: ReportDataSpan = { kind: 'period', start: '2026-09-08', end: '2026-09-14' };

// 対になっていない UTF-16 のサロゲート（u フラグを付けずに符号単位で照合する）。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function textAt(box: FlexBoxComponent, index: number): FlexTextComponent {
  const found = box.contents[index];
  if (found === undefined || found.type !== 'text') {
    throw new Error(`${index} 番目に text を期待した`);
  }
  return found;
}

function lastContent(box: FlexBoxComponent): FlexBoxContent {
  const found = box.contents[box.contents.length - 1];
  if (found === undefined) {
    throw new Error('box が空だった');
  }
  return found;
}

// 文字列の中の部分文字列の出現回数（重ならない数え方）。
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

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
      { name: '試験競合A', rating: 4.5, reviewCount: 300, starDiff: -0.3 },
      { name: '試験競合B', rating: 4.0, reviewCount: 80, starDiff: 0.2 },
      { name: '試験競合C', rating: 3.8, reviewCount: 40, starDiff: 0.4 },
    ],
    ...overrides,
  };
}

describe('formatDataDate（8.3）', () => {
  it.each([
    ['2026-09-14', '9月14日'],
    ['2026-01-05', '1月5日'],
    ['2026-12-31', '12月31日'],
    ['2028-02-29', '2月29日'],
    ['2026-07-12', '7月12日'],
  ])('%s を %s と書く（先頭のゼロを付けない）', (date, expected) => {
    expect(formatDataDate(date)).toBe(expected);
  });

  it.each([
    '2026-9-14',
    '2026-02-30',
    '2027-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-09-00',
    '',
    ' 2026-09-14',
    '2026-09-14T00:00:00Z',
    '２０２６-０９-１４',
  ])('暦日として正しくない値（%s）は例外にする（呼出元の誤りを黙って表示しない）', (date) => {
    expect(() => formatDataDate(date)).toThrow();
  });
});

describe('formatPeriod（8.3）', () => {
  it('始点と終点を「〜」でつなぐ', () => {
    expect(formatPeriod('2026-09-08', '2026-09-14')).toBe('9月8日〜9月14日');
  });

  it('年をまたぐ期間も月日で書く（30 日を超える古いデータは表示しないので年は要らない）', () => {
    expect(formatPeriod('2025-12-29', '2026-01-04')).toBe('12月29日〜1月4日');
  });

  it('始点が終点より後なら例外にする', () => {
    expect(() => formatPeriod('2026-09-15', '2026-09-14')).toThrow();
  });

  it('どちらかが暦日として正しくなければ例外にする', () => {
    expect(() => formatPeriod('2026-02-30', '2026-03-05')).toThrow();
    expect(() => formatPeriod('2026-03-01', '2026-03-32')).toThrow();
  });
});

describe('日付の表記は実行環境の TZ に依存しない', () => {
  const originalTz = process.env['TZ'];

  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env['TZ'];
    } else {
      process.env['TZ'] = originalTz;
    }
  });

  // UTC から大きく離れた両端（+14 と -12）と、日本時間・UTC・米国西海岸。
  it.each(['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Etc/GMT+12'])(
    'TZ=%s でも同じ表記になる',
    (tz) => {
      process.env['TZ'] = tz;
      expect(formatDataDate('2026-09-14')).toBe('9月14日');
      expect(formatDataDate('2026-01-01')).toBe('1月1日');
      expect(formatDataDate('2026-12-31')).toBe('12月31日');
      expect(formatPeriod('2025-12-29', '2026-01-04')).toBe('12月29日〜1月4日');
    },
  );

  it('試験の前提: TZ の切り替えが実際にこのプロセスの Date に効いている（空振りの防止）', () => {
    process.env['TZ'] = 'America/Los_Angeles';
    expect(new Date('2026-09-14T00:00:00Z').getDate()).toBe(13);
    process.env['TZ'] = 'Pacific/Kiritimati';
    expect(new Date('2026-09-14T12:00:00Z').getDate()).toBe(15);
  });
});

describe('formatDataSpan', () => {
  it('データ対象日は「M月D日時点のデータ」、対象期間は「M月D日〜M月D日のデータ」と書く', () => {
    expect(formatDataSpan(DATE_SPAN)).toBe('9月14日時点のデータ');
    expect(formatDataSpan(PERIOD_SPAN)).toBe('9月8日〜9月14日のデータ');
  });
});

describe('buildReportHeader（3.8・8.3）', () => {
  it('店舗名を太字で、続けてデータ対象日を置く', () => {
    const header = buildReportHeader(STORE, DATE_SPAN);
    expect(textAt(header, 0).text).toBe(STORE.storeName);
    expect(textAt(header, 0).weight).toBe('bold');
    expect(textAt(header, 1).text).toBe('9月14日時点のデータ');
    expect(header.contents).toHaveLength(2);
  });

  it('推移は対象期間を置く', () => {
    expect(textAt(buildReportHeader(STORE, PERIOD_SPAN), 1).text).toBe('9月8日〜9月14日のデータ');
  });

  it('20 文字を超える店舗名も省略せずに置き、折り返して全文を見せる（3.3・3.9）', () => {
    const longName = 'とても長い名前の試験用のレストラン 本店 東口 二階 奥の個室フロア';
    const name = textAt(buildReportHeader({ storeName: longName }, DATE_SPAN), 0);
    expect(name.text).toBe(longName);
    // 折り返さない text は容器の幅を超えると LINE が省略記号で切るので、店舗名は必ず折り返す。
    expect(name.wrap).toBe(true);
  });

  it('寸法と色はトークンから宣言する', () => {
    const header = buildReportHeader(STORE, DATE_SPAN);
    expect(header.paddingAll).toBe(lineLayout.blockPadding);
    expect(header.paddingBottom).toBe(lineLayout.headerPaddingBottom);
    expect(textAt(header, 0).size).toBe(lineLayout.bodySize);
    expect(textAt(header, 1).size).toBe(lineLayout.descriptionSize);
    expect(textAt(header, 1).color).toBe(lineColors.description);
    expect(textAt(header, 1).wrap).toBe(true);
  });
});

describe('帰属表示の部品（8.1）', () => {
  it('文言は「データ提供: Google Maps」そのものである（改変しない・改行を含まない）', () => {
    expect(ATTRIBUTION_TEXT).toBe('データ提供: Google Maps');
    expect(buildAttributionText().text).toBe(ATTRIBUTION_TEXT);
    expect(ATTRIBUTION_TEXT).not.toMatch(/[\r\n]/);
  });

  it('大きさは帰属表示のトークン、色は帰属表示のトークンである（caption と muted ではない）', () => {
    const attribution = buildAttributionText();
    expect(attribution.size).toBe(lineLayout.attributionSize);
    expect(attribution.color).toBe(lineColors.attribution);
    expect(attribution.size).not.toBe(lineLayout.captionSize);
    expect(attribution.color).not.toBe(lineColors.muted);
  });

  it('折り返さない（1 行で表示する）。自動の縮小など、大きさを変える指定を持たない', () => {
    const attribution = buildAttributionText();
    expect(attribution.wrap).toBe(false);
    // 鍵の集合を固定する。shrink-to-fit（adjustMode）は 12sp を下回る大きさへ縮めうる。
    expect(Object.keys(attribution).sort()).toEqual(['align', 'color', 'size', 'text', 'type', 'wrap']);
  });

  it('footer の末尾（同じバブルの下端）に 1 つだけ置き、渡した部品はその上に順に並べる', () => {
    const link: FlexTextComponent = { type: 'text', text: '詳細画面で見る' };
    const note: FlexTextComponent = { type: 'text', text: '注記' };
    const footer = attributionFooter([link, note]);
    expect(footer.contents).toEqual([link, note, buildAttributionText()]);
    expect(footer.layout).toBe('vertical');
    expect(footer.paddingAll).toBe(lineLayout.blockPadding);
    expect(footer.spacing).toBe(lineLayout.itemGap);
  });

  it('部品を渡さなければ、帰属表示だけの footer になる', () => {
    expect(attributionFooter().contents).toEqual([buildAttributionText()]);
  });
});

describe('buildReportBubble（3.8・8.1・8.3）', () => {
  const body: FlexBoxContent[] = [{ type: 'text', text: '本文の試験用の部品', wrap: true }];

  it('kilo のバブルに、見出し・本文・帰属表示の footer を組み、footer の上に区切り線を引く', () => {
    const bubble = buildReportBubble({ ctx: STORE, span: DATE_SPAN, body });
    expect(bubble.type).toBe('bubble');
    expect(bubble.size).toBe(lineLayout.bubbleSize);
    expect(bubble.styles?.footer?.separator).toBe(true);
    expect(bubble.header).toEqual(buildReportHeader(STORE, DATE_SPAN));
    expect(bubble.footer).toEqual(attributionFooter());
  });

  it('本文は渡した部品を順に並べ、header・footer と同じ内側余白を宣言する（design-language.md §7.14）', () => {
    const bubble = buildReportBubble({ ctx: STORE, span: DATE_SPAN, body });
    expect(bubble.body.contents).toEqual(body);
    expect(bubble.body.layout).toBe('vertical');
    expect(bubble.body.paddingAll).toBe(lineLayout.blockPadding);
    expect(bubble.body.spacing).toBe(lineLayout.sectionGap);
  });

  it('footer の部品は帰属表示の上に置く', () => {
    const link: FlexTextComponent = { type: 'text', text: '詳細画面で見る' };
    const bubble = buildReportBubble({ ctx: STORE, span: PERIOD_SPAN, body, footerContents: [link] });
    expect(bubble.footer).toEqual(attributionFooter([link]));
  });

  it('帰属表示はバブル全体でちょうど 1 回、footer の最後の部品として 1 行で入る', () => {
    const bubble = buildReportBubble({ ctx: STORE, span: DATE_SPAN, body });
    const json = JSON.stringify(bubble);
    expect(occurrences(json, ATTRIBUTION_TEXT)).toBe(1);
    // 「Google Maps」が別の部品へ分かれていない（1 つの text に収まっている）。
    expect(occurrences(json, 'Google Maps')).toBe(1);
    const last = lastContent(bubble.footer);
    expect(last).toEqual(buildAttributionText());
  });

  it('店舗名とデータ対象日が、同じバブルの見出しに入る', () => {
    const json = JSON.stringify(buildReportBubble({ ctx: STORE, span: DATE_SPAN, body }).header);
    expect(json).toContain(STORE.storeName);
    expect(json).toContain('9月14日');
  });
});

describe('30KB の検証', () => {
  // 見出し・footer を含む実際のバブルに、本文の text を 1 つだけ足した形。
  function bubbleWithFiller(filler: string): FlexBubbleContents {
    return buildReportBubble({ ctx: STORE, span: DATE_SPAN, body: [{ type: 'text', text: filler }] });
  }

  it('上限は 30,000 バイトである（30 KB の定義が 30,000 と 30,720 のどちらでも超えない側）', () => {
    expect(FLEX_BUBBLE_MAX_BYTES).toBe(30_000);
  });

  it('大きさは JSON の UTF-8 のバイト数で数える（仮名は 3 バイト、BMP の外の文字は 4 バイト）', () => {
    const ascii = flexBubbleByteLength(bubbleWithFiller('a'.repeat(100)));
    expect(flexBubbleByteLength(bubbleWithFiller('あ'.repeat(100))) - ascii).toBe(200);
    expect(flexBubbleByteLength(bubbleWithFiller('\u{1F363}'.repeat(100))) - ascii).toBe(300);
  });

  it('大きさは JSON に直した後の長さである（引用符などの escape を含む）', () => {
    const plain = flexBubbleByteLength(bubbleWithFiller('a'.repeat(10)));
    // `"` は JSON で `\"` の 2 バイトになる。
    expect(flexBubbleByteLength(bubbleWithFiller('"'.repeat(10))) - plain).toBe(10);
  });

  it('ちょうど 30,000 バイトは受理し、30,001 バイトは拒否する', () => {
    const base = flexBubbleByteLength(bubbleWithFiller(''));
    const exact = bubbleWithFiller('a'.repeat(FLEX_BUBBLE_MAX_BYTES - base));
    const over = bubbleWithFiller('a'.repeat(FLEX_BUBBLE_MAX_BYTES - base + 1));
    expect(flexBubbleByteLength(exact)).toBe(FLEX_BUBBLE_MAX_BYTES);
    expect(fitsFlexBubbleLimit(exact)).toBe(true);
    expect(fitsFlexBubbleLimit(over)).toBe(false);
    expect(toReportMessage('試験の代替テキスト', exact).type).toBe('flex');
    expect(() => toReportMessage('試験の代替テキスト', over)).toThrow(FlexBubbleTooLargeError);
  });

  it('超過の例外は大きさと上限を持つ', () => {
    const base = flexBubbleByteLength(bubbleWithFiller(''));
    const over = bubbleWithFiller('a'.repeat(FLEX_BUBBLE_MAX_BYTES - base + 5));
    let caught: unknown;
    try {
      toReportMessage('試験の代替テキスト', over);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FlexBubbleTooLargeError);
    if (!(caught instanceof FlexBubbleTooLargeError)) throw new Error('unreachable');
    expect(caught.sizeBytes).toBe(FLEX_BUBBLE_MAX_BYTES + 5);
    expect(caught.limitBytes).toBe(FLEX_BUBBLE_MAX_BYTES);
  });
});

describe('toReportMessage の altText', () => {
  const bubble = buildReportBubble({ ctx: STORE, span: DATE_SPAN, body: [{ type: 'text', text: '本文' }] });
  const SUFFIX = `（${ATTRIBUTION_TEXT}）`;

  function altTextOf(altText: string): string {
    const message = toReportMessage(altText, bubble);
    if (message.type !== 'flex') throw new Error('flex を期待した');
    expect(message.contents).toBe(bubble);
    return message.altText;
  }

  it('渡した本文の末尾に帰属表示を付ける', () => {
    expect(altTextOf('試験食堂 駅前店の新着口コミ（9月14日時点）')).toBe(`試験食堂 駅前店の新着口コミ（9月14日時点）${SUFFIX}`);
  });

  it('上限は 400 字である', () => {
    expect(ALT_TEXT_MAX_LENGTH).toBe(400);
  });

  it('長い本文は 400 字（UTF-16 の単位）に収め、帰属表示は切らずに残す', () => {
    const altText = altTextOf('あ'.repeat(1000));
    expect(altText.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
    expect(altText.endsWith(`…${SUFFIX}`)).toBe(true);
    expect(altText.length).toBe(ALT_TEXT_MAX_LENGTH);
  });

  it('BMP の外の文字を 2 単位と数え、サロゲートペアを割らない', () => {
    const altText = altTextOf('\u{1F363}'.repeat(400));
    expect(altText.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
    expect(LONE_SURROGATE.test(altText)).toBe(false);
    expect(altText.endsWith(SUFFIX)).toBe(true);
  });

  it('ちょうど収まる本文はそのまま使う', () => {
    const body = 'あ'.repeat(ALT_TEXT_MAX_LENGTH - SUFFIX.length);
    expect(altTextOf(body)).toBe(`${body}${SUFFIX}`);
  });

  it('本文が空なら例外にする（何のメッセージか分からない altText を送らない）', () => {
    expect(() => toReportMessage('', bubble)).toThrow();
  });
});

describe('文字数の道具', () => {
  it('codePointLength はコードポイントで数える', () => {
    expect(codePointLength('')).toBe(0);
    expect(codePointLength('あいう')).toBe(3);
    expect(codePointLength('\u{20BB7}')).toBe(1);
  });

  it('splitGraphemes は書記素に分ける（絵文字の連結・国旗・結合文字を 1 つとして扱う）', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(splitGraphemes(`あ${family}\u{1F1EF}\u{1F1F5}が`)).toEqual(['あ', family, '\u{1F1EF}\u{1F1F5}', 'が']);
    expect(splitGraphemes('')).toEqual([]);
  });

  it('fitText は上限以内ならそのまま返し、超えれば書記素の境目で切って「…」を付ける', () => {
    expect(fitText('あいう', 3)).toBe('あいう');
    expect(fitText('あいうえ', 3)).toBe('あい…');
  });

  it('fitText の数え方を差し替えられる（UTF-16 の単位で数えると BMP の外の文字は 2 になる）', () => {
    const sushi = '\u{1F363}';
    expect(fitText(sushi.repeat(3), 3)).toBe(sushi.repeat(3));
    expect(fitText(sushi.repeat(3), 3, (text) => text.length)).toBe(`${sushi}…`);
  });

  it('fitText の上限が 1 未満か整数でなければ例外にする（「…」だけでも上限を超える）', () => {
    expect(() => fitText('あいう', 0)).toThrow();
    expect(() => fitText('あいう', 1.5)).toThrow();
    expect(fitText('あいう', 1)).toBe('…');
  });
});

describe('スナップショット（Flex Message Simulator へ貼って目視する材料）', () => {
  it('共通の部品だけで組んだレポートのメッセージ（本文は試験用の 1 行）', () => {
    const bubble = buildReportBubble({
      ctx: STORE,
      span: PERIOD_SPAN,
      body: [{ type: 'text', text: '本文の試験用の部品', wrap: true }],
      footerContents: [{ type: 'text', text: '詳細画面への導線の試験用の部品' }],
    });
    expect(toReportMessage('試験食堂 駅前店の試験用のレポート', bubble)).toMatchSnapshot();
  });
});

describe('normalizeReadRow と isComparableRow', () => {
  it('normalizeReadRow は #255 の正規化を通し、他の項目はそのまま残す', () => {
    // 旧 Go の行: 評価 0 の競合が最下位に数えられ、母数が 1 つ多い。
    const legacy = rawRow({
      rank: 2,
      rank_total: 4,
      competitors: [
        { name: '試験競合A', rating: 4.5, reviewCount: 300, starDiff: -0.3 },
        { name: '試験競合B', rating: 4.0, reviewCount: 80, starDiff: 0.2 },
        { name: '試験競合C', rating: 0, reviewCount: 0, starDiff: 4.2 },
      ],
      new_reviews: [{ authorName: '試験投稿者', publishTime: '2026-09-13T01:00:00Z', rating: 5, textExcerpt: '試験の本文' }],
    });
    const row = normalizeReadRow(legacy);
    expect(row.rank_total).toBe(3);
    expect(row.competitors[2]).toEqual({ name: '試験競合C', rating: null, reviewCount: 0, starDiff: null });
    expect(row.summary_date).toBe('2026-09-14');
    expect(row.new_reviews).toEqual(legacy.new_reviews);
    expect(row.new_review_count).toBe(2);
    expect(row.review_count_prev).toBe(118);
  });

  it('比較可能は「取得失敗でなく、順位があり、母数が 2 以上」', () => {
    expect(isComparableRow(normalizeReadRow(rawRow()))).toBe(true);
    expect(isComparableRow(normalizeReadRow(rawRow({ rank: 1, rank_total: 2 })))).toBe(true);
  });

  it.each<[string, Partial<DailySummaryReadRow>]>([
    ['取得失敗', { status: 'failed', rank: null, rank_total: null, rating: null }],
    ['取得失敗（順位の列が残っていても）', { status: 'failed' }],
    ['競合なし（自店だけの 1 店中 1 位）', { status: 'no_competitors', rank: 1, rank_total: 1, competitors: [] }],
    ['評価を持つ競合なし（母数 1）', { rank: 1, rank_total: 1 }],
    ['自店が未評価', { rating: null, rank: null, rank_total: null }],
    ['自店が旧 Go の評価 0', { rating: '0.0', rank: 3, rank_total: 4 }],
  ])('%s は比較可能でない', (_label, overrides) => {
    expect(isComparableRow(normalizeReadRow(rawRow(overrides)))).toBe(false);
  });

  it('旧 Go の評価 0 の競合を除くと母数が 1 になる行は、比較可能でない', () => {
    const legacy = rawRow({
      rank: 1,
      rank_total: 2,
      competitors: [{ name: '試験競合C', rating: 0, reviewCount: 0, starDiff: 4.2 }],
    });
    expect(isComparableRow(normalizeReadRow(legacy))).toBe(false);
  });
});
