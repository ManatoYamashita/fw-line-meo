import { describe, it, expect, vi } from 'vitest';
import { surveyDefinitionFingerprint, type StructuredSurveyDefinition } from '@fwlm/db';
import { handleDrafts, type DraftsDeps } from '../src/app/api/drafts/handler';
import { handleResponses, type ResponsesDeps } from '../src/app/api/responses/handler';
import { createSessionTokenService } from '../src/lib/session-token';
import { ok } from '../src/lib/result';
import { REGEN_MAX } from '../src/lib/limits';
import type { StructuredDraftMaterial, StructuredDraftPort } from '../src/lib/draft/structured-draft';

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
        positiveSelections: [{ categoryCode: 'food', targetId: SASHIMI, facetCodes: ['taste'] }],
        concernSelections: [],
      }),
      responsesDeps(realizer),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ mode: 'structured', generation: 'ok', draft: '刺身盛り合わせがおいしかったです。', regenerationsLeft: REGEN_MAX });
    const verified = tokens.verifyStructured(body.sessionToken as string);
    // 未回答の Target は、検証に使った同じ定義から作って素材へ封入する（事後検証だけが使い、LLM へは渡さない）。
    const sealed = { ...SNAPSHOT, unselectedTargets: [{ id: YAKITORI, label: '焼き鳥5種盛り', categoryCode: 'food' }] };
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
    // 再生成であることだけを伝える（前とは違う組み立てにする決まった指示）。素材は封入したものだけ。
    expect(realizer.prepare).toHaveBeenCalledWith(SNAPSHOT, { regeneration: true });
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
