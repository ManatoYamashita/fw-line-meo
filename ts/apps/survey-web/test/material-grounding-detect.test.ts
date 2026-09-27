import { describe, it, expect } from 'vitest';
import {
  detectUngroundedClaims,
  readGroundingLexicon,
  STAR_NARRATION,
  GROUNDING_AXES,
  type GroundingSource,
} from '../src/lib/draft/material-grounding';
import lexiconRaw from '../src/lib/draft/material-grounding-lexicon.json';
import visitLexiconRaw from '../src/lib/draft/visit-context-lexicon.json';

// 素材に無い固有名詞・数値・日付を検出する検出器（Issue #222）の自己検証。実 API を呼ばないため CI で常時走る。
//
// 実測（eval/factuality.eval.test.ts）は API キーが無いと skip されるので、検出器が壊れても
// 「実行されない」だけで気づけない。検出器の正しさはここで独立に、軸ごと両方向で固定する
// （拾うべきものを拾い、拾ってはならないものを拾わない）。

const lexicon = readGroundingLexicon(lexiconRaw);

/** 既定の素材。店名は料理・飲み物の手がかり（カフェ・定食など）を含まないものにする。 */
const PLAIN: GroundingSource = { storeName: 'あおば' };

/** 検出結果を「軸:分類」の並びにする（matchedText は個別のケースで見る）。 */
function kindsOf(draft: string, source: GroundingSource = PLAIN): string[] {
  return detectUngroundedClaims(draft, source, lexicon)
    .map((c) => `${c.axis}:${c.kind}`)
    .sort();
}

/** 自己照合の対照: 下書き自身を一言として渡す。eval の対照と同じ式である。 */
function selfSourced(draft: string, storeName: string) {
  return detectUngroundedClaims(draft, { storeName, comment: draft }, lexicon);
}

describe('素材に無い固有名詞・数値・日付を検出する', () => {
  // 実際に観測した出力を回帰ケースとして固定する。検出器を弱めたらここが赤くなる。
  const OBSERVED = [
    {
      // #132 の観測（test/factuality-detect.test.ts の OBSERVED と同じ下書き）。素材は店名と星と観点だけで、
      // ラーメンは素材に無い。実在店の事前知識が混入した形であり、架空店名との対比で見たい当のもの。
      // 「一杯」は漢数字の慣用句なので数値として数えない。
      name: '#132 観測（実在店の品名を事前知識から補う）',
      draft:
        '一蘭 渋谷店でラーメンをいただきました。スープは非常に濃厚で、深いコクを感じる大変おいしい一杯でした。店内の雰囲気も良く、スタッフの方の接客も丁寧で、最初から最後まで気持ちよく食事を楽しむことができました。',
      source: { storeName: '一蘭 渋谷店' },
      expected: ['properNoun:dish:ラーメン'],
    },
    {
      // #132 の観測。コーヒーは店名の COFFEE が手がかりになるので数えない。店名の英字も数えない。
      name: '#132 観測（店名が品名の手がかりになる）',
      draft:
        '美味しいコーヒーが飲みたくてONIBUS COFFEE 自由が丘店へ。コーヒーはとても香り高く、一口飲むと心が落ち着く味わいでした。店内は穏やかな雰囲気が流れており、ゆっくりと贅沢な時間を過ごすことができました。接客も丁寧で居心地が良く、またぜひ立ち寄りたいと思える素敵なお店です。',
      source: { storeName: 'ONIBUS COFFEE 自由が丘店' },
      expected: [],
    },
    {
      // #254 の本番 E2E（2026-09-13）。素材の一言は「店内が小さかった」。駅名は素材に無い。
      // 公開リポジトリのため、店名に由来する地名は伏せてある（伏せ字の〇〇も地名として拾う）。
      name: '#254 本番（素材に無い駅名）',
      draft:
        '〇〇駅前を通る際に立ち寄りました。店内は非常に小さく、座席間隔も近いため窮屈に感じました。お店の雰囲気を目当てに訪れましたが、清潔さに関しても気になる点があり、全体として居心地はあまり良くありませんでした。空間が限られているため、ゆっくりと過ごすには少し難しい環境だと感じました。',
      source: { storeName: 'カフェ みなも', comment: '店内が小さかった' },
      expected: ['properNoun:place:〇〇駅'],
    },
    {
      // #254 の修正後の実測。固有名詞・数値・日付には触れていない（検出してはならない側の実例）。
      name: '#254 修正後の観測（該当なし）',
      draft:
        'カフェ みなもを利用しました。今回初めて来店しましたが、総合的に見て非常に満足度の高い時間を過ごすことができました。また機会があれば利用したいと思います。',
      source: { storeName: 'カフェ みなも' },
      expected: [],
    },
  ] as const;

  it.each(OBSERVED)('観測済みの下書き: $name', ({ draft, source, expected }) => {
    const got = detectUngroundedClaims(draft, source, lexicon)
      .map((c) => `${c.axis}:${c.kind}:${c.matchedText}`)
      .sort();
    expect(got).toEqual([...expected].sort());
  });

  // 軸・分類ごとの陽性例。**日付の語彙のすべてのパターンと、固有名詞のすべてのパターンが、
  // 少なくとも 1 つの例で発火すること**を下で確かめる（発火しない行は、書き間違えても誰も気づかない）。
  const POSITIVE = [
    { text: '先週末は混んでいました。', expected: 'dateTime:relativeDay' },
    { text: '先日、食事をしました。', expected: 'dateTime:relativeDay' },
    { text: '昨日は混んでいました。', expected: 'dateTime:relativeDay' },
    { text: '今朝焼き上がったばかりだそうです。', expected: 'dateTime:relativeDay' },
    { text: '9月12日に訪れました。', expected: 'dateTime:calendar' },
    { text: '日曜日に訪れました。', expected: 'dateTime:calendar' },
    { text: '年末に利用しました。', expected: 'dateTime:calendar' },
    { text: '12時頃に入りました。', expected: 'dateTime:timeOfDay' },
    { text: 'ランチタイムに利用しました。', expected: 'dateTime:timeOfDay' },
    { text: '仕事帰りに寄りました。', expected: 'dateTime:timeOfDay' },
    { text: '20分ほど待ちました。', expected: 'number:digits' },
    { text: 'お会計は1,000円でした。', expected: 'number:digits' },
    { text: '３人で利用しました。', expected: 'number:digits' },
    { text: 'スタッフの山田さんが親切でした。', expected: 'properNoun:person' },
    { text: 'マスターのタナカさんが淹れてくれました。', expected: 'properNoun:person' },
    { text: '渋谷駅から歩いてすぐです。', expected: 'properNoun:place' },
    { text: '中央商店街の一角にあります。', expected: 'properNoun:place' },
    { text: 'Wi-Fiも使えました。', expected: 'properNoun:latin' },
    { text: 'パスタが美味しかったです。', expected: 'properNoun:dish' },
  ] as const;

  it.each(POSITIVE)('陽性例を拾う: $text', ({ text, expected }) => {
    expect(kindsOf(text)).toEqual([expected]);
  });

  it('日付の語彙のすべてのパターンが、陽性例のどれかで発火する（死んだパターンが無い）', () => {
    const dead: string[] = [];
    for (const [category, patterns] of Object.entries(lexicon.dateTime.patterns)) {
      for (const pattern of patterns) {
        if (!POSITIVE.some((p) => pattern.test(p.text.normalize('NFKC')))) dead.push(`${category}: ${pattern.source}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it('固有名詞のすべてのパターンが、陽性例のどれかで発火する（死んだパターンが無い）', () => {
    const dead: string[] = [];
    for (const [kind, rule] of Object.entries(lexicon.properNoun)) {
      for (const pattern of rule.patterns) {
        if (!POSITIVE.some((p) => pattern.test(p.text.normalize('NFKC')))) dead.push(`${kind}: ${pattern.source}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it('料理・飲み物の語彙はすべて単独で拾われ、手がかりがあれば拾われない', () => {
    const missed: string[] = [];
    const leaked: string[] = [];
    for (const [term, hints] of Object.entries(lexicon.dish)) {
      const draft = `${term}が美味しかったです。`;
      const got = detectUngroundedClaims(draft, PLAIN, lexicon).map((c) => `${c.kind}:${c.matchedText}`);
      // 長い語の中の短い語（パンケーキの中のケーキ）を二重に数えないことも、ここで確かめる。
      if (JSON.stringify(got) !== JSON.stringify([`dish:${term}`])) missed.push(`${term} → ${got.join(',')}`);
      for (const hint of hints) {
        if (detectUngroundedClaims(draft, { storeName: `${hint} あおば` }, lexicon).length > 0) leaked.push(`${term} ← ${hint}`);
      }
    }
    expect(missed).toEqual([]);
    expect(leaked).toEqual([]);
  });

  // 拾ってはならない形。星の読み上げは別の軸・将来の意向は事実の断定ではない・一般名詞は固有名詞ではない。
  const NEGATIVE = [
    '評価は5点です。',
    '星5つの満足度でした。',
    'また週末に訪れたいです。',
    'ランチに立ち寄りたいお店です。',
    '期待通りの味でした。',
    '店員さんの接客が丁寧でした。',
    '若い男性店員さんが対応してくれました。',
    'スタッフさんが親切でした。',
    'お客さんが多かったです。',
    '最寄り駅から近いです。',
    'すぐそばにあるお店です。',
    '一口ごとに満足しました。',
    '料理が美味しかったです。',
    'また来たいと思います。',
  ];

  it.each(NEGATIVE)('拾ってはならない形を拾わない: %s', (text) => {
    expect(kindsOf(text)).toEqual([]);
  });

  it('店名に含まれる数字・英字・駅名・品名は数えない（店名は素材そのもの）', () => {
    expect(kindsOf('ONIBUS COFFEE 中目黒駅前店でコーヒーを飲みました。', { storeName: 'ONIBUS COFFEE 中目黒駅前店' })).toEqual([]);
    expect(kindsOf('BAR 3丁目で飲みました。', { storeName: 'BAR 3丁目' })).toEqual([]);
    expect(kindsOf('定食屋 あおばの定食は美味しかったです。', { storeName: '定食屋 あおば' })).toEqual([]);
    // 対照: 同じ下書きでも、店名が手がかりを持たなければ拾う（除去が「常に 0」へ化けていないことの確認）。
    expect(kindsOf('BAR 3丁目で飲みました。', PLAIN)).toEqual(['number:digits', 'properNoun:latin']);
    // 日付の軸は一言の手がかりでしか除外しないので、店名の中の日付の語は店名の除去でしか外れない。
    expect(kindsOf('クリスマス食堂 あおばで食べました。', { storeName: 'クリスマス食堂 あおば' })).toEqual([]);
    expect(kindsOf('クリスマス食堂 あおばで食べました。', PLAIN)).toEqual(['dateTime:calendar']);
  });

  it('客が一言に書いた事実は数えない（一言が無ければ拾う）', () => {
    const cases = [
      { draft: '先日伺いました。', comment: '先日行きました', kind: 'dateTime:relativeDay' },
      { draft: '注文から40分ほど待ちました。', comment: '注文してから提供まで40分ほど待ちました', kind: 'number:digits' },
      { draft: '渋谷駅から近いです。', comment: '渋谷駅から歩いた', kind: 'properNoun:place' },
      { draft: '山田さんが親切でした。', comment: '山田さんありがとう', kind: 'properNoun:person' },
      { draft: 'パスタが美味しかったです。', comment: 'パスタ最高', kind: 'properNoun:dish' },
      { draft: 'good でした。', comment: 'コーヒーが good でした', kind: 'properNoun:latin' },
    ];
    for (const { draft, comment, kind } of cases) {
      expect(kindsOf(draft), draft).toEqual([kind]);
      expect(kindsOf(draft, { ...PLAIN, comment }), `${draft} ← ${comment}`).toEqual([]);
    }
  });

  it('一言の数値は値で照合する（別の値なら拾う・全角も同じ値として扱う）', () => {
    expect(kindsOf('40分待ちました。', { ...PLAIN, comment: '１０分' })).toEqual(['number:digits']);
    expect(kindsOf('40分待ちました。', { ...PLAIN, comment: '４０分' })).toEqual([]);
    expect(kindsOf('1000円でした。', { ...PLAIN, comment: '1,000円' })).toEqual([]);
  });

  it('日付・時刻の数字は数値の軸で二重に数えない', () => {
    expect(kindsOf('9月12日の12時頃に入りました。').filter((k) => k.startsWith('number'))).toEqual([]);
  });

  it('日付の軸が拾わない期間の数字は、数値の軸で数える（どちらの軸からも落とさない）', () => {
    // 「日」「時」の前の数字を一律に日付の軸へ回すと、日付の軸が拾わない期間がどこにも数えられない。
    expect(kindsOf('3日間通いました。')).toEqual(['number:digits']);
    expect(kindsOf('3日前に食べました。')).toEqual(['number:digits']);
    // 「2時間」は待ち時間であって時刻ではない。
    expect(kindsOf('2時間待ちました。')).toEqual(['number:digits']);
  });

  it('自己照合の対照: 下書き自身を素材として渡すと、どの軸も 0 件になる', () => {
    const drafts = [
      ...POSITIVE.map((p) => ({ draft: p.text, storeName: PLAIN.storeName })),
      ...OBSERVED.map((o) => ({ draft: o.draft, storeName: o.source.storeName })),
    ];
    // 対照が空振りしていないこと: 素材が店名だけなら、これらの下書きは拾われる。
    expect(drafts.filter((d) => detectUngroundedClaims(d.draft, { storeName: d.storeName }, lexicon).length > 0).length).toBe(
      POSITIVE.length + OBSERVED.filter((o) => o.expected.length > 0).length,
    );
    for (const { draft, storeName } of drafts) {
      expect(selfSourced(draft, storeName), draft).toEqual([]);
    }
  });

  it('本文の先頭と末尾のどちらに置いても拾う（位置に依存しない）', () => {
    const body = 'スープは濃厚で、最後まで美味しくいただきました。';
    for (const piece of ['先日伺いました。', '20分待ちました。', '渋谷駅から近いです。']) {
      expect(kindsOf(`${piece}${body}`)).toEqual(kindsOf(`${body}${piece}`));
      expect(kindsOf(`${body}${piece}`).length).toBe(1);
    }
  });

  it('同じ入力に対して何度呼んでも同じ結果を返す（正規表現が状態を持ち越さない）', () => {
    const draft = '山田さんと田中さんが渋谷駅で待っていました。20分と30分。';
    const first = kindsOf(draft);
    expect(kindsOf(draft)).toEqual(first);
    expect(first).toEqual(['number:digits', 'number:digits', 'properNoun:person', 'properNoun:person', 'properNoun:place']);
  });

  it('同じ箇所を 2 回書いても 1 件にまとめる', () => {
    expect(kindsOf('20分待ち、さらに20分待ちました。')).toEqual(['number:digits']);
  });
});

describe('軸の定義と語彙の読み込み', () => {
  it('3 つの軸を持つ', () => {
    expect([...GROUNDING_AXES]).toEqual(['properNoun', 'number', 'dateTime']);
  });

  it('日付の 3 分類と、固有名詞の規則をすべて持つ', () => {
    expect(Object.keys(lexicon.dateTime.patterns).sort()).toEqual(['calendar', 'relativeDay', 'timeOfDay']);
    expect(Object.keys(lexicon.properNoun).sort()).toEqual(['person', 'place']);
    expect(Object.keys(lexicon.dish).length).toBeGreaterThan(0);
  });

  it('過去形の後置条件は visit-context の語彙と同一である（片方だけ直すと除外がずれる）', () => {
    const raw = lexiconRaw as { dateTime: { placeholders: Record<string, string> } };
    const visit = visitLexiconRaw as { placeholders: Record<string, string> };
    expect(raw.dateTime.placeholders.PAST).toBe(visit.placeholders.PAST);
  });

  it('形式が不正なら読み込みで止める（黙って空の語彙にしない）', () => {
    const valid = lexiconRaw as Record<string, unknown>;
    expect(() => readGroundingLexicon({})).toThrow();
    expect(() => readGroundingLexicon({ ...valid, dateTime: {} })).toThrow();
    // 名前を取り出す捕捉グループの無いパターンは、素材との照合ができない。
    expect(() =>
      readGroundingLexicon({ ...valid, properNoun: { place: { patterns: ['駅'], stop: ['最寄'] }, person: (valid.properNoun as Record<string, unknown>).person } }),
    ).toThrow();
    expect(() => readGroundingLexicon({ ...valid, dish: { パスタ: 'x' } })).toThrow();
    expect(() => readGroundingLexicon({ ...valid, dish: {} })).toThrow();
  });
});

describe('星の数の読み上げ（eval の既存の軸・移設の前後で同一）', () => {
  it('正規表現の文字列は eval にあったものと同一である（既存の数値の比較可能性）', () => {
    expect(STAR_NARRATION.source).toBe(
      '評価は\\s*[1-5１-５]|[1-5１-５]\\s*段階|星\\s*[1-5１-５]|★\\s*[1-5１-５]|[1-5１-５]\\s*点(?!心)|[1-5１-５]つ星',
    );
    expect(STAR_NARRATION.flags).toBe('');
  });
});
