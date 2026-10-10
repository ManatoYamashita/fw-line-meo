import { describe, it, expect } from 'vitest';
import casesRaw from '../eval/structured/cases.json';
import lexiconRaw from '../src/lib/draft/structured/lexicon.json';
import {
  claimsOf,
  evaluateStructuredDraft,
  exactOverlaps,
  gateFamily,
  readLegacyLexicons,
  readStructuredCases,
  readStructuredEvalLexicon,
  splitSentences,
  type StructuredEvalCase,
} from '../eval/structured/gates';

// structured survey の下書き評価（Issue #440）の検出器自身の検証。実 API 不要で CI で常時走る。
// 実測（eval/structured/structured.eval.test.ts）はキーが無いと skip されるので、検出器が壊れても「実行されないだけ」
// で気づけない。検出器の正しさはここで固定する（既存の eval と同じ二層・eval/README.md）。

const cases = readStructuredCases(casesRaw);
const lex = readStructuredEvalLexicon(lexiconRaw);
const legacy = readLegacyLexicons();
const byId = (id: string): StructuredEvalCase => cases.find((c) => c.id === id)!;
const families = (c: StructuredEvalCase, text: string) =>
  [...new Set(evaluateStructuredDraft(c, text, lex, legacy).findings.map((f) => f.kind))];

describe('structured eval fixture の形', () => {
  it('A〜M の 15 ケース（一言ありは硬め・普通・カジュアルの 3 種）を持ち、すべて架空の店名', () => {
    expect(cases.map((c) => c.id)).toEqual([
      'A-simple-positive',
      'B-multi-facet',
      'C-multi-target',
      'D-positive-and-concern',
      'E-same-target-other-facet',
      'F-exact-overlap',
      'G-target-only',
      'H-category-facets',
      'I1-comment-formal',
      'I2-comment-neutral',
      'I3-comment-casual',
      'K-everyday-mix',
      'L-reservation-drink',
      'M-overlap-volume-wait',
      'J-dense',
    ]);
    expect(cases.filter((c) => c.comment !== undefined).map((c) => c.commentTone)).toEqual(['formal', 'neutral', 'casual']);
  });

  it('形の誤りは測定の前に止める', () => {
    const base = (casesRaw as { cases: unknown[] }).cases[0] as Record<string, unknown>;
    const bad = (patch: Record<string, unknown>) => ({ cases: [{ ...base, ...patch }] });
    expect(() => readStructuredCases({ cases: [] })).toThrow();
    expect(() => readStructuredCases(bad({ star: 6 }))).toThrow();
    expect(() => readStructuredCases(bad({ selections: [{ polarity: 'good', categoryCode: 'food', categoryLabel: '料理', facets: [] }] }))).toThrow();
    // 開いただけ（Target も facet も無い）のグループは回答ではない。
    expect(() => readStructuredCases(bad({ selections: [{ polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', facets: [] }] }))).toThrow();
    expect(() => readStructuredCases(bad({ allowedParaphrases: [] }))).toThrow();
    expect(() => readStructuredCases({ cases: [base, base] })).toThrow();
  });

  it('claim は Target だけ・Target + facet・カテゴリ全体の facet を区別し、exact overlap を見つける', () => {
    expect(claimsOf(byId('G-target-only')).map((c) => c.id)).toEqual(['positive:t-sashimi']);
    expect(claimsOf(byId('B-multi-facet')).map((c) => c.id)).toEqual(['positive:t-sashimi:taste', 'positive:t-sashimi:appearance']);
    expect(claimsOf(byId('H-category-facets')).map((c) => c.id)).toEqual(['positive:atmosphere:comfort', 'concern:atmosphere:noise_level']);
    expect(exactOverlaps(byId('F-exact-overlap'))).toEqual(['t-sashimi:taste']);
    expect(exactOverlaps(byId('E-same-target-other-facet'))).toEqual([]);
  });
});

describe('許す言い換えは、すべての hard gate を通り、すべての claim を述べている', () => {
  for (const c of cases) {
    for (const text of c.allowedParaphrases) {
      it(`${c.id}: ${text}`, () => {
        const result = evaluateStructuredDraft(c, text, lex, legacy);
        expect(result.findings).toEqual([]);
        expect(result.coverage.filter((cv) => !cv.covered).map((cv) => cv.claimId)).toEqual([]);
      });
    }
  }
});

describe('失格になるべき例は、期待した hard gate に当たる', () => {
  for (const c of cases) {
    for (const example of c.forbiddenExamples) {
      it(`${c.id}: ${example.text} → ${example.kinds.join(', ')}`, () => {
        // 分類つきの種類（visitContext:motive など）は、例では頭の名前で書いてよい。
        const got = [...new Set([...families(c, example.text), ...families(c, example.text).map(gateFamily)])];
        for (const kind of example.kinds) expect(got, JSON.stringify(got)).toContain(kind);
      });
    }
  }
});

it('すべての hard gate の種類が、失格になるべき例で少なくとも 1 回は検証されている', () => {
  const exercised = new Set(cases.flatMap((c) => c.forbiddenExamples.flatMap((e) => e.kinds.map(gateFamily))));
  for (const family of [
    'unselectedTarget', 'unselectedFacet', 'unselectedCategory', 'newAttribute', 'cause', 'timing', 'companion',
    'visitContext', 'expectation', 'revisit', 'recommendation', 'intensity', 'polarityReversal',
    'positiveDropped', 'concernDropped', 'targetDropped', 'overlapReason', 'commentLinkage', 'absence',
    'ungrounded', 'caseForbidden',
  ]) {
    expect(exercised, family).toContain(family);
  }
});

describe('structured 固有の gate', () => {
  it('coverage は文字列一致ではない: 「おいしかった」で 刺身盛り合わせ / 味 / positive を満たす', () => {
    const r = evaluateStructuredDraft(byId('A-simple-positive'), '刺身盛り合わせがおいしかったです。', lex, legacy);
    expect(r.coverage).toEqual([{ claimId: 'positive:t-sashimi:taste', covered: true, facetMentioned: true }]);
  });

  it('同じ Target・同じ極性の facet は統合してよい（facet の字が無くても失格にしない）', () => {
    const r = evaluateStructuredDraft(byId('B-multi-facet'), '刺身盛り合わせがおいしかったです。', lex, legacy);
    expect(r.passed).toBe(true);
    expect(r.coverage.find((cv) => cv.claimId === 'positive:t-sashimi:appearance')).toEqual({
      claimId: 'positive:t-sashimi:appearance',
      covered: true,
      facetMentioned: false,
    });
  });

  it('exact overlap の理由は overlap のケースでだけ数える（別の facet のケースでは数えない）', () => {
    const text = '刺身盛り合わせは味が良かったですが、部位によって量は気になりました。';
    expect(families(byId('F-exact-overlap'), '刺身盛り合わせの味は、部位によって良い点も気になる点もありました。')).toContain('overlapReason');
    expect(families(byId('E-same-target-other-facet'), text)).not.toContain('overlapReason');
  });

  it('Issue #418 の本番の観測例（両面の共存の理由）を exact overlap で拾う', () => {
    const c = byId('F-exact-overlap');
    for (const text of [
      '刺身盛り合わせの味は、利用するタイミングによって印象が変わるような料理でした。',
      '刺身盛り合わせの味は、その時々の状況によって印象が大きく異なるものであり、良い点も気になる点もありました。',
    ]) {
      expect(families(c, text)).toContain('overlapReason');
    }
  });

  it('一言にある内容・強度・意向は、その客の素材として数えない', () => {
    const formal = byId('I1-comment-formal');
    expect(families(formal, '刺身盛り合わせの味は良好でした。料理の提供にはやや時間を要しました。')).toEqual([]);
    const casual = byId('I3-comment-casual');
    expect(families(casual, '刺身盛り合わせ、うまかった！また行きます。')).toEqual([]);
  });

  it('一言の内容を別の claim の理由として結ばなければ、同じ文に並べてもよい', () => {
    const c = byId('I2-comment-neutral');
    expect(families(c, '店員さんの対応が丁寧で、刺身盛り合わせもおいしかったです。')).not.toContain('commentLinkage');
    expect(families(c, '店員さんの対応が丁寧だったから、刺身盛り合わせもおいしく感じました。')).toContain('commentLinkage');
  });

  it('一言の内容を、カテゴリ全体の facet の claim の理由として結んでも失格', () => {
    const c = byId('I1-comment-formal');
    // 一言「料理の提供にはやや時間を要しました」を、刺身の味（Target）ではなく別の主題へ結ぶ形も拾う。
    expect(families(c, '料理の提供に時間を要したので、刺身盛り合わせの味も良好には感じませんでした。')).toContain('commentLinkage');
    expect(families(c, '刺身盛り合わせの味は良好でした。料理の提供にはやや時間を要しました。')).not.toContain('commentLinkage');
  });

  it('Target の名前に属性の語が含まれても（だし巻き玉子の「だし」）属性の追加として数えない', () => {
    expect(families(byId('C-multi-target'), '刺身盛り合わせもだし巻き玉子もおいしかったです。')).toEqual([]);
  });

  it('店名から始まる・店名に含まれる語は数えない', () => {
    const c = byId('H-category-facets');
    expect(families(c, '珈琲と本 こもれびは居心地が良かったです。にぎやかさは気になりました。')).toEqual([]);
  });

  it('文に分ける', () => {
    expect(splitSentences('一。二！三?\n四')).toEqual(['一。', '二！', '三?', '四']);
  });

  it('分類つきの失格は頭の名前へまとめる', () => {
    expect(gateFamily('ungrounded:number')).toBe('ungrounded');
    expect(gateFamily('intensity')).toBe('intensity');
  });
});
