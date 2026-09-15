// 店舗の解決と選択肢の頁の試験（design.md「StoreSelection」・Requirements 3.1, 3.2, 3.3, 3.6, 3.9, 3.10）。
// - 1 店なら選択なしで決まり、複数なら選択肢を出し、店舗が無ければ none を返すこと
// - 解決した店舗と選択肢の店舗が、必ず入力の配列の要素そのものであること（IDOR の構造的排除）
// - 集合外の店舗 ID には、その ID が他所に実在するかどうかに関わらず同じ応答を返すこと（非オラクル）
// - 選択肢が 1 頁 12 店で、次の頁があるときだけ次の頁の番号を持ち、範囲外の頁を 0 頁目として扱うこと
// - 20 文字を超える店名を 19 文字と「…」に省略し、絵文字や結合文字を途中で割らないこと
// - 同じ頁で省略したラベルが衝突したときだけ、衝突した店舗を先頭＋「…」＋末尾の形で区別すること
import { describe, expect, it } from 'vitest';
import type { ReportableStore } from '@fwlm/db';
import type { ReportKind, ReportRequest } from '@fwlm/line-report';
import {
  STORE_CHOICE_PAGE_SIZE,
  STORE_LABEL_MAX_LENGTH,
  abbreviateStoreLabel,
  labelStoreChoices,
  resolveTargetStore,
  type StoreResolution,
} from '../../src/report/stores.js';

// LINE のクイックリプライの項目数の上限（references/message-objects.md の Quick Reply）。
const QUICK_REPLY_MAX_ITEMS = 13;

const KINDS: readonly ReportKind[] = ['new_reviews', 'comparison', 'trend'];

// stores.id と同じ uuid の形の値を番号から作る（実在の店舗とは無関係）。
function fakeStoreId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function makeStores(count: number): ReportableStore[] {
  return Array.from({ length: count }, (_, i) => ({
    id: fakeStoreId(i + 1),
    name: `試験店舗${String(i + 1).padStart(3, '0')}`,
  }));
}

function request(storeId: string | null, page = 0, kind: ReportKind = 'comparison'): ReportRequest {
  return { kind, storeId, page };
}

function resolvedStore(result: StoreResolution): ReportableStore {
  if (result.kind !== 'resolved') {
    throw new Error(`resolved を期待したが ${result.kind} だった`);
  }
  return result.store;
}

function choice(result: StoreResolution): Extract<StoreResolution, { kind: 'choose' }> {
  if (result.kind !== 'choose') {
    throw new Error(`choose を期待したが ${result.kind} だった`);
  }
  return result;
}

// 他のオーナーの店舗という想定の、uuid の形の値。
const FOREIGN_STORE_ID = 'ffffffff-0000-4000-8000-000000000001';

// 集合外の店舗 ID。実在しそうな uuid の形の値と、形の崩れた値を混ぜる。
// Object の添字で引く実装が値を返してしまう名前（__proto__ など）も入れる。
const OUT_OF_SET_IDS: readonly string[] = [
  FOREIGN_STORE_ID,
  '3f2c9a4e-1b7d-4c8e-9a51-6d0e2f7b8c13',
  'not-a-uuid',
  '',
  'x'.repeat(64),
  '__proto__',
  'toString',
  'constructor',
];

// 範囲外の頁。復号器は 0〜99 の整数しか返さないが、関数は ReportRequest を直接受けるので、
// 負の数・小数・NaN・無限大も 0 頁目へ倒れることを確かめる。
const OUT_OF_RANGE_PAGES: readonly number[] = [2, 3, 99, 100, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

// 対になっていない UTF-16 のサロゲート（u フラグを付けずに符号単位で照合する）。
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// 絵文字の ZWJ 連結（家族: 男性・ZWJ・女性・ZWJ・女の子）。5 コードポイントで 1 書記素。
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';
// 結合用の濁点（U+3099）を伴う「か」。2 コードポイントで 1 書記素（「が」と読まれる）。
const KA_WITH_COMBINING_DAKUTEN = 'が';
// 国旗（地域指示記号 2 つ）。2 コードポイントで 1 書記素。
const FLAG_JP = '\u{1F1EF}\u{1F1F5}';
// BMP の外の漢字（UTF-16 ではサロゲートペア）。1 コードポイントで 1 書記素。
const SURROGATE_KANJI = '\u{20BB7}';

function codePoints(text: string): number {
  return [...text].length;
}

describe('定数', () => {
  it('1 頁の店舗数は 12 で、「ほかの店舗」を足してもクイックリプライの上限 13 件に収まる', () => {
    expect(STORE_CHOICE_PAGE_SIZE).toBe(12);
    expect(STORE_CHOICE_PAGE_SIZE + 1).toBeLessThanOrEqual(QUICK_REPLY_MAX_ITEMS);
  });

  it('ラベルの上限はクイックリプライのラベルの上限の 20 文字である', () => {
    expect(STORE_LABEL_MAX_LENGTH).toBe(20);
  });
});

describe('resolveTargetStore: 対象店舗が無い', () => {
  it.each([null, fakeStoreId(1), FOREIGN_STORE_ID])('店舗の指定（%s）と頁によらず none を返す', (storeId) => {
    expect(resolveTargetStore([], request(storeId))).toEqual({ kind: 'none' });
    expect(resolveTargetStore([], request(storeId, 5))).toEqual({ kind: 'none' });
  });
});

describe('resolveTargetStore: 1 店（3.1）', () => {
  const stores = makeStores(1);

  it('店舗の指定が無ければ、選択なしでその店舗に決まる', () => {
    const result = resolveTargetStore(stores, request(null));
    expect(result).toEqual({ kind: 'resolved', store: stores[0] });
    expect(resolvedStore(result)).toBe(stores[0]);
  });

  it('頁の番号を持つ要求（古い「ほかの店舗」）でも、その店舗に決まる', () => {
    expect(resolvedStore(resolveTargetStore(stores, request(null, 3)))).toBe(stores[0]);
  });

  it('その店舗を指定すれば、その店舗に決まる', () => {
    expect(resolvedStore(resolveTargetStore(stores, request(fakeStoreId(1))))).toBe(stores[0]);
  });

  it('集合外の店舗を指定すれば、その 1 店を選択肢として再提示し、指定を採らない（3.6）', () => {
    expect(resolveTargetStore(stores, request(FOREIGN_STORE_ID))).toEqual({
      kind: 'choose',
      reason: 'invalid_choice',
      page: { stores: [stores[0]], pageIndex: 0, nextPageIndex: null },
    });
  });
});

describe('resolveTargetStore: 複数店（3.2・3.3）', () => {
  it.each([2, 5, 12])('%i 店で店舗の指定が無ければ、全店を 1 頁の選択肢として出す', (count) => {
    const stores = makeStores(count);
    const result = resolveTargetStore(stores, request(null));
    expect(result).toEqual({
      kind: 'choose',
      reason: 'multiple',
      page: { stores, pageIndex: 0, nextPageIndex: null },
    });
    choice(result).page.stores.forEach((store, i) => expect(store).toBe(stores[i]));
  });

  it('選んだ店舗に決まり、戻り値は入力の配列のその要素そのものである', () => {
    const stores = makeStores(5);
    for (const store of stores) {
      expect(resolvedStore(resolveTargetStore(stores, request(store.id)))).toBe(store);
    }
  });

  it('同じ名前の店舗があっても、ID で選んだ方に決まる', () => {
    const stores: ReportableStore[] = [
      { id: fakeStoreId(1), name: '試験食堂' },
      { id: fakeStoreId(2), name: '試験食堂' },
    ];
    expect(resolvedStore(resolveTargetStore(stores, request(fakeStoreId(2))))).toBe(stores[1]);
    expect(resolvedStore(resolveTargetStore(stores, request(fakeStoreId(1))))).toBe(stores[0]);
  });

  it('20 文字を超える店名でも、解決した店舗と選択肢の店舗の名前は省略しない（3.3・3.9）', () => {
    const longName = 'あ'.repeat(40);
    const stores: ReportableStore[] = [
      { id: fakeStoreId(1), name: longName },
      { id: fakeStoreId(2), name: '試験店舗' },
    ];
    expect(resolvedStore(resolveTargetStore(stores, request(fakeStoreId(1)))).name).toBe(longName);
    expect(choice(resolveTargetStore(stores, request(null))).page.stores[0]?.name).toBe(longName);
  });

  it('店舗を指定した要求は、種類と頁の番号によらず同じ店舗に決まる', () => {
    const stores = makeStores(25);
    const target = stores[20];
    if (target === undefined) throw new Error('fixture: 21 店目が無い');
    for (const kind of KINDS) {
      for (const page of [0, 1, 2, 99]) {
        expect(resolvedStore(resolveTargetStore(stores, request(target.id, page, kind)))).toBe(target);
      }
    }
  });
});

describe('resolveTargetStore: 集合外の指定（3.6・非オラクル）', () => {
  it.each([1, 2, 12, 13, 25])(
    '%i 店のとき、集合外の ID はどれも同じ invalid_choice になる（実在しそうな ID と形の崩れた ID で応答が変わらない）',
    (count) => {
      const stores = makeStores(count);
      for (const page of [0, 1]) {
        const baseline = resolveTargetStore(stores, request(FOREIGN_STORE_ID, page));
        expect(choice(baseline).reason).toBe('invalid_choice');
        for (const storeId of OUT_OF_SET_IDS) {
          expect(resolveTargetStore(stores, request(storeId, page))).toEqual(baseline);
        }
      }
    },
  );

  it('再提示の頁は、店舗の指定が無い要求と同じ頁である（理由だけが違う）', () => {
    const stores = makeStores(25);
    for (const page of [0, 1, 2]) {
      const menu = choice(resolveTargetStore(stores, request(null, page)));
      expect(menu.reason).toBe('multiple');
      expect(resolveTargetStore(stores, request(FOREIGN_STORE_ID, page))).toEqual({
        ...menu,
        reason: 'invalid_choice',
      });
    }
  });

  it('応答に、指定された集合外の ID が現れない', () => {
    const stores = makeStores(13);
    for (const storeId of [FOREIGN_STORE_ID, '3f2c9a4e-1b7d-4c8e-9a51-6d0e2f7b8c13']) {
      expect(JSON.stringify(resolveTargetStore(stores, request(storeId)))).not.toContain(storeId);
    }
  });
});

describe('resolveTargetStore: 解決した店舗は必ず入力の要素（IDOR の構造的排除）', () => {
  it('店舗の集合・店舗の指定・頁のあらゆる組合せで、resolved の店舗と選択肢の店舗は入力の要素そのものである', () => {
    const storeSets: ReportableStore[][] = [
      [],
      makeStores(1),
      makeStores(2),
      makeStores(12),
      makeStores(13),
      makeStores(25),
      [
        { id: fakeStoreId(1), name: '同名の店' },
        { id: fakeStoreId(2), name: '同名の店' },
        { id: fakeStoreId(3), name: '同名の店' },
      ],
    ];
    const pages = [0, 1, 2, 3, 99, 100, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
    const counts: Record<StoreResolution['kind'], number> = { resolved: 0, choose: 0, none: 0 };

    for (const stores of storeSets) {
      // 集合の内の ID・集合外の ID に加え、集合の内の ID に近い値（大文字・前後の空白・1 文字欠け）を指定する。
      const storeIds: (string | null)[] = [
        null,
        ...OUT_OF_SET_IDS,
        ...stores.map((store) => store.id),
        ...stores.map((store) => store.id.toUpperCase()),
        ...stores.map((store) => ` ${store.id}`),
        ...stores.map((store) => store.id.slice(0, -1)),
      ];
      for (const storeId of storeIds) {
        for (const page of pages) {
          const result = resolveTargetStore(stores, request(storeId, page));
          counts[result.kind] += 1;
          if (result.kind === 'resolved') {
            // toContain は配列に対して同一性（===）で照合する。
            expect(stores).toContain(result.store);
          } else if (result.kind === 'choose') {
            expect(result.page.stores.length).toBeGreaterThan(0);
            expect(result.page.stores.length).toBeLessThanOrEqual(STORE_CHOICE_PAGE_SIZE);
            for (const store of result.page.stores) {
              expect(stores).toContain(store);
            }
          } else {
            expect(stores).toHaveLength(0);
          }
        }
      }
    }

    // 組合せが 3 種類の結果をすべて通ったことを確かめる（空振りの防止）。
    expect(counts.resolved).toBeGreaterThan(0);
    expect(counts.choose).toBeGreaterThan(0);
    expect(counts.none).toBeGreaterThan(0);
  });
});

describe('resolveTargetStore: 選択肢の頁（3.10）', () => {
  // [店舗数, 頁ごとの [店舗数, 次の頁の番号]]
  const cases: [number, [number, number | null][]][] = [
    [12, [[12, null]]],
    [
      13,
      [
        [12, 1],
        [1, null],
      ],
    ],
    [
      24,
      [
        [12, 1],
        [12, null],
      ],
    ],
    [
      25,
      [
        [12, 1],
        [12, 2],
        [1, null],
      ],
    ],
  ];

  it.each(cases)('%i 店の頁の分け方', (count, expectedPages) => {
    const stores = makeStores(count);
    expectedPages.forEach(([size, nextPageIndex], pageIndex) => {
      const { page } = choice(resolveTargetStore(stores, request(null, pageIndex)));
      expect(page.pageIndex).toBe(pageIndex);
      expect(page.nextPageIndex).toBe(nextPageIndex);
      // 入力の順のまま、頁の位置の店舗を切り出している。
      expect(page.stores).toHaveLength(size);
      page.stores.forEach((store, i) => expect(store).toBe(stores[pageIndex * 12 + i]));
    });
  });

  it.each([2, 11, 12, 13, 24, 25, 37, 100])(
    '%i 店のとき、0 頁目から次の頁をたどると全店舗を 1 度ずつ選べる',
    (count) => {
      const stores = makeStores(count);
      const seen: ReportableStore[] = [];
      let pageIndex: number | null = 0;
      // 次の頁が巡回する誤りで試験が止まらなくならないよう、たどる回数に上限を置く。
      for (let step = 0; pageIndex !== null && step < 20; step += 1) {
        const { page } = choice(resolveTargetStore(stores, request(null, pageIndex)));
        expect(page.pageIndex).toBe(pageIndex);
        seen.push(...page.stores);
        pageIndex = page.nextPageIndex;
      }
      expect(pageIndex).toBeNull();
      expect(seen).toHaveLength(stores.length);
      seen.forEach((store, i) => expect(store).toBe(stores[i]));
    },
  );

  it.each(OUT_OF_RANGE_PAGES)('範囲外の頁（%s）は 0 頁目として扱う', (page) => {
    const stores = makeStores(13);
    const first = choice(resolveTargetStore(stores, request(null, 0)));
    expect(first.page.pageIndex).toBe(0);
    expect(resolveTargetStore(stores, request(null, page))).toEqual(first);
    expect(resolveTargetStore(stores, request(FOREIGN_STORE_ID, page))).toEqual({
      ...first,
      reason: 'invalid_choice',
    });
  });

  it('1 頁に収まる店舗数では、1 頁目の要求も 0 頁目として扱う', () => {
    const stores = makeStores(12);
    expect(resolveTargetStore(stores, request(null, 1))).toEqual(resolveTargetStore(stores, request(null, 0)));
  });
});

describe('abbreviateStoreLabel（3.9）', () => {
  it.each([
    '',
    '試験店舗',
    'あいうえおかきくけこさしすせそたちつて',
    'あいうえおかきくけこさしすせそたちつてと',
    'A'.repeat(20),
  ])('20 文字以内の名前（%s）はそのまま返す', (name) => {
    expect(abbreviateStoreLabel(name)).toBe(name);
  });

  it('21 文字の名前は、先頭の 19 文字と「…」の 20 文字にする', () => {
    const label = abbreviateStoreLabel('あいうえおかきくけこさしすせそたちつてとな');
    expect(label).toBe('あいうえおかきくけこさしすせそたちつて…');
    expect(codePoints(label)).toBe(20);
  });

  it('長い名前も、先頭の 19 文字と「…」にする', () => {
    expect(abbreviateStoreLabel('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ')).toBe(
      'あいうえおかきくけこさしすせそたちつて…',
    );
  });

  it('BMP の外の漢字を含む 20 文字の名前は、UTF-16 で 21 単位でもそのまま返す', () => {
    const name = `${SURROGATE_KANJI}${'あ'.repeat(19)}`;
    expect(name.length).toBe(21);
    expect(abbreviateStoreLabel(name)).toBe(name);
  });

  it('省略の境目にあるサロゲートペアを割らない', () => {
    // UTF-16 の 19 単位で切ると、ちょうどペアの間で割れる位置に置く。
    expect(abbreviateStoreLabel(`${'あ'.repeat(18)}${SURROGATE_KANJI}いう`)).toBe(
      `${'あ'.repeat(18)}${SURROGATE_KANJI}…`,
    );
    expect(abbreviateStoreLabel('\u{1F363}'.repeat(21))).toBe(`${'\u{1F363}'.repeat(19)}…`);
    expect(abbreviateStoreLabel('\u{1F363}'.repeat(20))).toBe('\u{1F363}'.repeat(20));
  });

  it('省略の境目にある絵文字の連結・結合文字・国旗を途中で割らず、入り切らなければ丸ごと落とす', () => {
    expect(abbreviateStoreLabel(`${'あ'.repeat(18)}${FAMILY}い`)).toBe(`${'あ'.repeat(18)}…`);
    expect(abbreviateStoreLabel(`${'あ'.repeat(18)}${KA_WITH_COMBINING_DAKUTEN}いう`)).toBe(`${'あ'.repeat(18)}…`);
    expect(abbreviateStoreLabel(`${'あ'.repeat(18)}${FLAG_JP}い`)).toBe(`${'あ'.repeat(18)}…`);
    // 入り切るなら丸ごと残す。
    expect(abbreviateStoreLabel(`${'あ'.repeat(14)}${FAMILY}いう`)).toBe(`${'あ'.repeat(14)}${FAMILY}…`);
  });

  it('上限はコードポイントで数える（書記素で 20 以内でも、コードポイントで 20 を超えれば省略する）', () => {
    // LINE はラベルを書記素で数えるが、どの版の分け方で数えても書記素の数はコードポイントの数を超えない。
    const within = `${'あ'.repeat(15)}${FAMILY}`; // 20 コードポイント・16 書記素
    expect(abbreviateStoreLabel(within)).toBe(within);
    expect(abbreviateStoreLabel(`${'あ'.repeat(16)}${FAMILY}`)).toBe(`${'あ'.repeat(16)}…`); // 21 コードポイント・17 書記素
  });

  it('どんな名前でも、20 コードポイント以内なら元のまま、超えれば元の名前の先頭と「…」の 20 コードポイント以内になる', () => {
    const pieces = ['あ', 'A', ' ', SURROGATE_KANJI, '\u{1F363}', FAMILY, KA_WITH_COMBINING_DAKUTEN, FLAG_JP];
    let abbreviated = 0;
    for (const lead of ['', 'あ', 'あい']) {
      for (const piece of pieces) {
        for (let repeat = 0; repeat <= 30; repeat += 1) {
          const name = `${lead}${piece.repeat(repeat)}`;
          const label = abbreviateStoreLabel(name);
          expect(LONE_SURROGATE.test(label)).toBe(false);
          if (codePoints(name) <= STORE_LABEL_MAX_LENGTH) {
            expect(label).toBe(name);
          } else {
            abbreviated += 1;
            expect(codePoints(label)).toBeLessThanOrEqual(STORE_LABEL_MAX_LENGTH);
            expect(label.endsWith('…')).toBe(true);
            expect(name.startsWith(label.slice(0, -1))).toBe(true);
          }
        }
      }
    }
    // 省略する側の分岐を実際に通ったことを確かめる（空振りの防止）。
    expect(abbreviated).toBeGreaterThan(0);
  });
});

describe('labelStoreChoices（3.9 の「識別できる形」）', () => {
  // 先頭の 19 文字が同じなので、19 文字＋「…」ではどちらも「試験グループ運営のとても長い名前の焼肉…」になる。
  const SHIBUYA = '試験グループ運営のとても長い名前の焼肉店 渋谷道玄坂店';
  const SHINJUKU = '試験グループ運営のとても長い名前の焼肉店 新宿東口店';

  function storesNamed(names: readonly string[]): ReportableStore[] {
    return names.map((name, i) => ({ id: fakeStoreId(i + 1), name }));
  }

  function labelsOf(names: readonly string[]): string[] {
    return labelStoreChoices(storesNamed(names)).map(({ label }) => label);
  }

  it('入力と同じ順に、入力の要素そのものとラベルの組を返す', () => {
    const stores = storesNamed(['試験食堂', SHIBUYA, '試験酒場']);
    const labeled = labelStoreChoices(stores);
    expect(labeled).toHaveLength(3);
    labeled.forEach(({ store }, i) => expect(store).toBe(stores[i]));
  });

  it('衝突しなければ、どのラベルも abbreviateStoreLabel と同じ（19 文字＋「…」のまま）', () => {
    const names = ['試験食堂', SHIBUYA, 'あいうえおかきくけこさしすせそたちつてとなにぬ', 'A'.repeat(20)];
    expect(labelsOf(names)).toEqual(names.map((name) => abbreviateStoreLabel(name)));
  });

  it('前提: 2 つの長い名前は、19 文字＋「…」では同じラベルになる', () => {
    expect(abbreviateStoreLabel(SHIBUYA)).toBe(abbreviateStoreLabel(SHINJUKU));
  });

  it('同じ頁で衝突したら、先頭 9 文字＋「…」＋末尾 10 文字にして、末尾の支店名で区別する', () => {
    expect(labelsOf([SHIBUYA, SHINJUKU])).toEqual(['試験グループ運営の…焼肉店 渋谷道玄坂店', '試験グループ運営の…の焼肉店 新宿東口店']);
  });

  it('衝突したラベルだけを変え、同じ頁の衝突しない長い名前と短い名前はそのままにする', () => {
    const other = 'あいうえおかきくけこさしすせそたちつてとなにぬ';
    expect(labelsOf(['試験食堂', SHIBUYA, other, SHINJUKU])).toEqual([
      '試験食堂',
      '試験グループ運営の…焼肉店 渋谷道玄坂店',
      abbreviateStoreLabel(other),
      '試験グループ運営の…の焼肉店 新宿東口店',
    ]);
  });

  it('3 店以上の衝突も、衝突したすべてを区別する', () => {
    const third = '試験グループ運営のとても長い名前の焼肉店 横浜西口店';
    const labels = labelsOf([SHIBUYA, SHINJUKU, third]);
    expect(new Set(labels).size).toBe(3);
    expect(labels[2]).toBe('試験グループ運営の…の焼肉店 横浜西口店');
  });

  it('衝突は同じ頁の中だけで判定する（相手が頁にいなければ 19 文字＋「…」のまま）', () => {
    expect(labelsOf([SHIBUYA])).toEqual([abbreviateStoreLabel(SHIBUYA)]);
    expect(labelsOf([SHIBUYA, '試験食堂'])).toEqual([abbreviateStoreLabel(SHIBUYA), '試験食堂']);
  });

  it('20 文字以内の名前は、長い名前と衝突しても全文のまま残し、長い名前の側だけを変える', () => {
    // 長い名前の 19 文字＋「…」と、たまたま同じ文字列の短い名前。
    const short = abbreviateStoreLabel(SHIBUYA);
    expect([...short].length).toBe(STORE_LABEL_MAX_LENGTH);
    expect(labelsOf([short, SHIBUYA])).toEqual([short, '試験グループ運営の…焼肉店 渋谷道玄坂店']);
  });

  it('既知の限界: 名前そのもの（または先頭 9 文字と末尾 10 文字）が同じ店舗は区別できない', () => {
    // 省略しない同名の店舗は、名前以外に表示できるものが無い。
    expect(labelsOf(['試験食堂', '試験食堂'])).toEqual(['試験食堂', '試験食堂']);
    // 長い同名の店舗も、先頭＋「…」＋末尾の形にはなるが同じラベルのままである。
    expect(labelsOf([SHIBUYA, SHIBUYA])).toEqual(['試験グループ運営の…焼肉店 渋谷道玄坂店', '試験グループ運営の…焼肉店 渋谷道玄坂店']);
  });

  it('先頭と末尾を書記素の境目で切り、入り切らない絵文字の連結や国旗は丸ごと落とす', () => {
    const name = (last: string): string => `${'あ'.repeat(8)}${FAMILY}${'う'.repeat(10)}${FLAG_JP}${'い'.repeat(8)}${last}`;
    expect(labelsOf([name('甲'), name('乙')])).toEqual([
      `${'あ'.repeat(8)}…${'い'.repeat(8)}甲`,
      `${'あ'.repeat(8)}…${'い'.repeat(8)}乙`,
    ]);
    // 入り切るなら丸ごと残す（先頭 9 のちょうど位置にある BMP の外の漢字・末尾にある国旗）。
    const fits = (last: string): string => `${'あ'.repeat(8)}${SURROGATE_KANJI}${'う'.repeat(12)}${FLAG_JP}${'い'.repeat(7)}${last}`;
    expect(labelsOf([fits('甲'), fits('乙')])).toEqual([
      `${'あ'.repeat(8)}${SURROGATE_KANJI}…${FLAG_JP}${'い'.repeat(7)}甲`,
      `${'あ'.repeat(8)}${SURROGATE_KANJI}…${FLAG_JP}${'い'.repeat(7)}乙`,
    ]);
  });

  it('末尾だけが違う長い名前のどんな組でも、衝突したラベルは区別され、20 コードポイント以内で、名前の先頭と末尾から成る', () => {
    const pieces = ['あ', 'A', ' ', SURROGATE_KANJI, '\u{1F363}', FAMILY, KA_WITH_COMBINING_DAKUTEN, FLAG_JP];
    let collided = 0;
    for (const piece of pieces) {
      for (let repeat = 0; repeat <= 12; repeat += 1) {
        const names = ['甲', '乙'].map((last) => `${'あ'.repeat(19)}${piece.repeat(repeat)}${last}`);
        const labels = labelsOf(names);
        const [first, second] = names;
        if (first === undefined || second === undefined) throw new Error('unreachable');
        if (abbreviateStoreLabel(first) === abbreviateStoreLabel(second)) {
          collided += 1;
          expect(new Set(labels).size).toBe(2);
        }
        labels.forEach((label, i) => {
          const source = names[i] ?? '';
          expect(codePoints(label)).toBeLessThanOrEqual(STORE_LABEL_MAX_LENGTH);
          expect(LONE_SURROGATE.test(label)).toBe(false);
          if (label !== source) {
            const [head, tail] = label.split('…');
            expect(source.startsWith(head ?? '\0')).toBe(true);
            expect(source.endsWith(tail ?? '\0')).toBe(true);
          }
        });
      }
    }
    // 衝突する側の分岐を実際に通ったことを確かめる（空振りの防止）。
    expect(collided).toBeGreaterThan(0);
  });
});
