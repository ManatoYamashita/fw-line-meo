// 新着口コミのレポートの試験（design.md「Report builders（表示）」の NewReviewsBuilder・
// Requirements 4.1–4.8, 8.2, 8.3, 8.4, 8.6, 8.7）。
// - 見出しに店舗名とデータ対象日、footer に帰属表示が入ること
// - 新着件数・最大 3 件の口コミ（投稿者の画像・投稿者名とプロフィールへのリンク・投稿日時・星・本文・
//   Google Maps で見る導線）・残り件数
// - Google Maps 上の URL（https の絶対 URL）を持たない口コミは、内容を出さずに件数にだけ数えること（8.7）。
//   不適合な URL を 1 つでも部品に入れると LINE がメッセージ全体を拒否するので、部品の URL はすべて https
// - 評価で口コミを絞らず、並べ替えもしないこと（レビューゲーティングの禁止）
// - 前日比が取れて 0 件なら「新着口コミはありません」、前日の集計が無ければ判定できない旨を出し、
//   そのときは「新着口コミはありません」を出さないこと（4.6・4.8）
// - 投稿日時は日本時間の `M月D日 HH:mm` で、実行環境の TZ に依存しないこと
// - 本文は 300 字で切って 4 行で折り返し、30KB を超えるときは本文を落として組み直すこと
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DailySummaryNewReview, DailySummaryReadRow } from '@fwlm/db';
import { lineColors, lineLayout } from '@fwlm/design-tokens';
import type { LineMessage } from '../../src/line/client.js';
import type { FlexBoxComponent, FlexBubbleContents, FlexTextComponent } from '../../src/line/flex-types.js';
import {
  GOOGLE_MAPS_LINK_TEXT,
  MAX_DISPLAYED_REVIEWS,
  REVIEW_TEXT_MAX_LENGTH,
  REVIEW_TEXT_MAX_LINES,
  STORE_REVIEWS_LINK_TEXT,
  buildNewReviewsBubble,
  buildNewReviewsReport,
  displayableReviews,
  formatPublishTimeJst,
} from '../../src/report/builders/new-reviews.js';
import {
  ATTRIBUTION_TEXT,
  FLEX_BUBBLE_MAX_BYTES,
  FlexBubbleTooLargeError,
  buildAttributionText,
  codePointLength,
  fitsFlexBubbleLimit,
  flexBubbleByteLength,
  normalizeReadRow,
  toFlexHttpsUrl,
  type NormalizedReadRow,
  type ReportContext,
} from '../../src/report/format.js';

const STORE: ReportContext = { storeName: '試験食堂 駅前店' };

const NONE_TEXT = '新着口コミはありません';
const UNDETERMINABLE_TEXT = '前日のデータが無いため、新着口コミの件数を判定できません。';
const UNAVAILABLE_TEXT = '新着口コミの内容は、ここでは表示できません。';

// 対になっていない UTF-16 のサロゲート（u フラグを付けずに符号単位で照合する）。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function mapsUri(id: string): string {
  return `https://www.google.com/maps/reviews/data=!4m8!14m7!1m6!2m5!1s${id}!2m1!1s0x0:0x1!3m1!1s2@1:${id}`;
}

// 架空の口コミ。投稿者名・本文は試験用の架空のもので、実在の店舗や人物を指さない。
function review(n: number, overrides: Partial<DailySummaryNewReview> = {}): DailySummaryNewReview {
  return {
    authorName: `試験投稿者${n}`,
    publishTime: '2026-09-13T01:05:00Z',
    rating: 4,
    textExcerpt: `試験の本文${n}です。料理の提供が早く、席も落ち着いていました。`,
    authorUri: `https://www.google.com/maps/contrib/10000000000000000000${n}/reviews`,
    authorPhotoUri: `https://lh3.googleusercontent.com/a-/TEST-PHOTO-${n}=s128-c0x00000000-cc-rp-mo`,
    googleMapsUri: mapsUri(`TEST${n}`),
    ...overrides,
  };
}

// 帰属の任意項目のうち、指定したものの鍵を持たない口コミ（Go は空の項目の鍵を書かない）。
function withoutFields(
  source: DailySummaryNewReview,
  ...keys: readonly ('authorUri' | 'authorPhotoUri' | 'googleMapsUri')[]
): DailySummaryNewReview {
  const copy = { ...source };
  for (const key of keys) delete copy[key];
  return copy;
}

// 帰属の 3 項目を持たない口コミ（3 項目を足す前に Go が書いた行の要素と同じ形）。
function legacyReview(n: number): DailySummaryNewReview {
  return {
    authorName: `旧形の投稿者${n}`,
    publishTime: '2026-09-13T02:00:00Z',
    rating: 5,
    textExcerpt: `旧形の本文${n}です。`,
  };
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
    new_reviews: [review(1), review(2)],
    competitors: [
      { name: '試験競合A', rating: 4.5, reviewCount: 300, starDiff: -0.3 },
      { name: '試験競合B', rating: 4.0, reviewCount: 80, starDiff: 0.2 },
      { name: '試験競合C', rating: 3.8, reviewCount: 40, starDiff: 0.4 },
    ],
    // 既定は「口コミ一覧の URL を取得できていない日」（Issue #303）。導線の試験だけが明示で値を与える。
    // 既定を値ありにすると、導線を無条件に置く実装が全試験で緑のまま通る。
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

// 部品が LINE へ渡す URL のすべて（action の uri と画像の url）。
function urlsIn(node: unknown): string[] {
  const found: string[] = [];
  walk(node, (object) => {
    if (typeof object['uri'] === 'string') found.push(object['uri']);
    if (object['type'] === 'image' && typeof object['url'] === 'string') found.push(object['url']);
  });
  return found;
}

// 本文に並ぶ口コミの枠（本文の直下の box）。
function reviewBlocks(bubble: FlexBubbleContents): FlexBoxComponent[] {
  return bubble.body.contents.filter((content): content is FlexBoxComponent => content.type === 'box');
}

function textWith(node: unknown, text: string): FlexTextComponent {
  const found = textComponents(node).find((component) => component.text === text);
  if (found === undefined) {
    throw new Error(`text「${text}」が見つからなかった`);
  }
  return found;
}

// 部品の形（鍵の集合と type）だけを残し、値を落とす。評価で見た目の構成を変えていないことの比較に使う。
function shapeOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(shapeOf);
  if (node !== null && typeof node === 'object') {
    const object = node as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, key === 'type' ? object[key] : shapeOf(object[key])]),
    );
  }
  return typeof node;
}

describe('見出しと帰属表示（4.2・8.1・8.3）', () => {
  it('見出しに店舗名とデータ対象日を置き、footer の末尾に帰属表示を 1 つだけ置く', () => {
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row()));
    expect(texts(bubble.header)).toEqual([STORE.storeName, '9月14日時点のデータ']);
    expect(bubble.footer.contents[bubble.footer.contents.length - 1]).toEqual(buildAttributionText());
    expect(JSON.stringify(bubble).split(ATTRIBUTION_TEXT)).toHaveLength(2);
  });

  it.each<[string, Partial<DailySummaryReadRow>]>([
    ['新着あり', {}],
    ['新着なし', { new_review_count: 0, new_reviews: [] }],
    ['前日の集計なし', { review_count_prev: null, rating_prev: null, new_review_count: 0, new_reviews: [] }],
    ['抜粋を表示できない', { new_reviews: [legacyReview(1)] }],
  ])('%s でも、店舗名・データ対象日・帰属表示が入る', (_label, overrides) => {
    const { altText, bubble } = flexOf(buildNewReviewsReport(STORE, row(overrides)));
    expect(texts(bubble.header)).toEqual([STORE.storeName, '9月14日時点のデータ']);
    expect(texts(bubble.footer)).toContain(ATTRIBUTION_TEXT);
    expect(altText).toContain(STORE.storeName);
    expect(altText).toContain('9月14日');
    expect(altText.endsWith(`（${ATTRIBUTION_TEXT}）`)).toBe(true);
  });
});

describe('新着件数と口コミ（4.1–4.4・8.2・8.6）', () => {
  it('新着件数を前日比として出す（4.2・4.7）', () => {
    const { altText, bubble } = flexOf(buildNewReviewsReport(STORE, row()));
    expect(texts(bubble.body)).toContain('新着口コミ 2件（前日比）');
    expect(altText).toContain('新着口コミ 2件');
  });

  it('1 件の口コミに、投稿者の画像・投稿者名・投稿日時・星・本文・Google Maps で見る導線を並べる', () => {
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 1, new_reviews: [review(1)] })));
    const [block] = reviewBlocks(bubble);
    expect(reviewBlocks(bubble)).toHaveLength(1);
    const blockTexts = texts(block);
    expect(blockTexts).toEqual([
      '試験投稿者1',
      '9月13日 10:05',
      '★★★★☆',
      '試験の本文1です。料理の提供が早く、席も落ち着いていました。',
      GOOGLE_MAPS_LINK_TEXT,
    ]);
    expect(GOOGLE_MAPS_LINK_TEXT).toBe('Google Maps で見る');
  });

  it('投稿者名は投稿者のプロフィールへのリンクにし、画像は投稿者名の左に 1:1 で置く（8.6）', () => {
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 1, new_reviews: [review(1)] })));
    const [block] = reviewBlocks(bubble);
    const name = textWith(block, '試験投稿者1');
    expect(name.action).toEqual({ type: 'uri', label: expect.any(String), uri: review(1).authorUri });
    expect(name.wrap).toBe(true);

    const authorRow = block?.contents[0];
    if (authorRow === undefined || authorRow.type !== 'box') throw new Error('投稿者の段は box である');
    expect(authorRow.layout).toBe('horizontal');
    const [image, nameBlock] = authorRow.contents;
    expect(image).toMatchObject({ type: 'image', url: review(1).authorPhotoUri, aspectRatio: '1:1', aspectMode: 'cover' });
    expect(texts(nameBlock)).toEqual(['試験投稿者1', '9月13日 10:05']);
  });

  it('Google Maps で見る導線は、その口コミの googleMapsUri を開く（8.2）', () => {
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row()));
    const blocks = reviewBlocks(bubble);
    expect(blocks.map((block) => textWith(block, GOOGLE_MAPS_LINK_TEXT).action)).toEqual([
      { type: 'uri', label: GOOGLE_MAPS_LINK_TEXT, uri: mapsUri('TEST1') },
      { type: 'uri', label: GOOGLE_MAPS_LINK_TEXT, uri: mapsUri('TEST2') },
    ]);
  });

  it('導線は押せる部品なのでアクション色を持ち、星と本文は本文色で描く（design-language.md §7.1・§7.15）', () => {
    const [block] = reviewBlocks(bubbleOf(buildNewReviewsReport(STORE, row())));
    expect(textWith(block, GOOGLE_MAPS_LINK_TEXT).color).toBe(lineColors.action);
    expect(textWith(block, '★★★★☆').color).toBe(lineColors.body);
    expect(textWith(block, review(1).textExcerpt).color).toBe(lineColors.body);
    expect(textWith(block, review(1).textExcerpt).size).toBe(lineLayout.descriptionSize);
  });

  it('最大 3 件を入力の順に出し、表示していない残りの件数を明示する（4.3・4.4）', () => {
    expect(MAX_DISPLAYED_REVIEWS).toBe(3);
    const reviews = [review(1), review(2), review(3), review(4), review(5)];
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 5, new_reviews: reviews })));
    const blocks = reviewBlocks(bubble);
    expect(blocks.map((block) => texts(block)[0])).toEqual(['試験投稿者1', '試験投稿者2', '試験投稿者3']);
    expect(texts(bubble.body)).toContain('表示していない新着口コミがほかに2件あります。');
    expect(JSON.stringify(bubble)).not.toContain('試験投稿者4');
  });

  it('残りの件数には、内容を出せない口コミも数える（件数は新着件数から表示した件数を引いたもの）', () => {
    const reviews = [review(1), legacyReview(2), review(3)];
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 4, new_reviews: reviews })));
    expect(reviewBlocks(bubble)).toHaveLength(2);
    expect(texts(bubble.body)).toContain('表示していない新着口コミがほかに2件あります。');
  });

  it('すべて表示したときは残りの件数を出さない', () => {
    const body = JSON.stringify(bubbleOf(buildNewReviewsReport(STORE, row())).body);
    expect(body).not.toContain('ほかに');
  });

  it('新着件数より多い抜粋は、件数を超えて出さない（件数と表示が食い違わない）', () => {
    const reviews = [review(1), review(2), review(3)];
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 1, new_reviews: reviews })));
    expect(reviewBlocks(bubble)).toHaveLength(1);
    expect(texts(bubble.body)).toContain('新着口コミ 1件（前日比）');
    expect(JSON.stringify(bubble.body)).not.toContain('ほかに');
  });
});

describe('Google Maps 上の URL を持たない口コミは内容を出さない（8.7）', () => {
  it('googleMapsUri の無い口コミは、投稿者名も本文も出さず、件数にだけ数える', () => {
    const message = buildNewReviewsReport(STORE, row({ new_review_count: 2, new_reviews: [legacyReview(1), review(2)] }));
    const json = JSON.stringify(message);
    expect(json).not.toContain('旧形の投稿者1');
    expect(json).not.toContain('旧形の本文1');
    const bubble = bubbleOf(message);
    expect(reviewBlocks(bubble)).toHaveLength(1);
    expect(texts(bubble.body)).toContain('新着口コミ 2件（前日比）');
    expect(texts(bubble.body)).toContain('表示していない新着口コミがほかに1件あります。');
  });

  // LINE の uri アクションは http・https・line・tel を受け付けるが、ここでは https の絶対 URL だけを使う。
  // 不適合な値を部品に入れると LINE がメッセージ全体を拒否するので、導線が無いものとして内容を出さない。
  const TOO_LONG_URI = `https://www.google.com/maps/${'a'.repeat(1000)}`;
  const INVALID_MAPS_URIS: readonly (readonly [string, string])[] = [
    ['スキームの無い相対 URL', '//www.google.com/maps/reviews/data=!4m8'],
    ['http', 'http://www.google.com/maps/reviews/data=!4m8'],
    ['javascript', 'javascript:alert(1)'],
    ['スラッシュが 1 つ', 'https:/www.google.com/maps'],
    ['スラッシュが 3 つ（解釈でホストが補われる）', 'https:///www.google.com/maps'],
    ['ホストが無い', 'https://'],
    ['利用者情報を含む', 'https://user@www.google.com/maps'],
    ['空文字', ''],
    ['前の空白', ' https://www.google.com/maps/reviews/data=!4m8'],
    ['途中の空白', 'https://www.google.com/maps/reviews/data !4m8'],
    ['百分率符号化していない非 ASCII', 'https://www.google.com/maps/口コミ'],
    ['壊れた百分率符号化', 'https://www.google.com/maps/%E3%8'],
    ['パス区切りに逆斜線', 'https:\\\\www.google.com\\maps'],
    ['1000 文字を超える', TOO_LONG_URI],
  ];

  it.each(INVALID_MAPS_URIS)('googleMapsUri が不適合（%s）なら、導線が無いものとして内容を出さない', (_label, uri) => {
    const bad = review(1, { authorName: '不適合な導線の投稿者', textExcerpt: '不適合な導線の本文', googleMapsUri: uri });
    const message = buildNewReviewsReport(STORE, row({ new_review_count: 2, new_reviews: [bad, review(2)] }));
    const json = JSON.stringify(message);
    expect(json).not.toContain('不適合な導線の投稿者');
    expect(json).not.toContain('不適合な導線の本文');
    expect(reviewBlocks(bubbleOf(message))).toHaveLength(1);
    expect(displayableReviews([bad])).toEqual([]);
  });

  it('試験の前提: 同じ口コミは、適合する googleMapsUri なら内容を出す（上の試験の空振りの防止）', () => {
    const good = review(1, { authorName: '不適合な導線の投稿者', textExcerpt: '不適合な導線の本文' });
    const json = JSON.stringify(buildNewReviewsReport(STORE, row({ new_review_count: 2, new_reviews: [good, review(2)] })));
    expect(json).toContain('不適合な導線の投稿者');
    expect(json).toContain('不適合な導線の本文');
    for (const [, uri] of INVALID_MAPS_URIS) {
      expect(toFlexHttpsUrl(uri, 1000)).toBeNull();
    }
    // 長すぎる値は、長さの他は適合している（上限の判定だけで落ちていることを確かめる）。
    expect(toFlexHttpsUrl(TOO_LONG_URI, 2000)).toBe(TOO_LONG_URI);
  });

  it('googleMapsUri が 1000 文字ちょうどなら使う（uri アクションの上限）', () => {
    const uri = `https://www.google.com/maps/${'a'.repeat(1000 - 'https://www.google.com/maps/'.length)}`;
    expect(uri).toHaveLength(1000);
    const message = buildNewReviewsReport(STORE, row({ new_review_count: 1, new_reviews: [review(1, { googleMapsUri: uri })] }));
    expect(urlsIn(message)).toContain(uri);
  });

  it('authorUri が不適合なら、投稿者名をリンクにせずに出す（口コミの内容は出す）', () => {
    const reviews = [review(1, { authorUri: '//www.google.com/maps/contrib/1' }), review(2, { authorUri: 'javascript:alert(1)' })];
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_reviews: reviews })));
    const blocks = reviewBlocks(bubble);
    expect(blocks).toHaveLength(2);
    expect(textWith(blocks[0], '試験投稿者1').action).toBeUndefined();
    expect(textWith(blocks[1], '試験投稿者2').action).toBeUndefined();
    expect(texts(blocks[0])).toContain(GOOGLE_MAPS_LINK_TEXT);
  });

  it('authorUri が無ければ、投稿者名をリンクにせずに出す', () => {
    const withoutAuthorUri = withoutFields(review(1), 'authorUri');
    expect('authorUri' in withoutAuthorUri).toBe(false);
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 1, new_reviews: [withoutAuthorUri] })));
    expect(textWith(bubble.body, '試験投稿者1').action).toBeUndefined();
  });

  it('authorPhotoUri が無いか不適合なら、画像を置かない（投稿者名は出す）', () => {
    const withoutPhoto = withoutFields(review(1), 'authorPhotoUri');
    const reviews = [withoutPhoto, review(2, { authorPhotoUri: 'http://lh3.googleusercontent.com/a-/TEST' })];
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_reviews: reviews })));
    const images: unknown[] = [];
    walk(bubble, (object) => {
      if (object['type'] === 'image') images.push(object);
    });
    expect(images).toEqual([]);
    expect(reviewBlocks(bubble).map((block) => texts(block)[0])).toEqual(['試験投稿者1', '試験投稿者2']);
  });

  it('不適合な URL が混ざっても、メッセージに入る URL はすべて https の絶対 URL である', () => {
    const reviews = [
      review(1, { authorUri: '//x.example/1', authorPhotoUri: 'http://x.example/1.png' }),
      review(2, { googleMapsUri: 'javascript:alert(1)' }),
      review(3, { authorPhotoUri: 'data:image/png;base64,AAAA' }),
      legacyReview(4),
    ];
    const message = buildNewReviewsReport(STORE, row({ new_review_count: 4, new_reviews: reviews }));
    const urls = urlsIn(message);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith('https://')).toBe(true);
      expect(new URL(url).protocol).toBe('https:');
    }
  });

  it('投稿者名が空の口コミは、投稿者名を併記できないので内容を出さない（8.2）', () => {
    const reviews = [review(1, { authorName: '', textExcerpt: '投稿者名の無い本文' }), review(2)];
    const message = buildNewReviewsReport(STORE, row({ new_reviews: reviews }));
    expect(JSON.stringify(message)).not.toContain('投稿者名の無い本文');
    expect(reviewBlocks(bubbleOf(message))).toHaveLength(1);
  });

  it('displayableReviews は、表示できる口コミだけを入力の順のまま返す', () => {
    const reviews = [review(1), legacyReview(2), review(3, { googleMapsUri: 'http://x.example' }), review(4)];
    expect(displayableReviews(reviews)).toEqual([review(1), review(4)]);
  });
});

describe('評価で口コミを絞らない（レビューゲーティングの禁止）', () => {
  it('星 1 の口コミも、星 5 の口コミと同じ構成で、入力の順のまま出す', () => {
    const reviews = [review(1, { rating: 1 }), review(2, { rating: 5 }), review(3, { rating: 2 })];
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 3, new_reviews: reviews })));
    const blocks = reviewBlocks(bubble);
    expect(blocks.map((block) => texts(block)[0])).toEqual(['試験投稿者1', '試験投稿者2', '試験投稿者3']);
    expect(blocks.map((block) => texts(block)[2])).toEqual(['★☆☆☆☆', '★★★★★', '★★☆☆☆']);
    expect(shapeOf(blocks[0])).toEqual(shapeOf(blocks[1]));
    expect(shapeOf(blocks[2])).toEqual(shapeOf(blocks[1]));
    expect(texts(blocks[0])).toContain(GOOGLE_MAPS_LINK_TEXT);
  });

  it('星 1 だけの新着も、すべて出す', () => {
    const reviews = [review(1, { rating: 1 }), review(2, { rating: 1 }), review(3, { rating: 1 })];
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 3, new_reviews: reviews })));
    expect(reviewBlocks(bubble)).toHaveLength(3);
  });

  it('displayableReviews は評価で絞らない', () => {
    const reviews = [1, 2, 3, 4, 5].map((rating) => review(rating, { rating }));
    expect(displayableReviews(reviews)).toEqual(reviews);
  });

  it('星の値が 1〜5 の数でなければ星を「—」とし、口コミは出す（値を補わない・8.4）', () => {
    const reviews = [review(1, { rating: 0 }), review(2, { rating: Number.NaN }), review(3, { rating: 6 })];
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 3, new_reviews: reviews })));
    expect(reviewBlocks(bubble).map((block) => texts(block)[2])).toEqual(['—', '—', '—']);
  });
});

describe('新着なし・判定できない・抜粋を表示できない（4.5・4.6・4.8）', () => {
  it('前日の集計があり新着が 0 件なら「新着口コミはありません」と出す（4.6）', () => {
    const { altText, bubble } = flexOf(
      buildNewReviewsReport(STORE, row({ new_review_count: 0, new_reviews: [], review_count_prev: 120 })),
    );
    expect(texts(bubble.body)).toEqual(['新着口コミはありません。']);
    expect(altText).toContain(NONE_TEXT);
    expect(JSON.stringify(bubble)).not.toContain('件（前日比）');
  });

  it('前日の集計が無ければ判定できない旨を出し、「新着口コミはありません」を出さない（4.8）', () => {
    const message = buildNewReviewsReport(
      STORE,
      row({ review_count_prev: null, rating_prev: null, rank_prev: null, new_review_count: 0, new_reviews: [] }),
    );
    const { altText, bubble } = flexOf(message);
    expect(texts(bubble.body)).toEqual([UNDETERMINABLE_TEXT]);
    expect(JSON.stringify(message)).not.toContain(NONE_TEXT);
    expect(altText).not.toContain(NONE_TEXT);
    expect(JSON.stringify(message)).not.toContain('0件');
  });

  it('前日の集計が無い行に抜粋が入っていても、件数も内容も出さない（前日比の新着ではない・4.7）', () => {
    const message = buildNewReviewsReport(STORE, row({ review_count_prev: null, new_review_count: 2, new_reviews: [review(1)] }));
    const bubble = bubbleOf(message);
    expect(texts(bubble.body)).toEqual([UNDETERMINABLE_TEXT]);
    expect(JSON.stringify(message)).not.toContain('試験投稿者1');
    expect(JSON.stringify(message)).not.toContain(NONE_TEXT);
  });

  it('新着が 1 件以上で表示できる抜粋が無ければ、件数と表示できない旨を出す（4.5）', () => {
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 2, new_reviews: [legacyReview(1)] })));
    expect(texts(bubble.body)).toEqual(['新着口コミ 2件（前日比）', UNAVAILABLE_TEXT]);
    expect(reviewBlocks(bubble)).toEqual([]);
  });

  it('新着が 1 件以上で抜粋が 1 件も届いていなくても、件数と表示できない旨を出す（4.5）', () => {
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 3, new_reviews: [] })));
    expect(texts(bubble.body)).toEqual(['新着口コミ 3件（前日比）', UNAVAILABLE_TEXT]);
    expect(JSON.stringify(bubble)).not.toContain(NONE_TEXT);
  });

  it('組立は閲覧した時刻に依存しない（閲覧の有無で件数が変わらない・4.7）', () => {
    const input = row({ new_review_count: 5, new_reviews: [review(1), review(2), review(3), review(4)] });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-14T00:00:00Z'));
      const first = buildNewReviewsReport(STORE, input);
      vi.setSystemTime(new Date('2026-10-30T12:34:56Z'));
      expect(buildNewReviewsReport(STORE, input)).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- 店舗の口コミ一覧への導線（Issue #303）-------------------------------------------------
//
// Places API は口コミを関連度順に最大 5 件しか返さず、新着順へ並べ替える手段を持たない。そのため
// 口コミ数の多い店では、前日より後に投稿された口コミが上位 5 件へ入らない。本番では 30 日間、
// 22 件の新着に対し抜粋が 1 件も取れず、このレポートは件数だけを出して行き止まっていた。
// 内容を読めていない新着が残る日は、店舗の口コミ一覧（そこでは新着順に読める）への導線を添える。

const STORE_REVIEWS_URI = 'https://www.google.com/maps/place//data=!4m4!3m3!1s0x0:0x1!9m1!1b1';

describe('店舗の口コミ一覧への導線（4.4・4.5・Issue #303）', () => {
  it('抜粋が 1 件も出せない日に、口コミ一覧への導線を件数と案内の後ろへ置く', () => {
    const bubble = bubbleOf(
      buildNewReviewsReport(
        STORE,
        row({ new_review_count: 3, new_reviews: [], google_maps_reviews_uri: STORE_REVIEWS_URI }),
      ),
    );
    expect(texts(bubble.body)).toEqual([
      '新着口コミ 3件（前日比）',
      UNAVAILABLE_TEXT,
      STORE_REVIEWS_LINK_TEXT,
    ]);
    // 行き先は保存された値そのもの。書き換えて救わない。
    const link = textWith(bubble.body, STORE_REVIEWS_LINK_TEXT);
    expect(link.action).toEqual({ type: 'uri', label: STORE_REVIEWS_LINK_TEXT, uri: STORE_REVIEWS_URI });
    expect(link.color).toBe(lineColors.action);
  });

  it('1 件ごとの導線とは別の語を使う（同じ本文に両方が並ぶため）', () => {
    expect(STORE_REVIEWS_LINK_TEXT).toBe('Google Maps で口コミをすべて見る');
    expect(STORE_REVIEWS_LINK_TEXT).not.toBe(GOOGLE_MAPS_LINK_TEXT);
    // 一覧は新着で絞られていない。取得済みのデータに無いことを言わない（8.4）。
    expect(STORE_REVIEWS_LINK_TEXT).not.toContain('新着');
  });

  it('内容を読めていない新着の有無で、出る日と出ない日が決まる', () => {
    const cases = [
      {
        name: '抜粋が 0 件（本番の常態）',
        overrides: { new_review_count: 2, new_reviews: [legacyReview(1)] },
        shown: true,
      },
      {
        name: '一部だけ出せた（残りがある）',
        overrides: { new_review_count: 5, new_reviews: [review(1), review(2)] },
        shown: true,
      },
      {
        // 上限の 3 件を出し切ってもなお残る日。
        name: '上限まで出してなお残る',
        overrides: { new_review_count: 9, new_reviews: [review(1), review(2), review(3), review(4)] },
        shown: true,
      },
      {
        // 全件の内容を出せた日。各口コミが自分の導線を持つので重ねて置かない。
        name: '全件出せた',
        overrides: { new_review_count: 2, new_reviews: [review(1), review(2)] },
        shown: false,
      },
      {
        name: '新着が 0 件',
        overrides: { new_review_count: 0, new_reviews: [] },
        shown: false,
      },
      {
        // 前日の集計が無い日は件数そのものを判定しない（4.8）。判定できない旨だけを出す。
        name: '前日の集計が無い',
        overrides: { review_count_prev: null, new_review_count: 3, new_reviews: [] },
        shown: false,
      },
    ] as const;

    // 出る側・出ない側の両方を必ず通る。片側だけの表は、その向きしか検査しない。
    expect(cases.filter((item) => item.shown)).toHaveLength(3);
    expect(cases.filter((item) => !item.shown)).toHaveLength(3);

    for (const item of cases) {
      const bubble = bubbleOf(
        buildNewReviewsReport(STORE, row({ ...item.overrides, google_maps_reviews_uri: STORE_REVIEWS_URI })),
      );
      expect(texts(bubble.body).includes(STORE_REVIEWS_LINK_TEXT), item.name).toBe(item.shown);
      expect(urlsIn(bubble).includes(STORE_REVIEWS_URI), item.name).toBe(item.shown);
    }
  });

  it('使えない URL の日は導線ごと置かない（空の uri を LINE へ送らない）', () => {
    const cases = [
      { name: '列が NULL', uri: null },
      { name: 'https でない', uri: 'http://www.google.com/maps/place//data=x' },
      { name: 'スキームが無い', uri: '//www.google.com/maps/place//data=x' },
      { name: 'javascript:', uri: 'javascript:alert(1)' },
      { name: 'ホストが無い', uri: 'https:///maps/place//data=x' },
      { name: '空文字', uri: '' },
      // uri アクションの上限（1000 文字）を 1 文字超える値。LINE は 1 つでも不適合だと全体を拒否する。
      { name: '上限を 1 文字超える', uri: `https://www.google.com/maps/place//data=${'x'.repeat(1000 - 40 + 1)}` },
    ] as const;

    for (const item of cases) {
      const bubble = bubbleOf(
        buildNewReviewsReport(
          STORE,
          row({ new_review_count: 3, new_reviews: [], google_maps_reviews_uri: item.uri }),
        ),
      );
      // 件数と案内は残る（行き先が無いことは、件数を伏せる理由にならない）。
      expect(texts(bubble.body), item.name).toEqual(['新着口コミ 3件（前日比）', UNAVAILABLE_TEXT]);
      expect(urlsIn(bubble), item.name).toEqual([]);
    }

    // 上限ちょうどの値は通る（境界の向きを取り違えていないことの対照）。
    const atLimit = `https://www.google.com/maps/place//data=${'x'.repeat(1000 - 40)}`;
    expect(atLimit).toHaveLength(1000);
    const bubble = bubbleOf(
      buildNewReviewsReport(STORE, row({ new_review_count: 3, new_reviews: [], google_maps_reviews_uri: atLimit })),
    );
    expect(urlsIn(bubble)).toEqual([atLimit]);
  });

  it('altText は導線の有無で変わらない（読み上げは件数だけを伝える）', () => {
    const withLink = flexOf(
      buildNewReviewsReport(
        STORE,
        row({ new_review_count: 3, new_reviews: [], google_maps_reviews_uri: STORE_REVIEWS_URI }),
      ),
    );
    const withoutLink = flexOf(buildNewReviewsReport(STORE, row({ new_review_count: 3, new_reviews: [] })));
    expect(withLink.altText).toBe(withoutLink.altText);
  });

  it('本文を落として組み直す 30KB 超の経路でも導線は残る', () => {
    const row3 = row({
      new_review_count: 3,
      new_reviews: [],
      google_maps_reviews_uri: STORE_REVIEWS_URI,
    });
    expect(texts(buildNewReviewsBubble(STORE, row3, { withTexts: false }).body)).toContain(STORE_REVIEWS_LINK_TEXT);
  });
});

describe('本文（300 字で切り、4 行で折り返す）', () => {
  it('本文は 300 字（コードポイント）で切り、wrap と maxLines 4 で折り返す', () => {
    expect(REVIEW_TEXT_MAX_LENGTH).toBe(300);
    expect(REVIEW_TEXT_MAX_LINES).toBe(4);
    const long = 'あ'.repeat(REVIEW_TEXT_MAX_LENGTH + 50);
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 1, new_reviews: [review(1, { textExcerpt: long })] })));
    const body = texts(reviewBlocks(bubble)[0])[3] ?? '';
    expect(codePointLength(body)).toBe(REVIEW_TEXT_MAX_LENGTH);
    expect(body.endsWith('…')).toBe(true);
    const component = textWith(bubble.body, body);
    expect(component.wrap).toBe(true);
    expect(component.maxLines).toBe(REVIEW_TEXT_MAX_LINES);
  });

  it('300 字ちょうどの本文はそのまま出す', () => {
    const exact = 'い'.repeat(REVIEW_TEXT_MAX_LENGTH);
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 1, new_reviews: [review(1, { textExcerpt: exact })] })));
    expect(texts(bubble.body)).toContain(exact);
  });

  it('BMP の外の文字を含む本文も、サロゲートペアを割らずに切る', () => {
    const long = '\u{20BB7}'.repeat(REVIEW_TEXT_MAX_LENGTH + 1);
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 1, new_reviews: [review(1, { textExcerpt: long })] })));
    const body = texts(reviewBlocks(bubble)[0])[3] ?? '';
    expect(codePointLength(body)).toBe(REVIEW_TEXT_MAX_LENGTH);
    expect(LONE_SURROGATE.test(body)).toBe(false);
  });

  it('本文が空の口コミは、本文の部品を置かずに投稿者名と星と導線を出す（空の text を送らない）', () => {
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 1, new_reviews: [review(1, { textExcerpt: '' })] })));
    expect(texts(reviewBlocks(bubble)[0])).toEqual(['試験投稿者1', '9月13日 10:05', '★★★★☆', GOOGLE_MAPS_LINK_TEXT]);
    expect(textComponents(bubble).every((component) => component.text.length > 0)).toBe(true);
  });
});

describe('投稿日時は日本時間の `M月D日 HH:mm`（実行環境の TZ に依存しない）', () => {
  it.each([
    ['2026-09-13T01:05:00Z', '9月13日 10:05'],
    ['2026-09-13T15:30:00Z', '9月14日 00:30'],
    ['2025-12-31T15:00:00Z', '1月1日 00:00'],
    ['2026-09-13T10:05:00+09:00', '9月13日 10:05'],
    ['2026-09-12T20:05:00-05:00', '9月13日 10:05'],
    ['2026-09-13T01:05:00.123456789Z', '9月13日 10:05'],
    ['2026-02-28T15:00:00Z', '3月1日 00:00'],
  ])('%s は %s', (publishTime, expected) => {
    expect(formatPublishTimeJst(publishTime)).toBe(expected);
  });

  it.each([
    ['時差の無い日時（実行環境の TZ で読まれてしまう）', '2026-09-13T01:05:00'],
    ['日付だけ', '2026-09-13'],
    ['暦日として正しくない', '2026-02-30T01:05:00Z'],
    ['時刻として正しくない', '2026-09-13T24:05:00Z'],
    ['時差として正しくない', '2026-09-13T01:05:00+24:00'],
    ['空文字', ''],
    ['文字列でない形', 'yesterday'],
  ])('読めない値（%s）は null を返し、レポートでは「—」にする（値を補わない・8.4）', (_label, publishTime) => {
    expect(formatPublishTimeJst(publishTime)).toBeNull();
    const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 1, new_reviews: [review(1, { publishTime })] })));
    expect(texts(reviewBlocks(bubble)[0])[1]).toBe('—');
  });

  describe('TZ を切り替えても同じ表記になる', () => {
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
      expect(formatPublishTimeJst('2026-09-13T15:30:00Z')).toBe('9月14日 00:30');
      expect(formatPublishTimeJst('2026-09-13T01:05:00Z')).toBe('9月13日 10:05');
      expect(formatPublishTimeJst('2025-12-31T14:59:00Z')).toBe('12月31日 23:59');
      const bubble = bubbleOf(buildNewReviewsReport(STORE, row({ new_review_count: 1, new_reviews: [review(1)] })));
      expect(texts(reviewBlocks(bubble)[0])[1]).toBe('9月13日 10:05');
    });

    it('試験の前提: TZ の切り替えが実際にこのプロセスの Date に効いている（空振りの防止）', () => {
      process.env['TZ'] = 'America/Los_Angeles';
      expect(new Date('2026-09-13T15:30:00Z').getHours()).toBe(8);
      process.env['TZ'] = 'Pacific/Kiritimati';
      expect(new Date('2026-09-13T15:30:00Z').getHours()).toBe(5);
    });
  });
});

describe('30KB の検証', () => {
  // uri アクションの上限（1000）と画像の url の上限（2000）ちょうどの URL。
  function longUrl(prefix: string, length: number): string {
    return `${prefix}${'a'.repeat(length - prefix.length)}`;
  }

  it('上限いっぱいの URL と 300 字の 4 バイト文字の本文を 3 件並べても、本文を落とさずに収まる', () => {
    const reviews = [1, 2, 3].map((n) =>
      review(n, {
        textExcerpt: '\u{1F363}'.repeat(REVIEW_TEXT_MAX_LENGTH + 10),
        authorUri: longUrl(`https://www.google.com/maps/contrib/${n}/`, 1000),
        googleMapsUri: longUrl(`https://www.google.com/maps/reviews/${n}/`, 1000),
        authorPhotoUri: longUrl(`https://lh3.googleusercontent.com/a-/${n}/`, 2000),
      }),
    );
    const input = row({ new_review_count: 30, new_reviews: reviews });
    const bubble = bubbleOf(buildNewReviewsReport(STORE, input));
    expect(fitsFlexBubbleLimit(bubble)).toBe(true);
    expect(bubble).toEqual(buildNewReviewsBubble(STORE, input, { withTexts: true }));
    expect(reviewBlocks(bubble)).toHaveLength(3);
    expect(urlsIn(bubble)).toHaveLength(9);
  });

  it('本文を含めると 30KB を超えるときは、本文を落として組み直す（投稿者名と導線は残す）', () => {
    // 投稿者名を長くして本文なしで上限の近くまで寄せ、本文（JSON で 1 字 6 バイトに escape される制御文字）で超えさせる。
    const reviews = [1, 2, 3].map((n) =>
      review(n, { authorName: `試験投稿者${n}${'名'.repeat(2700)}`, textExcerpt: ''.repeat(REVIEW_TEXT_MAX_LENGTH) }),
    );
    const input = row({ new_review_count: 3, new_reviews: reviews });
    const withTexts = buildNewReviewsBubble(STORE, input, { withTexts: true });
    const withoutTexts = buildNewReviewsBubble(STORE, input, { withTexts: false });
    // 試験の前提: 本文ありは上限を超え、本文なしは収まる（空振りの防止）。
    expect(fitsFlexBubbleLimit(withTexts)).toBe(false);
    expect(fitsFlexBubbleLimit(withoutTexts)).toBe(true);

    const bubble = bubbleOf(buildNewReviewsReport(STORE, input));
    expect(bubble).toEqual(withoutTexts);
    expect(flexBubbleByteLength(bubble)).toBeLessThanOrEqual(FLEX_BUBBLE_MAX_BYTES);
    expect(JSON.stringify(bubble)).not.toContain('\\u0001');
    const blocks = reviewBlocks(bubble);
    expect(blocks).toHaveLength(3);
    for (const [index, block] of blocks.entries()) {
      expect(texts(block)[0]).toBe(reviews[index]?.authorName);
      expect(textWith(block, GOOGLE_MAPS_LINK_TEXT).action).toEqual({
        type: 'uri',
        label: GOOGLE_MAPS_LINK_TEXT,
        uri: reviews[index]?.googleMapsUri,
      });
    }
  });

  it('本文を落としても収まらないときは FlexBubbleTooLargeError を投げる（誤った形の Reply を送らない）', () => {
    const huge: ReportContext = { storeName: '店'.repeat(FLEX_BUBBLE_MAX_BYTES) };
    expect(() => buildNewReviewsReport(huge, row())).toThrow(FlexBubbleTooLargeError);
  });
});

describe('スナップショット（Flex Message Simulator へ貼って目視する材料）', () => {
  it('新着あり: 画像なし・リンクなしの投稿者を含み、残りの件数を持つ', () => {
    const plain = withoutFields(review(2, { rating: 1 }), 'authorPhotoUri', 'authorUri');
    const reviews = [review(1, { rating: 5 }), plain, legacyReview(3), review(4, { rating: 3 })];
    expect(buildNewReviewsReport(STORE, row({ new_review_count: 5, new_reviews: reviews }))).toMatchSnapshot();
  });

  it('新着なし', () => {
    expect(buildNewReviewsReport(STORE, row({ new_review_count: 0, new_reviews: [] }))).toMatchSnapshot();
  });

  it('前日の集計なし', () => {
    expect(
      buildNewReviewsReport(STORE, row({ review_count_prev: null, rating_prev: null, new_review_count: 0, new_reviews: [] })),
    ).toMatchSnapshot();
  });

  it('抜粋を表示できない', () => {
    expect(buildNewReviewsReport(STORE, row({ new_review_count: 2, new_reviews: [legacyReview(1)] }))).toMatchSnapshot();
  });
});
