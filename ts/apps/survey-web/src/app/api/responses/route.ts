import { getPool, findStoreForSurvey, listSurveyAspects, incrementTallies } from '@fwlm/db';
import { createDefaultDraftGenerator } from '../../../lib/draft/generator';
import { createRateLimiter } from '../../../lib/rate-limit';
import { createSessionTokenService } from '../../../lib/session-token';
import { logFactualityResidual, writeStructuredLog } from '../../../lib/structured-log';
import { handleResponses, type ResponsesDeps } from './handler';

// pg / @fwlm/gemini（内部で @google/genai）を使うため Node ランタイム・動的（POST）。
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
    clientKey: (req) => req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown',
    log: writeStructuredLog,
  };
}

export async function POST(req: Request): Promise<Response> {
  try {
    depsPromise ??= buildDeps();
    return await handleResponses(req, await depsPromise);
  } catch {
    return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'サーバーエラー' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
