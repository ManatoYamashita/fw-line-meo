import type { DraftGenerator } from '../../../lib/draft/generator';
import { pickVariation } from '../../../lib/draft/prompt';
import type { RateLimiter } from '../../../lib/rate-limit';
import type { SessionTokenService } from '../../../lib/session-token';
import { jsonError, jsonOk } from '../../../lib/http';
import { REGEN_MAX } from '../../../lib/limits';

// 再生成 API の中核ロジック（依存注入でテスト可能）。
// 集計には一切触れず、attempt は生成成功時のみ +1、上限到達で 409。

export interface DraftsDeps {
  tokens: SessionTokenService;
  generator: DraftGenerator;
  rateLimiter: RateLimiter;
  clientKey: (req: Request) => string;
  log: (level: 'warn' | 'error' | 'info', event: string) => void;
}

export async function handleDrafts(req: Request, deps: DraftsDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'TOKEN_INVALID', 'お手数ですが最初から回答し直してください');
  }
  const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const sessionToken = typeof obj.sessionToken === 'string' ? obj.sessionToken : '';

  const verified = deps.tokens.verify(sessionToken);
  if (!verified.ok) {
    const code = verified.error === 'EXPIRED' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    return jsonError(400, code, 'お手数ですが最初から回答し直してください');
  }

  if (!deps.rateLimiter.check(deps.clientKey(req))) {
    return jsonError(429, 'RATE_LIMITED', '時間をおいて再度お試しください');
  }

  const { storeId, material, attempt } = verified.value;

  // 上限到達（再生成は最大 REGEN_MAX 回）
  if (attempt >= REGEN_MAX) {
    return jsonError(409, 'REGEN_LIMIT', '再生成の上限に達しました。編集してご利用ください');
  }

  const gen = await deps.generator.generate(material, pickVariation());

  if (!gen.ok) {
    // 失敗した試行は再生成回数を消費しない（attempt 据え置き）。
    if (gen.error.kind === 'SAFETY_BLOCKED') {
      deps.log('info', 'generation_safety_blocked');
    } else {
      deps.log('error', 'generation_failed');
    }
    const token = deps.tokens.sign({ storeId, material, attempt });
    return jsonOk({ generation: 'failed', draft: null, sessionToken: token, regenerationsLeft: REGEN_MAX - attempt });
  }

  const nextAttempt = attempt + 1;
  const token = deps.tokens.sign({ storeId, material, attempt: nextAttempt });
  return jsonOk({
    generation: 'ok',
    draft: gen.value,
    sessionToken: token,
    regenerationsLeft: REGEN_MAX - nextAttempt,
  });
}
