import type { Queryable } from './pool.js';

export type AuditActorType = 'operator' | 'agency' | 'owner';
export type AuditTargetType =
  | 'operator'
  | 'agency'
  | 'owner'
  | 'store'
  | 'invite_code'
  | 'dashboard_user';

/**
 * 監査記録の action の正典。
 *
 * DB の `audit_logs.action` の CHECK（`ck_audit_logs_action`・migration 0009）と同じ集合を持つ。
 * 一致は `test/audit-logs.db.test.ts` が実 DB の制約定義と照合して固定する。action を足すときは、
 * CHECK を作り直す migration とこの配列を同時に変える。片方だけを変えると、型が許す値の INSERT が
 * CHECK 違反で落ちるか、型が許さない値を DB だけが受け付ける状態になる。
 */
export const AUDIT_LOG_ACTIONS = [
  'owner_created',
  'onboarding_completed',
  'store_registered',
  'store_category_updated',
  'rich_menu_linked',
  'rich_menu_link_failed',
  'invite_code_issued',
  'invite_code_disabled',
  'agency_created',
  'dashboard_user_created',
  'dashboard_user_disabled',
  'dashboard_user_enabled',
  // dashboard-user-edit（Issue #259）: 利用者の属性の変更。payload の列は無いので、
  // ロールの変更は向きそのものを名前に持たせる。
  'dashboard_user_promoted_to_operator',
  'dashboard_user_demoted_to_agency',
  'dashboard_user_agency_updated',
  'dashboard_user_display_name_updated',
] as const;

export type AuditLogAction = (typeof AUDIT_LOG_ACTIONS)[number];

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
