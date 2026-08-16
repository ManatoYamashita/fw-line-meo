import type { DashboardUserIdentity, DashboardUserResolution } from '@fwlm/db';

// 認証（Identity Platform ID トークン検証）と RBAC 判定。
// firebase-admin は注入可能な TokenVerifier に隔離し、テストではモックする。
// 認証は「Bearer 検証 → 利用者解決」に「無効化拒否」と「初回ログイン時リンク」を加えて拡張する。
// Firebase=認証、Postgres=認可の分離。認証情報は一切保存しない（Identity Platform 委譲）。

// 検証済み ID トークンのクレーム。リンク可否判定に必要な検証済み属性を含む。
export interface VerifiedToken {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  signInProvider: string | null;
}

export interface TokenVerifier {
  verifyIdToken(token: string): Promise<VerifiedToken>;
}

export interface AuthDeps {
  verifier: TokenVerifier;
  // dashboard_user の解決（未登録は null）。無効化状態を含む DashboardUserResolution を返す。
  findUser: (uid: string) => Promise<DashboardUserResolution | null>;
  // 初回ログイン時リンク（事前登録された保留行へ uid を原子的に埋める・案B）。一致無しは null。
  linkByEmail: (normalizedEmail: string, uid: string) => Promise<DashboardUserIdentity | null>;
}

export type AuthOutcome =
  | { kind: 'unauthenticated' } // トークン無し/不正 → 401
  | { kind: 'unregistered' } // 有効トークンだが dashboard_user 未登録 → 403
  | { kind: 'disabled' } // 登録済みだが無効化済み → 403
  | { kind: 'authenticated'; user: DashboardUserIdentity };

/**
 * Authorization ヘッダから ID トークンを検証し、登録済み・有効なユーザーを解決する。
 * - 既存 UID の行あり: 無効化済みなら disabled、有効なら authenticated。
 * - 行なし: 検証済み Google メール（google.com かつ email_verified）のときのみ初回リンクを試行。
 *   リンク成功で authenticated、それ以外は unregistered。
 */
export async function authenticate(
  deps: AuthDeps,
  authorization: string | undefined,
): Promise<AuthOutcome> {
  const token = extractBearer(authorization);
  if (token === null) return { kind: 'unauthenticated' };

  let verified: VerifiedToken;
  try {
    verified = await deps.verifier.verifyIdToken(token);
  } catch {
    return { kind: 'unauthenticated' };
  }

  const resolution = await deps.findUser(verified.uid);
  if (resolution !== null) {
    if (resolution.disabled) return { kind: 'disabled' };
    return { kind: 'authenticated', user: toIdentity(resolution) };
  }

  // 未登録 UID: 検証済み Google メールのときのみ初回ログイン時リンクを試行する（乗っ取り防止）。
  const normalizedEmail = eligibleLinkEmail(verified);
  if (normalizedEmail !== null) {
    const linked = await deps.linkByEmail(normalizedEmail, verified.uid);
    if (linked !== null) return { kind: 'authenticated', user: linked };
  }
  return { kind: 'unregistered' };
}

/** RBAC: operator は全店許可、agency は担当代理店の店舗のみ許可。 */
export function canAccessStore(user: DashboardUserIdentity, storeAgencyId: string): boolean {
  if (user.role === 'operator') return true;
  return user.role === 'agency' && user.agencyId !== null && user.agencyId === storeAgencyId;
}

// リンク適格性: google.com かつ email_verified かつ email 有り のときのみ、正規化 email を返す。
// それ以外（別プロバイダ・未検証・email 欠落）は null（リンク試行しない）。
function eligibleLinkEmail(verified: VerifiedToken): string | null {
  if (verified.signInProvider !== 'google.com') return null;
  if (verified.emailVerified !== true) return null;
  if (verified.email === null) return null;
  const normalized = verified.email.trim().toLowerCase();
  return normalized === '' ? null : normalized;
}

// DashboardUserResolution から身元のみ（disabled を落とす）を抽出する。
function toIdentity(resolution: DashboardUserResolution): DashboardUserIdentity {
  return {
    id: resolution.id,
    role: resolution.role,
    operatorId: resolution.operatorId,
    agencyId: resolution.agencyId,
  };
}

function extractBearer(authorization: string | undefined): string | null {
  if (authorization === undefined) return null;
  const match = /^Bearer (.+)$/.exec(authorization);
  return match?.[1] ?? null;
}
