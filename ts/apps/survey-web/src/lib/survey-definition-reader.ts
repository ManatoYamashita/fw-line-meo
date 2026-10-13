import { readStoreSurveyDefinition, type Queryable, type StoreSurveyDefinition } from '@fwlm/db';
import { logStructuredSchemaUnavailable, type SurveyLogger } from './structured-log';

// アンケートの表示（app/s/[storeId]/page.tsx）と回答受付（app/api/responses/route.ts）が **同じ** 定義の読み方を
// 使うための配線（PR #443 のレビュー対応）。互換の逃げ道の有効 / 無効も、両方がここで同じ環境変数から決める
// （片方だけが legacy に落ちると、表示は legacy なのに送信は 500、またはその逆になる）。
//
// 互換の逃げ道（structured の表・権限が無い 42P01 / 42501 のときに legacy として扱う）は **既定で無効** である。
// 有効にするのは、migration 0015 / 0016・grants.sql の前にこのコードが動く一時的な互換期間・緊急時だけで、
// `STRUCTURED_SCHEMA_COMPAT_FALLBACK=1` を明示したときに限る。structured の店舗を 1 件でも有効にする前に外す。
// 値は `1` との完全一致だけを有効と読む（`true`・`yes`・空白つきなど、それ以外はすべて無効＝投げる）。
// 有効中に legacy として扱ったときは、エラーコードだけを記録する（店舗 ID・エラーの本文は載せない）。

export const STRUCTURED_SCHEMA_COMPAT_FALLBACK_ENV = 'STRUCTURED_SCHEMA_COMPAT_FALLBACK';

/** 互換の逃げ道が明示的に有効か（`1` との完全一致だけ）。 */
export function structuredSchemaCompatFallbackEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[STRUCTURED_SCHEMA_COMPAT_FALLBACK_ENV] === '1';
}

export function createSurveyDefinitionReader(
  getDb: () => Promise<Queryable>,
  log: SurveyLogger,
  env: Readonly<Record<string, string | undefined>> = process.env,
): (storeId: string) => Promise<StoreSurveyDefinition> {
  const allowStructuredSchemaFallback = structuredSchemaCompatFallbackEnabled(env);
  return async (storeId) =>
    readStoreSurveyDefinition(await getDb(), storeId, {
      allowStructuredSchemaFallback,
      onStructuredSchemaUnavailable: (code) => logStructuredSchemaUnavailable(log, code),
    });
}
