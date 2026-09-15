-- 0009_audit_logs_dashboard_user_update.sql
-- dashboard-user-edit（Issue #259）: 利用者の属性の変更を監査記録へ残すため、audit_logs.action の
-- CHECK を明示の名前で作り直し、4 値を足す（Requirement 5.2）。
--
-- 追加する action（audit_logs に payload の列は無いので、変化の向きを名前に持たせる）:
--   dashboard_user_promoted_to_operator  … 代理店ロール → 運営ロール
--   dashboard_user_demoted_to_agency     … 運営ロール → 代理店ロール（所属代理店の設定を含めて 1 件）
--   dashboard_user_agency_updated        … 代理店ロールのままの所属代理店の変更
--   dashboard_user_display_name_updated  … 表示名の変更（値そのものは記録しない）
--
-- 1. 制約に明示の名前を付ける
--    0007 は action を無名の列 CHECK として宣言しており、実名は PostgreSQL が付けた
--    audit_logs_action_check である（隔離 DB で実測・2026-09-13）。以後の migration が名前を
--    推測しなくて済むよう、ck_audit_logs_action として作り直す。
--    **DROP に IF EXISTS を付けない。** 旧制約の名前が違えば旧 CHECK が残り、新旧の CHECK が
--    両方効いて新しい 4 値だけが拒否される。黙って残すより、ここで失敗させて止める。
--    DROP と ADD は同じ ALTER TABLE の中で行うので、CHECK の無い状態は外から観測できない。
--
-- 2. 値の集合の正典は TypeScript の AUDIT_LOG_ACTIONS（ts/packages/db/src/audit-logs.ts）
--    本 CHECK は同じ集合でなければならない。ts/packages/db/test/audit-logs.db.test.ts が
--    pg_get_constraintdef から値を取り出して照合する（ここから値を 1 つ落とすと赤くなる）。
--    制約の名前と旧名の不在、新しい 4 値の受理は db/test/assertions/80_audit_logs.sql の 8.1 が見る。
--
-- **本番へは、新しいコードより先に当てること。** 既存 12 値の上位集合なので、旧コードは影響を
-- 受けない（マージより前ならいつ当ててもよい）。逆順にすると、利用者の更新は確定するのに監査の
-- INSERT が CHECK 違反（23514）で落ちる。しかも再試行した時点では差分が無いので監査を書かず、
-- その変更の監査は二度と戻らない（重複ではなく欠落の方向に壊れる）。
--
-- 事前確認（本番・表の所有者で実行する。ALTER TABLE は所有者でないと実行できない）:
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'audit_logs'::regclass AND contype = 'c';
--   → audit_logs_action_check の 1 行だけであること。
-- 適用の確認（本番）:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'audit_logs'::regclass AND contype = 'c';
--   → ck_audit_logs_action の 1 行だけで、定義に上の 4 値が入っていること。
--
-- 並行する #252（店舗の利用停止）も action を足す予定で、同じ CHECK を作り直す。**後から着地する側が
-- migration の番号を振り直し、ck_audit_logs_action を両者の値の和集合で作り直す。** 片方の値を
-- 落としても migration 番号のガード（scripts/check-db-ordinals.sh）は検出しないが、上の集合一致の
-- テストが赤で知らせる。
--
-- ロールバック: 旧 12 値の CHECK へ戻す逆操作は、新しい action の行が 1 行でもあると失敗する。
-- コードを戻しても本 migration は残してよい（上位集合なので旧コードは影響を受けない）。
--
-- 表・列・索引・grants・ERD・write-boundary は変わらない（audit_logs の書込責任は TypeScript のまま・
-- grants.sql の再適用は要らない）。
-- ============================================================
BEGIN;

ALTER TABLE audit_logs
    DROP CONSTRAINT audit_logs_action_check,
    ADD CONSTRAINT ck_audit_logs_action CHECK (action IN (
      -- 0007 の 12 値（同じ並び）
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
      -- dashboard-user-edit（Issue #259）
      'dashboard_user_promoted_to_operator',
      'dashboard_user_demoted_to_agency',
      'dashboard_user_agency_updated',
      'dashboard_user_display_name_updated'
    ));

COMMIT;
