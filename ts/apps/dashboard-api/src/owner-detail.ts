import type { OwnerListItem, StoreListItem } from '@fwlm/db';
import { authenticate, type AuthDeps } from './auth.js';
import { resolveAgencyScope } from './scope.js';
import { jsonError } from './http.js';
import { toOwnerListItemJson } from './owners-list.js';
import { toStoreListItemJson } from './stores-list.js';

// GET /owners/:id の中核ロジック（agency-dashboard Requirement 11.6・11.7・11.9・11.10・Issue #526）。
// オーナーの詳細の画面が、オーナー 1 人（オーナー一覧の 1 行と同じ形）と、そのオーナーの全店舗
// （店舗一覧の行と同じ形・未確定を含む）を 1 回で読む。
//
// 評価の順は GET /stores/:id と同じ（認証 → UUID の形 → 範囲の解決 → 取得）。形の不正・不存在・範囲外は
// 同じ本文の 404 で返す（11.9）。店舗は、オーナーが範囲内で見つかったときだけ読む。範囲内のオーナーの
// 店舗は同じ代理店に属する（stores.owner_id → owners.agency_id・Requirement 2.4）ので、店舗側で範囲を重ねない。

export interface OwnerDetailDeps {
  auth: AuthDeps;
  // findOwner（@fwlm/db）を部分適用した取得。agencyId が null なら全代理店（運営だけが渡す）。
  findOwner: (input: { ownerId: string; agencyId: string | null }) => Promise<OwnerListItem | null>;
  // listStoresWithStatus（@fwlm/db）を ownerId で部分適用した取得。
  listStores: (ownerId: string) => Promise<StoreListItem[]>;
}

export interface OwnerDetailRequest {
  authorization: string | undefined;
  id: string;
}

// UUID 形式でない id は DB を叩かず 404 扱い（存在の探り当てを許さない・store-suspension と同じ規律）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_FOUND_MESSAGE = 'オーナーが見つかりません';

export async function handleOwnerDetail(
  deps: OwnerDetailDeps,
  req: OwnerDetailRequest,
): Promise<Response> {
  const auth = await authenticate(deps.auth, req.authorization);
  if (auth.kind === 'unauthenticated') {
    return jsonError(401, 'unauthenticated', 'ログインが必要です');
  }
  if (auth.kind === 'unregistered' || auth.kind === 'disabled') {
    return jsonError(403, 'forbidden', 'アクセス権がありません');
  }

  if (!UUID_RE.test(req.id)) {
    return jsonError(404, 'not_found', NOT_FOUND_MESSAGE);
  }

  const scope = resolveAgencyScope(auth.user, undefined);
  if (!scope.ok) {
    return jsonError(403, 'forbidden', 'アクセス権がありません');
  }
  const agencyId = scope.scope.kind === 'all' ? null : scope.scope.agencyId;

  const owner = await deps.findOwner({ ownerId: req.id, agencyId });
  if (owner === null) {
    return jsonError(404, 'not_found', NOT_FOUND_MESSAGE);
  }
  // 1 件の取得で正規化された id（小文字）を使う
  const stores = await deps.listStores(owner.id);

  return new Response(
    JSON.stringify({ owner: toOwnerListItemJson(owner), stores: stores.map(toStoreListItemJson) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}
