import { getPool, findStoreForSurvey, listSurveyAspects, incrementTallies } from '@fwlm/db';
import { createDefaultDraftGenerator } from '../../../lib/draft/generator';
import { createRateLimiter } from '../../../lib/rate-limit';
import { createSessionTokenService } from '../../../lib/session-token';
import { handleResponses, type ResponsesDeps } from './handler';

// pg / @google/genai を使うため Node ランタイム・動的（POST）。
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let depsPromise: Promise<ResponsesDeps> | undefined;

async function buildDeps(): Promise<ResponsesDeps> {
  const signingKey = process.env.SESSION_SIGNING_KEY;
  if (!signingKey) throw new Error('SESSION_SIGNING_KEY is required');
  const tokens = createSessionTokenService(signingKey);
  const generator = await createDefaultDraftGenerator();
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
    log: (level, event) => {
      // 自由記述・下書き本文はログに出さない（イベント名のみ）。
      console[level](JSON.stringify({ level, event }));
    },
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
