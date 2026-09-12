import { createDefaultDraftGenerator } from '../../../lib/draft/generator';
import { createRateLimiter } from '../../../lib/rate-limit';
import { createSessionTokenService } from '../../../lib/session-token';
import { logFactualityResidual, writeStructuredLog } from '../../../lib/structured-log';
import { handleDrafts, type DraftsDeps } from './handler';
import { correlationIdFromHeaders, supportCodeFromCorrelationId, withCorrelation } from '@fwlm/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let depsPromise: Promise<DraftsDeps> | undefined;

async function buildDeps(): Promise<DraftsDeps> {
  const signingKey = process.env.SESSION_SIGNING_KEY;
  if (!signingKey) throw new Error('SESSION_SIGNING_KEY is required');
  return {
    tokens: createSessionTokenService(signingKey),
    // 再生成 API も同じ生成器を通るので、事後検証は配線を足さずに効く（Issue #132・案B）。
    generator: await createDefaultDraftGenerator({
      onResidual: (aspectCodes) => logFactualityResidual(writeStructuredLog, aspectCodes),
    }),
    rateLimiter: createRateLimiter({ limit: 20, windowMs: 60_000 }),
    clientKey: (req) => req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown',
    log: writeStructuredLog,
  };
}

export async function POST(req: Request): Promise<Response> {
  try {
    depsPromise ??= buildDeps();
    const correlationId = correlationIdFromHeaders(req.headers);
    const deps = await depsPromise;
    return await handleDrafts(req, {
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
