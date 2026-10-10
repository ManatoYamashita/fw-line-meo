import { describe, it, expect } from 'vitest';
import type { StructuredSurveyDefinition } from '@fwlm/db';
import {
  validateStructuredAnswer,
  resolveStructuredAnswer,
  structuredMaterialCounts,
  type StructuredSurveyAnswer,
} from '../src/lib/structured-answer';

// structured survey の回答契約（Issue #436）。定義は readStoreSurveyDefinition が返す形の fixture。
// 「他店舗の Target」「非表示の Target」「非表示のカテゴリ」は、定義に現れないことで表す
// （read model がそれらを除くことは @fwlm/db の survey-definition.db.test.ts が検証する）。

const SASHIMI = '11111111-1111-4111-8111-111111111111';
const YAKITORI = '22222222-2222-4222-8222-222222222222';
const LEMON_SOUR = '33333333-3333-4333-8333-333333333333';
const OTHER_STORE_TARGET = '44444444-4444-4444-8444-444444444444';
const HIDDEN_TARGET = '55555555-5555-4555-8555-555555555555';

const facet = (code: string, label: string, sortOrder: number) => ({ code, label, sortOrder });

const DEF: StructuredSurveyDefinition = {
  mode: 'structured',
  revision: 3,
  categories: [
    {
      code: 'food',
      label: '料理',
      sortOrder: 10,
      allowsTargets: true,
      categoryFacets: [
        facet('taste', '味', 10),
        facet('volume', '量', 20),
        facet('variety', '種類', 30),
        facet('appearance', '見た目', 40),
      ],
      targetFacets: [
        facet('taste', '味', 10),
        facet('volume', '量', 20),
        facet('appearance', '見た目', 30),
        facet('temperature_condition', '温度・状態', 40),
      ],
      targets: [
        { id: SASHIMI, label: '刺身盛り合わせ', sortOrder: 0 },
        { id: YAKITORI, label: '焼き鳥5種盛り', sortOrder: 1 },
      ],
    },
    {
      code: 'drink',
      label: 'ドリンク',
      sortOrder: 20,
      allowsTargets: true,
      categoryFacets: [facet('taste', '味', 10), facet('variety', '種類', 20), facet('volume', '量', 30)],
      targetFacets: [
        facet('taste', '味', 10),
        facet('volume', '量', 20),
        facet('temperature_condition', '温度・状態', 30),
      ],
      targets: [{ id: LEMON_SOUR, label: '自家製レモンサワー', sortOrder: 0 }],
    },
    {
      code: 'service_delivery',
      label: '接客・提供',
      sortOrder: 30,
      allowsTargets: false,
      categoryFacets: [facet('service_courtesy', '接客の丁寧さ', 10), facet('serving', '料理・ドリンクの提供', 40)],
      targetFacets: [],
      targets: [],
    },
    {
      code: 'price',
      label: '価格',
      sortOrder: 50,
      allowsTargets: false,
      categoryFacets: [facet('value', 'コスパ', 30)],
      targetFacets: [],
      targets: [],
    },
    // reservation_visit は店舗で非表示にした想定で定義に無い。
  ],
};

function accept(input: unknown): StructuredSurveyAnswer {
  const res = validateStructuredAnswer(input, DEF);
  if (!res.ok) throw new Error(`expected ok, got ${JSON.stringify(res.error)}`);
  return res.value;
}

function reject(input: unknown) {
  const res = validateStructuredAnswer(input, DEF);
  if (res.ok) throw new Error(`expected error, got ${JSON.stringify(res.value)}`);
  return res.error;
}

describe('validateStructuredAnswer', () => {
  describe('受理する回答', () => {
    it('星だけで有効（選択は任意・未指定は空）', () => {
      expect(accept({ star: 5 })).toEqual({ star: 5, positiveSelections: [], concernSelections: [] });
    });

    it('Category 全体の facet（料理全体 → 味）', () => {
      const a = accept({ star: 4, positiveSelections: [{ categoryCode: 'food', facetCodes: ['taste'] }] });
      expect(a.positiveSelections).toEqual([{ categoryCode: 'food', facetCodes: ['taste'] }]);
    });

    it('Target だけ（刺身盛り合わせ自体について）は有効で、facet を推測して足さない', () => {
      const a = accept({
        star: 4,
        positiveSelections: [{ categoryCode: 'food', targetId: SASHIMI, facetCodes: [] }],
      });
      expect(a.positiveSelections).toEqual([{ categoryCode: 'food', targetId: SASHIMI, facetCodes: [] }]);
    });

    it('Target の facet（刺身盛り合わせ → 味・見た目）', () => {
      const a = accept({
        star: 5,
        positiveSelections: [
          { categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste', 'appearance'] },
        ],
      });
      expect(a.positiveSelections[0]?.facetCodes).toEqual(['taste', 'appearance']);
    });

    it('Target を持てないカテゴリの facet（接客・提供 → 料理・ドリンクの提供）', () => {
      const a = accept({
        star: 3,
        concernSelections: [{ categoryCode: 'service_delivery', facetCodes: ['serving'] }],
      });
      expect(a.concernSelections).toEqual([{ categoryCode: 'service_delivery', facetCodes: ['serving'] }]);
    });

    it('複数の Target・Category 全体と Target の併存（同じ facet でも別の evidence）', () => {
      const a = accept({
        star: 4,
        positiveSelections: [
          { categoryCode: 'food', targetId: YAKITORI, facetCodes: ['taste'] },
          { categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] },
          { categoryCode: 'food', facetCodes: ['taste'] },
          { categoryCode: 'drink', targetId: LEMON_SOUR, facetCodes: ['volume'] },
        ],
      });
      // 定義の順（カテゴリ → Category 全体 → Target の順）へ並べる。併合はしない。
      expect(a.positiveSelections).toEqual([
        { categoryCode: 'food', facetCodes: ['taste'] },
        { categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] },
        { categoryCode: 'food', targetId: YAKITORI, facetCodes: ['taste'] },
        { categoryCode: 'drink', targetId: LEMON_SOUR, facetCodes: ['volume'] },
      ]);
    });

    it('良かったところと気になったところに同じ選択があってよい（どちらも消さない）', () => {
      const same = { categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] };
      const a = accept({ star: 3, positiveSelections: [same], concernSelections: [same] });
      expect(a.positiveSelections).toEqual([same]);
      expect(a.concernSelections).toEqual([same]);
    });

    it('片方の極性だけ空でよい', () => {
      const a = accept({
        star: 2,
        positiveSelections: [],
        concernSelections: [{ categoryCode: 'price', facetCodes: ['value'] }],
      });
      expect(a.positiveSelections).toEqual([]);
      expect(a.concernSelections).toHaveLength(1);

      const b = accept({
        star: 5,
        positiveSelections: [{ categoryCode: 'price', facetCodes: ['value'] }],
        concernSelections: [],
      });
      expect(b.positiveSelections).toHaveLength(1);
      expect(b.concernSelections).toEqual([]);
    });

    it('グループ内の facet の重複は除き、定義の順へ並べる', () => {
      const a = accept({
        star: 4,
        positiveSelections: [{ categoryCode: 'food', facetCodes: ['appearance', 'taste', 'appearance'] }],
      });
      expect(a.positiveSelections[0]?.facetCodes).toEqual(['taste', 'appearance']);
    });

    it('targetId: null は Target なしとして扱う', () => {
      const a = accept({
        star: 4,
        positiveSelections: [{ categoryCode: 'food', targetId: null, facetCodes: ['taste'] }],
      });
      expect(a.positiveSelections).toEqual([{ categoryCode: 'food', facetCodes: ['taste'] }]);
    });

    it('一言は legacy と同じ規則（空白だけは未回答・200 文字以内）', () => {
      expect(accept({ star: 5, comment: '   ' }).comment).toBeUndefined();
      expect(accept({ star: 5, comment: '窓側の席が落ち着きました' }).comment).toBe('窓側の席が落ち着きました');
      expect(reject({ star: 5, comment: 'あ'.repeat(201) })).toEqual([{ field: 'comment', code: 'TOO_LONG' }]);
    });
  });

  describe('拒否する回答', () => {
    const one = (group: unknown, field: 'positiveSelections' | 'concernSelections' = 'positiveSelections') =>
      reject({ star: 4, [field]: [group] });

    it('星は必須（legacy と同じ規則）', () => {
      expect(reject({ positiveSelections: [] })).toEqual([{ field: 'star', code: 'REQUIRED' }]);
      expect(reject({ star: 6 })).toEqual([{ field: 'star', code: 'OUT_OF_RANGE' }]);
    });

    it('定義に無いカテゴリ（非表示にしたカテゴリを含む）', () => {
      expect(one({ categoryCode: 'no_such', facetCodes: ['taste'] })).toEqual([
        { field: 'positiveSelections', index: 0, code: 'UNKNOWN_CATEGORY' },
      ]);
      expect(one({ categoryCode: 'reservation_visit', facetCodes: ['findability'] })).toEqual([
        { field: 'positiveSelections', index: 0, code: 'UNKNOWN_CATEGORY' },
      ]);
    });

    it('定義に無い facet', () => {
      expect(one({ categoryCode: 'food', facetCodes: ['no_such'] })).toEqual([
        { field: 'positiveSelections', index: 0, code: 'UNKNOWN_FACET' },
      ]);
      // 他カテゴリの facet も、このカテゴリでは未知。
      expect(one({ categoryCode: 'food', facetCodes: ['serving'] })).toEqual([
        { field: 'positiveSelections', index: 0, code: 'UNKNOWN_FACET' },
      ]);
    });

    it('scope の違う facet（Target 無しに Target 用・Target に Category 全体用）', () => {
      expect(one({ categoryCode: 'food', facetCodes: ['temperature_condition'] })).toEqual([
        { field: 'positiveSelections', index: 0, code: 'FACET_SCOPE_MISMATCH' },
      ]);
      expect(one({ categoryCode: 'food', targetId: SASHIMI, facetCodes: ['variety'] })).toEqual([
        { field: 'positiveSelections', index: 0, code: 'FACET_SCOPE_MISMATCH' },
      ]);
    });

    it('他店舗の Target・非表示の Target・存在しない Target', () => {
      for (const id of [OTHER_STORE_TARGET, HIDDEN_TARGET, 'not-a-uuid', '']) {
        expect(one({ categoryCode: 'food', targetId: id, facetCodes: [] })).toEqual([
          { field: 'positiveSelections', index: 0, code: 'UNKNOWN_TARGET' },
        ]);
      }
    });

    it('別のカテゴリの Target', () => {
      expect(one({ categoryCode: 'food', targetId: LEMON_SOUR, facetCodes: ['taste'] })).toEqual([
        { field: 'positiveSelections', index: 0, code: 'TARGET_CATEGORY_MISMATCH' },
      ]);
    });

    it('Target を持てないカテゴリに targetId', () => {
      expect(one({ categoryCode: 'service_delivery', targetId: SASHIMI, facetCodes: ['serving'] })).toEqual([
        { field: 'positiveSelections', index: 0, code: 'TARGET_NOT_ALLOWED' },
      ]);
    });

    it('カテゴリだけ（Target も facet も無い）はカテゴリを開いただけなので evidence にしない', () => {
      expect(one({ categoryCode: 'food', facetCodes: [] }, 'concernSelections')).toEqual([
        { field: 'concernSelections', index: 0, code: 'EMPTY_GROUP' },
      ]);
    });

    it('同じ極性に同じカテゴリ×Target のグループが 2 つ（意味を推測して併合しない）', () => {
      expect(
        reject({
          star: 4,
          positiveSelections: [
            { categoryCode: 'food', targetId: SASHIMI, facetCodes: [] },
            { categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] },
          ],
        }),
      ).toEqual([{ field: 'positiveSelections', index: 1, code: 'DUPLICATE_GROUP' }]);
      expect(
        reject({
          star: 4,
          concernSelections: [
            { categoryCode: 'food', facetCodes: ['taste'] },
            { categoryCode: 'food', facetCodes: ['volume'] },
          ],
        }),
      ).toEqual([{ field: 'concernSelections', index: 1, code: 'DUPLICATE_GROUP' }]);
    });

    it('形が不正なグループ・配列', () => {
      for (const bad of [
        null,
        'food',
        [],
        { facetCodes: ['taste'] },
        { categoryCode: 'food' },
        { categoryCode: 'food', facetCodes: 'taste' },
        { categoryCode: 'food', facetCodes: [1] },
        { categoryCode: 'food', targetId: 1, facetCodes: [] },
      ]) {
        expect(one(bad)).toEqual([{ field: 'positiveSelections', index: 0, code: 'INVALID' }]);
      }
      expect(reject({ star: 4, positiveSelections: { categoryCode: 'food' } })).toEqual([
        { field: 'positiveSelections', code: 'INVALID' },
      ]);
    });

    it('定義から決まるグループ数の上限を超える配列は中身を見ずに拒否する', () => {
      // 定義の異なるグループは 料理 1+2・ドリンク 1+1・接客 1・価格 1 の 7 つ。
      const groups = Array.from({ length: 8 }, () => ({ categoryCode: 'price', facetCodes: ['value'] }));
      expect(reject({ star: 4, positiveSelections: groups })).toEqual([
        { field: 'positiveSelections', code: 'INVALID' },
      ]);
    });

    it('エラーはフィールド単位で全件集める', () => {
      expect(
        reject({
          star: 0,
          positiveSelections: [{ categoryCode: 'food', facetCodes: [] }],
          concernSelections: [{ categoryCode: 'no_such', facetCodes: ['taste'] }],
        }),
      ).toEqual([
        { field: 'star', code: 'OUT_OF_RANGE' },
        { field: 'positiveSelections', index: 0, code: 'EMPTY_GROUP' },
        { field: 'concernSelections', index: 0, code: 'UNKNOWN_CATEGORY' },
      ]);
    });
  });
});

describe('resolveStructuredAnswer（label snapshot）', () => {
  const answer = accept({
    star: 3,
    positiveSelections: [
      { categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste', 'appearance'] },
      { categoryCode: 'food', targetId: YAKITORI, facetCodes: [] },
    ],
    concernSelections: [
      { categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] },
      { categoryCode: 'service_delivery', facetCodes: ['serving'] },
    ],
    comment: '提供が少し遅かった',
  });

  it('Target の UUID を回答時点の表示名へ解決し、極性と選んだ facet だけを持つ', () => {
    expect(resolveStructuredAnswer(answer, DEF)).toEqual({
      surveyRevision: 3,
      star: 3,
      comment: '提供が少し遅かった',
      selections: [
        {
          polarity: 'positive',
          categoryCode: 'food',
          categoryLabel: '料理',
          targetId: SASHIMI,
          targetLabel: '刺身盛り合わせ',
          facets: [
            { code: 'taste', label: '味' },
            { code: 'appearance', label: '見た目' },
          ],
        },
        {
          polarity: 'positive',
          categoryCode: 'food',
          categoryLabel: '料理',
          targetId: YAKITORI,
          targetLabel: '焼き鳥5種盛り',
          facets: [],
        },
        {
          polarity: 'concern',
          categoryCode: 'food',
          categoryLabel: '料理',
          targetId: SASHIMI,
          targetLabel: '刺身盛り合わせ',
          facets: [{ code: 'taste', label: '味' }],
        },
        {
          polarity: 'concern',
          categoryCode: 'service_delivery',
          categoryLabel: '接客・提供',
          facets: [{ code: 'serving', label: '料理・ドリンクの提供' }],
        },
      ],
    });
  });

  it('解決した後に店舗が名称を変えても、解決済みの snapshot は変わらない', () => {
    const resolved = resolveStructuredAnswer(answer, DEF);
    const renamed: StructuredSurveyDefinition = structuredClone(DEF);
    const target = renamed.categories[0]?.targets[0];
    if (target) target.label = 'お刺身盛り合わせ';
    expect(resolved.selections[0]?.targetLabel).toBe('刺身盛り合わせ');
    // 同じ UUID は新しい定義では新しい名称へ解決される（identity は名前ではなく UUID）。
    expect(resolveStructuredAnswer(answer, renamed).selections[0]).toMatchObject({
      targetId: SASHIMI,
      targetLabel: 'お刺身盛り合わせ',
    });
  });

  it('定義に無い Target を含む回答（検証していない回答）は名前を推測せず例外にする', () => {
    const unvalidated: StructuredSurveyAnswer = {
      star: 4,
      positiveSelections: [{ categoryCode: 'food', targetId: OTHER_STORE_TARGET, facetCodes: [] }],
      concernSelections: [],
    };
    expect(() => resolveStructuredAnswer(unvalidated, DEF)).toThrow(/unresolvable target/);
  });
});

describe('structuredMaterialCounts（匿名集計の個数）', () => {
  it('極性ごとのグループ数・Target を指すグループ数・facet 数と一言の有無だけを返す', () => {
    const counts = structuredMaterialCounts(
      accept({
        star: 3,
        positiveSelections: [
          { categoryCode: 'food', facetCodes: ['taste', 'volume'] },
          { categoryCode: 'food', targetId: SASHIMI, facetCodes: [] },
          { categoryCode: 'drink', targetId: LEMON_SOUR, facetCodes: ['taste'] },
        ],
        concernSelections: [{ categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] }],
        comment: '一言',
      }),
    );
    expect(counts).toEqual({
      positiveGroupCount: 3,
      concernGroupCount: 1,
      positiveTargetCount: 2,
      concernTargetCount: 1,
      positiveFacetCount: 3,
      concernFacetCount: 1,
      hasComment: true,
    });
    // 選択の中身・Target 名・一言の本文を持たない（DB へ渡る値は個数と有無だけ）。
    const values = Object.values(counts);
    expect(values.every((v) => typeof v === 'number' || typeof v === 'boolean')).toBe(true);
  });

  it('選択なし・一言なし', () => {
    expect(structuredMaterialCounts(accept({ star: 5 }))).toEqual({
      positiveGroupCount: 0,
      concernGroupCount: 0,
      positiveTargetCount: 0,
      concernTargetCount: 0,
      positiveFacetCount: 0,
      concernFacetCount: 0,
      hasComment: false,
    });
  });
});
