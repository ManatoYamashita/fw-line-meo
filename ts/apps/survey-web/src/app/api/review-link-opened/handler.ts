import type { RateLimiter } from '../../../lib/rate-limit';
import type { SessionTokenService } from '../../../lib/session-token';
import { logSurveyReviewLinkOpened, type SurveyLogger } from '../../../lib/structured-log';

// 投稿導線の押下の通知を受ける（Issue #137・Requirement 5.7）。依存注入でテスト可能にする。
//
// 客の端末は「Google のクチコミを書く」を押した瞬間に sendBeacon でここへ投げ、結果を待たない
// （Requirement 5.8）。したがって応答は誰も読まない。本文を持たず、状態コードだけを返す。
//
// 数えるのは token を検証できた押下だけで、記録するのは storeId だけである。
// - 下書き画面は sessionToken を送る。これは /api/responses の後にしか発行されないので、
//   「実際の回答の後の押下」を証明する
// - 回答済み画面（24 時間以内の再訪）は pageToken を送る。これが証明するのは「ページが配信された」
//   ことまでで、信頼水準は表示件数（survey_page_viewed）と同じである
// どちらも HMAC を検証するので、ページを経由せず API だけを叩いた押下は数えない。DB には触れない。

export interface ReviewLinkDeps {
  tokens: SessionTokenService;
  rateLimiter: RateLimiter;
  clientKey: (req: Request) => string;
  log: SurveyLogger;
}

function status(code: number): Response {
  return new Response(null, { status: code });
}

export async function handleReviewLinkOpened(req: Request, deps: ReviewLinkDeps): Promise<Response> {
  // sendBeacon は文字列の本文を text/plain で送るので、Content-Type に依らず本文を JSON として読む。
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return status(400);
  }
  const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const storeId = typeof obj.storeId === 'string' ? obj.storeId : '';
  const token = typeof obj.token === 'string' ? obj.token : '';

  if (!deps.rateLimiter.check(deps.clientKey(req))) return status(429);
  if (!isAuthentic(deps.tokens, token, storeId)) return status(400);

  logSurveyReviewLinkOpened(deps.log, storeId);
  return status(204);
}

/** pageToken（その店舗向け）か、その店舗の回答で発行された sessionToken なら真。 */
function isAuthentic(tokens: SessionTokenService, token: string, storeId: string): boolean {
  if (storeId === '' || token === '') return false;
  if (tokens.verifyPage(token, storeId).ok) return true;
  const session = tokens.verify(token);
  return session.ok && session.value.storeId === storeId;
}
