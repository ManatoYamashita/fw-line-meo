import { describe, it, expect, vi } from 'vitest';
import type { StructuredSurveyDefinition } from '@fwlm/db';
import type { GenAiClient } from '../src/lib/draft/generator';
import type { StructuredDraftMaterial } from '../src/lib/draft/structured-draft';
import { evaluateStructuredDraft, gateFamily, readLegacyLexicons, readStructuredGateLexicon } from '../src/lib/draft/structured/gate';
import { createNaturalRealizer, gateInputOf } from '../src/lib/draft/structured/realizer';
import { unselectedTargetsOf } from '../src/lib/structured-answer';
import lexiconRaw from '../src/lib/draft/structured/lexicon.json';

// 本番の runtime hard gate（Issue #439 の runtime / eval の揃え）。本番の素材（gateInputOf）から作った入力で、
// 評価だけが拾っていた 2 つ（未回答の Target の混入・一言の因果づけ）を本番でも高 precision に拾うことを固定する。
// 拾うのは完全一致・決まった形だけで、言い換えや主題を省いた因果は評価（eval/structured）の側に残す。

const LEX = readStructuredGateLexicon(lexiconRaw);
const LEGACY = readLegacyLexicons();

const SASHIMI = 'a4390000-0000-4000-8000-0000000000a1';
const YAKITORI = 'a4390000-0000-4000-8000-0000000000a2';
const MOTSUNI = 'a4390000-0000-4000-8000-0000000000a3';
const SASHIMI_SHORT = 'a4390000-0000-4000-8000-0000000000a4';

const DEFINITION: StructuredSurveyDefinition = {
  mode: 'structured',
  revision: 4,
  categories: [
    {
      code: 'food',
      label: '料理',
      sortOrder: 10,
      allowsTargets: true,
      categoryFacets: [{ code: 'volume', label: '量', sortOrder: 10 }],
      targetFacets: [{ code: 'taste', label: '味', sortOrder: 10 }],
      targets: [
        { id: SASHIMI, label: '刺身盛り合わせ', sortOrder: 0 },
        { id: YAKITORI, label: '焼き鳥5種盛り', sortOrder: 1 },
        { id: MOTSUNI, label: '名物もつ煮', sortOrder: 2 },
      ],
    },
  ],
};

const sashimiTaste = { polarity: 'positive' as const, categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [{ code: 'taste', label: '味' }] };

function material(over: Partial<StructuredDraftMaterial> = {}): StructuredDraftMaterial {
  const base: StructuredDraftMaterial = {
    storeName: '居酒屋 テスト',
    surveyRevision: 4,
    star: 4,
    selections: [sashimiTaste],
    unselectedTargets: unselectedTargetsOf(
      { star: 4, positiveSelections: [{ categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] }], concernSelections: [] },
      DEFINITION,
    ),
  };
  return { ...base, ...over };
}

const families = (m: StructuredDraftMaterial, draft: string) =>
  [...new Set(evaluateStructuredDraft(gateInputOf(m), draft, LEX, LEGACY).findings.map((f) => gateFamily(f.kind)))];

describe('未回答の Target（runtime）', () => {
  it('回答の検証と同じ定義から、選ばれなかった active な Target を作る', () => {
    expect(material().unselectedTargets).toEqual([
      { id: YAKITORI, label: '焼き鳥5種盛り', categoryCode: 'food' },
      { id: MOTSUNI, label: '名物もつ煮', categoryCode: 'food' },
    ]);
  });

  it('選んだ Target だけを書いた下書きは通す', () => {
    expect(families(material(), '刺身盛り合わせがおいしかったです。')).toEqual([]);
  });

  it('店舗の別の active な Target の名前を足したら失格（「焼き鳥5種盛りも良かった」）', () => {
    expect(families(material(), '刺身盛り合わせがおいしく、焼き鳥5種盛りも良かったです。')).toContain('unselectedTarget');
    // 名前の中の空白・全角半角の違いは同じ名前として扱う（NFKC）。
    expect(families(material(), '刺身盛り合わせがおいしく、焼き鳥５種盛りも良かったです。')).toContain('unselectedTarget');
  });

  it('選んだ Target が複数でも、選んだものだけなら通す', () => {
    const m = material({
      selections: [sashimiTaste, { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: YAKITORI, targetLabel: '焼き鳥5種盛り', facets: [] }],
      unselectedTargets: [{ id: MOTSUNI, label: '名物もつ煮', categoryCode: 'food' }],
    });
    expect(families(m, '刺身盛り合わせがおいしく、焼き鳥5種盛りも良かったです。')).toEqual([]);
    expect(families(m, '刺身盛り合わせがおいしく、焼き鳥5種盛りも名物もつ煮も良かったです。')).toContain('unselectedTarget');
  });

  it('回答の後に店舗が名前を変えても、素材の snapshot の名前で照合する（選んだ Target を未回答と数えない）', () => {
    // 回答時点の名前「刺身盛り合わせ」の snapshot。店舗はその後「本日の刺身」へ変えたが、素材は変わらない。
    const m = material({ selections: [{ ...sashimiTaste, targetLabel: '刺身盛り合わせ' }] });
    expect(families(m, '刺身盛り合わせがおいしかったです。')).toEqual([]);
  });

  it('選んだ Target の名前に含まれる未回答の名前（選んだ「刺身盛り合わせ」と未回答の「刺身」）は、選んだ名前の中では数えない', () => {
    const m = material({ unselectedTargets: [{ id: SASHIMI_SHORT, label: '刺身', categoryCode: 'food' }] });
    expect(families(m, '刺身盛り合わせがおいしかったです。')).toEqual([]);
    expect(families(m, '刺身盛り合わせがおいしかったです。刺身も良かったです。')).toContain('unselectedTarget');
  });

  it('関係の無い普通名詞・言い換えは推測しない（高 precision）', () => {
    // 「もつ」「焼き鳥」は未回答の Target の名前と一致しない（名前の一部・言い換えは拾わない）。
    expect(families(material(), '刺身盛り合わせがおいしかったです。')).not.toContain('unselectedTarget');
    expect(families(material(), '刺身盛り合わせの味が良かったです。焼き鳥の店らしい雰囲気でした。')).not.toContain('unselectedTarget');
    // 1 文字の名前は照合しない（普通名詞の一部に当たりやすい）。
    const m = material({ unselectedTargets: [{ id: SASHIMI_SHORT, label: '鍋', categoryCode: 'food' }] });
    expect(families(m, '刺身盛り合わせがおいしかったです。')).not.toContain('unselectedTarget');
  });

  it('一言に書かれた未回答の Target の名前は客の素材なので数えない', () => {
    const m = material({ comment: '名物もつ煮も食べました' });
    expect(families(m, '刺身盛り合わせがおいしかったです。名物もつ煮も食べました。')).not.toContain('unselectedTarget');
  });

  it('Issue #439 より前の sessionToken の素材（unselectedTargets 無し）は照合しない', () => {
    const old: StructuredDraftMaterial = { ...material() };
    delete old.unselectedTargets;
    expect(families(old, '刺身盛り合わせがおいしく、焼き鳥5種盛りも良かったです。')).not.toContain('unselectedTarget');
  });
});

describe('一言の因果づけ（runtime）', () => {
  const comfort = { polarity: 'positive' as const, categoryCode: 'atmosphere', categoryLabel: '店内・雰囲気', facets: [{ code: 'comfort', label: '居心地' }] };
  const withWindow = (over: Partial<StructuredDraftMaterial> = {}) => material({ selections: [comfort], comment: '窓側の席でした', ...over });

  it('一言を独立した内容として並べるのは通す', () => {
    expect(families(withWindow(), '居心地が良かったです。窓側の席でした。')).toEqual([]);
    expect(families(withWindow(), '窓側の席で、居心地が良かったです。')).not.toContain('commentLinkage');
  });

  it('一言の内容を別の claim の理由として結ぶと失格（「窓側の席だったので居心地が良かった」）', () => {
    expect(families(withWindow(), '窓側の席だったので居心地が良かったです。')).toContain('commentLinkage');
    expect(families(withWindow(), '窓側の席だったため、居心地が良かったです。')).toContain('commentLinkage');
    // 主題が接続の前にあっても、一言の語が理由の側にあれば拾う。
    expect(families(withWindow(), '居心地は、窓側の席だったので良かったです。')).toContain('commentLinkage');
  });

  it('Target の claim への因果づけも拾う（「店員さんの対応が丁寧だったから、刺身盛り合わせもおいしく感じた」）', () => {
    const m = material({ comment: '店員さんの対応が丁寧でした' });
    expect(families(m, '店員さんの対応が丁寧だったから、刺身盛り合わせもおいしく感じました。')).toContain('commentLinkage');
    expect(families(m, '刺身盛り合わせがおいしかったです。店員さんの対応も丁寧でした。')).not.toContain('commentLinkage');
  });

  it('claim 同士の自然な接続・起点の「から」は数えない（一言の語が理由の側に無い）', () => {
    const m = material({ selections: [sashimiTaste, comfort], comment: '窓側の席でした' });
    expect(families(m, '刺身盛り合わせがおいしかったので、居心地も良かったです。窓側の席でした。')).not.toContain('commentLinkage');
    const staff = material({ comment: '店員さんが説明してくれた' });
    expect(families(staff, '店員さんから説明があり、刺身盛り合わせがおいしかったです。')).not.toContain('commentLinkage');
  });

  it('一言そのものが因果を述べていれば、客の素材なので数えない', () => {
    const m = withWindow({ comment: '窓側の席だったので居心地が良かった' });
    expect(families(m, '窓側の席だったので居心地が良かったです。')).not.toContain('commentLinkage');
  });

  it('一言が無ければ従来どおり判定しない', () => {
    const m = material({ selections: [sashimiTaste, comfort] });
    expect(families(m, '刺身盛り合わせがおいしかったので、居心地も良かったです。')).not.toContain('commentLinkage');
  });
});

describe('既存の境界を壊さない（runtime）', () => {
  it('Target だけの claim は「良かった」までで、味・量・鮮度を足すと失格', () => {
    const m = material({ selections: [{ polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [] }] });
    expect(families(m, '刺身盛り合わせが良かったです。')).toEqual([]);
    expect(families(m, '刺身盛り合わせがおいしかったです。')).toContain('unselectedFacet');
    expect(families(m, '刺身盛り合わせは量が多かったです。')).toContain('unselectedFacet');
    expect(families(m, '刺身盛り合わせが新鮮でした。')).toContain('newAttribute');
  });

  it('exact overlap は両面だけなら通し、時間帯・部位などの理由を足すと失格', () => {
    const m = material({ selections: [sashimiTaste, { ...sashimiTaste, polarity: 'concern' }] });
    expect(families(m, '刺身盛り合わせの味は、良かったところも、気になるところもありました。')).toEqual([]);
    expect(families(m, '刺身盛り合わせの味は、時間帯によって良いときと気になるときがありました。')).toContain('overlapReason');
    expect(families(m, '刺身盛り合わせの味は、部位によって良かったり気になったりしました。')).toContain('overlapReason');
  });

  it('カテゴリ全体の facet の claim は、その facet で述べれば通す', () => {
    const m = material({ selections: [{ polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', facets: [{ code: 'volume', label: '量' }] }] });
    expect(families(m, '料理の量が良かったです。')).toEqual([]);
  });
});

describe('Realizer の作り直し（未回答の Target・一言の因果づけ）', () => {
  function fakeClient(...replies: string[]) {
    const contents: string[] = [];
    const client: GenAiClient = {
      models: {
        generateContent: async (req) => {
          contents.push(req.contents);
          return { text: JSON.stringify({ draft: replies.shift() ?? '' }) };
        },
      },
    };
    return { client, contents };
  }

  it('未回答の Target を足した 1 回目は作り直し、2 回目が通れば LLM の下書き。未回答の Target 一覧は LLM へ渡さない', async () => {
    const onRetry = vi.fn();
    const { client, contents } = fakeClient('刺身盛り合わせがおいしく、焼き鳥5種盛りも良かったです。', '刺身盛り合わせがおいしかったです。');
    const result = await createNaturalRealizer(client, { random: () => 0, onRetry }).prepare(material());
    expect(result).toEqual({ kind: 'draft', draft: '刺身盛り合わせがおいしかったです。', source: 'llm', attempts: 2 });
    // 「5種」の数字も素材に無い数値として当たる（ungrounded）。種類と claim の件数だけを渡す。
    expect(onRetry.mock.calls[0]![0]).toContain('unselectedTarget');
    expect(onRetry.mock.calls[0]![1]).toBe(1);
    for (const c of contents) expect(c).not.toMatch(/焼き鳥5種盛り|名物もつ煮/);
  });

  it('2 回とも一言を理由に結べば safe fallback', async () => {
    const onFallback = vi.fn();
    const comfort = { polarity: 'positive' as const, categoryCode: 'atmosphere', categoryLabel: '店内・雰囲気', facets: [{ code: 'comfort', label: '居心地' }] };
    const { client } = fakeClient('窓側の席だったので居心地が良かったです。', '窓側の席だったため、居心地が良かったです。');
    const result = await createNaturalRealizer(client, { random: () => 0, onFallback }).prepare(
      material({ selections: [comfort], comment: '窓側の席でした' }),
    );
    expect(result).toMatchObject({ source: 'fallback', attempts: 2, draft: '居心地が良かったです。' });
    expect(onFallback).toHaveBeenCalledWith('gate', ['commentLinkage'], 1);
  });
});
