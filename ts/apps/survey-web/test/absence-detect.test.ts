import { describe, it, expect } from 'vitest';
import { ABSENCE_CATEGORIES, detectAbsenceAssertions, readAbsenceLexicon } from '../src/lib/draft/absence';
import lexiconRaw from '../src/lib/draft/absence-lexicon.json';

// 選ばなかったことを「無かった」と断定したことを検出する検出器（Issue #414）の自己検証。
// 実 API を呼ばないため CI で常時走る。
//
// 実測（eval/factuality.eval.test.ts）は API キーが無いと skip されるので、検出器が壊れても
// 「実行されない」だけで気づけない。検出器の正しさはここで独立に、両方向で固定する
// （拾うべきものを拾い、拾ってはならないものを拾わない）。

const lexicon = readAbsenceLexicon(lexiconRaw);

function categoriesOf(draft: string, comment?: string): string[] {
  return detectAbsenceAssertions(draft, comment, lexicon)
    .map((c) => c.category)
    .sort();
}

describe('選ばなかったことを「無かった」と断定した箇所を検出する', () => {
  it('#339 の本番確認（2026-09-30）で観測した文を拾う', () => {
    // 素材は星 1・良かった点「雰囲気」・気になった点「雰囲気」・一言なし。選ばなかった観点を「特にない」と書いた。
    expect(categoriesOf('今回の利用において、その他の要素についての特筆すべき事項は特にない。')).toEqual(['others']);
  });

  // #339 の eval（2026-09-30）で保存した下書きから取った陽性例。**語彙のすべてのパターンが、少なくとも 1 つの例で
  // 発火すること**を下で確かめる（発火しないパターンは、書き間違えても誰も気づかない死んだ行になる）。
  const POSITIVE = [
    { text: '良かった点は特にありませんでした。', category: 'goodPoints' },
    { text: '今回の利用において、満足できる点は特にありませんでした。', category: 'goodPoints' },
    { text: '今回の利用において、特に良かったと感じる点はありませんでした。', category: 'goodPoints' },
    { text: '今回来店した中では良いと感じる要素が特になく、対応の面で不満が残る結果となりました。', category: 'goodPoints' },
    { text: '特筆すべき良かった点はありません。', category: 'goodPoints' },
    { text: '気になった点は特になく、終始快適に利用させていただきました。', category: 'concerns' },
    { text: '全体を通して素晴らしく、特に気になる点はありませんでした。', category: 'concerns' },
    { text: '快適な空間で食事を楽しむことができ、何一つ気になる点はありませんでした。', category: 'concerns' },
    { text: 'また、他に気になった点はありませんでした。', category: 'concerns' },
    { text: '今回の利用において、他の点については特筆すべき事項はありませんでした。', category: 'others' },
    { text: '他の部分について触れることは特にないが、今回は量に関して気になる点が多く残る訪問となった。', category: 'others' },
    { text: '雰囲気以外については特に記載することがないため、以上が今回感じた正直な感想となります。', category: 'others' },
    { text: 'お店の雰囲気や味については特に記載がありませんが、接客面で非常に好印象を抱きました。', category: 'others' },
    { text: '他にも特に言及する点はありませんが、今回は以上のような印象を受けました。', category: 'others' },
    { text: '今回の食事では、その点以外に特に触れるべき要素はありませんでした。', category: 'others' },
    { text: '食事の内容や店の様子については特筆すべきことはありませんが、ボリュームの面で改善の余地があると感じました。', category: 'others' },
    { text: '店内の様子やサービスなどについては特に記されていませんが、全体としてとても良かったです。', category: 'others' },
  ] as const;

  it.each(POSITIVE)('陽性例を拾う: $text', ({ text, category }) => {
    expect(categoriesOf(text)).toEqual([category]);
  });

  it('語彙のすべてのパターンが、同じ分類の陽性例のどれかで発火する（死んだパターンが無い）', () => {
    const dead: string[] = [];
    for (const [category, patterns] of Object.entries(lexicon.patterns)) {
      for (const pattern of patterns) {
        if (!POSITIVE.some((p) => p.category === category && pattern.test(p.text))) dead.push(`${category}: ${pattern.source}`);
      }
    }
    expect(dead).toEqual([]);
  });

  // 拾ってはならない形。評価の低さを述べる文・一言そのもの・「特筆すべき」を肯定に使う文は、不在の断定ではない。
  const NEGATIVE = [
    'あまり満足できる内容ではありませんでした。',
    '全体として満足できる内容ではありませんでした。',
    '定食屋 あおばを利用しましたが、全体的な満足度はあまり高くありませんでした。',
    '期待していたほどではありませんでした。',
    '食事の量については満足のいくものではありませんでした。',
    '特筆すべきは接客の質の高さで、丁寧な対応のおかげで心地よく過ごすことができました。',
    '落ち着いた空間でゆっくりと過ごすことができ、味に優れている点は特筆すべき魅力です。',
    '全ての点において申し分ありませんでした。',
    '雰囲気については、良かった面と気になった面の両方を感じた。',
    '接客について気になる点がありました。',
    '他のメニューも試してみたいと思います。',
    '他のお店にはない魅力がありました。',
    '食事をする上で特筆すべき点は以上となります。',
    // 「申し分ない」は肯定の評価（NEG の直前が「申し分」なら数えない）。
    '他の点も特に申し分ないです。',
  ];

  it.each(NEGATIVE)('拾ってはならない形を拾わない: %s', (text) => {
    expect(categoriesOf(text)).toEqual([]);
  });

  it('客が一言に書いた事情は、同じ分類なら数えない', () => {
    const draft = '全体を通して素晴らしく、特に気になる点はありませんでした。';
    // 対照: 一言が無ければ拾う（除外が「常に 0」へ化けていないことの確認）。
    expect(categoriesOf(draft)).toEqual(['concerns']);
    expect(categoriesOf(draft, '気になる点はなかったです')).toEqual([]);
    // 一言が別の分類の事情なら除外しない。
    expect(categoriesOf(draft, '良かった点は特にない')).toEqual(['concerns']);
  });

  it('本文の先頭と末尾のどちらに置いても拾う（位置に依存しない）', () => {
    const body = '接客について気になる点がありました。';
    expect(categoriesOf(`良かった点は特にありませんでした。${body}`)).toEqual(['goodPoints']);
    expect(categoriesOf(`${body}良かった点は特にありませんでした。`)).toEqual(['goodPoints']);
  });

  it('同じ入力に対して何度呼んでも同じ結果を返す（正規表現が状態を持ち越さない）', () => {
    const draft = '良かった点は特にありませんでした。他にも特に言及する点はありません。';
    const first = categoriesOf(draft);
    expect(categoriesOf(draft)).toEqual(first);
    expect(first).toEqual(['goodPoints', 'others']);
  });
});

describe('語彙の読み込み', () => {
  it('goodPoints の最初のパターンは旧 ABSENCE_ASSERTION と同一の文字列である（#254 以来の実測と比べられるように保つ）', () => {
    const raw = lexiconRaw as { patterns: Record<string, string[]> };
    expect(raw.patterns.goodPoints?.[0]).toBe(
      '(?:良かった|よかった|良い)(?:点|ところ)(?:は|が)?(?:特に|とくに)?(?:なく|なし|無く|無し|ありません|ない|見当たり)',
    );
  });

  it('分類は goodPoints / concerns / others と過不足なく一致する', () => {
    expect(Object.keys(lexicon.patterns).sort()).toEqual([...ABSENCE_CATEGORIES].sort());
  });

  it('分類が食い違う語彙は読み込みで止める（黙って数えない分類を作らない）', () => {
    const ok = { goodPoints: ['良かった'], concerns: ['気にな'], others: ['その他'] };
    expect(() => readAbsenceLexicon({ patterns: ok, commentHints: ok })).not.toThrow();
    const missing = { goodPoints: ['良かった'], concerns: ['気にな'] };
    expect(() => readAbsenceLexicon({ patterns: missing, commentHints: missing })).toThrow();
    const extra = { ...ok, motive: ['目当て'] };
    expect(() => readAbsenceLexicon({ patterns: extra, commentHints: extra })).toThrow();
  });
});
