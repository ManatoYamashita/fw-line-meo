import type { DashboardUserIdentity } from '@fwlm/db';

// RBAC スコープ解決: ロールと要求 agencyId から有効スコープを一意に決める。
// UI の導線有無に依存せずサーバー側で判定する（2.3）。agency は常に自代理店に束縛される。

export type AgencyScope =
  | { kind: 'all' } // operator が agencyId 未指定 → 全代理店
  | { kind: 'single'; agencyId: string }; // agency は常に自代理店 / operator は指定時

export type ScopeResult =
  | { ok: true; scope: AgencyScope }
  | { ok: false; status: 403 }; // agency が他代理店を指定した等 → 403

/**
 * ロールと要求 agencyId から有効スコープを解決する。
 * - operator + 未指定 → all（全代理店）。operator + 指定 → single(指定)。
 * - agency → 常に single(自代理店)。他代理店を指定したら 403。
 * agency の agencyId は構造上 non-null だが、防御的に null は 403 として扱う。
 */
export function resolveAgencyScope(
  user: DashboardUserIdentity,
  requestedAgencyId: string | undefined,
): ScopeResult {
  if (user.role === 'operator') {
    if (requestedAgencyId === undefined) return { ok: true, scope: { kind: 'all' } };
    return { ok: true, scope: { kind: 'single', agencyId: requestedAgencyId } };
  }

  // agency ロール: 常に自代理店に束縛する。
  if (user.agencyId === null) return { ok: false, status: 403 }; // 防御（構造上あり得ない）
  if (requestedAgencyId === undefined || requestedAgencyId === user.agencyId) {
    return { ok: true, scope: { kind: 'single', agencyId: user.agencyId } };
  }
  return { ok: false, status: 403 };
}

/** admin API の前置ガード（運営専用エンドポイント）。 */
export function requireOperator(user: DashboardUserIdentity): boolean {
  return user.role === 'operator';
}
