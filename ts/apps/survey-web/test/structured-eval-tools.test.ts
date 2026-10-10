import { describe, it, expect, vi } from 'vitest';
import casesRaw from '../eval/structured/cases.json';
import lexiconRaw from '../src/lib/draft/structured/lexicon.json';
import { readLegacyLexicons, readStructuredCases, readStructuredEvalLexicon, evaluateStructuredDraft, type StructuredEvalCase } from '../eval/structured/gates';
import { bigramJaccard, diagnoseDraft, regenerationSimilarity, summarizeDiagnostics } from '../eval/structured/diagnostics';
import { aggregateRatings, buildRatingPacket, parseCsv, RATINGS_HEADER, type RatingSample } from '../eval/structured/rating';
import { evalGenerators, materialOf, safeFallback } from '../eval/structured/methods';
import { formatSummary, recordSample, successChecks, summarize } from '../eval/structured/report';
import type { GenAiClient } from '../src/lib/draft/generator';

// structured survey の評価の道具（Issue #440）の検証。実 API 不要で CI で常時走る。
// 評価の対象は本番の通常生成と safe fallback の 2 つだけ（方式の比較はしない）。

const cases = readStructuredCases(casesRaw);
const lex = readStructuredEvalLexicon(lexiconRaw);
const legacy = readLegacyLexicons();
const byId = (id: string): StructuredEvalCase => cases.find((c) => c.id === id)!;

describe('自然さの診断（個々の合否ではない）', () => {
  it('safe fallback 風（羅列）・1 文 1 主題・項目名の読み上げを数え、自然な文では立たない', () => {
    const k = byId('K-everyday-mix');
    const fb = diagnoseDraft(k, safeFallback(k), lex);
    expect(fb.fallbackLike).toBe(true);
    expect(fb.subjectPerSentence).toBe(true);
    // 読み上げに近い文（項目名のまま・1 文 1 主題）。順番が入力と違っても subjectPerSentence は立つ。
    const readout = diagnoseDraft(k, '入店までの待ち時間が気になりました。料理の量は満足できました。接客の丁寧さも良かったです。', lex);
    expect(readout).toMatchObject({ fallbackLike: false, subjectPerSentence: true, checklistLike: false, labelVerbatimRate: 1 });
    for (const natural of k.allowedParaphrases) {
      expect(diagnoseDraft(k, natural, lex), natural).toMatchObject({ fallbackLike: false, subjectPerSentence: false });
    }
    expect(diagnoseDraft(k, k.allowedParaphrases[1]!, lex).labelVerbatimRate).toBe(0);
  });

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

describe('人手の採点（本番の通常生成の下書き）', () => {
  const samples: RatingSample[] = [1, 0, 2].map((run) => ({ caseId: 'A-simple-positive', run, draft: `下書き-${run}` }));

  it('ケースごとに run の順で S1・S2… を振り、下書きの出どころ（LLM / safe fallback）を出さない', () => {
    const packet = buildRatingPacket(samples, { caseContext: { 'A-simple-positive': '★5・良:刺身盛り合わせ/味' } });
    expect(packet.sheet).toContain('回答: ★5・良:刺身盛り合わせ/味');
    expect(packet.sheet).toContain('### S1\n\n下書き-0');
    expect(packet.sheet).toContain('### S3\n\n下書き-2');
    expect(packet.sheet).not.toMatch(/fallback|llm|production|方式/i);
    expect(packet.ratingsTemplate.trim().split('\n')).toEqual([
      RATINGS_HEADER,
      'A-simple-positive,S1,,,,,',
      'A-simple-positive,S2,,,,,',
      'A-simple-positive,S3,,,,,',
    ]);
  });

  it('記入用の表は評価者を符号で記録する列を持ち、名前の列を持たない', () => {
    expect(RATINGS_HEADER).toBe('case_id,sample,rater,naturalness,postability,fidelity,fabrication');
    expect(RATINGS_HEADER).not.toMatch(/name|氏名|名前/);
  });

  it('記入済みの表を、全体と評価者ごとの平均・創作の指摘の件数へ集計する（評価者の空欄・範囲外は数えない）', () => {
    const agg = aggregateRatings(
      parseCsv(
        [
          RATINGS_HEADER,
          'A-simple-positive,S1,R1,4,4,5,0',
          'A-simple-positive,S2,R1,2,3,5,1',
          'A-simple-positive,S1,R2,5,5,5,0',
          'A-simple-positive,S2,R2,9,,,',
          'A-simple-positive,S3,,5,5,5,0',
        ].join('\n'),
      ),
    );
    expect(agg.raters).toEqual(['R1', 'R2']);
    expect(agg.overall).toEqual({ n: 3, fabrication: 1, mean: { naturalness: 11 / 3, postability: 4, fidelity: 5 } });
    expect(agg.byRater.R1).toEqual({ n: 2, fabrication: 1, mean: { naturalness: 3, postability: 3.5, fidelity: 5 } });
  });
});

describe('評価の対象（本番の通常生成と safe fallback の 2 つだけ）', () => {
  it('対象は production と safe-fallback だけ', () => {
    expect(evalGenerators({ model: 'm' }).map((g) => [g.id, g.requiresApi])).toEqual([
      ['production', true],
      ['safe-fallback', false],
    ]);
  });

  it('safe fallback: 決定的なテンプレートは、すべてのケースで hard gate を通り、すべての claim を述べる', () => {
    for (const c of cases) {
      const text = safeFallback(c);
      const r = evaluateStructuredDraft(c, text, lex, legacy);
      expect(r.findings, `${c.id}: ${text}`).toEqual([]);
      expect(r.coverage.every((cv) => cv.covered), `${c.id}: ${text}`).toBe(true);
    }
    expect(safeFallback(byId('F-exact-overlap'))).toBe('刺身盛り合わせの味は、良かったところもあり、気になるところもありました。');
  });

  it('production は本番の StructuredDraftPort を呼び、下書きの出どころと LLM の呼び出し回数を返す', async () => {
    const none = evalGenerators({ model: 'm' }).find((g) => g.id === 'production')!;
    expect(await none.generate(byId('A-simple-positive'), 0)).toEqual({ draft: null, source: null, attempts: 0 });
    const plugged = evalGenerators({
      model: 'm',
      structuredPort: {
        prepare: async () => ({ kind: 'draft', draft: '刺身盛り合わせがおいしかったです。', source: 'llm', attempts: 2 }),
      },
    }).find((g) => g.id === 'production')!;
    expect(await plugged.generate(byId('A-simple-positive'), 0)).toEqual({
      draft: '刺身盛り合わせがおいしかったです。',
      source: 'llm',
      attempts: 2,
    });
  });

  it('本番の素材を作る: 未回答の Target は名前だけ（言い方は渡さない）・星と一言はそのまま', () => {
    const m = materialOf(byId('C-multi-target'));
    expect(m.unselectedTargets).toEqual([{ id: 't-karaage', label: '鶏の唐揚げ', categoryCode: 'food' }]);
    expect(m.star).toBe(4);
    expect(materialOf(byId('I3-comment-casual')).comment).toBe('刺身うまかった！また行く');
  });

  it('production は client があれば本番の Realizer で、未回答の Target の名前を事後検証へ渡し、作り直しを通知する', async () => {
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
    const p = evalGenerators({ client, model: 'gemini-test', realizerEvents: { onRetry, onFallback } }).find((g) => g.id === 'production')!;
    // 1 回目は未回答の「鶏の唐揚げ」を足したので作り直し、2 回目の LLM の文を返す（本番と同じ runtime hard gate）。
    expect(await p.generate(byId('C-multi-target'), 0)).toEqual({
      draft: '刺身盛り合わせもだし巻き玉子もおいしかったです。',
      source: 'llm',
      attempts: 2,
    });
    expect(onRetry.mock.calls[0]![0]).toContain('unselectedTarget');
    expect(onFallback).not.toHaveBeenCalled();
    // 未回答の Target は事後検証だけが使い、LLM へは渡さない。
    for (const text of contents) expect(text).not.toContain('鶏の唐揚げ');
  });
});

describe('集計の形と成功条件', () => {
  const llm = (draft: string | null) => ({ draft, source: draft === null ? null : ('llm' as const), attempts: 1 });

  it('対象ごとに offline eval gate・overlap の理由・coverage・fallback・作り直し・診断・ケースごとの合否を出す', () => {
    const f = byId('F-exact-overlap');
    const a = byId('A-simple-positive');
    const samples = [
      recordSample(f, 'production', 0, llm('刺身盛り合わせの味は、時間帯によって良いときと気になるときがありました。'), lex, legacy),
      recordSample(f, 'production', 1, { draft: safeFallback(f), source: 'fallback', attempts: 2 }, lex, legacy),
      recordSample(a, 'production', 0, llm('刺身盛り合わせがおいしかったです。'), lex, legacy),
      recordSample(a, 'production', 1, llm(null), lex, legacy),
    ];
    const s = summarize([a, f], samples);
    const m = s.generators[0]!;
    expect(m).toMatchObject({
      generator: 'production',
      samples: 4,
      missing: 1,
      fallback: 1,
      retried: 1,
      hardFailed: 1,
      overlapReason: { failed: 1, of: 2 },
    });
    expect(m.gateCounts.overlapReason).toBe(1);
    expect(m.byCase['F-exact-overlap']).toEqual({ passed: 1, of: 2, kinds: ['overlapReason', 'timing'] });
    // 自然さの診断は LLM の文だけ（safe fallback の文を除く）。
    expect(m.diagnostics.n).toBe(2);
    const text = formatSummary(s);
    expect(text).toContain('| production | 3/4 | 1/3 | 1/3 | 1/3（33.3%） | 1/2 |');
    expect(text).toContain('| offline eval gate の失格（runtime を通った最終の下書きの残差） | 1/3 | 0 件 | FAIL |');
  });

  it('成功条件: 事実性の残差 0・fallback 10% 以下・fallback 風 5% 以下・読み上げ 10% 以下などを判定する', () => {
    const k = byId('K-everyday-mix');
    const good = k.allowedParaphrases.map((d, run) => recordSample(k, 'production', run, llm(d), lex, legacy));
    const pass = successChecks(summarize([k], good).generators[0]!);
    expect(pass.filter((c) => !c.passed).map((c) => c.id)).toEqual([]);
    expect(pass.map((c) => c.id)).toEqual([
      'factuality',
      'overlapReason',
      'fallbackRate',
      'fallbackLike',
      'checklistLike',
      'sameEndingRun3',
      'length',
      'duplicates',
    ]);

    const fallbackish = [0, 1].map((run) => recordSample(k, 'production', run, llm(safeFallback(k)), lex, legacy));
    const fail = successChecks(summarize([k], fallbackish).generators[0]!);
    expect(fail.filter((c) => !c.passed).map((c) => c.id)).toEqual(expect.arrayContaining(['fallbackLike', 'duplicates']));
  });
});
