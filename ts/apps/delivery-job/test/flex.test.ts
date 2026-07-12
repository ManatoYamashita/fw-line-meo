import { describe, expect, it } from 'vitest';
import type { DailySummaryCompetitor, DailySummaryNewReview, DailySummaryRow } from '@fwlm/db';
import {
  ALT_TEXT_MAX_LENGTH,
  BUBBLE_SIZE_LIMIT_BYTES,
  FlexBubbleTooLargeError,
  buildDailySummaryFlex,
  validateBubbleSize,
  type FlexBubble,
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
});
