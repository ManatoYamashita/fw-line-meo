import type { OnboardingStatus, OwnerListItem } from '@fwlm/db';
import { authenticate, type AuthDeps } from './auth.js';
import { resolveAgencyScope } from './scope.js';
import { jsonError } from './http.js';

// GET /owners の中核ロジック（依存注入でテスト可能・ルート配線は app 側の責務）。
// 店舗登録の対象オーナー選択用（Req 3.1, 3.2）。認証 → スコープ解決 → 一覧取得 → 封筒化。
// stores 一覧と異なり、オーナー選択は「具体的な 1 代理店」が定まっている必要がある:
// operator が agencyId 未指定（スコープ all）の場合は 400 で代理店の指定を促す（design: GET /owners?agencyId=）。
// スコープ拒否はデータアクセス（listOwners）より前に行う（Req 2.3）。

export interface OwnersListDeps {
  auth: AuthDeps;
  // listOwnersByAgency（@fwlm/db）を部分適用した一覧取得（agency_id で絞り込み済み）。
  listOwners: (agencyId: string) => Promise<OwnerListItem[]>;
}

export interface OwnersListRequest {
  authorization: string | undefined;
  // クエリ ?agencyId=（operator は必須。agency が他代理店を指定したら 403）。
  agencyId: string | undefined;
}

// 一覧 1 行の JSON 形。Date は ISO 8601 文字列へ明示的に変換する。
export interface OwnerListItemJson {
  id: string;
  displayName: string | null;
  onboardingStatus: OnboardingStatus;
  createdAt: string; // ISO 8601
}

export async function handleOwnersList(
  deps: OwnersListDeps,
  req: OwnersListRequest,
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

  // 2. スコープ解決。拒否時は listOwners を一切呼ばない（越権要求にデータアクセスさせない）。
  const scope = resolveAgencyScope(auth.user, req.agencyId);
  if (!scope.ok) {
    return jsonError(403, 'forbidden', 'この代理店へのアクセス権がありません');
  }

  // 3. オーナー選択には具体的な 1 代理店が必要（operator の未指定＝all は 400）。
  if (scope.scope.kind === 'all') {
    return jsonError(400, 'validation_failed', 'オーナー選択には代理店の指定が必要です');
  }

  // 4. 一覧取得。0 件は 200 + 空配列（UI が 3.3 の「招待コード先行」案内を出す）。
  const owners = await deps.listOwners(scope.scope.agencyId);

  return new Response(JSON.stringify({ owners: owners.map(toJson) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// OwnerListItem（DAL 型・Date 含む）→ JSON 形（ISO 文字列）への明示的シリアライズ。
function toJson(item: OwnerListItem): OwnerListItemJson {
  return {
    id: item.id,
    displayName: item.displayName,
    onboardingStatus: item.onboardingStatus,
    createdAt: item.createdAt.toISOString(),
  };
}
