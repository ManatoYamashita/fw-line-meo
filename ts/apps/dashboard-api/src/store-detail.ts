import type { StoreListItem } from '@fwlm/db';
import { authenticate, type AuthDeps } from './auth.js';
import { resolveAgencyScope } from './scope.js';
import { jsonError } from './http.js';
import { toStoreListItemJson } from './stores-list.js';

// GET /stores/:id の中核ロジック（agency-dashboard Requirement 11.1・11.9・11.10・Issue #526）。
// 店舗の詳細の画面が、店舗 1 件を一覧の 1 行と同じ形で読む。
//
// 評価の順: 認証 → UUID の形の検査 → 範囲の解決 → 取得。範囲（運営 = 全代理店、代理店 = 自代理店）は
// 取得の SQL の WHERE に含めて渡し、範囲外の店舗はプロセスへ運ばない（findStoreWithStatus）。
// **形の不正・不存在・範囲外は、同じ本文の 404 で返す（11.9）。** 区別できると、代理店ロールの利用者が
// 識別子を試して他の代理店の店舗の存在を推測できる。既存の QR と実績の取得（不在 404・担当外 403）は変えない。
// 読み出しだけなので監査記録を残さない。

export interface StoreDetailDeps {
  auth: AuthDeps;
  // findStoreWithStatus（@fwlm/db）を部分適用した取得。agencyId が null なら全代理店（運営だけが渡す）。
  findStore: (input: { storeId: string; agencyId: string | null }) => Promise<StoreListItem | null>;
}

export interface StoreDetailRequest {
  authorization: string | undefined;
  id: string;
}

// UUID 形式でない id は DB を叩かず 404 扱い（存在の探り当てを許さない・store-suspension と同じ規律）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_FOUND_MESSAGE = '店舗が見つかりません';

export async function handleStoreDetail(
  deps: StoreDetailDeps,
  req: StoreDetailRequest,
): Promise<Response> {
  const auth = await authenticate(deps.auth, req.authorization);
  if (auth.kind === 'unauthenticated') {
    return jsonError(401, 'unauthenticated', 'ログインが必要です');
  }
  if (auth.kind === 'unregistered' || auth.kind === 'disabled') {
    return jsonError(403, 'forbidden', 'アクセス権がありません');
  }

  // 形の不正は DB へ問い合わせずに、不存在と同じ 404 にする。
  if (!UUID_RE.test(req.id)) {
    return jsonError(404, 'not_found', NOT_FOUND_MESSAGE);
  }

  // 代理店を指定しない要求なので、範囲の解決は拒否しない（運営 = all、代理店 = 自代理店）。
  const scope = resolveAgencyScope(auth.user, undefined);
  if (!scope.ok) {
    return jsonError(403, 'forbidden', 'アクセス権がありません');
  }
  const agencyId = scope.scope.kind === 'all' ? null : scope.scope.agencyId;

  const store = await deps.findStore({ storeId: req.id, agencyId });
  if (store === null) {
    return jsonError(404, 'not_found', NOT_FOUND_MESSAGE);
  }

  return new Response(JSON.stringify({ store: toStoreListItemJson(store) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
