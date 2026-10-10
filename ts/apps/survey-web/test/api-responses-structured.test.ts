import { describe, it, expect, vi } from 'vitest';
import { surveyDefinitionFingerprint, type StructuredSurveyDefinition, type StoreSurveyDefinition } from '@fwlm/db';
import { handleResponses, STALE_SURVEY_MESSAGE, type ResponsesDeps } from '../src/app/api/responses/handler';
import { createSessionTokenService } from '../src/lib/session-token';
import { ok } from '../src/lib/result';

// /api/responses の種類の分岐（Issue #438）。実際に signPage / signStructuredPage で作った token を通し、
//   - 現在の定義を 1 回だけ読み、種類・版・指紋を照合してから分岐すること
//   - legacy の token を structured として、structured の token を legacy として扱わないこと
//   - structured の回答は incrementStructuredTallies だけを呼び、legacy の集計・観点・生成器へ進まないこと
//     （星を二重に数えない）
// を依存の spy で制御フローとして固定する。

const KEY = 'test-signing-key';
const STORE = '44444444-4444-4444-4444-444444444444';
const SASHIMI = 'a4380000-0000-4000-8000-0000000000a1';
const tokens = createSessionTokenService(KEY);

function definition(revision = 3): StructuredSurveyDefinition {
  return {
    mode: 'structured',
    revision,
    categories: [
      {
        code: 'food',
        label: '料理',
        sortOrder: 10,
        allowsTargets: true,
        categoryFacets: [{ code: 'taste', label: '味', sortOrder: 10 }],
        targetFacets: [
          { code: 'taste', label: '味', sortOrder: 10 },
          { code: 'temperature_condition', label: '温度・状態', sortOrder: 40 },
        ],
        targets: [{ id: SASHIMI, label: '刺身盛り合わせ', sortOrder: 0 }],
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
}

function structuredToken(def: StructuredSurveyDefinition = definition()): string {
  return tokens.signStructuredPage(STORE, def.revision, surveyDefinitionFingerprint(def));
}

function spiedDeps(current: StoreSurveyDefinition) {
  return {
    tokens,
    generator: { generate: vi.fn(() => Promise.resolve(ok('legacy の下書き'))) },
    rateLimiter: { check: vi.fn(() => true) },
    findStore: vi.fn(() =>
      Promise.resolve({ id: STORE, name: 'テスト店', placeId: 'ChIJ', placeStatus: 'confirmed' as const, suspendedAt: null }),
    ),
    listAspects: vi.fn(() => Promise.resolve([{ code: 'taste', label: '味' }])),
    incrementTallies: vi.fn(() => Promise.resolve()),
    readDefinition: vi.fn(() => Promise.resolve(current)),
    incrementStructuredTallies: vi.fn(() => Promise.resolve()),
    structuredDrafts: { prepare: vi.fn(() => Promise.resolve({ kind: 'unavailable' as const })) },
    clientKey: () => 'ip1',
    log: vi.fn(),
  } satisfies ResponsesDeps;
}

function req(body: Record<string, unknown>): Request {
  return new Request('http://x/api/responses', { method: 'POST', body: JSON.stringify({ storeId: STORE, ...body }) });
}

const STRUCTURED_ANSWER = {
  star: 4,
  positiveSelections: [
    { categoryCode: 'food', targetId: SASHIMI, facetCodes: [] },
    { categoryCode: 'food', facetCodes: ['taste'] },
  ],
  concernSelections: [{ categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] }],
  comment: '少しぬるかった',
};

function expectNoLegacyWork(deps: ReturnType<typeof spiedDeps>): void {
  expect(deps.listAspects).not.toHaveBeenCalled();
  expect(deps.incrementTallies).not.toHaveBeenCalled();
  expect(deps.generator.generate).not.toHaveBeenCalled();
}

function expectNoStructuredWork(deps: ReturnType<typeof spiedDeps>): void {
  expect(deps.incrementStructuredTallies).not.toHaveBeenCalled();
  expect(deps.structuredDrafts.prepare).not.toHaveBeenCalled();
}

describe('handleResponses × structured survey（Issue #438）', () => {
  it('structured の店舗 × 一致する v2 token → 検証・解決して structured の集計だけを 1 回呼ぶ（星を二重に数えない）', async () => {
    const deps = spiedDeps(definition());
    const res = await handleResponses(req({ pageToken: structuredToken(), ...STRUCTURED_ANSWER }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: 'structured', generation: 'unavailable', draft: null });

    expect(deps.readDefinition).toHaveBeenCalledTimes(1);
    expect(deps.incrementStructuredTallies).toHaveBeenCalledTimes(1);
    expect(deps.incrementStructuredTallies).toHaveBeenCalledWith({
      storeId: STORE,
      star: 4,
      positiveGroupCount: 2,
      concernGroupCount: 1,
      positiveTargetCount: 1,
      concernTargetCount: 1,
      positiveFacetCount: 1,
      concernFacetCount: 1,
      hasComment: true,
    });
    expectNoLegacyWork(deps);
  });

  it('structured の下書きの口へ、回答時点の表示名へ解決した素材を渡す（Target は UUID と名前の snapshot）', async () => {
    const deps = spiedDeps(definition());
    await handleResponses(req({ pageToken: structuredToken(), ...STRUCTURED_ANSWER }), deps);
    expect(deps.structuredDrafts.prepare).toHaveBeenCalledTimes(1);
    expect(deps.structuredDrafts.prepare).toHaveBeenCalledWith({
      storeName: 'テスト店',
      surveyRevision: 3,
      star: 4,
      comment: '少しぬるかった',
      selections: [
        { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', facets: [{ code: 'taste', label: '味' }] },
        {
          polarity: 'positive',
          categoryCode: 'food',
          categoryLabel: '料理',
          targetId: SASHIMI,
          targetLabel: '刺身盛り合わせ',
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
      ],
      // 店舗の Target はすべて選ばれたので、事後検証用の未回答の Target は空（Issue #439）。
      unselectedTargets: [],
    });
  });

  it('legacy の店舗 × legacy の token → 従来どおり legacy の集計と生成だけを呼ぶ', async () => {
    const deps = spiedDeps({ mode: 'legacy' });
    const res = await handleResponses(req({ pageToken: tokens.signPage(STORE), star: 5, aspectCodes: ['taste'] }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).generation).toBe('ok');
    expect(deps.readDefinition).toHaveBeenCalledTimes(1);
    expect(deps.incrementTallies).toHaveBeenCalledTimes(1);
    expect(deps.generator.generate).toHaveBeenCalledTimes(1);
    expectNoStructuredWork(deps);
  });

  describe('古い画面（STALE_SURVEY・409）はどちらの検証・集計・生成へも進めない', () => {
    const cases: [string, StoreSurveyDefinition, () => string][] = [
      ['版が進んだ（店舗が設定を変えた）', definition(4), () => structuredToken(definition(3))],
      [
        '版は同じだが定義の指紋が違う（全店舗共通の taxonomy が変わった）',
        (() => {
          const d = definition(3);
          d.categories[0]!.categoryFacets[0]!.label = '味わい';
          return d;
        })(),
        () => structuredToken(definition(3)),
      ],
      ['legacy の店舗 × v2 token（structured を無効にした）', { mode: 'legacy' }, () => structuredToken()],
      ['structured の店舗 × legacy token（structured を有効にした）', definition(), () => tokens.signPage(STORE)],
    ];
    for (const [name, current, token] of cases) {
      it(name, async () => {
        const deps = spiedDeps(current);
        const res = await handleResponses(
          req({ pageToken: token(), ...STRUCTURED_ANSWER, aspectCodes: ['taste'] }),
          deps,
        );
        expect(res.status).toBe(409);
        expect((await res.json()).error).toEqual({ code: 'STALE_SURVEY', message: STALE_SURVEY_MESSAGE });
        expect(deps.readDefinition).toHaveBeenCalledTimes(1);
        expectNoLegacyWork(deps);
        expectNoStructuredWork(deps);
      });
    }
  });

  describe('定義に照らして不正な structured の回答は 400 で、集計しない', () => {
    const cases: [string, unknown][] = [
      ['他店の Target（定義に無い UUID）', [{ categoryCode: 'food', targetId: 'a4380000-0000-4000-8000-0000000000ff', facetCodes: [] }]],
      ['Target を持てないカテゴリに targetId', [{ categoryCode: 'service_delivery', targetId: SASHIMI, facetCodes: [] }]],
      ['scope の違う facet（料理全体に温度・状態）', [{ categoryCode: 'food', facetCodes: ['temperature_condition'] }]],
      ['開いただけの空のグループ', [{ categoryCode: 'service_delivery', facetCodes: [] }]],
      ['表示していないカテゴリ', [{ categoryCode: 'price', facetCodes: ['value_for_money'] }]],
    ];
    for (const [name, positiveSelections] of cases) {
      it(name, async () => {
        const deps = spiedDeps(definition());
        const res = await handleResponses(
          req({ pageToken: structuredToken(), star: 3, positiveSelections, concernSelections: [] }),
          deps,
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe('VALIDATION');
        expectNoStructuredWork(deps);
        expectNoLegacyWork(deps);
      });
    }
  });

  it('星だけの structured の回答（選択なし）も受け付ける', async () => {
    const deps = spiedDeps(definition());
    const res = await handleResponses(
      req({ pageToken: structuredToken(), star: 2, positiveSelections: [], concernSelections: [] }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(deps.incrementStructuredTallies).toHaveBeenCalledWith(
      expect.objectContaining({ star: 2, positiveGroupCount: 0, concernGroupCount: 0, hasComment: false }),
    );
  });

  it('structured の集計が失敗しても回答は受け付け、warn を残す（legacy と同じく非致命）', async () => {
    const deps = spiedDeps(definition());
    deps.incrementStructuredTallies.mockImplementation(() => Promise.reject(new Error('db down')));
    const res = await handleResponses(req({ pageToken: structuredToken(), ...STRUCTURED_ANSWER }), deps);
    expect(res.status).toBe(200);
    expect(deps.log).toHaveBeenCalledWith('warn', 'tally_failed');
  });
});
