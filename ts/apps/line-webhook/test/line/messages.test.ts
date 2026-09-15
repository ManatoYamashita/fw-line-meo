import { describe, it, expect } from 'vitest';
import type { StoreCandidate } from '@fwlm/db';
import { lineColors, lineLayout } from '@fwlm/design-tokens';
import { REPORT_LABELS } from '@fwlm/line-report';
import type { LineMessage } from '../../src/line/client.js';
import { decodePostback } from '../../src/onboarding/stages.js';
import * as messageModule from '../../src/line/messages.js';
import {
  buildGreetingMessage,
  buildInvalidInviteCodeMessage,
  buildCandidateCarouselMessage,
  buildConfirmationMessage,
  buildCompletionMessage,
  buildInternalErrorRetryMessage,
  buildPlaceAlreadyRegisteredMessage,
  buildStatusGuidanceMessage,
} from '../../src/line/messages.js';
import type {
  FlexCarouselContents,
  FlexBubbleContents,
  FlexBoxComponent,
  FlexButtonComponent,
  FlexPostbackAction,
} from '../../src/line/flex-types.js';

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

// 未置換の英語プレースホルダが本文へ混入していないことのスポットチェック（網羅的な言語判定ではない）。
// オーナーへ届くのは日本語の案内であり、TODO や undefined がそのまま出れば体裁が壊れる（Issue #179）。
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

describe('buildStatusGuidanceMessage（line-on-demand-report Req 2.5・2.10）', () => {
  function guidanceText(): string {
    const message = buildStatusGuidanceMessage();
    if (message.type !== 'text') throw new Error('text メッセージではない');
    return message.text;
  }

  function guidanceLine(index: number): string {
    const line = guidanceText().split('\n')[index];
    if (line === undefined) throw new Error(`${index + 1} 行目が無い`);
    return line;
  }

  it('text メッセージとして 1 文 1 行の 3 行で案内する（design-language §7.16）', () => {
    expect(buildStatusGuidanceMessage().type).toBe('text');
    const lines = guidanceText().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      // 1 行に 1 文: 句点で終わり、行の途中に句点を持たない。
      expect(line.endsWith('。'), line).toBe(true);
      expect(line.split('。'), line).toHaveLength(2);
      assertContainsJapanese(line);
      assertNoObviousEnglishPlaceholder(line);
    }
  });

  it('1 行目は店舗の登録が完了していることを伝える', () => {
    const first = guidanceLine(0);
    expect(first).toContain('登録');
    expect(first).toContain('完了');
  });

  it('2 行目はメニューの 3 つのレポートの導線と詳細画面の導線を、メニューの文言のまま挙げる', () => {
    const second = guidanceLine(1);
    expect(second).toContain('メニュー');
    expect(Object.values(REPORT_LABELS)).toHaveLength(3);
    for (const label of Object.values(REPORT_LABELS)) {
      expect(second).toContain(`「${label}」`);
    }
    expect(second).toContain('レポート');
    expect(second).toContain('「詳細を見る」');
    expect(second).toContain('詳細画面');
  });

  it('3 行目は変化があった日に配信時刻に知らせることを伝え、固定の時刻を書かない（Req 1.9）', () => {
    const third = guidanceLine(2);
    expect(third).toContain('変化があった日');
    expect(third).toContain('配信時刻');
    expect(third).toContain('お知らせします');
    // 配信時刻はオーナーごとの値（owners.delivery_hour）なので、固定の時刻や時間帯を書くと食い違いうる。
    expect(guidanceText()).not.toMatch(/[0-9０-９]+\s*時/);
    expect(guidanceText()).not.toContain('朝');
  });

  it('オンボーディングの案内（招待コード・店名の入力）を含めない（Req 2.9）', () => {
    const text = guidanceText();
    expect(text).not.toContain('招待コード');
    expect(text).not.toContain('店名');
    expect(text).not.toContain('お店の名前');
    expect(text).not.toContain('オンボーディング');
  });

  it('絵文字と ** の強調を使わない（design-language §7.16）', () => {
    const text = guidanceText();
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toContain('**');
  });
});

describe('buildInternalErrorRetryMessage の店舗名つきの形（line-on-demand-report Req 7.5）', () => {
  const STORE_NAME = '試験食堂 駅前店';

  function linesOf(message: LineMessage): string[] {
    if (message.type !== 'text') throw new Error('expected text message');
    return message.text.split('\n');
  }

  it('店舗名があれば、店舗名を「」で括ったレポートの失敗を先頭の行に置く', () => {
    expect(linesOf(buildInternalErrorRetryMessage(undefined, STORE_NAME))[0]).toBe(
      `「${STORE_NAME}」のレポートを表示できませんでした。`,
    );
    expect(linesOf(buildInternalErrorRetryMessage('abcd1234', STORE_NAME))[0]).toBe(
      `「${STORE_NAME}」のレポートを表示できませんでした。`,
    );
  });

  it('先頭の行のほかは汎用の再試行案内と同じで、行数を増やさない（サポートコード・再試行・問い合わせ）', () => {
    for (const supportCode of [undefined, 'abcd1234']) {
      const generic = linesOf(buildInternalErrorRetryMessage(supportCode));
      const scoped = linesOf(buildInternalErrorRetryMessage(supportCode, STORE_NAME));
      expect(scoped).toHaveLength(generic.length);
      expect(scoped.slice(1)).toEqual(generic.slice(1));
    }
  });

  it('サポートコードは店舗名つきの形でも添える', () => {
    expect(linesOf(buildInternalErrorRetryMessage('abcd1234', STORE_NAME))).toContain('サポートコード: abcd1234');
  });

  it('店舗名が無い（または空の）ときは、汎用の再試行案内のまま', () => {
    expect(buildInternalErrorRetryMessage(undefined, undefined)).toEqual(buildInternalErrorRetryMessage());
    expect(buildInternalErrorRetryMessage('abcd1234', '')).toEqual(buildInternalErrorRetryMessage('abcd1234'));
    expect(linesOf(buildInternalErrorRetryMessage())[0]).toBe('申し訳ございません、処理中にエラーが発生しました。');
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

  it('本文は変化があった日に知らせることとメニューから確認できることを案内する（line-on-demand-report Req 2.10）', () => {
    // 毎朝の配信を約束しない（「毎朝」「毎日」「日次」の不在は全ビルダーを対象とする試験が持つ）。
    // ここでは、約束の代わりに置く 2 つの案内が本文にあることを固定する。
    const message = buildCompletionMessage(LIFF_URL);
    if (message.type !== 'flex') throw new Error('unreachable');
    const contents = message.contents as FlexBubbleContents;
    const joined = contents.body.contents
      .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
      .map((t) => t.text)
      .join('\n');
    expect(joined).toContain('変化があった日');
    expect(joined).toContain('お知らせします');
    expect(joined).toContain('メニューから');
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

// LineMessage は union なので、contents を取り出す前に型を絞る（既存テストと同じ規律）。
function asFlexBubble(message: LineMessage): FlexBubbleContents {
  if (message.type !== 'flex') throw new Error('flex メッセージではない');
  return message.contents as FlexBubbleContents;
}

function asFlexCarousel(message: LineMessage): FlexCarouselContents {
  if (message.type !== 'flex') throw new Error('flex メッセージではない');
  return message.contents as FlexCarouselContents;
}

// Flex JSON 内から text の size / color だけを再帰的に集める（構造に依存しない意匠の観測用）。
function collectTextProp(node: unknown, prop: 'size' | 'color'): string[] {
  if (node === null || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const values: string[] = [];
  if (obj['type'] === 'text' && typeof obj[prop] === 'string') {
    values.push(obj[prop] as string);
  }
  if (Array.isArray(obj['contents'])) {
    for (const child of obj['contents']) {
      values.push(...collectTextProp(child, prop));
    }
  }
  for (const key of ['body', 'footer'] as const) {
    if (key in obj) values.push(...collectTextProp(obj[key], prop));
  }
  return values;
}

describe('4 バブルの意匠の不変条件（スナップショット更新では直らない）', () => {
  // スナップショットは -u 一発で「意匠を元に戻す変更」も静かに受理するため、
  // 意匠の規律そのものはここで固定する。
  const LIFF_URL = 'https://liff.line.me/2010693573-NxEVPPoc';
  const bubbles: readonly { readonly name: string; readonly bubble: FlexBubbleContents }[] = [
    {
      name: '候補カルーセル',
      bubble: asFlexCarousel(buildCandidateCarouselMessage([candidate()])).contents[0] as FlexBubbleContents,
    },
    { name: '確認', bubble: asFlexBubble(buildConfirmationMessage(candidate())) },
    { name: '完了', bubble: asFlexBubble(buildCompletionMessage(LIFF_URL)) },
    {
      name: '既登録エラー',
      bubble: asFlexBubble(buildPlaceAlreadyRegisteredMessage()),
    },
  ];

  it('4 バブルが同じ幅の段をトークンから宣言する', () => {
    for (const { name, bubble } of bubbles) {
      expect(bubble.size, `${name} の幅`).toBe(lineLayout.bubbleSize);
    }
  });

  it('body と footer が同じ内側余白をトークンから宣言する', () => {
    expect(bubbles).toHaveLength(4);
    for (const { name, bubble } of bubbles) {
      expect(bubble.body.paddingAll, `${name} の body`).toBe(lineLayout.blockPadding);
      expect(bubble.footer.paddingAll, `${name} の footer`).toBe(lineLayout.blockPadding);
    }
  });

  it('祝祭の主見出しはオンボーディング全体でちょうど 1 件である', () => {
    const sizes = bubbles.flatMap(({ bubble }) => collectTextProp(bubble, 'size'));
    // 抽出器が空振りしていないこと（0 件しか返さない抽出器でも「1 件でない」は成立してしまう）。
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.filter((size) => size === lineLayout.titleSize)).toHaveLength(1);
  });

  it('アクション色は押せるものだけが持ち、静的な文字は帯びない', () => {
    for (const { name, bubble } of bubbles) {
      const textColors = collectTextProp(bubble, 'color');
      expect(textColors.length, `${name} の色付き本文`).toBeGreaterThan(0);
      expect(textColors, `${name} の本文`).not.toContain(lineColors.action);
    }
  });

  it('主要操作は色と高さの両方をトークンから明示する', () => {
    // 高さを既定に委ねると、LINE 側の既定値が変わったとき日次サマリーの同じ操作と
    // 片方だけ動く。2 面で同じ役割の操作は同じ宣言を持たせる。
    const completion = asFlexBubble(buildCompletionMessage(LIFF_URL));
    const button = completion.footer.contents.find(
      (content): content is FlexButtonComponent => content.type === 'button',
    );
    expect(button).toBeDefined();
    expect(button?.color).toBe(lineColors.action);
    expect(button?.height).toBe(lineLayout.actionHeight);
  });
});

// メッセージの JSON から文字列の値をすべて再帰的に集める。鍵を列挙しないので、text・altText・
// ボタンの label・displayText・クイックリプライなど、どこに文言が入っても拾う。
function collectStrings(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return (node as readonly unknown[]).flatMap((child) => collectStrings(child));
  if (node !== null && typeof node === 'object') {
    return Object.values(node as Record<string, unknown>).flatMap((child) => collectStrings(child));
  }
  return [];
}

// messages.ts が公開するビルダー（LineMessage を返す関数の export）の名前。
type MessageModule = typeof messageModule;
type ExportedBuilderName = {
  [K in keyof MessageModule]: MessageModule[K] extends (...args: never[]) => LineMessage ? K : never;
}[keyof MessageModule];

// 毎日の定期配信を約束する語、または毎日届くと読める語（line-on-demand-report Req 2.10）。
const DAILY_PROMISE_WORDS = ['毎朝', '毎日', '日次'] as const;

describe('全ビルダーの文言が毎日の定期配信を約束しない（line-on-demand-report Req 2.10）', () => {
  const LIFF_URL = 'https://liff.line.me/2010693573-NxEVPPoc';

  // 公開するビルダーを 1 つ残らず呼ぶ表。鍵の過不足は、型検査（必須の鍵と余剰の鍵）と、下の試験の
  // 実行時の照合（関数の export の一覧との一致）の両方で検出する。引数で文言が分かれるものは両方の形を呼ぶ。
  const INVOKE_EVERY_BUILDER: { readonly [K in ExportedBuilderName]: () => readonly LineMessage[] } = {
    buildGreetingMessage: () => [messageModule.buildGreetingMessage()],
    buildInvalidInviteCodeMessage: () => [messageModule.buildInvalidInviteCodeMessage()],
    buildInviteCodeLockedMessage: () => [messageModule.buildInviteCodeLockedMessage()],
    buildStoreNameInputGuidanceMessage: () => [messageModule.buildStoreNameInputGuidanceMessage()],
    buildStatusGuidanceMessage: () => [messageModule.buildStatusGuidanceMessage()],
    buildCandidateCarouselMessage: () => [messageModule.buildCandidateCarouselMessage(candidates(10))],
    buildConfirmationMessage: () => [messageModule.buildConfirmationMessage(candidate())],
    buildCompletionMessage: () => [messageModule.buildCompletionMessage(LIFF_URL)],
    buildStoreNotFoundMessage: () => [messageModule.buildStoreNotFoundMessage()],
    buildSearchFailedMessage: () => [messageModule.buildSearchFailedMessage()],
    buildPlaceAlreadyRegisteredMessage: () => [messageModule.buildPlaceAlreadyRegisteredMessage()],
    buildCandidateSelectionExpiredMessage: () => [messageModule.buildCandidateSelectionExpiredMessage()],
    buildInternalErrorRetryMessage: () => [
      messageModule.buildInternalErrorRetryMessage(),
      messageModule.buildInternalErrorRetryMessage('SUPPORT-0001'),
      messageModule.buildInternalErrorRetryMessage(undefined, '試験食堂 駅前店'),
      messageModule.buildInternalErrorRetryMessage('SUPPORT-0001', '試験食堂 駅前店'),
    ],
  };

  it('表は messages.ts が公開する関数を 1 つ残らず呼ぶ', () => {
    const exportedFunctions = Object.entries(messageModule)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();
    expect(exportedFunctions.length).toBeGreaterThan(0);
    expect(Object.keys(INVOKE_EVERY_BUILDER).sort()).toEqual(exportedFunctions);
  });

  it('文字列の収集は入れ子の奥と末尾に置いた文言も拾う（収集器が空振りしないことの確認）', () => {
    const fixture = {
      type: 'flex',
      altText: '先頭の文言',
      contents: {
        type: 'carousel',
        contents: [{ footer: { contents: [{ action: { label: '押す', displayText: '奥の毎朝' } }] } }],
      },
      quickReply: { items: [{ type: 'action', action: { label: '末尾の毎日' } }] },
    };
    const strings = collectStrings(fixture);
    expect(strings).toContain('先頭の文言');
    expect(strings).toContain('奥の毎朝');
    expect(strings).toContain('末尾の毎日');
  });

  for (const [name, invoke] of Object.entries(INVOKE_EVERY_BUILDER)) {
    it(`${name} の文言は「毎朝」「毎日」「日次」を含まない`, () => {
      const messages = invoke();
      expect(messages.length).toBeGreaterThan(0);
      for (const message of messages) {
        const strings = collectStrings(message);
        // 空振りの防止: 日本語の文言を 1 つ以上拾えていること（0 件を「不在」と読まない）。
        expect(strings.some((value) => JAPANESE_CHAR_PATTERN.test(value)), `${name} の日本語の文言`).toBe(true);
        for (const word of DAILY_PROMISE_WORDS) {
          expect(strings.filter((value) => value.includes(word)), `${name} の「${word}」`).toEqual([]);
        }
      }
    });
  }
});

describe('テキスト案内のスナップショット（文言の差分を目視する材料）', () => {
  it('ステータス案内', () => {
    expect(buildStatusGuidanceMessage()).toMatchSnapshot();
  });

  it('店舗名つきの再試行案内（サポートコードあり）', () => {
    expect(buildInternalErrorRetryMessage('abcd1234', '試験食堂 駅前店')).toMatchSnapshot();
  });
});

describe('Flex JSON のスナップショット（Flex Message Simulator へ貼って目視する材料）', () => {
  const LIFF_URL = 'https://liff.line.me/2010693573-NxEVPPoc';

  it('候補カルーセル（1 件）', () => {
    expect(buildCandidateCarouselMessage([candidate()])).toMatchSnapshot();
  });

  it('確認', () => {
    expect(buildConfirmationMessage(candidate())).toMatchSnapshot();
  });

  it('完了', () => {
    expect(buildCompletionMessage(LIFF_URL)).toMatchSnapshot();
  });

  it('既登録エラー', () => {
    expect(buildPlaceAlreadyRegisteredMessage()).toMatchSnapshot();
  });
});
