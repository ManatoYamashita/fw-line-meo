import { describe, it, expect } from 'vitest';
import { detectVisitContextClaims, readVisitContextLexicon } from '../src/lib/draft/visit-context';
import lexiconRaw from '../src/lib/draft/visit-context-lexicon.json';

// 来店の経緯・動機の創作を検出する検出器（Issue #254）の自己検証。実 API を呼ばないため CI で常時走る。
//
// 実測（eval/factuality.eval.test.ts）は API キーが無いと skip されるので、検出器が壊れても
// 「実行されない」だけで気づけない。検出器の正しさはここで独立に、両方向で固定する
// （拾うべきものを拾い、拾ってはならないものを拾わない）。

const lexicon = readVisitContextLexicon(lexiconRaw);

function categoriesOf(draft: string, comment?: string): string[] {
  return detectVisitContextClaims(draft, comment, lexicon)
    .map((c) => c.category)
    .sort();
}

describe('来店の経緯・動機の創作を検出する', () => {
  // 実際に観測した出力を回帰ケースとして固定する。検出器を弱めたらここが赤くなる。
  const OBSERVED = [
    {
      // 本番 E2E（2026-09-13）。素材は星 1・観点「雰囲気」「清潔さ」・一言「店内が小さかった」。
      // 公開リポジトリのため、店名に由来する地名は伏せてある。
      name: '#254 本番（書き出し「訪問のきっかけから始める」のもとで経緯と動機を創作）',
      draft:
        '〇〇駅前を通る際に立ち寄りました。店内は非常に小さく、座席間隔も近いため窮屈に感じました。お店の雰囲気を目当てに訪れましたが、清潔さに関しても気になる点があり、全体として居心地はあまり良くありませんでした。空間が限られているため、ゆっくりと過ごすには少し難しい環境だと感じました。',
      comment: '店内が小さかった',
      expected: ['circumstance', 'motive'],
    },
    {
      // #132 の観測（test/factuality-detect.test.ts の OBSERVED と同じ下書き）。
      // 「飲みたくて」は動機の創作。末尾の「また立ち寄りたい」は将来の意向なので、経緯としては数えない。
      name: '#132 観測（動機を創作・末尾の意向は数えない）',
      draft:
        '美味しいコーヒーが飲みたくてONIBUS COFFEE 自由が丘店へ。コーヒーはとても香り高く、一口飲むと心が落ち着く味わいでした。店内は穏やかな雰囲気が流れており、ゆっくりと贅沢な時間を過ごすことができました。接客も丁寧で居心地が良く、またぜひ立ち寄りたいと思える素敵なお店です。',
      comment: undefined,
      expected: ['motive'],
    },
    {
      // #254 の修正後の実測（2026-09-13・架空の店名）。末尾の「また近くへ立ち寄った際には」は将来の仮定であり、
      // 経緯の創作ではない。語彙が「〜た際」を除いていなかったときは、この形を誤検出していた（同じ実測の 12 件中 9 件）。
      name: '#254 修正後の観測（末尾の「立ち寄った際には」は仮定なので数えない）',
      draft:
        'カフェ みなもにて食事をしました。料理の味は非常に素晴らしく、一口食べるごとに素材の旨みがしっかりと感じられる仕上がりでした。丁寧な調理が伝わってくるような味わいで、最後まで飽きることなく楽しむことができました。食事そのもののクオリティが高く、非常に満足感のある内容でした。また近くへ立ち寄った際には、ぜひ再訪したいと思います。',
      comment: undefined,
      expected: [],
    },
    {
      // #254 の修正後の実測（2026-09-13・架空の店名・観点も一言も無い素材）。「初めて来店しました」は来店歴の創作。
      name: '#254 修正後の観測（来店歴を創作）',
      draft:
        'カフェ みなもを利用しました。今回初めて来店しましたが、総合的に見て非常に満足度の高い時間を過ごすことができました。また機会があれば利用したいと思います。',
      comment: undefined,
      expected: ['history'],
    },
    {
      // #132 の観測。来店の事情には触れていない（検出してはならない側の実例）。
      name: '#132 観測（来店の事情に触れていない）',
      draft:
        '一蘭 渋谷店でラーメンをいただきました。スープは非常に濃厚で、深いコクを感じる大変おいしい一杯でした。店内の雰囲気も良く、スタッフの方の接客も丁寧で、最初から最後まで気持ちよく食事を楽しむことができました。',
      comment: undefined,
      expected: [],
    },
  ] as const;

  it.each(OBSERVED)('観測済みの下書き: $name', ({ draft, comment, expected }) => {
    expect(categoriesOf(draft, comment)).toEqual([...expected].sort());
  });

  // 分類ごとの陽性例。**語彙のすべてのパターンが、少なくとも 1 つの例で発火すること**を下で確かめる
  // （発火しないパターンは、書き間違えても誰も気づかない死んだ行になる）。
  const POSITIVE = [
    { text: '近くに用事があって立ち寄りました。', category: 'circumstance' },
    { text: '駅から歩いて通りかかったので入りました。', category: 'circumstance' },
    { text: '駅前を通る際に寄りました。', category: 'circumstance' },
    { text: 'ランチに立ち寄った店です。', category: 'circumstance' },
    { text: '近くに来たついでに入りました。', category: 'circumstance' },
    { text: 'パフェ目当てで伺いました。', category: 'motive' },
    { text: '口コミがきっかけで訪れました。', category: 'motive' },
    { text: 'コーヒーが飲みたくて入りました。', category: 'motive' },
    { text: 'ずっと気になっていたお店です。', category: 'motive' },
    { text: '評判を聞いて伺いました。', category: 'motive' },
    { text: '友人に勧められて来ました。', category: 'motive' },
    { text: '家族と訪れました。', category: 'companion' },
    { text: '同僚と一緒に来ました。', category: 'companion' },
    { text: '一人で入った店です。', category: 'companion' },
    { text: '初めての来店でした。', category: 'history' },
    { text: '初めて訪れました。', category: 'history' },
    { text: '久しぶりに伺いました。', category: 'history' },
    { text: '何度も通っているお店です。', category: 'history' },
    { text: '常連のお客さんが多いです。', category: 'history' },
    { text: 'リピートしています。', category: 'history' },
    { text: 'いつも利用しています。', category: 'history' },
  ] as const;

  it.each(POSITIVE)('陽性例を拾う: $text', ({ text, category }) => {
    expect(categoriesOf(text)).toEqual([category]);
  });

  it('語彙のすべてのパターンが、陽性例のどれかで発火する（死んだパターンが無い）', () => {
    const dead: string[] = [];
    for (const [category, patterns] of Object.entries(lexicon)) {
      for (const pattern of patterns) {
        if (!POSITIVE.some((p) => pattern.test(p.text))) dead.push(`${category}: ${pattern.source}`);
      }
    }
    expect(dead).toEqual([]);
  });

  // 拾ってはならない形。将来の意向・仮定・て形の描写は、来店の事情の創作ではない（語彙の設計方針）。
  const NEGATIVE = [
    'また立ち寄りたいお店です。',
    'また訪れたいと思います。',
    '友人と来たら盛り上がりそうです。',
    '家族と来ても楽しめる雰囲気でした。',
    '気軽に立ち寄って楽しめます。',
    '一人でも入りやすいお店でした。',
    'また来たいと思うきっかけになりました。',
    'リピート確定です。',
    'スタッフの接客が丁寧で、料理も美味しかったです。',
    // 「〜た際」「〜たとき」は将来の仮定（#254 の修正後の実測で、12 件中 9 件がこの形の誤検出だった）。
    'また近くへ立ち寄った際には、ぜひ利用したいです。',
    'また近くに来た際は立ち寄りたいです。',
    'また立ち寄ったときには別のメニューも試したいです。',
    '近くに用事がある際はまた寄りたいです。',
    '家族と来た時にもまた楽しめそうです。',
  ];

  it.each(NEGATIVE)('拾ってはならない形を拾わない: %s', (text) => {
    expect(categoriesOf(text)).toEqual([]);
  });

  it('客が一言に書いた事情は数えない（言い換えも同じ分類なら数えない）', () => {
    const draft = '友人と訪れました。料理が美味しかったです。';
    // 対照: 一言が無ければ創作として拾う（除外が「常に 0」へ化けていないことの確認）。
    expect(categoriesOf(draft)).toEqual(['companion']);
    expect(categoriesOf(draft, '友達と来ました')).toEqual([]);
    // 一言が別の分類の事情なら、この分類は除外しない。
    expect(categoriesOf(draft, '評判を聞いて来ました')).toEqual(['companion']);
  });

  it('本文の先頭と末尾のどちらに置いても拾う（位置に依存しない）', () => {
    const body = 'スープは濃厚で、麺の硬さもちょうど良く、最後まで美味しくいただきました。';
    expect(categoriesOf(`駅前を通る際に寄りました。${body}`)).toEqual(['circumstance']);
    expect(categoriesOf(`${body}近くに用事があって立ち寄りました。`)).toEqual(['circumstance']);
  });

  it('同じ入力に対して何度呼んでも同じ結果を返す（正規表現が状態を持ち越さない）', () => {
    const draft = '家族と訪れました。久しぶりに伺いました。';
    const first = categoriesOf(draft);
    expect(categoriesOf(draft)).toEqual(first);
    expect(first).toEqual(['companion', 'history']);
  });
});

describe('語彙の読み込み', () => {
  it('4 つの分類をすべて持つ', () => {
    expect(Object.keys(lexicon).sort()).toEqual(['circumstance', 'companion', 'history', 'motive']);
  });

  it('形式が不正なら読み込みで止める（黙って空の語彙にしない）', () => {
    expect(() => readVisitContextLexicon({})).toThrow();
    expect(() => readVisitContextLexicon({ patterns: { motive: [] } })).toThrow();
    expect(() => readVisitContextLexicon({ patterns: { motive: ['x'] } })).toThrow();
    expect(() => readVisitContextLexicon({ patterns: { motive: ['(未閉じ'] } })).toThrow();
  });
});
