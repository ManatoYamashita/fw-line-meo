import { describe, it, expect, vi } from 'vitest';
import casesRaw from '../eval/structured/cases.json';
import lexiconRaw from '../src/lib/draft/structured/lexicon.json';
import { readLegacyLexicons, readStructuredCases, readStructuredEvalLexicon, evaluateStructuredDraft, type StructuredEvalCase } from '../eval/structured/gates';
import { bigramJaccard, diagnoseDraft, regenerationSimilarity, summarizeDiagnostics } from '../eval/structured/diagnostics';
import {
  aggregatePairwise,
  aggregateRatings,
  buildBlindPacket,
  parseCsv,
  seededRandom,
  seededShuffle,
  type BlindSample,
} from '../eval/structured/blind';
import { claimsPlainPrompt, evalMethods, safeFallback, toLegacyMaterial } from '../eval/structured/methods';
import { formatSummary, recordSample, summarize } from '../eval/structured/report';
import type { GenAiClient } from '../src/lib/draft/generator';

// structured survey の評価の道具（Issue #440）の検証。実 API 不要で CI で常時走る。

const cases = readStructuredCases(casesRaw);
const lex = readStructuredEvalLexicon(lexiconRaw);
const legacy = readLegacyLexicons();
const byId = (id: string): StructuredEvalCase => cases.find((c) => c.id === id)!;

describe('AI っぽさの診断（合否ではない）', () => {
  it('定型句・反復・語尾の連続・店名の書き出し・締めの意向と推奨を数える', () => {
    const c = byId('J-dense');
    const d = diagnoseDraft(
      c,
      '旬菜 あかりは全体として好印象でした。刺身盛り合わせが良かったです。だし巻き玉子も良かったです。一方で、提供が気になりました。また来たいです。',
      lex,
    );
    expect(d.phrases).toMatchObject({ zentai: true, koinsho: true, ippou: true, manzokudo: false, yokattadesu: true });
    expect(d.yokattadesuCount).toBe(2);
    expect(d.maxSameEndingRun).toBe(2);
    expect(d.startsWithStoreName).toBe(true);
    expect(d.endsWithRevisit).toBe(true);
    expect(d.endsWithRecommendation).toBe(false);
    expect(d.sentenceCount).toBe(5);
    expect(d.claimCount).toBe(8);
  });

  it('主題を入力の順に 1 文 1 主題で並べたら checklistLike（同じ料理の味と見た目の統合は 1 主題）', () => {
    const c = byId('J-dense');
    expect(diagnoseDraft(c, safeFallback(c), lex).checklistLike).toBe(true);
    const natural = c.allowedParaphrases[0]!;
    expect(diagnoseDraft(c, natural, lex).checklistLike).toBe(false);
    // 素材が少ないケースは対象外（2 主題以下）。
    expect(diagnoseDraft(byId('D-positive-and-concern'), safeFallback(byId('D-positive-and-concern')), lex).checklistLike).toBe(false);
  });

  it('一言より感嘆符が増えたかを見る（一言が無いケースは null）', () => {
    const casual = byId('I3-comment-casual');
    expect(diagnoseDraft(casual, '刺身盛り合わせ、うまかった！！また行きます！', lex).exclamationAdded).toBe(true);
    expect(diagnoseDraft(casual, '刺身盛り合わせ、うまかった！また行きます。', lex).exclamationAdded).toBe(false);
    expect(diagnoseDraft(byId('A-simple-positive'), '刺身盛り合わせがおいしかったです！', lex).exclamationAdded).toBeNull();
  });

  it('再生成の類似度: 完全一致・語尾だけ違う・違う文を区別する', () => {
    expect(bigramJaccard('刺身がおいしかった', '刺身がおいしかった')).toBe(1);
    const sim = regenerationSimilarity(
      ['刺身盛り合わせが良かったです。', '刺身盛り合わせが良かった。', '刺身盛り合わせ、印象に残りました。'],
      '海鮮食堂 しおさい',
    );
    expect(sim.pairs).toBe(3);
    expect(sim.exactDuplicatePairs).toBe(0);
    expect(sim.sameExceptEndingPairs).toBe(1);
    expect(sim.meanJaccard).toBeGreaterThan(0);
    expect(sim.meanJaccard).toBeLessThan(1);
  });

  it('集計は率と、claim 数ごとの平均字数（薄い素材ほど長い状態を見る）を出す', () => {
    const list = [byId('A-simple-positive'), byId('J-dense')].map((c) => diagnoseDraft(c, safeFallback(c), lex));
    const s = summarizeDiagnostics(list);
    expect(s.n).toBe(2);
    expect(Object.keys(s.charsByClaimCount)).toEqual(['1', '8']);
    expect(s.rates.checklistLike).toBe(0.5);
  });
});

describe('ブラインドの人手評価', () => {
  const samples: BlindSample[] = ['legacy-direct', 'claims-plain', 'safe-fallback'].flatMap((method) =>
    [0, 1].map((run) => ({ caseId: 'A-simple-positive', caseTitle: '単純 positive', method, run, draft: `${method}-${run} の下書き` })),
  );

  it('同じシードからは同じ並び、違うシードからは違う並びになる（決定的）', () => {
    const a = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], seededRandom(440));
    expect(seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], seededRandom(440))).toEqual(a);
    expect(seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], seededRandom(441))).not.toEqual(a);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('本文に方式名を出さず、対応表は別に持つ。各方式の最初の run を 1 本ずつ出す', () => {
    const packet = buildBlindPacket(samples, { seed: 440 });
    for (const method of ['legacy-direct', 'claims-plain', 'safe-fallback']) {
      // 本文には方式の下書き（run 0）だけが出て、方式の名前の説明は出ない。
      expect(packet.sheet).not.toContain(`方式: ${method}`);
    }
    expect(packet.sheet).toContain('### 候補A');
    expect(packet.sheet).toContain('### 候補C');
    expect(packet.sheet).not.toContain('-1 の下書き');
    expect(Object.values(packet.key['A-simple-positive']!).sort()).toEqual(['claims-plain', 'legacy-direct', 'safe-fallback']);
    expect(buildBlindPacket(samples, { seed: 440 })).toEqual(packet);
  });

  it('記入用の表は評価者を符号で記録する列を持ち、名前の列を持たない', () => {
    const packet = buildBlindPacket(samples, { seed: 440 });
    expect(packet.ratingsTemplate.split('\n')[0]).toBe('case_id,candidate,rater,naturalness,ai_likeness,postability,fidelity');
    expect(packet.pairwiseTemplate.split('\n')[0]).toBe('case_id,left,right,rater,choice');
    expect(packet.ratingsTemplate).not.toMatch(/name|氏名|名前/);
    expect(packet.pairwiseTemplate.trim().split('\n')).toHaveLength(1 + 3);
  });

  it('記入済みの表を方式ごとの平均と、方式どうしの勝ち・負け・同等へ集計する', () => {
    const packet = buildBlindPacket(samples, { seed: 440 });
    const key = packet.key;
    const letterOf = (method: string) => Object.entries(key['A-simple-positive']!).find(([, m]) => m === method)![0];
    const [lg, cp, sf] = ['legacy-direct', 'claims-plain', 'safe-fallback'].map(letterOf);
    const ratings = parseCsv(
      [
        'case_id,candidate,rater,naturalness,ai_likeness,postability,fidelity',
        `A-simple-positive,${lg},R1,2,4,2,5`,
        `A-simple-positive,${cp},R1,4,2,4,5`,
        `A-simple-positive,${sf},R1,1,5,1,5`,
        `A-simple-positive,${cp},R2,5,1,5,4`,
        `A-simple-positive,${sf},R2,,,,`,
      ].join('\n'),
    );
    const agg = aggregateRatings(ratings, key);
    expect(agg['claims-plain']).toEqual({ n: 2, mean: { naturalness: 4.5, ai_likeness: 1.5, postability: 4.5, fidelity: 4.5 } });
    expect(agg['safe-fallback']!.n).toBe(1);
    const [a, b] = [cp, lg].sort() as [string, string];
    const pairs = aggregatePairwise(
      parseCsv(['case_id,left,right,rater,choice', `A-simple-positive,${a},${b},R1,${cp}`, `A-simple-positive,${a},${b},R2,同等`, `A-simple-positive,${a},${b},R3,Z`].join('\n')),
      key,
    );
    expect(pairs['claims-plain vs legacy-direct']).toEqual({ wins: 1, losses: 0, ties: 1 });
  });
});

describe('比較する方式', () => {
  it('A: structured の素材を legacy の観点のラベルへ平らにする（Target と facet は「刺身盛り合わせの味」）', () => {
    expect(toLegacyMaterial(byId('E-same-target-other-facet'))).toEqual({
      storeName: '海鮮食堂 しおさい',
      star: 3,
      aspectLabels: ['刺身盛り合わせの味'],
      concernLabels: ['刺身盛り合わせの量'],
    });
    expect(toLegacyMaterial(byId('G-target-only')).aspectLabels).toEqual(['刺身盛り合わせ']);
    expect(toLegacyMaterial(byId('I2-comment-neutral')).comment).toBe('店員さんの対応が丁寧でした');
  });

  it('B: claim を箇条書きで渡し、選んでいない極性の見出しを出さない（未選択を「なし」と書かせない）', () => {
    const { userContent } = claimsPlainPrompt(byId('A-simple-positive'));
    expect(userContent).toContain('- 料理 > 刺身盛り合わせ > 味');
    expect(userContent).not.toContain('気になったところ');
    expect(userContent).not.toMatch(/なし/);
  });

  it('D: 決定的なテンプレートは、すべてのケースで hard gate を通り、すべての claim を述べる', () => {
    for (const c of cases) {
      const text = safeFallback(c);
      const r = evaluateStructuredDraft(c, text, lex, legacy);
      expect(r.findings, `${c.id}: ${text}`).toEqual([]);
      expect(r.coverage.every((cv) => cv.covered), `${c.id}: ${text}`).toBe(true);
    }
    expect(safeFallback(byId('F-exact-overlap'))).toBe('刺身盛り合わせの味は、良かったところもあり、気になるところもありました。');
  });

  it('C は本番の StructuredDraftPort を呼ぶ。Stage 2 の暫定実装（下書きなし）では生成なしとして数える', async () => {
    const methods = evalMethods({ model: 'm' });
    expect(methods.map((m) => m.id)).toEqual(['legacy-direct', 'claims-plain', 'natural-realizer', 'safe-fallback']);
    const c = methods.find((m) => m.id === 'natural-realizer')!;
    expect(await c.generate(byId('A-simple-positive'), 0)).toBeNull();
    const plugged = evalMethods({ model: 'm', structuredPort: { prepare: async () => ({ kind: 'draft', draft: '刺身盛り合わせがおいしかったです。' }) as never } });
    expect(await plugged.find((m) => m.id === 'natural-realizer')!.generate(byId('A-simple-positive'), 0)).toBe('刺身盛り合わせがおいしかったです。');
  });

  it('C は client があれば本番の Realizer で、未回答の Target の名前を事後検証へ渡し、作り直し・fallback を通知する', async () => {
    const replies = ['刺身盛り合わせもだし巻き玉子も、鶏の唐揚げもおいしかったです。', '刺身盛り合わせもだし巻き玉子もおいしかったです。'];
    const contents: string[] = [];
    const client: GenAiClient = {
      models: {
        generateContent: async (req) => {
          contents.push(req.contents);
          return { text: JSON.stringify({ draft: replies.shift() ?? '' }) };
        },
      },
    };
    const onRetry = vi.fn();
    const onFallback = vi.fn();
    const c = evalMethods({ client, model: 'gemini-test', realizerEvents: { onRetry, onFallback } }).find((m) => m.id === 'natural-realizer')!;
    // 1 回目は未回答の「鶏の唐揚げ」を足したので作り直し、2 回目の LLM の文を返す（本番と同じ runtime hard gate）。
    expect(await c.generate(byId('C-multi-target'), 0)).toBe('刺身盛り合わせもだし巻き玉子もおいしかったです。');
    expect(onRetry.mock.calls[0]![0]).toContain('unselectedTarget');
    expect(onFallback).not.toHaveBeenCalled();
    // 未回答の Target は事後検証だけが使い、LLM へは渡さない。
    for (const text of contents) expect(text).not.toContain('鶏の唐揚げ');
  });

  it('A・B は同じクライアント・同じモデル・本番と同じ temperature で呼ぶ', async () => {
    const requests: { model: string; config: Record<string, unknown> }[] = [];
    const client: GenAiClient = {
      models: {
        generateContent: async (req) => {
          requests.push({ model: req.model, config: req.config });
          return { text: JSON.stringify({ draft: '刺身盛り合わせがおいしかったです。' }) };
        },
      },
    };
    const methods = evalMethods({ client, model: 'gemini-test' });
    for (const id of ['legacy-direct', 'claims-plain']) {
      expect(await methods.find((m) => m.id === id)!.generate(byId('A-simple-positive'), 0)).toBe('刺身盛り合わせがおいしかったです。');
    }
    expect(requests.map((r) => [r.model, r.config.temperature])).toEqual([
      ['gemini-test', 1],
      ['gemini-test', 1],
    ]);
  });
});

describe('集計の形', () => {
  it('方式ごとに hard gate・overlap の理由・coverage・診断・再生成の類似度・ケースごとの合否を出す', () => {
    const f = byId('F-exact-overlap');
    const a = byId('A-simple-positive');
    const samples = [
      recordSample(f, 'x', 0, '刺身盛り合わせの味は、時間帯によって良いときと気になるときがありました。', lex, legacy),
      recordSample(f, 'x', 1, safeFallback(f), lex, legacy),
      recordSample(a, 'x', 0, '刺身盛り合わせがおいしかったです。', lex, legacy),
      recordSample(a, 'x', 1, null, lex, legacy),
    ];
    const s = summarize([a, f], samples);
    const m = s.methods[0]!;
    expect(m).toMatchObject({ method: 'x', samples: 4, missing: 1, hardFailed: 1, overlapReason: { failed: 1, of: 2 } });
    expect(m.gateCounts.overlapReason).toBe(1);
    expect(m.byCase['F-exact-overlap']).toEqual({ passed: 1, of: 2, kinds: ['overlapReason', 'timing'] });
    expect(formatSummary(s)).toContain('| x | 3/4 | 1/3（33.3%） | 1/2 |');
  });
});
