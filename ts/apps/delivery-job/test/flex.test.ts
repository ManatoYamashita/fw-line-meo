import { describe, expect, it } from 'vitest';
import type { DailySummaryCompetitor, DailySummaryNewReview, DailySummaryRow } from '@fwlm/db';
import { lineColors, lineLayout } from '@fwlm/design-tokens';
import {
  ALT_TEXT_MAX_LENGTH,
  BUBBLE_SIZE_LIMIT_BYTES,
  FlexBubbleTooLargeError,
  buildDailySummaryFlex,
  validateBubbleSize,
  type FlexBubble,
  type FlexButton,
  type FlexSeparator,
} from '../src/flex.js';

const LIFF_URL = 'https://liff.line.me/1234567890-abcdefgh';

function baseSummary(overrides: Partial<DailySummaryRow> = {}): DailySummaryRow {
  return {
    id: '1',
    store_id: 'store-1',
    summary_date: new Date('2026-07-11'),
    status: 'ready',
    rank: 2,
    rank_total: 4,
    rank_prev: 3,
    rating: '4.2',
    review_count: 128,
    rating_prev: '4.1',
    review_count_prev: 125,
    new_review_count: 3,
    new_reviews: [
      { authorName: '田中太郎', publishTime: '2026-07-11T08:00:00Z', rating: 5, textExcerpt: 'とても美味しかったです。' },
      { authorName: '佐藤花子', publishTime: '2026-07-11T09:00:00Z', rating: 4, textExcerpt: '接客が丁寧でした。' },
      { authorName: '鈴木一郎', publishTime: '2026-07-11T10:00:00Z', rating: 3, textExcerpt: '雰囲気が良かったです。' },
    ],
    // rating/starDiff は number（jsonb 内の Go 実出力に一致。task 7.1 で発見・是正した
    // DailySummaryCompetitor の型 — ts/packages/db/src/types.ts のコメント参照）。
    competitors: [
      { name: '近隣カフェA', rating: 4.5, reviewCount: 200, starDiff: 0.3 },
      { name: '近隣カフェB', rating: 3.9, reviewCount: 80, starDiff: -0.3 },
      { name: '近隣カフェC', rating: 4.0, reviewCount: 60, starDiff: -0.2 },
    ],
    created_at: new Date('2026-07-11T22:00:00Z'),
    ...overrides,
  };
}

function findBlock(bubble: FlexBubble, block: 'header' | 'body' | 'footer') {
  const b = bubble[block];
  if (!b) throw new Error(`${block} block missing`);
  return b;
}

// Flex JSON 内から text の文字列だけを再帰的に集める（構造に依存しないアサーション用）。
function collectTexts(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const texts: string[] = [];
  if (obj['type'] === 'text' && typeof obj['text'] === 'string') {
    texts.push(obj['text']);
  }
  if (Array.isArray(obj['contents'])) {
    for (const child of obj['contents']) {
      texts.push(...collectTexts(child));
    }
  }
  for (const key of ['header', 'body', 'footer'] as const) {
    if (key in obj) texts.push(...collectTexts(obj[key]));
  }
  return texts;
}


// Flex JSON 内から text の size 指定だけを再帰的に集める（唯一の大声の一意性を測るため）。
function collectTextSizes(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const sizes: string[] = [];
  if (obj['type'] === 'text' && typeof obj['size'] === 'string') {
    sizes.push(obj['size']);
  }
  if (Array.isArray(obj['contents'])) {
    for (const child of obj['contents']) {
      sizes.push(...collectTextSizes(child));
    }
  }
  for (const key of ['header', 'body', 'footer'] as const) {
    if (key in obj) sizes.push(...collectTextSizes(obj[key]));
  }
  return sizes;
}
describe('buildDailySummaryFlex', () => {
  describe('正常系（前日比あり・新着あり・競合あり）', () => {
    const result = buildDailySummaryFlex(baseSummary(), LIFF_URL);

    it('type/altText/contents を含む Flex メッセージ形状を返す', () => {
      expect(result.type).toBe('flex');
      expect(result.contents.type).toBe('bubble');
    });

    it('4段構成の順序を守る（header→body内: 自店指標→新着→競合）', () => {
      const bubble = result.contents;
      const header = findBlock(bubble, 'header');
      const body = findBlock(bubble, 'body');
      const footer = findBlock(bubble, 'footer');

      const headerTexts = collectTexts(header).join('\n');
      expect(headerTexts).toContain('近隣4店中 2位');
      expect(headerTexts).toContain('前日比');
      expect(headerTexts).toContain('上昇'); // rank 2 < rank_prev 3 → 上昇

      const bodyTexts = collectTexts(body);
      const selfIdx = bodyTexts.findIndex((t) => t.includes('★4.2'));
      const newReviewIdx = bodyTexts.findIndex((t) => t.includes('新着クチコミ'));
      const competitorIdx = bodyTexts.findIndex((t) => t.includes('競合との比較'));
      expect(selfIdx).toBeGreaterThanOrEqual(0);
      expect(newReviewIdx).toBeGreaterThan(selfIdx);
      expect(competitorIdx).toBeGreaterThan(newReviewIdx);

      const footerTexts = collectTexts(footer);
      const hasButton = JSON.stringify(footer).includes('"詳細を見る"');
      expect(hasButton).toBe(true);
      expect(footerTexts.some((t) => t.includes('データ提供: Google Maps'))).toBe(true);
    });

    it('詳細を見るボタンが liffUrl を uri アクションとして持つ', () => {
      const footer = findBlock(result.contents, 'footer');
      const json = JSON.stringify(footer);
      expect(json).toContain(`"uri":"${LIFF_URL}"`);
      expect(json).toContain('"type":"uri"');
    });

    it('新着クチコミに投稿者名の帰属を含む', () => {
      const body = findBlock(result.contents, 'body');
      const texts = collectTexts(body).join('\n');
      expect(texts).toContain('田中太郎');
    });

    it('スナップショット: 正常系の Flex JSON', () => {
      expect(result).toMatchSnapshot();
    });
  });

  describe('前日データなし（rank_prev=null, R3.7）', () => {
    const result = buildDailySummaryFlex(baseSummary({ rank_prev: null, rating_prev: null, review_count_prev: null }), LIFF_URL);

    it('前日比を表示しない', () => {
      const header = findBlock(result.contents, 'header');
      const headerTexts = collectTexts(header).join('\n');
      expect(headerTexts).not.toContain('前日比');
      expect(headerTexts).toContain('近隣4店中 2位');
    });

    it('altText にも前日比を含めない', () => {
      expect(result.altText).not.toContain('前日比');
    });

    it('スナップショット: 前日なしの Flex JSON', () => {
      expect(result).toMatchSnapshot();
    });
  });

  describe('新着クチコミなし（new_review_count=0, R3.6）', () => {
    const result = buildDailySummaryFlex(
      baseSummary({ new_review_count: 0, new_reviews: [] }),
      LIFF_URL,
    );

    it('「新着なし」を表示する', () => {
      const body = findBlock(result.contents, 'body');
      const texts = collectTexts(body);
      expect(texts).toContain('新着なし');
    });

    it('altText に新着件数の言及を含めない', () => {
      expect(result.altText).not.toContain('新着クチコミ');
    });

    it('スナップショット: 新着なしの Flex JSON', () => {
      expect(result).toMatchSnapshot();
    });
  });

  describe('新着クチコミが表示上限を超える（見出しの件数と抜粋数の食い違い）', () => {
    const overflowReviews: DailySummaryNewReview[] = Array.from({ length: 5 }, (_, i) => ({
      authorName: `投稿者${i}`,
      publishTime: '2026-07-11T08:00:00Z',
      rating: 4,
      textExcerpt: `抜粋${i}`,
    }));
    const result = buildDailySummaryFlex(
      baseSummary({ new_review_count: 5, new_reviews: overflowReviews }),
      LIFF_URL,
    );

    it('見出しが告げた件数と読める件数の差を手がかりとして示す', () => {
      const texts = collectTexts(result.contents);
      expect(texts).toContain('5件の新着クチコミ');
      // 抜粋は表示上限で打ち切られるため、実際に読めるのは 3 件だけになる。
      expect(texts.filter((text) => text.startsWith('投稿者'))).toHaveLength(3);
      expect(texts).toContain('ほか2件');
    });

    it('上限以下のときは手がかりを出さない', () => {
      // 条件つきの分岐は既定側も固定しないと、無条件に出す実装が素通りする。
      const texts = collectTexts(buildDailySummaryFlex(baseSummary(), LIFF_URL).contents);
      expect(texts.some((text) => text.startsWith('ほか'))).toBe(false);
    });
  });

  describe('競合なし（competitors=[], status=no_competitors, R1.3）', () => {
    const result = buildDailySummaryFlex(
      baseSummary({ status: 'no_competitors', competitors: [], rank: 1, rank_total: 1, rank_prev: null }),
      LIFF_URL,
    );

    it('競合が見つかっていない旨を明示する', () => {
      const body = findBlock(result.contents, 'body');
      const texts = collectTexts(body).join('\n');
      expect(texts).toContain('競合が見つかっていません');
    });

    it('自店のみの順位（1店中1位）は表示される', () => {
      const header = findBlock(result.contents, 'header');
      const headerTexts = collectTexts(header).join('\n');
      expect(headerTexts).toContain('近隣1店中 1位');
    });

    it('スナップショット: 競合なしの Flex JSON', () => {
      expect(result).toMatchSnapshot();
    });
  });

  describe('failed ステータス（想定外呼出時の縮退表示）', () => {
    const result = buildDailySummaryFlex(
      baseSummary({
        status: 'failed',
        rank: null,
        rank_total: null,
        rank_prev: null,
        rating: null,
        review_count: null,
        rating_prev: null,
        review_count_prev: null,
        new_review_count: 0,
        new_reviews: [],
        competitors: [],
      }),
      LIFF_URL,
    );

    it('例外を投げず、取得失敗を伝える文言を返す', () => {
      const header = findBlock(result.contents, 'header');
      const texts = collectTexts(header).join('\n');
      expect(texts).toContain('取得できませんでした');
    });

    it('altText も空にならず取得失敗を伝える', () => {
      expect(result.altText.length).toBeGreaterThan(0);
      expect(result.altText).toContain('取得できませんでした');
    });
  });

  describe('altText', () => {
    it('400 字以内である', () => {
      const result = buildDailySummaryFlex(baseSummary(), LIFF_URL);
      expect(result.altText.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
    });

    it('空でなく、順位情報を含む有意な文言である', () => {
      const result = buildDailySummaryFlex(baseSummary(), LIFF_URL);
      expect(result.altText.length).toBeGreaterThan(0);
      expect(result.altText).toContain('位');
    });

    it('異常に長いデータが入力されても 400 字を超えない（切り詰め）', () => {
      const longName = 'あ'.repeat(1000);
      const result = buildDailySummaryFlex(
        baseSummary({ competitors: [{ name: longName, rating: 4.0, reviewCount: 1, starDiff: 0.1 }] }),
        LIFF_URL,
      );
      expect(result.altText.length).toBeLessThanOrEqual(ALT_TEXT_MAX_LENGTH);
    });
  });

  describe('サイズ検証（30KB, design.md「組立後にサイズ検証」）', () => {
    it('通常サイズの Bubble は上限内と判定される', () => {
      const result = buildDailySummaryFlex(baseSummary(), LIFF_URL);
      const check = validateBubbleSize(result.contents);
      expect(check.withinLimit).toBe(true);
      expect(check.sizeBytes).toBeLessThanOrEqual(BUBBLE_SIZE_LIMIT_BYTES);
    });

    it('validateBubbleSize は明らかに超過する Bubble を検出する', () => {
      const oversizedBubble: FlexBubble = {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [{ type: 'text', text: 'x'.repeat(40 * 1024) }],
        },
      };
      const check = validateBubbleSize(oversizedBubble);
      expect(check.withinLimit).toBe(false);
      expect(check.sizeBytes).toBeGreaterThan(BUBBLE_SIZE_LIMIT_BYTES);
    });

    it('病的に巨大な入力（5競合の長大な名前＋長大な新着抜粋）を渡すと buildDailySummaryFlex が超過を検出して例外を投げる', () => {
      const hugeName = 'あ'.repeat(4000);
      const hugeExcerpt = 'い'.repeat(4000);
      const hugeCompetitors: DailySummaryCompetitor[] = Array.from({ length: 5 }, (_, i) => ({
        name: `${hugeName}${i}`,
        rating: 4.0,
        reviewCount: 10,
        starDiff: 0.1,
      }));
      const hugeReviews: DailySummaryNewReview[] = Array.from({ length: 3 }, (_, i) => ({
        authorName: `匿名希望さん${i}`,
        publishTime: '2026-07-11T08:00:00Z',
        rating: 5,
        textExcerpt: hugeExcerpt,
      }));

      expect(() =>
        buildDailySummaryFlex(
          baseSummary({ competitors: hugeCompetitors, new_reviews: hugeReviews, new_review_count: 3 }),
          LIFF_URL,
        ),
      ).toThrow(FlexBubbleTooLargeError);
    });
  });

  describe('意匠の不変条件（スナップショット更新では直らない）', () => {
    // スナップショットは -u 一発で「意匠を元に戻す変更」も静かに受理するため、
    // 意匠の規律そのものはここで固定する。値がトークン由来であることと、
    // 群として読める間隔になっていることを直接 assert する。
    const bubble = buildDailySummaryFlex(baseSummary(), LIFF_URL).contents;

    it('幅の段をトークンから明示する', () => {
      // 既定に委ねると LINE 側の既定値が変わったとき、オンボーディングの 4 バブルと片方だけ動く。
      // このカードは順位・3 セクション・3 列の競合行を詰めているので、幅の変化が直に破綻へつながる。
      expect(bubble.size).toBe(lineLayout.bubbleSize);
    });

    it('header / body / footer が同じ内側余白をトークンから宣言する', () => {
      for (const block of ['header', 'body', 'footer'] as const) {
        expect(findBlock(bubble, block).paddingAll).toBe(lineLayout.blockPadding);
      }
    });

    it('唯一の大声はカード全体でちょうど 1 件である', () => {
      const sizes = collectTextSizes(bubble);
      // 抽出器が空振りしていないこと（0 件しか返さない抽出器でも「1 件でない」は成立してしまう）。
      expect(sizes.length).toBeGreaterThan(1);
      expect(sizes.filter((size) => size === lineLayout.displaySize)).toHaveLength(1);
    });

    it('区切り線は節を閉じるため、セクション間の間隔より大きい段を取る', () => {
      const body = findBlock(bubble, 'body');
      const separators = body.contents.filter((c): c is FlexSeparator => c.type === 'separator');
      expect(separators.length).toBeGreaterThan(0);
      for (const separator of separators) {
        expect(separator.margin).toBe(lineLayout.dividerMargin);
      }
      expect(body.spacing).toBe(lineLayout.sectionGap);
      // 同じ段だと均等な区切りにしか見えず、線が節を閉じない。
      expect(lineLayout.dividerMargin).not.toBe(lineLayout.sectionGap);
    });

    it('セクションの内側の間隔は外側より小さい', () => {
      const body = findBlock(bubble, 'body');
      const sections = body.contents.filter((c): c is typeof c & { type: 'box' } => c.type === 'box');
      expect(sections.length).toBeGreaterThan(0);
      for (const section of sections) {
        expect(section.spacing).toBe(lineLayout.itemGap);
      }
      expect(lineLayout.itemGap).not.toBe(lineLayout.sectionGap);
    });

    it('footer は上に線を持ち、帰属表記と操作を本文から切り離す', () => {
      expect(bubble.styles?.footer?.separator).toBe(true);
    });

    it('主要操作はアクション色と高さをトークンから明示する', () => {
      const footer = findBlock(bubble, 'footer');
      const button = footer.contents.find((c): c is FlexButton => c.type === 'button');
      expect(button).toBeDefined();
      // 色を明示しないと LINE 既定の緑になり、オンボーディング完了バブルの CTA と別の緑になりうる。
      expect(button?.color).toBe(lineColors.action);
      expect(button?.height).toBe(lineLayout.actionHeight);
    });
  });
});
