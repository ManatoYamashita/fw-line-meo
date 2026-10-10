import type { DraftGenerator } from '../../../lib/draft/generator';
import { pickVariation } from '../../../lib/draft/prompt';
import type { RateLimiter } from '../../../lib/rate-limit';
import type { SessionTokenService, StructuredSessionPayload } from '../../../lib/session-token';
import type { StructuredDraftPort } from '../../../lib/draft/structured-draft';
import type { SurveyStoreView } from '../responses/handler';
import { jsonError, jsonOk } from '../../../lib/http';
import { REGEN_MAX } from '../../../lib/limits';
import {
  logFabricationResidual,
  logFactualityResidual,
  logGenerationFailure,
  type SurveyLogger,
} from '../../../lib/structured-log';

// 再生成 API の中核ロジック（依存注入でテスト可能）。
// 集計には一切触れず、attempt は生成成功時のみ +1、上限到達で 409。
// 店舗が不存在・未確定・停止中なら 404（Issue #252）。sessionToken は停止前に発行されていても
// 有効期限内なら検証を通るため、トークンだけで判断せず毎回店舗の状態を読む。

export interface DraftsDeps {
  tokens: SessionTokenService;
  generator: DraftGenerator;
  rateLimiter: RateLimiter;
  findStore: (id: string) => Promise<SurveyStoreView | null>;
  /** structured survey の再生成（Natural LLM Realizer・Issue #439）。 */
  structuredDrafts: StructuredDraftPort;
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

  // structured の sessionToken（v: 2・Issue #439）は structured の再生成へ。legacy の検証（v: 1）は v: 2 を通さないので、
  // 先に分岐する。legacy の経路はこの分岐の後で従来どおり。
  const structured = deps.tokens.verifyStructured(sessionToken);
  if (structured.ok) return handleStructuredDrafts(req, structured.value, deps);

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
    (categories) => logFabricationResidual(deps.log, categories),
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

/**
 * structured の再生成（Issue #439）。sessionToken に封入した素材（回答時点の Target の名前の snapshot）から作り直す。
 * 集計には触れない。上限・店舗の可否・レート制限は legacy と同じ規則。生成器が下書きを返せなかった（claim の無い
 * 素材・最大回数まで作れなかった generation error）ときは生成失敗として返し、試行は消費しない。生成器の内部の
 * 作り直し（最大 3 回）は 1 回の再生成として数える。
 */
async function handleStructuredDrafts(req: Request, payload: StructuredSessionPayload, deps: DraftsDeps): Promise<Response> {
  if (!deps.rateLimiter.check(deps.clientKey(req))) {
    return error(deps, 429, 'RATE_LIMITED', '時間をおいて再度お試しください');
  }
  const { storeId, structured, attempt } = payload;
  const store = await deps.findStore(storeId);
  if (!store || store.placeStatus !== 'confirmed' || store.suspendedAt !== null) {
    return error(deps, 404, 'STORE_NOT_AVAILABLE', 'このアンケートは現在利用できません');
  }
  if (attempt >= REGEN_MAX) {
    return error(deps, 409, 'REGEN_LIMIT', '再生成の上限に達しました。編集してご利用ください');
  }
  // 初回と同じ生成をもう一度行う（構成を変える指示は足さない。前回の下書きは受け取らず、渡さない）。
  const prepared = await deps.structuredDrafts.prepare(structured);
  if (prepared.kind !== 'draft') {
    const token = deps.tokens.signStructured({ storeId, structured, attempt });
    return jsonOk({ generation: 'failed', draft: null, sessionToken: token, regenerationsLeft: REGEN_MAX - attempt });
  }
  const nextAttempt = attempt + 1;
  return jsonOk({
    generation: 'ok',
    draft: prepared.draft,
    sessionToken: deps.tokens.signStructured({ storeId, structured, attempt: nextAttempt }),
    regenerationsLeft: REGEN_MAX - nextAttempt,
  });
}
