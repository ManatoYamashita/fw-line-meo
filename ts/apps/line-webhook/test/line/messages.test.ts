import { describe, it, expect } from 'vitest';
import type { StoreCandidate } from '@fwlm/db';
import { decodePostback } from '../../src/onboarding/stages.js';
import {
  buildGreetingMessage,
  buildInvalidInviteCodeMessage,
  buildCandidateCarouselMessage,
  buildConfirmationMessage,
  buildCompletionMessage,
  buildPlaceAlreadyRegisteredMessage,
  type FlexCarouselContents,
  type FlexBubbleContents,
  type FlexBoxComponent,
  type FlexButtonComponent,
  type FlexPostbackAction,
} from '../../src/line/messages.js';

// design.md「MessageBuilders」/ research.md 準拠のテスト。
// Requirement 1.1, 3.1, 4.1, 4.3, 7.4: 純粋関数のみで挨拶・候補カルーセル・確認・完了の
// 各メッセージを組み立てられること、カルーセルのバブル数上限・altText 付与・postback data
// 形式（decodePostback で往復可能）をテストで確認できることを保証する。

function candidate(overrides: Partial<StoreCandidate> = {}): StoreCandidate {
  return {
    placeId: 'ChIJ-place-1',
    name: 'テスト食堂',
    address: '東京都渋谷区1-1-1',
    latitude: 35.1,
    longitude: 139.1,
    types: ['restaurant', 'food'],
    ...overrides,
  };
}

function candidates(count: number): StoreCandidate[] {
  return Array.from({ length: count }, (_, i) =>
    candidate({ placeId: `ChIJ-place-${i}`, name: `テスト食堂${i}`, address: `東京都渋谷区${i}-1-1` }),
  );
}

// スパム判定回避用の英語プレースホルダ混入がないことのスポットチェック（網羅的な言語判定ではない）。
const OBVIOUS_ENGLISH_PLACEHOLDERS = ['TODO', 'FIXME', 'Lorem ipsum', 'undefined', 'placeholder'];

function assertNoObviousEnglishPlaceholder(text: string): void {
  for (const placeholder of OBVIOUS_ENGLISH_PLACEHOLDERS) {
    expect(text).not.toContain(placeholder);
  }
}

// テキストに日本語（ひらがな・カタカナ・漢字）が含まれることの簡易チェック。
const JAPANESE_CHAR_PATTERN = /[぀-ゟ゠-ヿ一-鿿]/;

function assertContainsJapanese(text: string): void {
  expect(text).toMatch(JAPANESE_CHAR_PATTERN);
}

function findButton(box: FlexBoxComponent, index: number): FlexButtonComponent {
  const found = box.contents[index];
  if (!found || found.type !== 'button') {
    throw new Error(`expected button at index ${index}`);
  }
  return found;
}

// button.action は postback|uri の union のため、postback 固有フィールド（data/displayText）に
// 触れるテストではここで postback へ絞り込む。
function asPostback(button: FlexButtonComponent): FlexPostbackAction {
  if (button.action.type !== 'postback') {
    throw new Error('expected postback action');
  }
  return button.action;
}

describe('buildGreetingMessage', () => {
  it('text メッセージとして挨拶と招待コード入力案内を返す（Req 1.1）', () => {
    const message = buildGreetingMessage();
    expect(message.type).toBe('text');
    if (message.type !== 'text') throw new Error('unreachable');
    expect(message.text.length).toBeGreaterThan(0);
    expect(message.text).toContain('招待コード');
    assertContainsJapanese(message.text);
    assertNoObviousEnglishPlaceholder(message.text);
  });
});

describe('buildInvalidInviteCodeMessage', () => {
  it('text メッセージとして再入力案内を返す（Req 2.2）', () => {
    const message = buildInvalidInviteCodeMessage();
    expect(message.type).toBe('text');
    if (message.type !== 'text') throw new Error('unreachable');
    expect(message.text.length).toBeGreaterThan(0);
    expect(message.text).toContain('招待コード');
    assertContainsJapanese(message.text);
    assertNoObviousEnglishPlaceholder(message.text);
  });
});

describe('buildCandidateCarouselMessage', () => {
  it('flex メッセージ・altText 必須（非空・400字以内）を満たす', () => {
    const message = buildCandidateCarouselMessage(candidates(3));
    expect(message.type).toBe('flex');
    if (message.type !== 'flex') throw new Error('unreachable');
    expect(message.altText.length).toBeGreaterThan(0);
    expect(message.altText.length).toBeLessThanOrEqual(400);
    assertContainsJapanese(message.altText);
    assertNoObviousEnglishPlaceholder(message.altText);
  });

  it('入力候補数と同数のバブルを生成する（3件）', () => {
    const message = buildCandidateCarouselMessage(candidates(3));
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexCarouselContents;
    expect(contents.type).toBe('carousel');
    expect(contents.contents).toHaveLength(3);
  });

  it('境界値: ちょうど10件でもバブル数が10件（LINEの12件上限を構造的に下回る）', () => {
    const message = buildCandidateCarouselMessage(candidates(10));
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexCarouselContents;
    expect(contents.contents).toHaveLength(10);
    expect(contents.contents.length).toBeLessThanOrEqual(12);
  });

  it('境界値: 1件のみでも成立する', () => {
    const message = buildCandidateCarouselMessage(candidates(1));
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexCarouselContents;
    expect(contents.contents).toHaveLength(1);
  });

  it('0件は契約違反として例外を投げる', () => {
    expect(() => buildCandidateCarouselMessage([])).toThrow();
  });

  it('11件（契約上限10件超過）は例外を投げる', () => {
    expect(() => buildCandidateCarouselMessage(candidates(11))).toThrow();
  });

  it('バブル数は入力配列長そのものに追従する（ハードコードされていない）', () => {
    const message5 = buildCandidateCarouselMessage(candidates(5));
    const message7 = buildCandidateCarouselMessage(candidates(7));
    if (message5.type !== 'flex' || message7.type !== 'flex') throw new Error('unreachable');
    expect((message5.contents as FlexCarouselContents).contents).toHaveLength(5);
    expect((message7.contents as FlexCarouselContents).contents).toHaveLength(7);
  });

  it('各バブルの店名・住所が対応する候補の値と一致する', () => {
    const input = candidates(4);
    const message = buildCandidateCarouselMessage(input);
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexCarouselContents;

    contents.contents.forEach((bubble: FlexBubbleContents, index: number) => {
      const bodyTexts = bubble.body.contents.filter((c) => c.type === 'text');
      const [nameText, addressText] = bodyTexts;
      expect(nameText?.type === 'text' && nameText.text).toBe(input[index]?.name);
      expect(addressText?.type === 'text' && addressText.text).toBe(input[index]?.address);
    });
  });

  it('各バブルの postback data が select_candidate として index 順に往復復号できる', () => {
    const input = candidates(10);
    const message = buildCandidateCarouselMessage(input);
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexCarouselContents;

    contents.contents.forEach((bubble: FlexBubbleContents, index: number) => {
      const button = findButton(bubble.footer, 0);
      expect(button.action.type).toBe('postback');
      const decoded = decodePostback(asPostback(button).data);
      expect(decoded).toEqual({ kind: 'select_candidate', index });
    });
  });

  it('各バブルの button の label/altText は日本語で英語プレースホルダを含まない', () => {
    const message = buildCandidateCarouselMessage(candidates(2));
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexCarouselContents;

    for (const bubble of contents.contents) {
      const button = findButton(bubble.footer, 0);
      assertContainsJapanese(button.action.label);
      assertNoObviousEnglishPlaceholder(button.action.label);
      assertNoObviousEnglishPlaceholder(asPostback(button).displayText);
    }
  });
});

describe('buildConfirmationMessage', () => {
  it('flex メッセージ・altText 必須（非空・400字以内）を満たす', () => {
    const message = buildConfirmationMessage(candidate());
    expect(message.type).toBe('flex');
    if (message.type !== 'flex') throw new Error('unreachable');
    expect(message.altText.length).toBeGreaterThan(0);
    expect(message.altText.length).toBeLessThanOrEqual(400);
    assertContainsJapanese(message.altText);
  });

  it('選択候補の店名・住所を本文に含む', () => {
    const target = candidate({ name: '確認用テスト店', address: '東京都新宿区9-9-9' });
    const message = buildConfirmationMessage(target);
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexBubbleContents;
    const bodyTexts = contents.body.contents.filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text');
    const joined = bodyTexts.map((t) => t.text).join('\n');
    expect(joined).toContain('確認用テスト店');
    expect(joined).toContain('東京都新宿区9-9-9');
  });

  it('confirm/restart の postback data がそれぞれ正しく往復復号できる', () => {
    const message = buildConfirmationMessage(candidate());
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexBubbleContents;

    const confirmButton = findButton(contents.footer, 0);
    const restartButton = findButton(contents.footer, 1);

    expect(decodePostback(asPostback(confirmButton).data)).toEqual({ kind: 'confirm' });
    expect(decodePostback(asPostback(restartButton).data)).toEqual({ kind: 'restart' });
  });

  it('ボタンラベルは日本語で英語プレースホルダを含まない', () => {
    const message = buildConfirmationMessage(candidate());
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexBubbleContents;
    for (let i = 0; i < contents.footer.contents.length; i += 1) {
      const button = findButton(contents.footer, i);
      assertContainsJapanese(button.action.label);
      assertNoObviousEnglishPlaceholder(button.action.label);
    }
  });
});

describe('buildCompletionMessage', () => {
  const LIFF_URL = 'https://liff.line.me/2010693573-NxEVPPoc';

  it('flex メッセージ・altText 必須（非空・400字以内・機能1に言及）を満たす（Req 4.3）', () => {
    const message = buildCompletionMessage(LIFF_URL);
    expect(message.type).toBe('flex');
    if (message.type !== 'flex') throw new Error('unreachable');
    expect(message.altText.length).toBeGreaterThan(0);
    expect(message.altText.length).toBeLessThanOrEqual(400);
    expect(message.altText).toContain('機能1');
    assertContainsJapanese(message.altText);
    assertNoObviousEnglishPlaceholder(message.altText);
  });

  it('本文に完了案内＋機能1利用可能の旨を含む', () => {
    const message = buildCompletionMessage(LIFF_URL);
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexBubbleContents;
    const joined = contents.body.contents
      .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
      .map((t) => t.text)
      .join('\n');
    expect(joined).toContain('完了');
    expect(joined).toContain('機能1');
    assertContainsJapanese(joined);
    assertNoObviousEnglishPlaceholder(joined);
  });

  it('footer に機能1の詳細（store-detail LIFF）への URI 導線ボタンを持つ', () => {
    const message = buildCompletionMessage(LIFF_URL);
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexBubbleContents;
    const button = findButton(contents.footer, 0);
    expect(button.action.type).toBe('uri');
    if (button.action.type !== 'uri') throw new Error('unreachable');
    expect(button.action.uri).toBe(LIFF_URL);
    assertContainsJapanese(button.action.label);
    assertNoObviousEnglishPlaceholder(button.action.label);
  });
});

describe('buildPlaceAlreadyRegisteredMessage', () => {
  it('flex メッセージ・altText 必須（非空・400字以内）を満たす（Req 4.4）', () => {
    const message = buildPlaceAlreadyRegisteredMessage();
    expect(message.type).toBe('flex');
    if (message.type !== 'flex') throw new Error('unreachable');
    expect(message.altText.length).toBeGreaterThan(0);
    expect(message.altText.length).toBeLessThanOrEqual(400);
    assertContainsJapanese(message.altText);
    assertNoObviousEnglishPlaceholder(message.altText);
  });

  it('本文に確定不可＋運営問い合わせの案内を含む', () => {
    const message = buildPlaceAlreadyRegisteredMessage();
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexBubbleContents;
    const joined = contents.body.contents
      .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
      .map((t) => t.text)
      .join('\n');
    expect(joined).toContain('登録');
    expect(joined).toContain('運営');
    assertContainsJapanese(joined);
    assertNoObviousEnglishPlaceholder(joined);
  });

  it('footer の「やり直す」ボタンが restart postback を往復復号できる（エラー後の再開導線）', () => {
    const message = buildPlaceAlreadyRegisteredMessage();
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexBubbleContents;
    const button = findButton(contents.footer, 0);
    expect(decodePostback(asPostback(button).data)).toEqual({ kind: 'restart' });
    assertContainsJapanese(button.action.label);
    assertNoObviousEnglishPlaceholder(button.action.label);
  });
});
