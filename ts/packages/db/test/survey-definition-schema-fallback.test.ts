import { describe, it, expect, vi } from 'vitest';
import type { Queryable } from '../src/pool.js';
import { readStoreSurveyDefinition, STRUCTURED_SCHEMA_UNAVAILABLE_CODES } from '../src/survey-definition.js';

// structured survey の表・権限がまだ本番に無いときの互換の逃げ道（PR #443 のレビュー対応）。
// legacy として扱うのは、明示的に有効にしたときの「表が無い（42P01）」「権限が無い（42501）」だけ（既定は投げる）。
// DB へは接続しない（query が投げるエラーを差し替える）。

const STORE = '44444444-4444-4444-4444-444444444444';

function failingDb(error: unknown): Queryable {
  return { query: vi.fn(() => Promise.reject(error)) } as unknown as Queryable;
}

function pgError(code: string, message = 'relation "store_survey_configs" does not exist'): Error {
  return Object.assign(new Error(message), { code });
}

const SCHEMA_CODES = ['42P01', '42501'] as const;
const ALWAYS_THROWN: [string, unknown][] = [
  ['接続の拒否', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
  ['文のタイムアウト（57014 query_canceled）', pgError('57014', 'canceling statement due to statement timeout')],
  ['列が無い（42703・SQL の誤り）', pgError('42703', 'column "x" does not exist')],
  ['構文の誤り（42601）', pgError('42601', 'syntax error')],
  ['接続の切断（08006）', pgError('08006', 'connection failure')],
  ['コードの無い例外', new Error('boom')],
  ['Error ではない値', 'boom'],
];

describe('readStoreSurveyDefinition: structured の表・権限が無いときの互換の逃げ道', () => {
  it('対象のエラーコードは 42P01（undefined_table）と 42501（insufficient_privilege）だけ', () => {
    expect([...STRUCTURED_SCHEMA_UNAVAILABLE_CODES]).toEqual([...SCHEMA_CODES]);
  });

  describe('既定（逃げ道は無効）: 表・権限が無くても legacy に落とさず投げる', () => {
    it.each(SCHEMA_CODES)('%s → 投げる（知らせもしない）', async (code) => {
      const error = pgError(code);
      const onStructuredSchemaUnavailable = vi.fn();
      await expect(readStoreSurveyDefinition(failingDb(error), STORE, { onStructuredSchemaUnavailable })).rejects.toBe(error);
      await expect(readStoreSurveyDefinition(failingDb(error), STORE)).rejects.toBe(error);
      expect(onStructuredSchemaUnavailable).not.toHaveBeenCalled();
    });

    it.each(SCHEMA_CODES)('%s → allowStructuredSchemaFallback: false を明示しても投げる', async (code) => {
      const error = pgError(code);
      await expect(
        readStoreSurveyDefinition(failingDb(error), STORE, { allowStructuredSchemaFallback: false }),
      ).rejects.toBe(error);
    });

    it('structured の運用中に権限が乱れた（42501）ときに、legacy として成功させない（回帰）', async () => {
      const error = pgError('42501', 'permission denied for table store_survey_configs');
      await expect(readStoreSurveyDefinition(failingDb(error), STORE)).rejects.toBe(error);
    });
  });

  describe('明示的に有効（allowStructuredSchemaFallback: true）', () => {
    it.each(SCHEMA_CODES)('%s → legacy を返し、コードだけを知らせる', async (code) => {
      const onStructuredSchemaUnavailable = vi.fn();
      await expect(
        readStoreSurveyDefinition(failingDb(pgError(code)), STORE, {
          allowStructuredSchemaFallback: true,
          onStructuredSchemaUnavailable,
        }),
      ).resolves.toEqual({ mode: 'legacy' });
      expect(onStructuredSchemaUnavailable).toHaveBeenCalledWith(code);
    });
  });

  describe.each([
    ['既定', {}],
    ['有効', { allowStructuredSchemaFallback: true }],
  ] as const)('%s でも、それ以外の DB の失敗は legacy に化けさせず投げる', (_mode, options) => {
    it.each(ALWAYS_THROWN)('%s', async (_name, error) => {
      const onStructuredSchemaUnavailable = vi.fn();
      await expect(
        readStoreSurveyDefinition(failingDb(error), STORE, { ...options, onStructuredSchemaUnavailable }),
      ).rejects.toBe(error);
      expect(onStructuredSchemaUnavailable).not.toHaveBeenCalled();
    });
  });
});
