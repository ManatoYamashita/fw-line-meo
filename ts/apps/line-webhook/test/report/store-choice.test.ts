// 店舗の選択肢のメッセージの試験（design.md「Report builders（表示）」の StoreChoiceBuilder・
// Requirements 3.2, 3.6, 3.9, 3.10）。
// - 「どの店舗の〇〇を表示しますか」の本文と、店舗ごとのクイックリプライ（postback）を持つこと
// - クイックリプライは 13 件以内（1 頁 12 店と、次の頁があるときだけ「ほかの店舗」）
// - 無効な選択の「その店舗は選べません」は本文の先頭に置き、項目を増やさないこと
// - ラベルは 20 文字以内に省略し、同じ頁で衝突したときは末尾を残して区別すること
// - displayText は店舗名そのもの（300 文字を超える名前だけを切る）
// - postback は @fwlm/line-report の符号化の出力で、店舗の選択は表示した頁を運ぶこと
// - 符号化できる頁は 0〜99 なので、たどって選べるのは 1200 店までであること（既知の限界）
import { describe, expect, it } from 'vitest';
import type { ReportableStore } from '@fwlm/db';
import {
  REPORT_LABELS,
  decodeReportPostback,
  encodeReportPostback,
  type ReportKind,
  type ReportRequest,
} from '@fwlm/line-report';
import type { LineMessage } from '../../src/line/client.js';
import type { QuickReplyItem } from '../../src/line/flex-types.js';
import { DISPLAY_TEXT_MAX_LENGTH, buildStoreChoiceMessage } from '../../src/report/builders/store-choice.js';
import {
  STORE_CHOICE_PAGE_SIZE,
  STORE_LABEL_MAX_LENGTH,
  labelStoreChoices,
  resolveTargetStore,
  type StoreChoicePage,
  type StoreResolution,
} from '../../src/report/stores.js';

// LINE のクイックリプライの項目数の上限（references/message-objects.md の Quick Reply）。
const QUICK_REPLY_MAX_ITEMS = 13;
// postback の data の上限（references/action-objects.md の Postback Action）。
const POSTBACK_DATA_MAX_LENGTH = 300;

const KINDS: readonly ReportKind[] = ['new_reviews', 'comparison', 'trend'];
const SUBJECTS: Readonly<Record<ReportKind, string>> = {
  new_reviews: '新着口コミ',
  comparison: '競合店との比較',
  trend: '直近の推移',
};

const NEXT_PAGE_LABEL = 'ほかの店舗';

// 他のオーナーの店舗という想定の、uuid の形の値。
const FOREIGN_STORE_ID = 'ffffffff-0000-4000-8000-000000000001';

// 対になっていない UTF-16 のサロゲート（u フラグを付けずに符号単位で照合する）。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function fakeStoreId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function makeStores(count: number): ReportableStore[] {
  return Array.from({ length: count }, (_, i) => ({
    id: fakeStoreId(i + 1),
    name: `試験店舗${String(i + 1).padStart(4, '0')}`,
  }));
}

function page(stores: readonly ReportableStore[], pageIndex = 0, nextPageIndex: number | null = null): StoreChoicePage {
  return { stores, pageIndex, nextPageIndex };
}

function codePoints(text: string): number {
  return [...text].length;
}

function asText(message: LineMessage): Extract<LineMessage, { type: 'text' }> {
  if (message.type !== 'text') {
    throw new Error(`text を期待したが ${message.type} だった`);
  }
  return message;
}

function itemsOf(message: LineMessage): readonly QuickReplyItem[] {
  const items = asText(message).quickReply?.items;
  if (items === undefined) {
    throw new Error('クイックリプライが無い');
  }
  return items;
}

function decodeItem(item: QuickReplyItem): ReportRequest {
  const decoded = decodeReportPostback(item.action.data);
  if (decoded === null) {
    throw new Error(`レポートの postback として復号できない: ${item.action.data}`);
  }
  return decoded;
}

function choose(result: StoreResolution): Extract<StoreResolution, { kind: 'choose' }> {
  if (result.kind !== 'choose') {
    throw new Error(`choose を期待したが ${result.kind} だった`);
  }
  return result;
}

describe('本文（3.2・3.6）', () => {
  it.each(KINDS)('%s: 「どの店舗の〇〇を表示しますか」と、選び方を 2 行で案内する', (kind) => {
    const text = asText(buildStoreChoiceMessage(kind, page(makeStores(3)), 'multiple')).text;
    expect(text).toBe(`どの店舗の${SUBJECTS[kind]}を表示しますか？\n下の店舗名から選んでください。`);
  });

  it.each(KINDS)('%s: 無効な選択なら「その店舗は選べません」を先頭の行に置く', (kind) => {
    const text = asText(buildStoreChoiceMessage(kind, page(makeStores(3)), 'invalid_choice')).text;
    expect(text).toBe(
      `その店舗は選べません。\nどの店舗の${SUBJECTS[kind]}を表示しますか？\n下の店舗名から選んでください。`,
    );
  });

  it('本文は 3 行以内で、絵文字と強調の記号を使わない（design-language.md §7.16）', () => {
    for (const kind of KINDS) {
      for (const reason of ['multiple', 'invalid_choice'] as const) {
        const text = asText(buildStoreChoiceMessage(kind, page(makeStores(13).slice(0, 12), 0, 1), reason)).text;
        expect(text.split('\n').length).toBeLessThanOrEqual(3);
        expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(text).not.toContain('**');
      }
    }
  });

  it('本文の〇〇は、メニューの導線の文言の先頭と一致する（別の名前で呼ばない）', () => {
    for (const kind of KINDS) {
      expect(REPORT_LABELS[kind].startsWith(SUBJECTS[kind])).toBe(true);
    }
  });

  it('無効な選択でも、選択肢の項目は増えない', () => {
    const stores = makeStores(5);
    expect(itemsOf(buildStoreChoiceMessage('trend', page(stores), 'invalid_choice'))).toEqual(
      itemsOf(buildStoreChoiceMessage('trend', page(stores), 'multiple')),
    );
  });
});

describe('クイックリプライの件数（3.2・3.10）', () => {
  it('店舗ごとに 1 件、頁の順に並べ、次の頁が無ければ「ほかの店舗」を出さない', () => {
    const stores = makeStores(5);
    const items = itemsOf(buildStoreChoiceMessage('comparison', page(stores), 'multiple'));
    expect(items).toHaveLength(5);
    expect(items.map((item) => decodeItem(item).storeId)).toEqual(stores.map((store) => store.id));
    expect(items.map((item) => item.action.label)).not.toContain(NEXT_PAGE_LABEL);
  });

  it('1 頁 12 店と「ほかの店舗」で、ちょうど上限の 13 件になる', () => {
    const stores = makeStores(STORE_CHOICE_PAGE_SIZE);
    const items = itemsOf(buildStoreChoiceMessage('comparison', page(stores, 0, 1), 'multiple'));
    expect(items).toHaveLength(QUICK_REPLY_MAX_ITEMS);
    expect(items[QUICK_REPLY_MAX_ITEMS - 1]?.action.label).toBe(NEXT_PAGE_LABEL);
  });

  it('頁の店舗が 0 店か 13 店以上なら例外にする（13 件の上限を超える選択肢を LINE へ送らない）', () => {
    expect(() => buildStoreChoiceMessage('comparison', page([]), 'multiple')).toThrow();
    expect(() => buildStoreChoiceMessage('comparison', page(makeStores(13)), 'multiple')).toThrow();
    expect(() => buildStoreChoiceMessage('comparison', page(makeStores(13), 0, 1), 'invalid_choice')).toThrow();
  });

  it.each([1, 2, 12, 13, 24, 25, 100, 1300])(
    '%i 店のどの頁でも、項目は 13 件以内で、すべて type が action の postback である',
    (count) => {
      const stores = makeStores(count);
      const pageCount = Math.ceil(count / STORE_CHOICE_PAGE_SIZE);
      for (const pageIndex of [0, 1, Math.min(pageCount - 1, 99)]) {
        // 集合外の店舗を指定すると、店舗の数によらず選択肢の頁が返る（1 店でも）。
        const { page: choicePage } = choose(
          resolveTargetStore(stores, { kind: 'trend', storeId: FOREIGN_STORE_ID, page: pageIndex }),
        );
        for (const reason of ['multiple', 'invalid_choice'] as const) {
          const items = itemsOf(buildStoreChoiceMessage('trend', choicePage, reason));
          expect(items.length).toBeGreaterThan(0);
          expect(items.length).toBeLessThanOrEqual(QUICK_REPLY_MAX_ITEMS);
          for (const item of items) {
            expect(item.type).toBe('action');
            expect(item.action.type).toBe('postback');
          }
        }
      }
    },
  );
});

describe('ラベルと displayText（3.9）', () => {
  it('20 文字以内の店舗名は、ラベルも displayText もそのまま使う', () => {
    const stores: ReportableStore[] = [
      { id: fakeStoreId(1), name: '試験食堂' },
      { id: fakeStoreId(2), name: 'あいうえおかきくけこさしすせそたちつてと' },
    ];
    const items = itemsOf(buildStoreChoiceMessage('new_reviews', page(stores), 'multiple'));
    expect(items.map((item) => item.action.label)).toEqual(stores.map((store) => store.name));
    expect(items.map((item) => item.action.displayText)).toEqual(stores.map((store) => store.name));
  });

  it('20 文字を超える店舗名は、ラベルだけを省略し、displayText には省略しない店舗名を入れる', () => {
    const longName = 'とても長い名前の試験用のレストラン 本店 東口';
    const stores: ReportableStore[] = [
      { id: fakeStoreId(1), name: longName },
      { id: fakeStoreId(2), name: '試験食堂' },
    ];
    const [first] = itemsOf(buildStoreChoiceMessage('new_reviews', page(stores), 'multiple'));
    expect(first?.action.label).toBe('とても長い名前の試験用のレストラン 本…');
    expect(first?.action.displayText).toBe(longName);
  });

  it('ラベルは頁の店舗から labelStoreChoices で作る（同じ頁で衝突した長い名前は末尾を残して区別する）', () => {
    const stores: ReportableStore[] = [
      { id: fakeStoreId(1), name: '試験グループ運営のとても長い名前の焼肉店 渋谷道玄坂店' },
      { id: fakeStoreId(2), name: '試験グループ運営のとても長い名前の焼肉店 新宿東口店' },
      { id: fakeStoreId(3), name: '試験食堂' },
    ];
    const items = itemsOf(buildStoreChoiceMessage('comparison', page(stores), 'multiple'));
    const labels = items.map((item) => item.action.label);
    expect(labels).toEqual(labelStoreChoices(stores).map(({ label }) => label));
    expect(new Set(labels).size).toBe(3);
    expect(labels[0]?.endsWith('渋谷道玄坂店')).toBe(true);
    expect(labels[1]?.endsWith('新宿東口店')).toBe(true);
    for (const label of labels) {
      expect(codePoints(label)).toBeLessThanOrEqual(STORE_LABEL_MAX_LENGTH);
    }
    // displayText は衝突の有無によらず全文である。
    expect(items.map((item) => item.action.displayText)).toEqual(stores.map((store) => store.name));
  });

  it('300 文字を超える店舗名だけ、displayText を 299 文字と「…」の 300 文字にする', () => {
    const at300 = 'あ'.repeat(DISPLAY_TEXT_MAX_LENGTH);
    const over300 = `${'い'.repeat(DISPLAY_TEXT_MAX_LENGTH)}う`;
    const stores: ReportableStore[] = [
      { id: fakeStoreId(1), name: at300 },
      { id: fakeStoreId(2), name: over300 },
    ];
    const [first, second] = itemsOf(buildStoreChoiceMessage('trend', page(stores), 'multiple'));
    expect(DISPLAY_TEXT_MAX_LENGTH).toBe(300);
    expect(first?.action.displayText).toBe(at300);
    expect(second?.action.displayText).toBe(`${'い'.repeat(DISPLAY_TEXT_MAX_LENGTH - 1)}…`);
  });

  it('displayText はコードポイントで数え、書記素の境目で切る（絵文字を割らない）', () => {
    const sushi = '\u{1F363}';
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    const stores: ReportableStore[] = [
      // BMP の外の文字だけの 300 コードポイント（UTF-16 では 600 単位）はそのまま使う。
      { id: fakeStoreId(1), name: sushi.repeat(DISPLAY_TEXT_MAX_LENGTH) },
      // 切る位置に 5 コードポイントの連結絵文字を置く。入り切らなければ丸ごと落とす。
      { id: fakeStoreId(2), name: `${'あ'.repeat(296)}${family}い` },
    ];
    const [first, second] = itemsOf(buildStoreChoiceMessage('trend', page(stores), 'multiple'));
    expect(first?.action.displayText).toBe(sushi.repeat(DISPLAY_TEXT_MAX_LENGTH));
    expect(second?.action.displayText).toBe(`${'あ'.repeat(296)}…`);
    for (const item of [first, second]) {
      const displayText = item?.action.displayText ?? '';
      expect(codePoints(displayText)).toBeLessThanOrEqual(DISPLAY_TEXT_MAX_LENGTH);
      expect(LONE_SURROGATE.test(displayText)).toBe(false);
    }
  });

  it('「ほかの店舗」は、ラベルと displayText のどちらも「ほかの店舗」である', () => {
    const items = itemsOf(buildStoreChoiceMessage('trend', page(makeStores(12), 0, 1), 'multiple'));
    const next = items[items.length - 1];
    expect(next?.action.label).toBe(NEXT_PAGE_LABEL);
    expect(next?.action.displayText).toBe(NEXT_PAGE_LABEL);
  });
});

describe('postback（3.2・3.6・3.10）', () => {
  it.each(KINDS)('%s: 店舗の選択は、種類・店舗・表示した頁を運ぶ（符号化の出力そのもの）', (kind) => {
    const stores = makeStores(STORE_CHOICE_PAGE_SIZE);
    for (const pageIndex of [0, 1, 7, 99]) {
      const items = itemsOf(buildStoreChoiceMessage(kind, page(stores, pageIndex, null), 'multiple'));
      items.forEach((item, i) => {
        const store = stores[i];
        if (store === undefined) throw new Error('fixture: 店舗が足りない');
        const expected: ReportRequest = { kind, storeId: store.id, page: pageIndex };
        expect(item.action.data).toBe(encodeReportPostback(expected));
        expect(decodeItem(item)).toEqual(expected);
      });
    }
  });

  it.each(KINDS)('%s: 「ほかの店舗」は、種類と次の頁だけを運ぶ（店舗を持たない）', (kind) => {
    const items = itemsOf(buildStoreChoiceMessage(kind, page(makeStores(12), 3, 4), 'multiple'));
    const next = items[items.length - 1];
    if (next === undefined) throw new Error('unreachable');
    const expected: ReportRequest = { kind, storeId: null, page: 4 };
    expect(next.action.data).toBe(encodeReportPostback(expected));
    expect(decodeItem(next)).toEqual(expected);
  });

  it('data は 300 文字以内である', () => {
    const items = itemsOf(buildStoreChoiceMessage('comparison', page(makeStores(12), 98, 99), 'invalid_choice'));
    for (const item of items) {
      expect(item.action.data.length).toBeLessThanOrEqual(POSTBACK_DATA_MAX_LENGTH);
    }
  });

  it('無効な選択の後は、選んだ店舗を表示していた頁を再提示する（頁を運ぶ理由）', () => {
    const stores = makeStores(25);
    const shown = choose(resolveTargetStore(stores, { kind: 'comparison', storeId: null, page: 1 }));
    const [firstOnPage1] = itemsOf(buildStoreChoiceMessage('comparison', shown.page, shown.reason));
    if (firstOnPage1 === undefined) throw new Error('unreachable');
    const tapped = decodeItem(firstOnPage1);

    // 選択肢を出した後に、その店舗が対象から外れた（停止など）。
    const remaining = stores.filter((store) => store.id !== tapped.storeId);
    const again = choose(resolveTargetStore(remaining, tapped));
    expect(again.reason).toBe('invalid_choice');
    expect(again.page.pageIndex).toBe(1);
    expect(asText(buildStoreChoiceMessage('comparison', again.page, again.reason)).text.startsWith('その店舗は選べません。')).toBe(
      true,
    );
  });
});

describe('頁の上限（3.10 の既知の限界: 1200 店）', () => {
  it('前提: 符号化は頁 99 を受理し、頁 100 を受理しない', () => {
    expect(() => encodeReportPostback({ kind: 'trend', storeId: null, page: 99 })).not.toThrow();
    expect(() => encodeReportPostback({ kind: 'trend', storeId: null, page: 100 })).toThrow();
  });

  it('次の頁が 99 なら「ほかの店舗」を出し、100 なら出さない（符号化できない頁を送らない）', () => {
    const stores = makeStores(STORE_CHOICE_PAGE_SIZE);
    const at98 = itemsOf(buildStoreChoiceMessage('trend', page(stores, 98, 99), 'multiple'));
    expect(at98).toHaveLength(QUICK_REPLY_MAX_ITEMS);
    const next = at98[at98.length - 1];
    if (next === undefined) throw new Error('unreachable');
    expect(decodeItem(next)).toEqual({ kind: 'trend', storeId: null, page: 99 });

    const at99 = itemsOf(buildStoreChoiceMessage('trend', page(stores, 99, 100), 'multiple'));
    expect(at99).toHaveLength(STORE_CHOICE_PAGE_SIZE);
    expect(at99.map((item) => item.action.label)).not.toContain(NEXT_PAGE_LABEL);
  });

  it.each([
    [1200, 1200],
    [1201, 1200],
    [1300, 1200],
    [37, 37],
  ])('%i 店のとき、0 頁目から「ほかの店舗」をたどって選べるのは %i 店である', (count, reachable) => {
    const stores = makeStores(count);
    const seen = new Set<string>();
    let request: ReportRequest | null = { kind: 'new_reviews', storeId: null, page: 0 };
    // 巡回する誤りで試験が止まらないよう、たどる回数に上限を置く。
    for (let step = 0; request !== null && step < 200; step += 1) {
      const { page: choicePage, reason } = choose(resolveTargetStore(stores, request));
      const items = itemsOf(buildStoreChoiceMessage('new_reviews', choicePage, reason));
      request = null;
      for (const item of items) {
        const decoded = decodeItem(item);
        if (decoded.storeId === null) {
          request = decoded;
        } else {
          seen.add(decoded.storeId);
        }
      }
    }
    expect(request).toBeNull();
    expect(seen.size).toBe(reachable);
    // たどれた店舗は先頭から reachable 店である（途中を飛ばしていない）。
    expect([...seen]).toEqual(stores.slice(0, reachable).map((store) => store.id));
  });
});

describe('スナップショット（LINE へ送る JSON の記録）', () => {
  const stores: ReportableStore[] = [
    { id: fakeStoreId(1), name: '試験食堂 駅前店' },
    { id: fakeStoreId(2), name: '試験グループ運営のとても長い名前の焼肉店 渋谷道玄坂店' },
    { id: fakeStoreId(3), name: '試験グループ運営のとても長い名前の焼肉店 新宿東口店' },
  ];

  it('複数店舗の選択肢', () => {
    expect(buildStoreChoiceMessage('new_reviews', page(stores), 'multiple')).toMatchSnapshot();
  });

  it('無効な選択の再提示', () => {
    expect(buildStoreChoiceMessage('comparison', page(stores), 'invalid_choice')).toMatchSnapshot();
  });

  it('次の頁がある選択肢', () => {
    expect(buildStoreChoiceMessage('trend', page(makeStores(12), 0, 1), 'multiple')).toMatchSnapshot();
  });
});
