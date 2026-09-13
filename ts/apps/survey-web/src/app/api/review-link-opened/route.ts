import { createRateLimiter } from '../../../lib/rate-limit';
import { createSessionTokenService } from '../../../lib/session-token';
import { writeStructuredLog } from '../../../lib/structured-log';
import { handleReviewLinkOpened, type ReviewLinkDeps } from './handler';
import { correlationIdFromHeaders, withCorrelation } from '@fwlm/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let deps: ReviewLinkDeps | undefined;

function buildDeps(): ReviewLinkDeps {
  const signingKey = process.env.SESSION_SIGNING_KEY;
  if (!signingKey) throw new Error('SESSION_SIGNING_KEY is required');
  return {
    tokens: createSessionTokenService(signingKey),
    // 正しい token を持つ押下でも、押し続ければその分だけ数えてしまう（無状態のため同一 token を
    // 区別できない）。人が押す回数を大きく超えないよう、生成を伴う 2 つの API より低く抑える。
    rateLimiter: createRateLimiter({ limit: 10, windowMs: 60_000 }),
    clientKey: (req) => req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown',
    log: writeStructuredLog,
  };
}

export async function POST(req: Request): Promise<Response> {
  try {
    deps ??= buildDeps();
    return await handleReviewLinkOpened(req, {
      ...deps,
      log: withCorrelation(deps.log, correlationIdFromHeaders(req.headers)),
    });
  } catch {
    // 応答は誰も読まない（sendBeacon の投げっぱなし）ので、エラー封筒もサポートコードも付けない。
    return new Response(null, { status: 500 });
  }
}
