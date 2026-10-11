import { describe, it, expect, vi } from 'vitest';
import type { Queryable } from '../src/pool.js';
import { readStoreSurveyDefinition, STRUCTURED_SCHEMA_UNAVAILABLE_CODES } from '../src/survey-definition.js';

// structured survey の表・権限がまだ本番に無いときの互換の逃げ道（PR #443 のレビュー対応）。
// legacy として扱うのは「表が無い（42P01）」「権限が無い（42501）」だけで、それ以外の DB の失敗は投げる。
// DB へは接続しない（query が投げるエラーを差し替える）。

const STORE = '44444444-4444-4444-4444-444444444444';

function failingDb(error: unknown): Queryable {
  return { query: vi.fn(() => Promise.reject(error)) } as unknown as Queryable;
}

function pgError(code: string, message = 'relation "store_survey_configs" does not exist'): Error {
  return Object.assign(new Error(message), { code });
}

describe('readStoreSurveyDefinition: structured の表・権限が無いときだけ legacy として扱う', () => {
  it('対象のエラーコードは 42P01（undefined_table）と 42501（insufficient_privilege）だけ', () => {
    expect([...STRUCTURED_SCHEMA_UNAVAILABLE_CODES]).toEqual(['42P01', '42501']);
  });

  it.each(['42P01', '42501'])('%s → legacy を返し、コードだけを知らせる', async (code) => {
    const onStructuredSchemaUnavailable = vi.fn();
    await expect(readStoreSurveyDefinition(failingDb(pgError(code)), STORE, { onStructuredSchemaUnavailable })).resolves.toEqual({
      mode: 'legacy',
    });
    expect(onStructuredSchemaUnavailable).toHaveBeenCalledWith(code);
  });

  it.each([
    ['接続の拒否', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['文のタイムアウト（57014 query_canceled）', pgError('57014', 'canceling statement due to statement timeout')],
    ['列が無い（42703・SQL の誤り）', pgError('42703', 'column "x" does not exist')],
    ['構文の誤り（42601）', pgError('42601', 'syntax error')],
    ['接続の切断（08006）', pgError('08006', 'connection failure')],
    ['コードの無い例外', new Error('boom')],
    ['Error ではない値', 'boom'],
  ])('%s は legacy に化けさせず投げる', async (_name, error) => {
    const onStructuredSchemaUnavailable = vi.fn();
    await expect(readStoreSurveyDefinition(failingDb(error), STORE, { onStructuredSchemaUnavailable })).rejects.toBe(error);
    expect(onStructuredSchemaUnavailable).not.toHaveBeenCalled();
  });

  it('知らせる口が無くても legacy を返す', async () => {
    await expect(readStoreSurveyDefinition(failingDb(pgError('42P01')), STORE)).resolves.toEqual({ mode: 'legacy' });
  });
});
