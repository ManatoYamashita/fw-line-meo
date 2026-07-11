import type { StoreWithAgency } from '@fwlm/db';
import { authenticate, canAccessStore, type AuthDeps } from './auth.js';
import { jsonError } from './http.js';

// QR エンドポイントの中核ロジック（依存注入でテスト可能）。
// 認証 → 店舗取得 → RBAC → place 確定 → QR PNG の順に評価する。
// qrcode / firebase-admin / DB はすべて注入面に隔離する。

export interface QrDeps {
  auth: AuthDeps;
  findStore: (id: string) => Promise<StoreWithAgency | null>;
  renderQr: (text: string, size: number) => Promise<Buffer>;
  surveyBaseUrl: string;
}

export interface QrRequest {
  storeId: string;
  size: number;
  authorization: string | undefined;
}

export async function handleQr(deps: QrDeps, req: QrRequest): Promise<Response> {
  // 1. 認証（Bearer + firebase-admin 検証）
  const auth = await authenticate(deps.auth, req.authorization);
  if (auth.kind === 'unauthenticated') {
    return jsonError(401, 'UNAUTHENTICATED', 'ログインが必要です');
  }
  if (auth.kind === 'unregistered') {
    return jsonError(403, 'FORBIDDEN', 'アクセス権がありません');
  }

  // 2. 店舗取得（無効 ID / 不在は 404。findStoreWithAgency が UUID ガードを持つ）
  const store = await deps.findStore(req.storeId);
  if (store === null) {
    return jsonError(404, 'NOT_FOUND', '店舗が見つかりません');
  }

  // 3. RBAC（operator 全店 / agency 担当店のみ）
  if (!canAccessStore(auth.user, store.agencyId)) {
    return jsonError(403, 'FORBIDDEN', 'この店舗へのアクセス権がありません');
  }

  // 4. place 確定（未確定は QR を発行しない）
  if (store.placeStatus !== 'confirmed') {
    return jsonError(409, 'PLACE_NOT_CONFIRMED', '店舗の場所が未確定です。先に確定してください');
  }

  // 5. QR PNG 生成（中身は {SURVEY_BASE_URL}/s/{storeId} の URL のみ）
  const url = `${deps.surveyBaseUrl}/s/${store.id}`;
  const png = await deps.renderQr(url, req.size);
  return new Response(new Uint8Array(png), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      // filename は UUID を使いヘッダインジェクションを避ける（店名は使わない）。
      'Content-Disposition': `attachment; filename="qr-${store.id}.png"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
