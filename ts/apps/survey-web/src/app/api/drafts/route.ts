import { createDefaultDraftGenerator } from '../../../lib/draft/generator';
import { createRateLimiter } from '../../../lib/rate-limit';
import { createSessionTokenService } from '../../../lib/session-token';
import { handleDrafts, type DraftsDeps } from './handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let depsPromise: Promise<DraftsDeps> | undefined;

async function buildDeps(): Promise<DraftsDeps> {
  const signingKey = process.env.SESSION_SIGNING_KEY;
  if (!signingKey) throw new Error('SESSION_SIGNING_KEY is required');
  return {
    tokens: createSessionTokenService(signingKey),
    generator: await createDefaultDraftGenerator(),
    rateLimiter: createRateLimiter({ limit: 20, windowMs: 60_000 }),
    clientKey: (req) => req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown',
    log: (level, event) => {
      console[level](JSON.stringify({ level, event }));
    },
  };
}

export async function POST(req: Request): Promise<Response> {
  try {
    depsPromise ??= buildDeps();
    return await handleDrafts(req, await depsPromise);
  } catch {
    return new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'サーバーエラー' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
