import type { Queryable } from './pool.js';

export type AuditActorType = 'operator' | 'agency' | 'owner';
export type AuditTargetType =
  | 'operator'
  | 'agency'
  | 'owner'
  | 'store'
  | 'invite_code'
  | 'dashboard_user';
export type AuditLogAction =
  | 'owner_created'
  | 'onboarding_completed'
  | 'store_registered'
  | 'store_category_updated'
  | 'rich_menu_linked'
  | 'rich_menu_link_failed'
  | 'invite_code_issued'
  | 'invite_code_disabled'
  | 'agency_created'
  | 'dashboard_user_created'
  | 'dashboard_user_disabled'
  | 'dashboard_user_enabled';

export interface AuditLogInput {
  actorType: AuditActorType;
  actorId: string;
  action: AuditLogAction;
  targetType: AuditTargetType;
  targetId: string;
  occurredAt?: Date;
}

export type AuditLogger = (input: AuditLogInput) => Promise<void>;

/** 業務上の書込操作を追記する。UPDATE/DELETE のアクセサは提供しない。 */
export async function createAuditLog(db: Queryable, input: AuditLogInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs
       (actor_type, actor_id, action, target_type, target_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))`,
    [
      input.actorType,
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      input.occurredAt ?? null,
    ],
  );
}
