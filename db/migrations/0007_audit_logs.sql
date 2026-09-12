-- 0007_audit_logs.sql
-- Issue #231: 業務上の書込操作を追記型の監査記録として保持する。
-- 正本は本表とし、Cloud Logging は補助的な運用ログとして扱う。

BEGIN;

CREATE TYPE audit_actor_type AS ENUM ('operator', 'agency', 'owner');
CREATE TYPE audit_target_type AS ENUM (
  'operator',
  'agency',
  'owner',
  'store',
  'invite_code',
  'dashboard_user'
);

CREATE TABLE audit_logs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_type  audit_actor_type NOT NULL,
    -- operator / agency は dashboard_users.id、owner は owners.id を格納する。
    -- customer は actor_type に存在しないため、顧客を監査主体として登録できない。
    actor_id    uuid NOT NULL,
    action      text NOT NULL CHECK (action IN (
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
      'dashboard_user_enabled'
    )),
    target_type audit_target_type NOT NULL,
    target_id   uuid NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

-- 監査は追記型。検索は主体・対象・発生時刻を主経路とする。
CREATE INDEX ix_audit_logs_actor_occurred_at
  ON audit_logs (actor_type, actor_id, occurred_at DESC);
CREATE INDEX ix_audit_logs_target_occurred_at
  ON audit_logs (target_type, target_id, occurred_at DESC);

COMMIT;
