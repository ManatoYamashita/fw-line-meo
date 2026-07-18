import type { PlaceStatus, StoreListItem } from '@fwlm/db';
import { authenticate, type AuthDeps } from './auth.js';
import { resolveAgencyScope } from './scope.js';
import { jsonError } from './http.js';

// GET /stores の中核ロジック（依存注入でテスト可能・ルート配線は app 側の責務）。
// 認証 → スコープ解決 → 一覧取得 → 封筒化の順に評価する。
// スコープ拒否はデータアクセス（listStores）より前に行う（Req 2.3: 導線の有無に依らずサーバー側で遮断）。

export interface StoresListDeps {
  auth: AuthDeps;
  // listStoresWithStatus（@fwlm/db）を部分適用した一覧取得。
  // スコープ all はフィルタなし（{}）、single は { agencyId } で呼ぶ。
  listStores: (filter: { agencyId?: string }) => Promise<StoreListItem[]>;
}

export interface StoresListRequest {
  authorization: string | undefined;
  // クエリ ?agencyId=（operator のみ有効。agency が他代理店を指定したら 403）。
  agencyId: string | undefined;
}

// 一覧 1 行の JSON 形。Date はそのまま JSON 化せず、ISO 8601 文字列へ明示的に変換する。
export interface StoreListItemJson {
  id: string;
  name: string;
  placeStatus: PlaceStatus;
  competitorConfigured: boolean;
  ownerId: string;
  ownerDisplayName: string | null;
  agencyId: string;
  agencyName: string;
  createdAt: string; // ISO 8601
}

export async function handleStoresList(
  deps: StoresListDeps,
  req: StoresListRequest,
): Promise<Response> {
  // 1. 認証（Bearer 検証 → 利用者解決）。design のコード体系（小文字）に従う。
  const auth = await authenticate(deps.auth, req.authorization);
  if (auth.kind === 'unauthenticated') {
    return jsonError(401, 'unauthenticated', 'ログインが必要です');
  }
  if (auth.kind === 'unregistered' || auth.kind === 'disabled') {
    // 未登録・無効化はいずれもアクセス権なし（403）。存在有無を漏らさない同一封筒。
    return jsonError(403, 'forbidden', 'アクセス権がありません');
  }

  // 2. スコープ解決（operator=全件または指定代理店 / agency=常に自代理店）。
  //    拒否時は listStores を一切呼ばない（越権要求にデータアクセスさせない）。
  const scope = resolveAgencyScope(auth.user, req.agencyId);
  if (!scope.ok) {
    return jsonError(403, 'forbidden', 'この代理店へのアクセス権がありません');
  }

  // 3. 一覧取得（all → 無フィルタ / single → agencyId フィルタ）。0 件は 200 + 空配列。
  const filter = scope.scope.kind === 'all' ? {} : { agencyId: scope.scope.agencyId };
  const stores = await deps.listStores(filter);

  return new Response(JSON.stringify({ stores: stores.map(toJson) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// StoreListItem（DAL 型・Date 含む）→ JSON 形（ISO 文字列）への明示的シリアライズ。
function toJson(item: StoreListItem): StoreListItemJson {
  return {
    id: item.id,
    name: item.name,
    placeStatus: item.placeStatus,
    competitorConfigured: item.competitorConfigured,
    ownerId: item.ownerId,
    ownerDisplayName: item.ownerDisplayName,
    agencyId: item.agencyId,
    agencyName: item.agencyName,
    createdAt: item.createdAt.toISOString(),
  };
}
