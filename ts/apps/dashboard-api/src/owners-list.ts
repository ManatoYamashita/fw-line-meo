import type { OnboardingStatus, OwnerInviteCodeRecord, OwnerLineLink, OwnerListItem } from '@fwlm/db';
import { authenticate, type AuthDeps } from './auth.js';
import { resolveAgencyScope } from './scope.js';
import { jsonError } from './http.js';

// GET /owners の中核ロジック（依存注入でテスト可能・ルート配線は app 側の責務）。
// 店舗登録の対象オーナー選択（agency-dashboard Req 3.1, 3.2）と、オーナー一覧の連携状態の表示
// （owner-line-unlink Req 2.1, 2.5, 2.6）が使う。認証 → スコープ解決 → 一覧取得 → 封筒化。
// operator が agencyId 未指定（スコープ all）の場合は全代理店のオーナーを返す（owner-line-unlink で 400 から変更）。
// agency は従来どおり自代理店に束縛され、他代理店の指定は 403。
// スコープ拒否はデータアクセス（listOwners）より前に行う（agency-dashboard Req 2.3）。

export interface OwnersListDeps {
  auth: AuthDeps;
  // listOwners（@fwlm/db）を部分適用した一覧取得。null は全代理店（スコープ all の operator だけが渡す）。
  listOwners: (agencyId: string | null) => Promise<OwnerListItem[]>;
}

export interface OwnersListRequest {
  authorization: string | undefined;
  // クエリ ?agencyId=（operator は任意で、未指定は全代理店。agency が他代理店を指定したら 403）。
  agencyId: string | undefined;
}

// 一覧 1 行の JSON 形。Date は ISO 8601 文字列へ明示的に変換する。
export interface OwnerListItemJson {
  id: string;
  displayName: string | null;
  onboardingStatus: OnboardingStatus;
  createdAt: string; // ISO 8601
  // 登録に用いた招待コード。null = 記録なし（0017 より前の登録）で、推定で埋めない（agency-dashboard Req 8.4, 8.5）。
  inviteCode: OwnerInviteCodeRecord | null;
  // 担当代理店の名前（運営が全代理店を見るときに区別する・owner-line-unlink Req 2.1）。
  agencyName: string;
  // LINE との連携状態（Req 2.1, 2.5）。LINE ユーザー ID そのものは応答に含めない。
  lineLink: OwnerLineLink;
  // 解除した元の LINE アカウントから完了後メニューをまだ外せていない（Req 3.2, 3.3）。
  menuUnlinkPending: boolean;
  // 確定済み店舗の名前（作成順）。
  storeNames: string[];
  // 店舗を引き継いだオーナー（Req 2.6）。引継ぎが無ければ null。
  takenOverBy: { ownerId: string; displayName: string | null } | null;
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

  // 3. 一覧取得。スコープ all（operator の未指定）は全代理店（null）、single はその代理店。
  //    0 件は 200 + 空配列（UI が agency-dashboard 3.3 の「招待コード先行」案内を出す）。
  const owners = await deps.listOwners(scope.scope.kind === 'all' ? null : scope.scope.agencyId);

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
    // DAL の型に項目が増えても応答へ混ざらないよう、返す 3 項目だけを写す。
    inviteCode:
      item.inviteCode === null
        ? null
        : { id: item.inviteCode.id, code: item.inviteCode.code, disabled: item.inviteCode.disabled },
    agencyName: item.agencyName,
    lineLink: item.lineLink,
    menuUnlinkPending: item.menuUnlinkPending,
    storeNames: [...item.storeNames],
    // 引継ぎ先も id と表示名だけを写す（LINE ユーザー ID などを応答へ混ぜない）。
    takenOverBy:
      item.takenOverBy === null
        ? null
        : { ownerId: item.takenOverBy.ownerId, displayName: item.takenOverBy.displayName },
  };
}
