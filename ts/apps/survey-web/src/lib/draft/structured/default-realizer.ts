import type { StructuredDraftPort } from '../structured-draft';
import { createDefaultGenAiClient } from '../gemini-client';
import { logStructuredDraftFallback, logStructuredDraftRetry, writeStructuredLog } from '../../structured-log';
import { createNaturalRealizer } from './realizer';

// 本番の Natural LLM Realizer（Issue #439）。/api/responses と /api/drafts の route.ts が配線する。
// 作り直し・fallback は失格の種類だけを記録する（下書き・一言・料理名は記録しない）。
export async function createDefaultStructuredDrafts(): Promise<StructuredDraftPort> {
  const client = await createDefaultGenAiClient();
  return createNaturalRealizer(client, {
    ...(process.env.GEMINI_MODEL ? { model: process.env.GEMINI_MODEL } : {}),
    onRetry: (kinds, claimCount) => logStructuredDraftRetry(writeStructuredLog, kinds, claimCount),
    onFallback: (reason, kinds, claimCount) => logStructuredDraftFallback(writeStructuredLog, reason, kinds, claimCount),
  });
}
