import type { Queryable } from './pool.js';
import type { DashboardRole } from './types.js';

// RBAC 判定に必要な認証主体の身元（auth_subject = Identity Platform UID から解決）。
export interface DashboardUserIdentity {
  id: string;
  role: DashboardRole;
  operatorId: string;
  agencyId: string | null;
}

/** Identity Platform の subject から dashboard_user を引く（未登録は null）。 */
export async function findByAuthSubject(
  db: Queryable,
  authSubject: string,
): Promise<DashboardUserIdentity | null> {
  const res = await db.query<{
    id: string;
    role: DashboardRole;
    operator_id: string;
    agency_id: string | null;
  }>(
    'SELECT id, role, operator_id, agency_id FROM dashboard_users WHERE auth_subject = $1',
    [authSubject],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    operatorId: row.operator_id,
    agencyId: row.agency_id,
  };
}
