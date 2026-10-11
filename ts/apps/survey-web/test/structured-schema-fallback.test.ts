import { describe, it, expect, vi } from 'vitest';
import type { Queryable } from '@fwlm/db';
import { loadSurveyPageData, type SurveyPageDeps } from '../src/app/s/[storeId]/page-data';
import { handleResponses, type ResponsesDeps } from '../src/app/api/responses/handler';
import { createSessionTokenService } from '../src/lib/session-token';
import { createSurveyDefinitionReader } from '../src/lib/survey-definition-reader';
import { ok } from '../src/lib/result';

// migration 0015 / 0016・grants.sql の適用前にコードがデプロイされたときの互換（PR #443 のレビュー対応）。
// 表示（loadSurveyPageData）と回答受付（handleResponses）は同じ読み方（createSurveyDefinitionReader）を通るので、
// 表・権限が無いときは **どちらも** legacy として動き、表示で発行した legacy の pageToken で送信まで通る。
// それ以外の DB の失敗は、どちらも legacy に化けさせずに失敗させる。DB へは接続しない。

const KEY = 'test-signing-key';
const STORE = '44444444-4444-4444-4444-444444444444';
const tokens = createSessionTokenService(KEY);
const STORE_ROW = { id: STORE, name: 'テスト店', placeId: 'ChIJ', placeStatus: 'confirmed' as const, suspendedAt: null };

function failingDb(error: unknown): () => Promise<Queryable> {
  return () => Promise.resolve({ query: () => Promise.reject(error) } as unknown as Queryable);
}
const pgError = (code: string) => Object.assign(new Error('relation "store_survey_configs" does not exist'), { code });

function pageDeps(getDb: () => Promise<Queryable>, log = vi.fn()): SurveyPageDeps {
  return {
    findStore: () => Promise.resolve(STORE_ROW),
    readDefinition: createSurveyDefinitionReader(getDb, log),
    listAspects: () => Promise.resolve([{ code: 'taste', label: '味' }]),
    signPage: (id) => tokens.signPage(id),
    signStructuredPage: (id, revision, fingerprint) => tokens.signStructuredPage(id, revision, fingerprint),
    buildReviewUrl: (placeId) => `https://review/${placeId}`,
    log,
  };
}

function responsesDeps(getDb: () => Promise<Queryable>, log = vi.fn()) {
  return {
    tokens,
    generator: { generate: vi.fn(() => Promise.resolve(ok('legacy の下書き'))) },
    rateLimiter: { check: () => true },
    findStore: () => Promise.resolve(STORE_ROW),
    listAspects: () => Promise.resolve([{ code: 'taste', label: '味' }]),
    incrementTallies: vi.fn(() => Promise.resolve()),
    readDefinition: createSurveyDefinitionReader(getDb, log),
    incrementStructuredTallies: vi.fn(() => Promise.resolve()),
    structuredDrafts: { prepare: vi.fn(() => Promise.resolve({ kind: 'unavailable' as const })) },
    clientKey: () => 'ip1',
    log,
  } satisfies ResponsesDeps;
}

const post = (body: unknown) => new Request('http://x/api/responses', { method: 'POST', body: JSON.stringify(body) });

describe('structured の表・権限が無い間は、表示と回答の両方が legacy として動く', () => {
  it.each(['42P01', '42501'])('%s: 表示は legacy、その pageToken で送った回答も legacy として受け付け、コードだけを記録する', async (code) => {
    const getDb = failingDb(pgError(code));
    const pageLog = vi.fn();
    const page = await loadSurveyPageData(pageDeps(getDb, pageLog), STORE);
    expect(page).toMatchObject({ kind: 'ready', mode: 'legacy' });
    expect(pageLog).toHaveBeenCalledWith('warn', 'survey-web.structured_schema_unavailable', { errorKind: code });

    const log = vi.fn();
    const deps = responsesDeps(getDb, log);
    const res = await handleResponses(
      post({ storeId: STORE, pageToken: page.kind === 'ready' ? page.pageToken : '', star: 5, aspectCodes: ['taste'] }),
      deps,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).generation).toBe('ok');
    expect(deps.incrementTallies).toHaveBeenCalledTimes(1);
    expect(deps.incrementStructuredTallies).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('warn', 'survey-web.structured_schema_unavailable', { errorKind: code });
    // 店舗 ID・エラーの本文は記録しない。
    const logged = JSON.stringify([...pageLog.mock.calls, ...log.mock.calls].filter((c) => c[1] === 'survey-web.structured_schema_unavailable'));
    expect(logged).not.toContain(STORE);
    expect(logged).not.toContain('does not exist');
  });

  it.each([
    ['接続の拒否', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['文のタイムアウト', pgError('57014')],
    ['SQL の誤り（列が無い）', pgError('42703')],
  ])('%s: 表示も回答も legacy に化けさせず失敗させる（記録もしない）', async (_name, error) => {
    const getDb = failingDb(error);
    const pageLog = vi.fn();
    await expect(loadSurveyPageData(pageDeps(getDb, pageLog), STORE)).rejects.toBe(error);
    const log = vi.fn();
    const deps = responsesDeps(getDb, log);
    await expect(
      handleResponses(post({ storeId: STORE, pageToken: tokens.signPage(STORE), star: 5, aspectCodes: ['taste'] }), deps),
    ).rejects.toBe(error);
    expect(deps.incrementTallies).not.toHaveBeenCalled();
    expect([...pageLog.mock.calls, ...log.mock.calls].map((c) => c[1])).not.toContain('survey-web.structured_schema_unavailable');
  });
});
