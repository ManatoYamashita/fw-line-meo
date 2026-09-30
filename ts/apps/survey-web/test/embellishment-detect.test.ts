import { describe, it, expect } from 'vitest';
import {
  attributeAspectOf,
  detectEmbellishments,
  readEmbellishmentLexicon,
  type EmbellishmentSource,
} from '../src/lib/draft/embellishment';
import lexiconRaw from '../src/lib/draft/embellishment-lexicon.json';
import visitLexiconRaw from '../src/lib/draft/visit-context-lexicon.json';
import aspectsRaw from '../eval/aspects.json';

// 素材の外から属性・事前の期待・再訪の意向を補ったことを検出する検出器（Issue #339）の自己検証。
// 実 API を呼ばないため CI で常時走る。
//
// 実測（eval/factuality.eval.test.ts）は API キーが無いと skip されるので、検出器が壊れても
// 「実行されない」だけで気づけない。検出器の正しさはここで独立に、両方向で固定する
// （拾うべきものを拾い、拾ってはならないものを拾わない）。

const lexicon = readEmbellishmentLexicon(lexiconRaw);

/** 既定の素材。店名は語彙のどの語も含まないものにする。 */
const PLAIN: EmbellishmentSource = { storeName: 'あおば' };

function categoriesOf(draft: string, source: EmbellishmentSource = PLAIN): string[] {
  return detectEmbellishments(draft, source, lexicon)
    .map((c) => c.category)
    .sort();
}

describe('素材の外から補った属性・事前の期待・再訪の意向を検出する', () => {
  // #339 の本番 E2E（2026-09-25）で観測した記述。素材は星 1・良かった点「雰囲気」・気になった点「雰囲気」・一言なし。
  // Issue には各回の抜粋だけが残っているので、抜粋を 1 文ずつ固定する。検出器を弱めたらここが赤くなる。
  const OBSERVED_339 = [
    { text: '落ち着いて過ごすことを期待して伺いました。', expected: ['expectation'] },
    { text: '別のタイミングで改めて様子を見てみたいと思います。', expected: ['intention'] },
    { text: '開放的で落ち着いた雰囲気のお店です。', expected: ['attribute:atmosphere'] },
    // 「惹かれて」（来店の動機）は visit-context の motive が数える（test/visit-context-detect.test.ts）。
    { text: 'コーヒーの香り漂う空間に惹かれて利用しました。', expected: ['attribute:atmosphere'] },
    { text: '期待していた通りには過ごせませんでした。', expected: ['expectation'] },
    { text: '洗練された様子ではありましたが、気になる点もありました。', expected: ['attribute:atmosphere'] },
  ] as const;

  it.each(OBSERVED_339)('#339 の観測を拾う: $text', ({ text, expected }) => {
    expect(categoriesOf(text)).toEqual([...expected].sort());
  });

  it('#339 の観測「今回の滞在」は意図して拾わない（来店したことから滞在は導けるため）', () => {
    expect(categoriesOf('今回の滞在では、雰囲気に気になる点がありました。')).toEqual([]);
  });

  it('#132 の観測（属性と再訪の意向を補った下書き）を拾う', () => {
    // test/visit-context-detect.test.ts の OBSERVED と同じ下書き。素材は店名・星 5・観点「味」「雰囲気」で、一言は無い。
    // visit-context はここから動機（「飲みたくて」）だけを数え、末尾の「また立ち寄りたい」は数えない。この軸はそれを数える。
    const draft =
      '美味しいコーヒーが飲みたくてONIBUS COFFEE 自由が丘店へ。コーヒーはとても香り高く、一口飲むと心が落ち着く味わいでした。店内は穏やかな雰囲気が流れており、ゆっくりと贅沢な時間を過ごすことができました。接客も丁寧で居心地が良く、またぜひ立ち寄りたいと思える素敵なお店です。';
    expect(categoriesOf(draft, { storeName: 'ONIBUS COFFEE 自由が丘店' })).toEqual(
      ['attribute:atmosphere', 'attribute:taste', 'intention'].sort(),
    );
  });

  // 分類ごとの陽性例。**語彙のすべてのパターンが、少なくとも 1 つの例で発火すること**を下で確かめる
  // （発火しないパターンは、書き間違えても誰も気づかない死んだ行になる）。
  const POSITIVE = [
    { text: '静かに過ごせることを期待して訪れました。', category: 'expectation' },
    { text: '期待したほどではありませんでした。', category: 'expectation' },
    { text: '期待以上の時間でした。', category: 'expectation' },
    { text: '期待を裏切られた気持ちです。', category: 'expectation' },
    { text: '前から楽しみにしていたお店です。', category: 'expectation' },
    { text: 'またぜひ立ち寄りたいお店です。', category: 'intention' },
    { text: 'また機会があれば伺います。', category: 'intention' },
    { text: '改めて別のメニューも試したいです。', category: 'intention' },
    { text: '次回は夜に来てみたいです。', category: 'intention' },
    { text: 'リピート確定です。', category: 'intention' },
    // 否定側の意向（#339 のベースラインの実測で、低評価の素材に足されていた形）。
    { text: '再訪については慎重に考えたいと思います。', category: 'intention' },
    { text: 'あえてまた行こうという気持ちにはなれないかもしれない。', category: 'intention' },
    { text: '開放感のある店内でした。', category: 'attribute:atmosphere' },
    { text: '洗練されたお店でした。', category: 'attribute:atmosphere' },
    { text: 'おしゃれな空間でした。', category: 'attribute:atmosphere' },
    { text: 'パンの香りが漂う店内でした。', category: 'attribute:atmosphere' },
    { text: '心地よいBGMが流れていました。', category: 'attribute:atmosphere' },
    { text: 'スープは濃厚でした。', category: 'attribute:taste' },
    { text: '素材の旨みが感じられました。', category: 'attribute:taste' },
    { text: 'とても香り高い一杯でした。', category: 'attribute:taste' },
    { text: '店員さんの笑顔が印象的でした。', category: 'attribute:service' },
    { text: '笑顔で迎えてくれました。', category: 'attribute:service' },
    { text: '気さくに話しかけてくれました。', category: 'attribute:service' },
    { text: 'メニューを丁寧に説明してくれました。', category: 'attribute:service' },
    { text: 'ご飯がたっぷり盛られていました。', category: 'attribute:volume' },
    { text: '床までピカピカでした。', category: 'attribute:cleanliness' },
  ] as const;

  it.each(POSITIVE)('陽性例を拾う: $text', ({ text, category }) => {
    expect(categoriesOf(text)).toEqual([category]);
  });

  it('語彙のすべてのパターンが、陽性例のどれかで発火する（死んだパターンが無い）', () => {
    const dead: string[] = [];
    for (const [category, patterns] of Object.entries(lexicon.patterns)) {
      for (const pattern of patterns) {
        if (!POSITIVE.some((p) => p.category === category && pattern.test(p.text))) {
          dead.push(`${category}: ${pattern.source}`);
        }
      }
    }
    expect(dead).toEqual([]);
  });

  it('語彙のすべての分類に、陽性例が 1 つ以上ある', () => {
    const covered = new Set<string>(POSITIVE.map((p) => p.category));
    expect(Object.keys(lexicon.patterns).filter((c) => !covered.has(c))).toEqual([]);
  });

  // 拾ってはならない形。素材の水準の文（選んだ観点を良い・悪いで述べるだけ）と、語の形が似た別の意味。
  const NEGATIVE = [
    '雰囲気が良かったです。',
    '雰囲気に気になる点がありました。',
    '料理が美味しかったです。',
    '接客が良かったです。',
    '総合的に満足できるお店でした。',
    // 接続詞の「また、」は再訪の意向ではない。「〜たい」で終わる形容詞（冷たい・ありがたい）も同じ。
    'また、接客も良かったです。',
    '冷たい飲み物がありがたいです。',
    // 将来への期待は事前の期待（来店前の物語）ではない。
    '今後に期待しています。',
    '今後に期待したいです。',
    // 「期待」を含まない評価の強調は数えない（程度の強調として使われる「想像以上」も既知の限界として外している）。
    '想像以上に満足できました。',
    // 名詞を修飾しない「落ち着いて」は、状態の描写として拾わない（誤検出を避ける側に倒す）。
    '落ち着いて食事ができました。',
    // 評価の言い換え（丁寧・親切・リーズナブル）は属性として数えない（語彙の設計方針）。
    '丁寧で親切な接客でした。',
    'リーズナブルな価格でした。',
    // #339 の実測で見つかった誤検出。味の描写を雰囲気の属性と、客の反応を接客の属性と数えていた。
    // （「洗練された味わい」は味の属性として数えるべきだが、雰囲気の分類へ入れないことをここで固定する）
    '洗練された味わいでした。',
    '一口食べるごとに思わず笑顔になるような美味しさでした。',
  ];

  it.each(NEGATIVE)('拾ってはならない形を拾わない: %s', (text) => {
    expect(categoriesOf(text)).toEqual([]);
  });

  it('客が一言に書いた事情は、同じ分類なら数えない（言い換えでも除外する）', () => {
    const cases = [
      { draft: 'コーヒーの香り漂う空間に惹かれました。', comment: '開放的な店内でした', category: 'attribute:atmosphere' },
      { draft: '期待していた通りではありませんでした。', comment: '期待していたほどではありませんでした', category: 'expectation' },
      { draft: 'またぜひ伺いたいです。', comment: 'また来たい', category: 'intention' },
      { draft: 'スープは濃厚でした。', comment: '濃い味でした', category: 'attribute:taste' },
    ];
    for (const { draft, comment, category } of cases) {
      // 対照: 一言が無ければ拾う（除外が「常に 0」へ化けていないことの確認）。
      expect(categoriesOf(draft), draft).toEqual([category]);
      expect(categoriesOf(draft, { storeName: 'あおば', comment }), `${draft} / 一言: ${comment}`).toEqual([]);
    }
  });

  it('一言が別の観点の属性なら、その観点の属性は除外しない（除外は観点ごとに効く）', () => {
    const draft = '落ち着いた雰囲気で、スープは濃厚でした。';
    expect(categoriesOf(draft)).toEqual(['attribute:atmosphere', 'attribute:taste']);
    expect(categoriesOf(draft, { storeName: 'あおば', comment: '落ち着いた雰囲気でした' })).toEqual(['attribute:taste']);
  });

  it('店名に現れる語は数えない（店名は素材そのもの）', () => {
    const draft = '静かな空間 あおばを利用しました。';
    expect(categoriesOf(draft)).toEqual(['attribute:atmosphere']);
    expect(categoriesOf(draft, { storeName: '静かな空間 あおば' })).toEqual([]);
    // モデルは店名の空白を詰めて書くことがある。
    expect(categoriesOf('静かな空間あおばを利用しました。', { storeName: '静かな空間 あおば' })).toEqual([]);
  });

  it('本文の先頭と末尾のどちらに置いても拾う（位置に依存しない）', () => {
    const body = '雰囲気に気になる点がありました。';
    expect(categoriesOf(`期待して伺いました。${body}`)).toEqual(['expectation']);
    expect(categoriesOf(`${body}また伺いたいです。`)).toEqual(['intention']);
  });

  it('同じ入力に対して何度呼んでも同じ結果を返す（正規表現が状態を持ち越さない）', () => {
    const draft = '期待して伺いました。また伺いたいです。';
    const first = categoriesOf(draft);
    expect(categoriesOf(draft)).toEqual(first);
    expect(first).toEqual(['expectation', 'intention']);
  });
});

describe('語彙の読み込み', () => {
  it('分類は事前の期待・再訪の意向と、観点ごとの属性である', () => {
    const categories = Object.keys(lexicon.patterns);
    expect(categories).toContain('expectation');
    expect(categories).toContain('intention');
    expect(categories.filter((c) => attributeAspectOf(c) !== undefined).length).toBeGreaterThan(0);
  });

  it('属性の分類は実在する観点を指す（綴りの誤りで観点に結びつかない分類を作らない）', () => {
    const codes = Object.keys(aspectsRaw.labels);
    const aspects = Object.keys(lexicon.patterns)
      .map(attributeAspectOf)
      .filter((a): a is string => a !== undefined);
    expect(aspects.filter((a) => !codes.includes(a))).toEqual([]);
  });

  it('形式が不正なら読み込みで止める（黙って空の語彙にしない）', () => {
    const ok = { patterns: { expectation: ['期待'] }, commentHints: { expectation: ['期待'] } };
    expect(() => readEmbellishmentLexicon(ok)).not.toThrow();
    expect(() => readEmbellishmentLexicon({})).toThrow();
    // 決められた形以外の分類名は止める。
    expect(() => readEmbellishmentLexicon({ patterns: { motive: ['期待'] }, commentHints: { motive: ['期待'] } })).toThrow();
    expect(() =>
      readEmbellishmentLexicon({ patterns: { 'attribute:': ['期待'] }, commentHints: { 'attribute:': ['期待'] } }),
    ).toThrow();
  });

  it('過去形の後置条件は visit-context の語彙と同一である（意味論を揃える）', () => {
    const raw = lexiconRaw as { placeholders: Record<string, string>; patterns: Record<string, string[]> };
    const visit = visitLexiconRaw as { placeholders: Record<string, string> };
    expect(raw.placeholders.PAST).toBe(visit.placeholders.PAST);
    // 過去形の語尾（「まし」「た(?![」）をパターンに直接書くと、PAST の除外がそのパターンだけ漏れる。
    // visit-context のテストは「た(?!」で照合するが、この語彙は再訪の意向で「また(?!、)」を持つので括弧まで含めて照合する。
    const sources = Object.values(raw.patterns).flat();
    expect(sources.filter((s) => s.includes('まし') || s.includes('た(?!['))).toEqual([]);
    expect(sources.filter((s) => s.includes('{PAST}')).length).toBeGreaterThan(0);
  });
});
