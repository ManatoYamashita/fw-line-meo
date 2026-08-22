import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAspectMentions, readLexicon } from '../src/lib/draft/factuality';
import lexiconRaw from '../src/lib/draft/aspect-lexicon.json';
import aspectsRaw from '../eval/aspects.json';
import datasetRaw from '../eval/dataset.json';

// 事実性検出器（Issue #132）の自己検証。実 API を呼ばないため CI で常時走る。
//
// この対が重要な理由: 実測側（eval/factuality.eval.test.ts）は API キーが無いと skip されるので、
// 検出器が壊れても実測は「実行されない」だけで気づけない。検出器の正しさはここで独立に固定する。
// 「抽出器に自己検証が無いと取りこぼしても緑になる」という Issue #60 と同じ構図を作らない。

const lexicon = readLexicon(lexiconRaw);
const labels = aspectsRaw.labels as Record<string, string>;
const ALL_CODES = Object.keys(lexicon);

/** 客が選んだ観点から「検証対象（＝選ばなかった観点）」を作る。本番も同じ差集合を渡す。 */
function unselected(selected: readonly string[]): string[] {
  return ALL_CODES.filter((c) => !selected.includes(c));
}

describe('未選択の評価軸への言及を検出する', () => {
  // 実際に本番・本番同等パラメータで観測した出力を回帰ケースとして固定する。
  // 検出器を弱めたらここが赤くなる。
  const OBSERVED = [
    {
      name: '一蘭 渋谷店（味・接客を選択）→ 雰囲気を創作',
      draft:
        '一蘭 渋谷店でラーメンをいただきました。スープは非常に濃厚で、深いコクを感じる大変おいしい一杯でした。店内の雰囲気も良く、スタッフの方の接客も丁寧で、最初から最後まで気持ちよく食事を楽しむことができました。',
      selected: ['taste', 'service'],
      expectedAspects: ['atmosphere'],
    },
    {
      name: 'ONIBUS COFFEE 自由が丘店（味・雰囲気を選択）→ 接客を創作',
      draft:
        '美味しいコーヒーが飲みたくてONIBUS COFFEE 自由が丘店へ。コーヒーはとても香り高く、一口飲むと心が落ち着く味わいでした。店内は穏やかな雰囲気が流れており、ゆっくりと贅沢な時間を過ごすことができました。接客も丁寧で居心地が良く、またぜひ立ち寄りたいと思える素敵なお店です。',
      selected: ['taste', 'atmosphere'],
      expectedAspects: ['service'],
    },
    {
      name: 'ONIBUS COFFEE 中目黒駅前店（味のみ選択）→ 雰囲気を創作',
      draft:
        'ONIBUS COFFEE 中目黒駅前店へ行ってきた。ここのコーヒーは本当に美味しくて、一口飲むと香りが口いっぱいに広がるのがたまらない。丁寧に淹れられた一杯からは、豆本来の風味の良さがしっかりと感じられて大満足だった。お店の雰囲気も良く、こだわりの味をゆったりと楽しむことができて最高の時間になった。',
      selected: ['taste'],
      expectedAspects: ['atmosphere'],
    },
  ] as const;

  it.each(OBSERVED)('観測済みの逸脱を検出する: $name', ({ draft, selected, expectedAspects }) => {
    const violations = detectAspectMentions(draft, unselected(selected), lexicon);
    expect(violations.map((v) => v.aspectCode).sort()).toEqual([...expectedAspects].sort());
  });

  it('検証対象に含めなかった観点は検出しない（＝選択済みの観点への言及は逸脱ではない）', () => {
    const draft = '接客がとても丁寧で、店内の雰囲気も落ち着いていました。';
    expect(detectAspectMentions(draft, unselected(['service', 'atmosphere']), lexicon)).toEqual([]);
  });

  it('全軸を選択した素材では検証対象が空になり構造的に 0 件（対照群が対照として機能する）', () => {
    const draft = '味わいも接客も雰囲気も清潔さもコスパもボリュームも文句なしでした。';
    expect(unselected(ALL_CODES)).toEqual([]);
    expect(detectAspectMentions(draft, unselected(ALL_CODES), lexicon)).toEqual([]);
  });

  it('同一軸で複数の語が当たっても 1 件に畳む（件数は逸脱した軸の数で数える）', () => {
    const draft = '雰囲気が良く、内装も素敵で、居心地の良い空間でした。';
    const violations = detectAspectMentions(draft, unselected([]), lexicon);
    expect(violations.filter((v) => v.aspectCode === 'atmosphere')).toHaveLength(1);
  });

  it('語彙を持たない観点を渡されても落ちない（未知の軸は判定できないので黙って飛ばす）', () => {
    // 実行時にここへ到達する経路は「lexicon が全ての評価軸を持つ」検査で塞いでいるが、
    // 例外を投げると客に下書きが出なくなるため、関数自体は落ちない設計にしている。
    expect(detectAspectMentions('雰囲気が良い', ['unknown_aspect'], lexicon)).toEqual([]);
  });

  describe('部分一致による誤検出を出さない（語彙設計の要）', () => {
    it('「美味しい」は taste の言及として検出しない', () => {
      // 「美味しい」には『味』が部分文字列として含まれる。1 文字の語を語彙へ入れると
      // taste 未選択のほぼ全サンプルが誤検出になるため、語彙は 2 文字以上に限っている。
      const violations = detectAspectMentions('とても美味しいお店でした。', unselected([]), lexicon);
      expect(violations.map((v) => v.aspectCode)).not.toContain('taste');
    });

    it('「気持ちよく過ごせた」は atmosphere の言及として検出しない', () => {
      const violations = detectAspectMentions('気持ちよく過ごせました。', unselected([]), lexicon);
      expect(violations.map((v) => v.aspectCode)).not.toContain('atmosphere');
    });
  });

  describe('既知の限界を明示的に固定する（第一段階のスコープ外）', () => {
    it('評価軸に紐づかない創作は検出しない', () => {
      // 「丁寧に淹れられた」は素材に無い創作だが、6 軸のいずれでもないため語彙では捕まらない。
      // 将来この種を検出できるようにしたらこのテストが赤くなる。それは意図した変更の通知であり、
      // 「限界が変わった」ことをレビューへ強制的に上げるためにここへ書いている。
      const violations = detectAspectMentions(
        '丁寧に淹れられた一杯で、静かな時間を過ごせました。',
        unselected(['taste']),
        lexicon,
      );
      expect(violations).toEqual([]);
    });
  });
});

describe('語彙と評価軸の正典との同期', () => {
  const seedPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../db/migrations/0002_reference_seed.sql',
  );

  /** seed SQL の survey_aspects INSERT から code → label を抽出する。 */
  function readSeedAspects(): Map<string, string> {
    const sql = readFileSync(seedPath, 'utf8');
    const block = /INSERT INTO survey_aspects \(code, label\) VALUES([\s\S]*?);/.exec(sql);
    if (block === null) throw new Error('seed から survey_aspects の INSERT を抽出できません');
    const pairs = new Map<string, string>();
    for (const m of block[1]!.matchAll(/\('([a-z_]+)',\s*'([^']+)'\)/g)) {
      pairs.set(m[1]!, m[2]!);
    }
    return pairs;
  }

  it('seed の抽出自体が空振りしていない（6 軸が取れる）', () => {
    expect(readSeedAspects().size).toBe(6);
  });

  it('aspects.json のラベルが seed と完全に一致する', () => {
    expect(Object.fromEntries(readSeedAspects())).toEqual(labels);
  });

  it('lexicon が全ての評価軸を漏れなく持つ（軸が増えたら語彙追加を強制する）', () => {
    expect(Object.keys(lexicon).sort()).toEqual([...readSeedAspects().keys()].sort());
  });

  it('dataset が参照する aspectCodes はすべて正典に存在する', () => {
    const known = new Set(readSeedAspects().keys());
    const unknown = datasetRaw.materials.flatMap((m) =>
      m.aspectCodes.filter((c: string) => !known.has(c)),
    );
    expect(unknown).toEqual([]);
  });

  it('lexicon の語はすべて 2 文字以上（1 文字は部分一致で誤検出する）', () => {
    expect(() => readLexicon({ terms: { taste: ['味'] } })).toThrow(/2 文字以上/);
  });
});
