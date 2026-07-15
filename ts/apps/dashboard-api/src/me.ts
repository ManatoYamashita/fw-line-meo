import type { DashboardRole } from '@fwlm/db';
import { authenticate, type AuthDeps } from './auth.js';
import { jsonError } from './http.js';

// GET /me の中核ロジック（依存注入でテスト可能・ルート配線は app 側の責務）。
// 認証 → 表示名/代理店名の解決 → 自己紹介応答の順に評価する。
// DashboardUserIdentity は displayName を持たないため、狭い注入関数で個別に解決する。

export interface MeDeps {
  auth: AuthDeps;
  // 代理店名の解決（agency ロールのみ使用）。不在は null。
  findAgencyName: (agencyId: string) => Promise<string | null>;
  // ダッシュボード利用者の表示名解決（dashboard_users.display_name）。未設定は null。
  findDisplayName: (userId: string) => Promise<string | null>;
}

export interface MeRequest {
  authorization: string | undefined;
}

// GET /me の 200 応答形（design の API 契約表: { user: { role, agencyId, agencyName, displayName } }）。
export interface MeUser {
  role: DashboardRole;
  agencyId: string | null;
  agencyName: string | null;
  displayName: string | null;
}

export async function handleMe(deps: MeDeps, req: MeRequest): Promise<Response> {
  // 1. 認証（Bearer 検証 → 利用者解決）。design のコード体系（小文字）に従う。
  const auth = await authenticate(deps.auth, req.authorization);
  if (auth.kind === 'unauthenticated') {
    return jsonError(401, 'unauthenticated', 'ログインが必要です');
  }
  if (auth.kind === 'unregistered' || auth.kind === 'disabled') {
    // 未登録・無効化はいずれもアクセス権なし（403）。存在有無を漏らさない同一封筒。
    return jsonError(403, 'forbidden', 'アクセス権がありません');
  }

  // 2. 表示名と（agency のみ）代理店名を並行解決。operator は代理店を持たないため解決しない。
  const { user } = auth;
  const [displayName, agencyName] = await Promise.all([
    deps.findDisplayName(user.id),
    user.agencyId === null ? Promise.resolve(null) : deps.findAgencyName(user.agencyId),
  ]);

  const me: MeUser = {
    role: user.role,
    agencyId: user.agencyId,
    agencyName,
    displayName,
  };
  return new Response(JSON.stringify({ user: me }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
