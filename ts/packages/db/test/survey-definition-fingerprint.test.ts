import { describe, it, expect } from 'vitest';
import { surveyDefinitionFingerprint, type StructuredSurveyDefinition } from '../src/survey-definition.js';

// 有効な定義の指紋（Issue #438）。客が見た定義の意味が変わったら必ず変わり、意味が同じなら変わらない。

function base(): StructuredSurveyDefinition {
  return {
    mode: 'structured',
    revision: 3,
    categories: [
      {
        code: 'food',
        label: '料理',
        sortOrder: 10,
        allowsTargets: true,
        categoryFacets: [
          { code: 'taste', label: '味', sortOrder: 10 },
          { code: 'volume', label: '量', sortOrder: 20 },
        ],
        targetFacets: [{ code: 'taste', label: '味', sortOrder: 10 }],
        targets: [
          { id: 'a4380000-0000-4000-8000-000000000001', label: '刺身盛り合わせ', sortOrder: 0 },
          { id: 'a4380000-0000-4000-8000-000000000002', label: '焼き鳥', sortOrder: 1 },
        ],
      },
      {
        code: 'price',
        label: '価格',
        sortOrder: 50,
        allowsTargets: false,
        categoryFacets: [{ code: 'value_for_money', label: 'コスパ', sortOrder: 30 }],
        targetFacets: [],
        targets: [],
      },
    ],
  };
}

type Mutation = [string, (d: StructuredSurveyDefinition) => void];

describe('surveyDefinitionFingerprint', () => {
  it('同じ定義からは同じ値（43 文字の base64url）を返す', () => {
    const a = surveyDefinitionFingerprint(base());
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(surveyDefinitionFingerprint(base())).toBe(a);
  });

  it('客が見た意味に関わる変更では必ず変わる', () => {
    const original = surveyDefinitionFingerprint(base());
    const mutations: Mutation[] = [
      ['カテゴリを非表示にした', (d) => d.categories.splice(1, 1)],
      ['カテゴリの並びを変えた', (d) => d.categories.reverse()],
      ['カテゴリの名前を変えた（taxonomy の変更）', (d) => (d.categories[0]!.label = 'お料理')],
      ['facet を足した（対応の変更）', (d) => d.categories[0]!.categoryFacets.push({ code: 'variety', label: '種類', sortOrder: 30 })],
      ['facet の並びを変えた', (d) => d.categories[0]!.categoryFacets.reverse()],
      ['facet の名前を変えた', (d) => (d.categories[0]!.categoryFacets[0]!.label = '味わい')],
      ['Target 用の facet を変えた', (d) => (d.categories[0]!.targetFacets = [])],
      ['Target の名前を変えた', (d) => (d.categories[0]!.targets[0]!.label = 'お刺身盛り合わせ')],
      ['Target の並びを変えた', (d) => d.categories[0]!.targets.reverse()],
      ['Target を非表示にした', (d) => d.categories[0]!.targets.pop()],
      ['Target の ID が変わった', (d) => (d.categories[0]!.targets[0]!.id = 'a4380000-0000-4000-8000-0000000000ff')],
    ];
    for (const [name, mutate] of mutations) {
      const d = base();
      mutate(d);
      expect(surveyDefinitionFingerprint(d), name).not.toBe(original);
    }
  });

  it('revision と数値の sort_order だけが違っても（並びが同じなら）変わらない', () => {
    const d = base();
    d.revision = 99;
    d.categories[0]!.sortOrder = 5;
    d.categories[0]!.targets[1]!.sortOrder = 7;
    expect(surveyDefinitionFingerprint(d)).toBe(surveyDefinitionFingerprint(base()));
  });
});
