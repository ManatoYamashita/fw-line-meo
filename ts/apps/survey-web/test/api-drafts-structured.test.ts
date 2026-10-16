import { describe, it, expect, vi } from 'vitest';
import { surveyDefinitionFingerprint, type StructuredSurveyDefinition } from '@fwlm/db';
import { handleDrafts, type DraftsDeps } from '../src/app/api/drafts/handler';
import { handleResponses, type ResponsesDeps } from '../src/app/api/responses/handler';
import { createSessionTokenService } from '../src/lib/session-token';
import { ok } from '../src/lib/result';
import { REGEN_MAX } from '../src/lib/limits';
import type { StructuredDraftMaterial, StructuredDraftPort } from '../src/lib/draft/structured-draft';
import type { GenAiClient } from '../src/lib/draft/generator';
import { createNaturalRealizer } from '../src/lib/draft/structured/realizer';

// safe fallback は本番の応答で呼ばない（内部用）。呼ばれたら分かるように差し替える。
const fallbackSpy = vi.hoisted(() => vi.fn(() => 'SAFE FALLBACK'));
vi.mock('../src/lib/draft/structured/fallback', () => ({ structuredFallbackDraft: fallbackSpy }));

// structured の下書き（Issue #439）の受付と再生成。回答受付は下書きと structured の sessionToken を返し、再生成は
// sessionToken に封入した同じ素材（Target の名前の snapshot）から作り直す。legacy の token とは互いに通さない。

const KEY = 'test-signing-key';
const STORE = '44444444-4444-4444-4444-444444444444';
const SASHIMI = 'a4390000-0000-4000-8000-0000000000a1';
const YAKITORI = 'a4390000-0000-4000-8000-0000000000a2';
const tokens = createSessionTokenService(KEY);

const DEFINITION: StructuredSurveyDefinition = {
  mode: 'structured',
  revision: 2,
  categories: [
    {
      code: 'food',
      label: '料理',
      sortOrder: 10,
      allowsTargets: true,
      categoryFacets: [{ code: 'taste', label: '味', sortOrder: 10 }],
      targetFacets: [{ code: 'taste', label: '味', sortOrder: 10 }],
      targets: [
        { id: SASHIMI, label: '刺身盛り合わせ', sortOrder: 0 },
        { id: YAKITORI, label: '焼き鳥5種盛り', sortOrder: 1 },
      ],
    },
  ],
};

const STORE_VIEW = { id: STORE, name: 'テスト店', placeId: 'ChIJ', placeStatus: 'confirmed' as const, suspendedAt: null };

function port(draft = '刺身盛り合わせがおいしかったです。'): StructuredDraftPort & { prepare: ReturnType<typeof vi.fn> } {
  return { prepare: vi.fn(async () => ({ kind: 'draft' as const, draft, source: 'llm' as const, attempts: 1 })) };
}

function responsesDeps(structuredDrafts: StructuredDraftPort): ResponsesDeps {
  return {
    tokens,
    generator: { generate: vi.fn(() => Promise.resolve(ok('legacy'))) },
    rateLimiter: { check: () => true },
    findStore: () => Promise.resolve(STORE_VIEW),
    listAspects: vi.fn(() => Promise.resolve([])),
    incrementTallies: vi.fn(() => Promise.resolve()),
    readDefinition: () => Promise.resolve(DEFINITION),
    incrementStructuredTallies: vi.fn(() => Promise.resolve()),
    structuredDrafts,
    clientKey: () => 'ip1',
    log: () => {},
  };
}

function draftsDeps(structuredDrafts: StructuredDraftPort): DraftsDeps & { generator: { generate: ReturnType<typeof vi.fn> } } {
  return {
    tokens,
    generator: { generate: vi.fn(() => Promise.resolve(ok('legacy の再生成'))) },
    rateLimiter: { check: () => true },
    findStore: () => Promise.resolve(STORE_VIEW),
    structuredDrafts,
    clientKey: () => 'ip1',
    log: () => {},
  };
}

const post = (url: string, body: unknown) => new Request(url, { method: 'POST', body: JSON.stringify(body) });

const SNAPSHOT: StructuredDraftMaterial = {
  storeName: 'テスト店',
  surveyRevision: 2,
  star: 4,
  selections: [
    { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', targetId: SASHIMI, targetLabel: '刺身盛り合わせ', facets: [{ code: 'taste', label: '味' }] },
  ],
};

describe('structured の下書き（Issue #439）', () => {
  it('回答受付は下書きと、回答時点の素材を封入した structured の sessionToken を返す', async () => {
    const realizer = port();
    const res = await handleResponses(
      post('http://x/api/responses', {
        storeId: STORE,
        pageToken: tokens.signStructuredPage(STORE, 2, surveyDefinitionFingerprint(DEFINITION)),
        star: 4,
        // 口コミ文を作るのに要る材料は 2 件（画面とサーバーで同じ下限・lib/structured-materials.ts）。
        positiveSelections: [
          { categoryCode: 'food', facetCodes: ['taste'] },
          { categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] },
        ],
        concernSelections: [],
      }),
      responsesDeps(realizer),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ mode: 'structured', generation: 'ok', draft: '刺身盛り合わせがおいしかったです。', regenerationsLeft: REGEN_MAX });
    const verified = tokens.verifyStructured(body.sessionToken as string);
    // 未回答の Target は、検証に使った同じ定義から作って素材へ封入する（事後検証だけが使い、LLM へは渡さない）。
    const sealed = {
      ...SNAPSHOT,
      selections: [
        { polarity: 'positive', categoryCode: 'food', categoryLabel: '料理', facets: [{ code: 'taste', label: '味' }] },
        ...SNAPSHOT.selections,
      ],
      unselectedTargets: [{ id: YAKITORI, label: '焼き鳥5種盛り', categoryCode: 'food' }],
    };
    expect(verified.ok && verified.value.structured).toEqual(sealed);
    expect(realizer.prepare).toHaveBeenCalledWith(sealed);
    expect(verified.ok && verified.value.attempt).toBe(0);
    // legacy の再生成の token としては通らない。
    expect(tokens.verify(body.sessionToken as string).ok).toBe(false);
  });

  it('再生成は封入した素材（名前の snapshot）から作り直し、試行を 1 つ進める。legacy の生成器は呼ばない', async () => {
    const realizer = port('刺身盛り合わせ、おいしかったです。');
    const deps = draftsDeps(realizer);
    const token = tokens.signStructured({ storeId: STORE, structured: SNAPSHOT, attempt: 0 });
    const res = await handleDrafts(post('http://x/api/drafts', { sessionToken: token }), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ generation: 'ok', draft: '刺身盛り合わせ、おいしかったです。', regenerationsLeft: REGEN_MAX - 1 });
    // 初回と同じ生成をもう一度行う（構成を変える指示は足さない）。素材は封入したものだけ。
    expect(realizer.prepare).toHaveBeenCalledWith(SNAPSHOT);
    expect(deps.generator.generate).not.toHaveBeenCalled();
    const next = tokens.verifyStructured(body.sessionToken as string);
    expect(next.ok && next.value.attempt).toBe(1);
  });

  it('再生成の要求に前回の下書きを載せても、生成器へは渡らない（事実の源は封入した素材だけ）', async () => {
    const realizer = port();
    const token = tokens.signStructured({ storeId: STORE, structured: SNAPSHOT, attempt: 0 });
    const body = { sessionToken: token, draft: '友人と行きました。刺身盛り合わせが20分で出てきました。', previousDraft: '友人と行きました。' };
    const res = await handleDrafts(post('http://x/api/drafts', body), draftsDeps(realizer));
    expect(res.status).toBe(200);
    expect(realizer.prepare).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(realizer.prepare.mock.calls[0])).not.toMatch(/友人|20分/);
  });

  it('再生成の上限に達したら 409 で、生成器を呼ばない', async () => {
    const realizer = port();
    const token = tokens.signStructured({ storeId: STORE, structured: SNAPSHOT, attempt: REGEN_MAX });
    const res = await handleDrafts(post('http://x/api/drafts', { sessionToken: token }), draftsDeps(realizer));
    expect(res.status).toBe(409);
    expect(realizer.prepare).not.toHaveBeenCalled();
  });

  it('legacy の sessionToken は従来どおり legacy の生成器で作り直し、structured の生成器を呼ばない', async () => {
    const realizer = port();
    const deps = draftsDeps(realizer);
    const legacy = tokens.sign({ storeId: STORE, material: { storeName: 'テスト店', star: 5, aspectLabels: ['味'] }, attempt: 0 });
    const res = await handleDrafts(post('http://x/api/drafts', { sessionToken: legacy }), deps);
    expect(res.status).toBe(200);
    expect(deps.generator.generate).toHaveBeenCalledTimes(1);
    expect(realizer.prepare).not.toHaveBeenCalled();
  });
});

// sessionToken の検証結果の分類。structured（v: 2）の期限切れは legacy の検証へ流さず TOKEN_EXPIRED で返す
// （legacy の検証は v: 2 を INVALID と読むので、流すと期限切れが TOKEN_INVALID に化ける）。
describe('再生成の sessionToken の分類（v: 1 / v: 2）', () => {
  const SESSION_TTL_PAST = 365 * 24 * 60 * 60 * 1000;
  const later = createSessionTokenService(KEY, () => Date.now() + SESSION_TTL_PAST);
  const LEGACY_MATERIAL = { storeName: 'テスト店', star: 5 as const, aspectLabels: ['味'] };
  const run = async (sessionToken: string, at: 'now' | 'later' = 'now') => {
    const deps = { ...draftsDeps(port()), tokens: at === 'now' ? tokens : later };
    const res = await handleDrafts(post('http://x/api/drafts', { sessionToken }), deps);
    return { status: res.status, body: (await res.json()) as { generation?: string; error?: { code?: string } } };
  };
  const v2 = () => tokens.signStructured({ storeId: STORE, structured: SNAPSHOT, attempt: 0 });
  const v1 = () => tokens.sign({ storeId: STORE, material: LEGACY_MATERIAL, attempt: 0 });

  it('v2 有効 → 200', async () => {
    const { status, body } = await run(v2());
    expect(status).toBe(200);
    expect(body.generation).toBe('ok');
  });

  it('v2 期限切れ → 400 TOKEN_EXPIRED', async () => {
    const { status, body } = await run(v2(), 'later');
    expect(status).toBe(400);
    expect(body.error?.code).toBe('TOKEN_EXPIRED');
  });

  it('v2 改ざん → 400 TOKEN_INVALID', async () => {
    const [payload, mac] = v2().split('.');
    const tampered = `${payload}.${mac!.slice(0, -2)}${mac!.endsWith('AA') ? 'BB' : 'AA'}`;
    const { status, body } = await run(tampered);
    expect(status).toBe(400);
    expect(body.error?.code).toBe('TOKEN_INVALID');
  });

  it('v1 期限切れ → 400 TOKEN_EXPIRED', async () => {
    const { status, body } = await run(v1(), 'later');
    expect(status).toBe(400);
    expect(body.error?.code).toBe('TOKEN_EXPIRED');
  });

  it('v1 有効 → 200', async () => {
    const { status, body } = await run(v1());
    expect(status).toBe(200);
    expect(body.generation).toBe('ok');
  });
});

// 本番の Realizer（偽の Gemini）を通した受付・再生成。ユーザーに返す下書きは必ず LLM の文で、safe fallback は呼ばない。
// 内部の作り直し（最大 3 回）は再生成の残り回数を 1 回しか消費せず、generation error では消費しない。
describe('ユーザーに表示する下書きは通常生成だけ（safe fallback を返さない）', () => {
  const OK_DRAFT = '刺身盛り合わせがおいしかったです。';
  const BAD = '新鮮な刺身盛り合わせがおいしかったです。';
  function realizer(...replies: (string | Error)[]) {
    const client: GenAiClient = {
      models: {
        generateContent: async () => {
          const reply = replies.shift();
          if (reply instanceof Error) throw reply;
          return { text: JSON.stringify({ draft: reply ?? '' }) };
        },
      },
    };
    return createNaturalRealizer(client, {});
  }
  const submit = (port: StructuredDraftPort) =>
    handleResponses(
      post('http://x/api/responses', {
        storeId: STORE,
        pageToken: tokens.signStructuredPage(STORE, 2, surveyDefinitionFingerprint(DEFINITION)),
        star: 4,
        // 口コミ文を作るのに要る材料は 2 件（画面とサーバーで同じ下限・lib/structured-materials.ts）。
        positiveSelections: [
          { categoryCode: 'food', facetCodes: ['taste'] },
          { categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] },
        ],
        concernSelections: [],
      }),
      responsesDeps(port),
    );
  const regenerate = (port: StructuredDraftPort, attempt = 0) =>
    handleDrafts(post('http://x/api/drafts', { sessionToken: tokens.signStructured({ storeId: STORE, structured: SNAPSHOT, attempt }) }), draftsDeps(port));

  it('受付: 内部で作り直して通った LLM の文を返し、safe fallback は呼ばない', async () => {
    fallbackSpy.mockClear();
    const body = (await (await submit(realizer(BAD, BAD, OK_DRAFT))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ mode: 'structured', generation: 'ok', draft: OK_DRAFT, regenerationsLeft: REGEN_MAX });
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('受付: 3 回とも作れなければ generation error（下書きなし）で、safe fallback の文を返さない', async () => {
    fallbackSpy.mockClear();
    const res = await submit(realizer(BAD, new Error('503'), BAD));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ mode: 'structured', generation: 'failed', draft: null, regenerationsLeft: REGEN_MAX });
    // 再試行（/api/drafts）できる token を返す（試行は消費していない）。
    const verified = tokens.verifyStructured(body.sessionToken as string);
    expect(verified.ok && verified.value.attempt).toBe(0);
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('再生成: 内部の作り直し（3 回）は残り回数を 1 回だけ消費し、LLM の文を返す。safe fallback は呼ばない', async () => {
    fallbackSpy.mockClear();
    const body = (await (await regenerate(realizer(BAD, BAD, OK_DRAFT))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ generation: 'ok', draft: OK_DRAFT, regenerationsLeft: REGEN_MAX - 1 });
    const verified = tokens.verifyStructured(body.sessionToken as string);
    expect(verified.ok && verified.value.attempt).toBe(1);
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('再生成: generation error なら残り回数を消費せず、下書きなしで返す（safe fallback は呼ばない）', async () => {
    fallbackSpy.mockClear();
    const body = (await (await regenerate(realizer(BAD, BAD, BAD), 1)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ generation: 'failed', draft: null, regenerationsLeft: REGEN_MAX - 1 });
    const verified = tokens.verifyStructured(body.sessionToken as string);
    expect(verified.ok && verified.value.attempt).toBe(1);
    expect(fallbackSpy).not.toHaveBeenCalled();
  });
});

// structured の Gemini の全面障害（残高切れ・API 障害）を、legacy と同じ generation_failed で記録し、既存の監視
// （infra/modules/guardrails の generation_failures）へ乗せる。factuality の失格は API の障害として数えない。
describe('structured の生成失敗の監視（generation_failed / generation_safety_blocked）', () => {
  const OK_DRAFT = '刺身盛り合わせがおいしかったです。';
  const BAD = '新鮮な刺身盛り合わせがおいしかったです。';
  const statusError = (status: number) => Object.assign(new Error('secret-api-key-in-message'), { status });
  function realizer(...replies: (string | Error | object)[]) {
    const client: GenAiClient = {
      models: {
        generateContent: async () => {
          const reply = replies.shift();
          if (reply instanceof Error) throw reply;
          if (typeof reply === 'object') return reply as never;
          return { text: JSON.stringify({ draft: reply ?? '' }) };
        },
      },
    };
    return createNaturalRealizer(client, {});
  }
  const ANSWER = {
    storeId: STORE,
    star: 4,
    positiveSelections: [
      { categoryCode: 'food', facetCodes: ['taste'] },
      { categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] },
    ],
    concernSelections: [],
    comment: '店員さんが丁寧でした',
  };
  async function submit(p: StructuredDraftPort) {
    const log = vi.fn();
    const res = await handleResponses(
      post('http://x/api/responses', { ...ANSWER, pageToken: tokens.signStructuredPage(STORE, 2, surveyDefinitionFingerprint(DEFINITION)) }),
      { ...responsesDeps(p), log },
    );
    return { body: (await res.json()) as Record<string, unknown>, log };
  }
  async function regenerate(p: StructuredDraftPort) {
    const log = vi.fn();
    const res = await handleDrafts(
      post('http://x/api/drafts', { sessionToken: tokens.signStructured({ storeId: STORE, structured: SNAPSHOT, attempt: 0 }) }),
      { ...draftsDeps(p), log },
    );
    return { body: (await res.json()) as Record<string, unknown>, log };
  }
  const events = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map((c) => c[1] as string);

  for (const [name, run] of [
    ['受付', submit],
    ['再生成', regenerate],
  ] as const) {
    it(`${name}: 全試行で API の例外（402）→ generation_failed（errorKind と status だけ）`, async () => {
      const { body, log } = await run(realizer(statusError(402), statusError(402), statusError(402)));
      expect(body).toMatchObject({ generation: 'failed', draft: null });
      expect(log).toHaveBeenCalledWith('error', 'generation_failed', { errorKind: 'API_ERROR', status: 402 });
      // 下書き・一言・料理名・例外の本文は記録しない。
      const logged = JSON.stringify(log.mock.calls);
      for (const secret of ['店員さんが丁寧でした', '刺身盛り合わせ', 'secret-api-key-in-message']) expect(logged).not.toContain(secret);
    });

    it(`${name}: 全試行で安全性による遮断 → generation_safety_blocked（generation_failed は出さない）`, async () => {
      const blocked = { promptFeedback: { blockReason: 'SAFETY' } };
      const { log } = await run(realizer(blocked, blocked, blocked));
      expect(log).toHaveBeenCalledWith('info', 'generation_safety_blocked', { errorKind: 'SAFETY_BLOCKED' });
      expect(events(log)).not.toContain('generation_failed');
    });

    it(`${name}: factuality の hard gate で 3 回失格 → API の障害ではないので generation_failed を出さない`, async () => {
      const { body, log } = await run(realizer(BAD, BAD, BAD));
      expect(body).toMatchObject({ generation: 'failed', draft: null });
      expect(events(log)).not.toContain('generation_failed');
      expect(events(log)).not.toContain('generation_safety_blocked');
    });

    it(`${name}: 作り直して作れたなら、途中の API の失敗は generation_failed にしない`, async () => {
      const { body, log } = await run(realizer(statusError(503), OK_DRAFT));
      expect(body).toMatchObject({ generation: 'ok', draft: OK_DRAFT });
      expect(events(log)).not.toContain('generation_failed');
    });

    // 全試行の生成の失敗は順番に依らずまとめ、記録は 1 件だけ（PR #443 の追加レビュー）。
    const API = statusError(402);
    const SAFETY = { promptFeedback: { blockReason: 'SAFETY' } };
    const INVALID = { text: 'not json' };
    for (const [seq, replies, expected] of [
      ['API, API, SAFETY', [API, API, SAFETY], ['error', 'generation_failed', { errorKind: 'API_ERROR', status: 402 }]],
      ['SAFETY, API, SAFETY', [SAFETY, API, SAFETY], ['error', 'generation_failed', { errorKind: 'API_ERROR', status: 402 }]],
      ['SAFETY, SAFETY, API', [SAFETY, SAFETY, API], ['error', 'generation_failed', { errorKind: 'API_ERROR', status: 402 }]],
      ['INVALID, SAFETY, SAFETY', [INVALID, SAFETY, SAFETY], ['error', 'generation_failed', { errorKind: 'INVALID_OUTPUT' }]],
      ['SAFETY, INVALID, SAFETY', [SAFETY, INVALID, SAFETY], ['error', 'generation_failed', { errorKind: 'INVALID_OUTPUT' }]],
      ['SAFETY, SAFETY, INVALID', [SAFETY, SAFETY, INVALID], ['error', 'generation_failed', { errorKind: 'INVALID_OUTPUT' }]],
      ['SAFETY × 3', [SAFETY, SAFETY, SAFETY], ['info', 'generation_safety_blocked', { errorKind: 'SAFETY_BLOCKED' }]],
      ['API × 3', [API, API, API], ['error', 'generation_failed', { errorKind: 'API_ERROR', status: 402 }]],
    ] as const) {
      it(`${name}: ${seq} → ${expected[1]} を 1 件だけ`, async () => {
        const { log } = await run(realizer(...(replies as readonly (Error | object)[])));
        const monitored = log.mock.calls.filter((c) => c[1] === 'generation_failed' || c[1] === 'generation_safety_blocked');
        expect(monitored).toEqual([expected]);
      });
    }

    it(`${name}: 生成の失敗と hard gate の失格が混ざった場合は gate のまま（generation_failed を出さない）`, async () => {
      const { body, log } = await run(realizer(API, BAD, SAFETY));
      expect(body).toMatchObject({ generation: 'failed', draft: null });
      expect(events(log)).not.toContain('generation_failed');
      expect(events(log)).not.toContain('generation_safety_blocked');
    });
  }
});
