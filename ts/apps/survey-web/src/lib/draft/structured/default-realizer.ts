import type { StructuredDraftPort } from '../structured-draft';
import { createDefaultGenAiClient } from '../gemini-client';
import { logStructuredDraftFallback, logStructuredDraftResult, logStructuredDraftRetry, writeStructuredLog } from '../../structured-log';
import { createNaturalRealizer } from './realizer';

// 本番の Natural LLM Realizer（Issue #439）。/api/responses と /api/drafts の route.ts が配線する。
// 作り直し・fallback は失格の種類だけを記録する（下書き・一言・料理名は記録しない）。
// 最終の結果（llm / fallback・LLM の呼び出し回数・style の作り直しの有無）は、ローカル検証のときだけ
// `STRUCTURED_DRAFT_DEBUG_LOG=1` で記録する（本番では配線しない。本番のログの方針は変えない）。
export async function createDefaultStructuredDrafts(): Promise<StructuredDraftPort> {
  const client = await createDefaultGenAiClient();
  return createNaturalRealizer(client, {
    ...(process.env.GEMINI_MODEL ? { model: process.env.GEMINI_MODEL } : {}),
    onRetry: (kinds, claimCount) => logStructuredDraftRetry(writeStructuredLog, kinds, claimCount),
    onFallback: (reason, kinds, claimCount) => logStructuredDraftFallback(writeStructuredLog, reason, kinds, claimCount),
    ...(process.env.STRUCTURED_DRAFT_DEBUG_LOG === '1'
      ? { onResult: (outcome, claimCount) => logStructuredDraftResult(writeStructuredLog, outcome, claimCount) }
      : {}),
  });
}
