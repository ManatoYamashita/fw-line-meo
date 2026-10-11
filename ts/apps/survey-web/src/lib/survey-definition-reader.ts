import { readStoreSurveyDefinition, type Queryable, type StoreSurveyDefinition } from '@fwlm/db';
import { logStructuredSchemaUnavailable, type SurveyLogger } from './structured-log';

// アンケートの表示（app/s/[storeId]/page.tsx）と回答受付（app/api/responses/route.ts）が **同じ** 定義の読み方を
// 使うための配線（PR #443 のレビュー対応）。
//
// structured survey の表・権限がまだ本番に無い（migration 0015 / 0016・grants.sql の適用前）ときに readStoreSurveyDefinition
// が legacy として扱った事実を、記録へ残す。片方だけがこの扱いをすると、表示は legacy なのに送信は 500（またはその逆）
// になるので、両方がここを通る。記録はエラーコードだけで、店舗 ID・エラーの本文は載せない。

export function createSurveyDefinitionReader(
  getDb: () => Promise<Queryable>,
  log: SurveyLogger,
): (storeId: string) => Promise<StoreSurveyDefinition> {
  return async (storeId) =>
    readStoreSurveyDefinition(await getDb(), storeId, {
      onStructuredSchemaUnavailable: (code) => logStructuredSchemaUnavailable(log, code),
    });
}
