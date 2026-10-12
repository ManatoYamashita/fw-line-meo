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
// どちらも HMAC を検証するので、ページを経由せず API だけを叩いた押下は数えない。
//
// 月次の匿名集計へ加算するのは sessionToken の押下だけである（Issue #401・Requirement 5.9）。
// 集計はダッシュボードの QR パネルでオーナー向けの数字になるので、実際の回答の後の押下と
// 示せる方だけを使う。pageToken の押下はログにだけ残す。

export interface ReviewLinkDeps {
  tokens: SessionTokenService;
  rateLimiter: RateLimiter;
  clientKey: (req: Request) => string;
  log: SurveyLogger;
  /** 押下の月次集計へ 1 件加算する（失敗は throw）。記録するのは storeId だけ。 */
  incrementReviewLinkTally: (storeId: string) => Promise<void>;
}

/** 押下の証明の種別。`session` は下書き画面、`page` は回答済み画面から届く。 */
type Proof = 'session' | 'page';

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
  const proof = verifyProof(deps.tokens, token, storeId);
  if (proof === null) return status(400);

  // 記録を加算より先に行う。加算が落ちても、押下の観測（Requirement 5.7）は欠けない。
  logSurveyReviewLinkOpened(deps.log, storeId);
  if (proof === 'session') {
    // 加算の失敗は客へ転嫁しない（Requirement 5.4）。応答は誰も読まないが、204 のまま返す。
    // 記録（survey_review_link_opened）と集計の乖離が、集計障害の検知になる。
    await deps.incrementReviewLinkTally(storeId).catch(() => deps.log('warn', 'review_link_tally_failed'));
  }
  return status(204);
}

/** その店舗の回答で発行された sessionToken なら `session`、その店舗向けの pageToken なら `page`。 */
function verifyProof(tokens: SessionTokenService, token: string, storeId: string): Proof | null {
  if (storeId === '' || token === '') return null;
  const session = tokens.verify(token);
  if (session.ok && session.value.storeId === storeId) return 'session';
  if (tokens.verifyPage(token, storeId).ok) return 'page';
  return null;
}
