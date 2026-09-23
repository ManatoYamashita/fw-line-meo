import type { DraftGenerator } from '../../../lib/draft/generator';
import { pickVariation } from '../../../lib/draft/prompt';
import type { RateLimiter } from '../../../lib/rate-limit';
import type { SessionTokenService } from '../../../lib/session-token';
import type { SurveyStoreView } from '../responses/handler';
import { jsonError, jsonOk } from '../../../lib/http';
import { REGEN_MAX } from '../../../lib/limits';
import { logFactualityResidual, logGenerationFailure, type SurveyLogger } from '../../../lib/structured-log';

// 再生成 API の中核ロジック（依存注入でテスト可能）。
// 集計には一切触れず、attempt は生成成功時のみ +1、上限到達で 409。
// 店舗が不存在・未確定・停止中なら 404（Issue #252）。sessionToken は停止前に発行されていても
// 有効期限内なら検証を通るため、トークンだけで判断せず毎回店舗の状態を読む。

export interface DraftsDeps {
  tokens: SessionTokenService;
  generator: DraftGenerator;
  rateLimiter: RateLimiter;
  findStore: (id: string) => Promise<SurveyStoreView | null>;
  clientKey: (req: Request) => string;
  log: SurveyLogger;
  supportCode?: string;
}

function error(deps: DraftsDeps, status: number, code: string, message: string): Response {
  return jsonError(status, code, message, deps.supportCode);
}

export async function handleDrafts(req: Request, deps: DraftsDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(deps, 400, 'TOKEN_INVALID', 'お手数ですが最初から回答し直してください');
  }
  const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const sessionToken = typeof obj.sessionToken === 'string' ? obj.sessionToken : '';

  const verified = deps.tokens.verify(sessionToken);
  if (!verified.ok) {
    const code = verified.error === 'EXPIRED' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    return error(deps, 400, code, 'お手数ですが最初から回答し直してください');
  }

  if (!deps.rateLimiter.check(deps.clientKey(req))) {
    return error(deps, 429, 'RATE_LIMITED', '時間をおいて再度お試しください');
  }

  const { storeId, material, attempt } = verified.value;

  // 店舗（存在＋place 確定＋利用中のみ）。読むのは署名済みトークンの storeId。
  const store = await deps.findStore(storeId);
  if (!store || store.placeStatus !== 'confirmed' || store.suspendedAt !== null) {
    return error(deps, 404, 'STORE_NOT_AVAILABLE', 'このアンケートは現在利用できません');
  }

  // 上限到達（再生成は最大 REGEN_MAX 回）
  if (attempt >= REGEN_MAX) {
    return error(deps, 409, 'REGEN_LIMIT', '再生成の上限に達しました。編集してご利用ください');
  }

  const gen = await deps.generator.generate(
    material,
    pickVariation(material),
    (aspectCodes) => logFactualityResidual(deps.log, aspectCodes),
  );

  if (!gen.ok) {
    // 失敗した試行は再生成回数を消費しない（attempt 据え置き）。
    logGenerationFailure(deps.log, gen.error);
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
