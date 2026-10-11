import { describe, it, expect } from 'vitest';
import type { StructuredSurveyDefinition } from '@fwlm/db';
import {
  EMPTY_EVIDENCE,
  MIN_MATERIALS,
  categoryEvidence,
  countMaterials,
  summarizeCategory,
  summaryText,
  toSelectionGroups,
  toggleCategoryFacet,
  toggleTarget,
  toggleTargetFacet,
} from '../src/lib/structured-selection';
import {
  MIN_MATERIALS as SHARED_MIN_MATERIALS,
  countSelectionGroupMaterials,
  countStructuredAnswerMaterials,
  hasEnoughMaterials,
} from '../src/lib/structured-materials';

// structured survey の選択（evidence）の状態と送信の形（Issue #438）。画面の展開状態はここに無い。

const SASHIMI = 'a4380000-0000-4000-8000-0000000000a1';
const YAKITORI = 'a4380000-0000-4000-8000-0000000000a2';

const DEF: StructuredSurveyDefinition = {
  mode: 'structured',
  revision: 1,
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
      targetFacets: [
        { code: 'taste', label: '味', sortOrder: 10 },
        { code: 'appearance', label: '見た目', sortOrder: 30 },
      ],
      targets: [
        { id: SASHIMI, label: '刺身盛り合わせ', sortOrder: 0 },
        { id: YAKITORI, label: '焼き鳥5種盛り', sortOrder: 1 },
      ],
    },
    {
      code: 'service_delivery',
      label: '接客・提供',
      sortOrder: 30,
      allowsTargets: false,
      categoryFacets: [{ code: 'serving', label: '料理・ドリンクの提供', sortOrder: 40 }],
      targetFacets: [],
      targets: [],
    },
  ],
};

describe('structured selection', () => {
  it('何も選んでいなければ、どちらの極性もグループを作らない', () => {
    expect(toSelectionGroups(EMPTY_EVIDENCE.positive, DEF)).toEqual([]);
    expect(toSelectionGroups(EMPTY_EVIDENCE.concern, DEF)).toEqual([]);
  });

  it('カテゴリ全体の facet は Target 無しのグループになる（定義の順）', () => {
    let s = toggleCategoryFacet(EMPTY_EVIDENCE, 'positive', 'food', 'volume');
    s = toggleCategoryFacet(s, 'positive', 'food', 'taste');
    expect(toSelectionGroups(s.positive, DEF)).toEqual([{ categoryCode: 'food', facetCodes: ['taste', 'volume'] }]);
  });

  it('Target だけを選んだら facet 0 件のグループ（Target は UUID）', () => {
    const s = toggleTarget(EMPTY_EVIDENCE, 'positive', 'food', SASHIMI);
    expect(toSelectionGroups(s.positive, DEF)).toEqual([{ categoryCode: 'food', targetId: SASHIMI, facetCodes: [] }]);
  });

  it('Target + facet、複数の Target、カテゴリ全体の facet は別のグループとして混ざらない', () => {
    let s = toggleTarget(EMPTY_EVIDENCE, 'positive', 'food', YAKITORI);
    s = toggleTarget(s, 'positive', 'food', SASHIMI);
    s = toggleTargetFacet(s, 'positive', 'food', SASHIMI, 'appearance');
    s = toggleTargetFacet(s, 'positive', 'food', SASHIMI, 'taste');
    s = toggleCategoryFacet(s, 'positive', 'food', 'taste');
    expect(toSelectionGroups(s.positive, DEF)).toEqual([
      { categoryCode: 'food', facetCodes: ['taste'] },
      { categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste', 'appearance'] },
      { categoryCode: 'food', targetId: YAKITORI, facetCodes: [] },
    ]);
  });

  it('Target を外すと、その Target について選んだ facet も外れる。選んでいない Target の facet は選べない', () => {
    let s = toggleTarget(EMPTY_EVIDENCE, 'positive', 'food', SASHIMI);
    s = toggleTargetFacet(s, 'positive', 'food', SASHIMI, 'taste');
    s = toggleTarget(s, 'positive', 'food', SASHIMI);
    expect(toSelectionGroups(s.positive, DEF)).toEqual([]);
    expect(toggleTargetFacet(s, 'positive', 'food', YAKITORI, 'taste')).toBe(s);
    // 外して空になったカテゴリは状態に残さない。
    expect(s.positive.has('food')).toBe(false);
  });

  it('facet を選んで外したら、空のグループは残らない', () => {
    let s = toggleCategoryFacet(EMPTY_EVIDENCE, 'concern', 'service_delivery', 'serving');
    s = toggleCategoryFacet(s, 'concern', 'service_delivery', 'serving');
    expect(toSelectionGroups(s.concern, DEF)).toEqual([]);
  });

  it('良かったところと気になったところは独立し、同じ Target・facet を両方に持てる', () => {
    let s = toggleTarget(EMPTY_EVIDENCE, 'positive', 'food', SASHIMI);
    s = toggleTargetFacet(s, 'positive', 'food', SASHIMI, 'taste');
    s = toggleTarget(s, 'concern', 'food', SASHIMI);
    s = toggleTargetFacet(s, 'concern', 'food', SASHIMI, 'taste');
    const group = [{ categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] }];
    expect(toSelectionGroups(s.positive, DEF)).toEqual(group);
    expect(toSelectionGroups(s.concern, DEF)).toEqual(group);
    // 片方を外しても、もう片方は残る。
    const removed = toggleTarget(s, 'concern', 'food', SASHIMI);
    expect(toSelectionGroups(removed.positive, DEF)).toEqual(group);
    expect(toSelectionGroups(removed.concern, DEF)).toEqual([]);
  });

  it('定義に無い Target（画面を開いた後に非表示にした等）は送らない', () => {
    const s = toggleTarget(EMPTY_EVIDENCE, 'positive', 'food', 'a4380000-0000-4000-8000-0000000000ff');
    expect(toSelectionGroups(s.positive, DEF)).toEqual([]);
  });

  it('要約は定義の順・表示名で、カテゴリ全体と Target を区切って書く', () => {
    let s = toggleCategoryFacet(EMPTY_EVIDENCE, 'positive', 'food', 'taste');
    s = toggleCategoryFacet(s, 'positive', 'food', 'volume');
    s = toggleTarget(s, 'positive', 'food', YAKITORI);
    s = toggleTarget(s, 'positive', 'food', SASHIMI);
    s = toggleTargetFacet(s, 'positive', 'food', SASHIMI, 'appearance');
    s = toggleTargetFacet(s, 'positive', 'food', SASHIMI, 'taste');
    const food = DEF.categories[0]!;
    expect(summaryText(summarizeCategory(categoryEvidence(s, 'positive', 'food'), food), food)).toBe(
      '料理全体：味・量／刺身盛り合わせ：味・見た目／焼き鳥5種盛り',
    );
    const service = DEF.categories[1]!;
    const c = toggleCategoryFacet(EMPTY_EVIDENCE, 'concern', 'service_delivery', 'serving');
    expect(summaryText(summarizeCategory(categoryEvidence(c, 'concern', 'service_delivery'), service), service)).toBe(
      '料理・ドリンクの提供',
    );
  });
});

describe('countMaterials（口コミ文を作るのに要る回答材料の数）', () => {
  it('下限は 2 件', () => {
    expect(MIN_MATERIALS).toBe(2);
  });

  it('何も選んでいなければ 0 件', () => {
    expect(countMaterials(EMPTY_EVIDENCE, DEF)).toBe(0);
  });

  it('カテゴリ全体の facet は 1 つにつき 1 件', () => {
    let s = toggleCategoryFacet(EMPTY_EVIDENCE, 'positive', 'food', 'taste');
    expect(countMaterials(s, DEF)).toBe(1);
    s = toggleCategoryFacet(s, 'positive', 'food', 'volume');
    expect(countMaterials(s, DEF)).toBe(2);
  });

  it('Target だけは 1 件。その Target に facet を足しても Target と facet を二重に数えない', () => {
    let s = toggleTarget(EMPTY_EVIDENCE, 'positive', 'food', SASHIMI);
    expect(countMaterials(s, DEF)).toBe(1);
    s = toggleTargetFacet(s, 'positive', 'food', SASHIMI, 'taste');
    expect(countMaterials(s, DEF)).toBe(1);
    // 同じ Target の別の facet は独立した材料（刺身盛り合わせ：味・見た目 = 2 件）。
    s = toggleTargetFacet(s, 'positive', 'food', SASHIMI, 'appearance');
    expect(countMaterials(s, DEF)).toBe(2);
  });

  it('良かったところと気になったところを合計する（極性ごとの下限は無い）', () => {
    let s = toggleCategoryFacet(EMPTY_EVIDENCE, 'positive', 'food', 'taste');
    s = toggleCategoryFacet(s, 'concern', 'service_delivery', 'serving');
    expect(countMaterials(s, DEF)).toBe(2);

    let c = toggleCategoryFacet(EMPTY_EVIDENCE, 'concern', 'food', 'volume');
    c = toggleCategoryFacet(c, 'concern', 'service_delivery', 'serving');
    expect(countMaterials(c, DEF)).toBe(2);
  });

  it('選択を外すと数も戻る（Target を外すとその facet も数えない）', () => {
    let s = toggleTarget(EMPTY_EVIDENCE, 'positive', 'food', SASHIMI);
    s = toggleTargetFacet(s, 'positive', 'food', SASHIMI, 'taste');
    s = toggleCategoryFacet(s, 'positive', 'food', 'volume');
    expect(countMaterials(s, DEF)).toBe(2);
    s = toggleTarget(s, 'positive', 'food', SASHIMI);
    expect(countMaterials(s, DEF)).toBe(1);
  });

  it('定義に無いカテゴリの選択は送らないので数えない', () => {
    const s = toggleCategoryFacet(EMPTY_EVIDENCE, 'positive', 'hidden', 'x');
    expect(countMaterials(s, DEF)).toBe(0);
  });
});

describe('画面の数え方とサーバーの数え方は同じ（lib/structured-materials.ts）', () => {
  it('画面の状態から数えた件数は、送信する選択（SelectionGroup[]）から数えた件数と一致する', () => {
    const states = [
      EMPTY_EVIDENCE,
      toggleTarget(EMPTY_EVIDENCE, 'positive', 'food', SASHIMI),
      toggleTargetFacet(toggleTarget(EMPTY_EVIDENCE, 'positive', 'food', SASHIMI), 'positive', 'food', SASHIMI, 'taste'),
      toggleTargetFacet(
        toggleTargetFacet(toggleTarget(EMPTY_EVIDENCE, 'concern', 'food', SASHIMI), 'concern', 'food', SASHIMI, 'taste'),
        'concern',
        'food',
        SASHIMI,
        'appearance',
      ),
      toggleCategoryFacet(toggleCategoryFacet(EMPTY_EVIDENCE, 'positive', 'food', 'taste'), 'concern', 'service_delivery', 'serving'),
    ];
    for (const state of states) {
      const answer = {
        positiveSelections: toSelectionGroups(state.positive, DEF),
        concernSelections: toSelectionGroups(state.concern, DEF),
      };
      expect(countMaterials(state, DEF)).toBe(countStructuredAnswerMaterials(answer));
    }
  });

  it('下限は画面とサーバーで同じ定数', () => {
    expect(MIN_MATERIALS).toBe(SHARED_MIN_MATERIALS);
    expect(hasEnoughMaterials(MIN_MATERIALS - 1)).toBe(false);
    expect(hasEnoughMaterials(MIN_MATERIALS)).toBe(true);
  });

  it('SelectionGroup[] からの数え方: Target だけ 1・Target + facet 1 つで 1・2 つで 2・カテゴリ全体の facet は 1 つずつ', () => {
    expect(countSelectionGroupMaterials([{ categoryCode: 'food', targetId: SASHIMI, facetCodes: [] }])).toBe(1);
    expect(countSelectionGroupMaterials([{ categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] }])).toBe(1);
    expect(countSelectionGroupMaterials([{ categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste', 'appearance'] }])).toBe(2);
    expect(countSelectionGroupMaterials([{ categoryCode: 'food', facetCodes: ['taste'] }])).toBe(1);
    expect(countSelectionGroupMaterials([{ categoryCode: 'food', facetCodes: ['taste', 'volume'] }])).toBe(2);
    expect(countSelectionGroupMaterials([])).toBe(0);
  });
});
