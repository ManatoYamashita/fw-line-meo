import { describe, it, expect, vi } from 'vitest';
import type { Queryable } from '@fwlm/db';
import { loadSurveyPageData, type SurveyPageDeps } from '../src/app/s/[storeId]/page-data';
import { handleResponses, type ResponsesDeps } from '../src/app/api/responses/handler';
import { createSessionTokenService } from '../src/lib/session-token';
import {
  createSurveyDefinitionReader,
  structuredSchemaCompatFallbackEnabled,
  surveyForceStructuredEnabled,
} from '../src/lib/survey-definition-reader';
import { ok } from '../src/lib/result';

// migration 0015 / 0016・grants.sql の適用前にコードが動く一時的な互換期間の逃げ道（PR #443 のレビュー対応）。
// **既定は無効**で、STRUCTURED_SCHEMA_COMPAT_FALLBACK=1 を明示したときだけ有効になる（追加レビュー）。
// 表示（loadSurveyPageData）と回答受付（handleResponses）は同じ読み方（createSurveyDefinitionReader）を通るので、
// 有効なら **どちらも** legacy として動き、無効なら **どちらも** 失敗する。DB へは接続しない。

const KEY = 'test-signing-key';
const STORE = '44444444-4444-4444-4444-444444444444';
const tokens = createSessionTokenService(KEY);
const STORE_ROW = { id: STORE, name: 'テスト店', placeId: 'ChIJ', placeStatus: 'confirmed' as const, suspendedAt: null };

function failingDb(error: unknown): () => Promise<Queryable> {
  return () => Promise.resolve({ query: () => Promise.reject(error) } as unknown as Queryable);
}
const pgError = (code: string) => Object.assign(new Error('relation "store_survey_configs" does not exist'), { code });

type Env = Readonly<Record<string, string | undefined>>;
const ON: Env = { STRUCTURED_SCHEMA_COMPAT_FALLBACK: '1' };
const OFF: Env = {};

function pageDeps(getDb: () => Promise<Queryable>, log = vi.fn(), env: Env = ON): SurveyPageDeps {
  return {
    findStore: () => Promise.resolve(STORE_ROW),
    readDefinition: createSurveyDefinitionReader(getDb, log, env),
    listAspects: () => Promise.resolve([{ code: 'taste', label: '味' }]),
    signPage: (id) => tokens.signPage(id),
    signStructuredPage: (id, revision, fingerprint) => tokens.signStructuredPage(id, revision, fingerprint),
    buildReviewUrl: (placeId) => `https://review/${placeId}`,
    log,
  };
}

function responsesDeps(getDb: () => Promise<Queryable>, log = vi.fn(), env: Env = ON) {
  return {
    tokens,
    generator: { generate: vi.fn(() => Promise.resolve(ok('legacy の下書き'))) },
    rateLimiter: { check: () => true },
    findStore: () => Promise.resolve(STORE_ROW),
    listAspects: () => Promise.resolve([{ code: 'taste', label: '味' }]),
    incrementTallies: vi.fn(() => Promise.resolve()),
    readDefinition: createSurveyDefinitionReader(getDb, log, env),
    incrementStructuredTallies: vi.fn(() => Promise.resolve()),
    structuredDrafts: { prepare: vi.fn(() => Promise.resolve({ kind: 'unavailable' as const })) },
    clientKey: () => 'ip1',
    log,
  } satisfies ResponsesDeps;
}

const post = (body: unknown) => new Request('http://x/api/responses', { method: 'POST', body: JSON.stringify(body) });

describe('逃げ道の有効 / 無効は STRUCTURED_SCHEMA_COMPAT_FALLBACK=1 の完全一致だけで決まる（fail-closed）', () => {
  it.each([
    [{ STRUCTURED_SCHEMA_COMPAT_FALLBACK: '1' }, true],
    [{}, false],
    [{ STRUCTURED_SCHEMA_COMPAT_FALLBACK: '' }, false],
    [{ STRUCTURED_SCHEMA_COMPAT_FALLBACK: '0' }, false],
    [{ STRUCTURED_SCHEMA_COMPAT_FALLBACK: 'true' }, false],
    [{ STRUCTURED_SCHEMA_COMPAT_FALLBACK: ' 1' }, false],
    [{ STRUCTURED_SCHEMA_COMPAT_FALLBACK: '1 ' }, false],
  ] as const)('%j → %s', (env, expected) => {
    expect(structuredSchemaCompatFallbackEnabled(env)).toBe(expected);
  });
});

describe('全店公開スイッチ SURVEY_FORCE_STRUCTURED', () => {
  it.each([
    [{ SURVEY_FORCE_STRUCTURED: '1' }, true],
    [{}, false],
    [{ SURVEY_FORCE_STRUCTURED: '0' }, false],
    [{ SURVEY_FORCE_STRUCTURED: 'true' }, false],
    [{ SURVEY_FORCE_STRUCTURED: ' 1' }, false],
    [{ SURVEY_FORCE_STRUCTURED: '1 ' }, false],
  ] as const)('%j → %s（文字列 1 だけ有効）', (env, expected) => {
    expect(surveyForceStructuredEnabled(env)).toBe(expected);
  });

  it('全店公開と schema 互換 fallback を同時には有効にできない', () => {
    expect(() => createSurveyDefinitionReader(failingDb(pgError('42P01')), vi.fn(), {
      SURVEY_FORCE_STRUCTURED: '1',
      STRUCTURED_SCHEMA_COMPAT_FALLBACK: '1',
    })).toThrow('SURVEY_FORCE_STRUCTURED=1 cannot be combined with STRUCTURED_SCHEMA_COMPAT_FALLBACK=1');
  });
});

describe('既定（逃げ道は無効）: 表・権限が無いと、表示も回答も legacy に化けずに失敗する', () => {
  it.each(['42P01', '42501'])('%s: 表示は失敗し、回答も legacy の集計・生成へ進まない', async (code) => {
    const error = pgError(code);
    const getDb = failingDb(error);
    const pageLog = vi.fn();
    await expect(loadSurveyPageData(pageDeps(getDb, pageLog, OFF), STORE)).rejects.toBe(error);
    const log = vi.fn();
    const deps = responsesDeps(getDb, log, OFF);
    await expect(
      handleResponses(post({ storeId: STORE, pageToken: tokens.signPage(STORE), star: 5, aspectCodes: ['taste'] }), deps),
    ).rejects.toBe(error);
    expect(deps.incrementTallies).not.toHaveBeenCalled();
    expect(deps.generator.generate).not.toHaveBeenCalled();
    expect([...pageLog.mock.calls, ...log.mock.calls].map((c) => c[1])).not.toContain('survey-web.structured_schema_unavailable');
  });

  it('structured の運用中に権限が乱れた（42501）とき、structured の店舗の回答が legacy として成功しない（回帰）', async () => {
    const deps = responsesDeps(failingDb(pgError('42501')), vi.fn(), OFF);
    await expect(
      handleResponses(post({ storeId: STORE, pageToken: tokens.signPage(STORE), star: 5, aspectCodes: ['taste'] }), deps),
    ).rejects.toMatchObject({ code: '42501' });
    expect(deps.incrementTallies).not.toHaveBeenCalled();
    expect(deps.incrementStructuredTallies).not.toHaveBeenCalled();
  });
});

describe('明示的に有効（STRUCTURED_SCHEMA_COMPAT_FALLBACK=1）: 表・権限が無い間は、表示と回答の両方が legacy として動く', () => {
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
