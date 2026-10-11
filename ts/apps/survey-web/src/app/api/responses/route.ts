import {
  getPool,
  findStoreForSurvey,
  listSurveyAspects,
  incrementTallies,
  incrementStructuredTallies,
} from '@fwlm/db';
import { createDefaultStructuredDrafts } from '../../../lib/draft/structured/default-realizer';
import { createDefaultDraftGenerator } from '../../../lib/draft/generator';
import { createClientKey } from '../../../lib/client-key';
import { createRateLimiter } from '../../../lib/rate-limit';
import { createSessionTokenService } from '../../../lib/session-token';
import { logFabricationResidual, logFactualityResidual, writeStructuredLog } from '../../../lib/structured-log';
import { createSurveyDefinitionReader } from '../../../lib/survey-definition-reader';
import { handleResponses, type ResponsesDeps } from './handler';
import { correlationIdFromHeaders, supportCodeFromCorrelationId, withCorrelation } from '@fwlm/observability';

// pg / @google/genai を使うため Node ランタイム・動的（POST）。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let depsPromise: Promise<ResponsesDeps> | undefined;

async function buildDeps(): Promise<ResponsesDeps> {
  const signingKey = process.env.SESSION_SIGNING_KEY;
  if (!signingKey) throw new Error('SESSION_SIGNING_KEY is required');
  const tokens = createSessionTokenService(signingKey);
  // 事後検証（Issue #132・案B）で作り直してもなお残った観点を記録する。下書き自体は客へ返すため
  // 生成失敗ではない。生成器はロガーを持たないので、記録の仕方はここで決める。
  const generator = await createDefaultDraftGenerator({
    onResidual: (aspectCodes) => logFactualityResidual(writeStructuredLog, aspectCodes),
    onClaimResidual: (categories) => logFabricationResidual(writeStructuredLog, categories),
  });
  const rateLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

  return {
    tokens,
    generator,
    rateLimiter,
    findStore: async (id) => findStoreForSurvey(await getPool(), id),
    listAspects: async () => listSurveyAspects(await getPool()),
    incrementTallies: async (input) => {
      await incrementTallies(await getPool(), input);
    },
    // 表示（s/[storeId]/page.tsx）と同じ読み方・同じ設定。42P01 / 42501 を legacy として扱うのは
    // STRUCTURED_SCHEMA_COMPAT_FALLBACK=1（完全一致）で明示的に有効にしたときだけ（記録つき）。既定・pilot・本運用では
    // 無効で、42P01 / 42501 も投げて 5xx になる（lib/survey-definition-reader.ts）。
    readDefinition: createSurveyDefinitionReader(getPool, writeStructuredLog),
    incrementStructuredTallies: async (input) => {
      await incrementStructuredTallies(await getPool(), input);
    },
    // structured の下書きは Natural LLM Realizer（Issue #439）。legacy の生成器とは分ける。
    structuredDrafts: await createDefaultStructuredDrafts(),
    clientKey: createClientKey(),
    log: writeStructuredLog,
  };
}

export async function POST(req: Request): Promise<Response> {
  try {
    depsPromise ??= buildDeps();
    const correlationId = correlationIdFromHeaders(req.headers);
    const deps = await depsPromise;
    return await handleResponses(req, {
      ...deps,
      log: withCorrelation(deps.log, correlationId),
      supportCode: supportCodeFromCorrelationId(correlationId),
    });
  } catch {
    const supportCode = supportCodeFromCorrelationId(correlationIdFromHeaders(req.headers));
    return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'サーバーエラー' }, ...(supportCode ? { supportCode } : {}) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
