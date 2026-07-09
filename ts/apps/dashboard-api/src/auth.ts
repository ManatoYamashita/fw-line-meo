import type { DashboardUserIdentity } from '@fwlm/db';

// 認証（Identity Platform ID トークン検証）と RBAC 判定。
// firebase-admin は注入可能な TokenVerifier に隔離し、テストではモックする。

export interface TokenVerifier {
  verifyIdToken(token: string): Promise<{ uid: string }>;
}

export interface AuthDeps {
  verifier: TokenVerifier;
  findUser: (uid: string) => Promise<DashboardUserIdentity | null>;
}

export type AuthOutcome =
  | { kind: 'unauthenticated' } // トークン無し/不正 → 401
  | { kind: 'unregistered' } // 有効トークンだが dashboard_user 未登録 → 403
  | { kind: 'authenticated'; user: DashboardUserIdentity };

/** Authorization ヘッダから ID トークンを検証し、登録済みユーザーを解決する。 */
export async function authenticate(
  deps: AuthDeps,
  authorization: string | undefined,
): Promise<AuthOutcome> {
  const token = extractBearer(authorization);
  if (token === null) return { kind: 'unauthenticated' };

  let uid: string;
  try {
    uid = (await deps.verifier.verifyIdToken(token)).uid;
  } catch {
    return { kind: 'unauthenticated' };
  }

  const user = await deps.findUser(uid);
  if (user === null) return { kind: 'unregistered' };
  return { kind: 'authenticated', user };
}

/** RBAC: operator は全店許可、agency は担当代理店の店舗のみ許可。 */
export function canAccessStore(user: DashboardUserIdentity, storeAgencyId: string): boolean {
  if (user.role === 'operator') return true;
  return user.role === 'agency' && user.agencyId !== null && user.agencyId === storeAgencyId;
}

function extractBearer(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer (.+)$/.exec(authorization);
  return match?.[1] ?? null;
}
