import { describe, it, expect } from 'vitest';
import type { StructuredSurveyDefinition } from '@fwlm/db';
import {
  EMPTY_EVIDENCE,
  categoryEvidence,
  summarizeCategory,
  summaryText,
  toSelectionGroups,
  toggleCategoryFacet,
  toggleTarget,
  toggleTargetFacet,
} from '../src/lib/structured-selection';

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
