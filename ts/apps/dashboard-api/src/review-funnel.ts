import type { StoreReviewFunnelMonth, StoreWithAgency } from '@fwlm/db';
import type { Sink } from '@fwlm/observability';
import { authenticate, canAccessStore, type AuthDeps } from './auth.js';
import { jsonError } from './http.js';

// GET /stores/:storeId/review-funnel の中核ロジック（Issue #401・store-qr-issuance-ui Requirement 8）。
// QR パネルに出す、その店舗の当月と前月のアンケートの回答件数と、Google の投稿画面へ進んだ回数を返す。
//
// 評価の順序は QR（qr.ts）と同じ「認証 → 店舗取得 → RBAC」で、QR を発行できる範囲の店舗だけに答える
// （8.6）。場所の確定と停止中の判定は置かない。実績の読み出しは店舗の利用可否を決めないためである。
// 読み出しは書込を伴わないので監査記録を残さない。

export interface ReviewFunnelDeps {
  auth: AuthDeps;
  findStore: (id: string) => Promise<StoreWithAgency | null>;
  // readStoreReviewFunnel（@fwlm/db）を部分適用した読み出し。当月・前月の 2 件を新しい順に返す。
  readFunnel: (storeId: string) => Promise<StoreReviewFunnelMonth[]>;
}

export interface ReviewFunnelRequest {
  storeId: string;
  authorization: string | undefined;
  log: Sink;
}

export async function handleReviewFunnel(
  deps: ReviewFunnelDeps,
  req: ReviewFunnelRequest,
): Promise<Response> {
  // 1. 認証
  const auth = await authenticate(deps.auth, req.authorization);
  if (auth.kind === 'unauthenticated') {
    return jsonError(401, 'unauthenticated', 'ログインが必要です');
  }
  if (auth.kind === 'unregistered' || auth.kind === 'disabled') {
    return jsonError(403, 'forbidden', 'アクセス権がありません');
  }

  // 2. 店舗取得（無効 ID / 不在は 404。findStoreWithAgency が UUID ガードを持つ）
  const store = await deps.findStore(req.storeId);
  if (store === null) {
    return jsonError(404, 'not_found', '店舗が見つかりません');
  }

  // 3. RBAC（operator 全店 / agency 担当店のみ）。拒否時は実績を読まない。
  if (!canAccessStore(auth.user, store.agencyId)) {
    return jsonError(403, 'forbidden', 'この店舗へのアクセス権がありません');
  }

  // 4. 読み出し。失敗は店舗の識別子だけを記録して 500 にする（件数も例外の文言も載せない）。
  let months: StoreReviewFunnelMonth[];
  try {
    months = await deps.readFunnel(store.id);
  } catch {
    req.log('error', 'dashboard-api.review_funnel_read_failed', { storeId: store.id });
    return jsonError(500, 'internal', '実績を読み込めませんでした。時間をおいて再試行してください');
  }

  // 返す項目は月・回答件数・押下回数の 3 つだけに固定する（8.2）。DAL が項目を足しても、
  // ここを通らない限り画面へは届かない。
  const body = {
    months: months.map((m) => ({
      month: m.month,
      responses: m.responses,
      reviewLinkOpens: m.reviewLinkOpens,
    })),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}
