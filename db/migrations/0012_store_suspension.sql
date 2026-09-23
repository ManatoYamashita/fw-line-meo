-- 0012_store_suspension.sql
-- store-suspension（Issue #252）: 運営・代理店が管理画面から店舗の利用を停止・再開できるようにする。
-- この migration は、その状態を保持する列と、操作を残す監査 action の 2 つだけを足す。
--
-- 1. stores.suspended_at（Requirement 1.7, 4.5）
--    NULL = 利用中、値あり = 停止中（値は停止した時刻）。停止の状態はこの列 1 つで表し、
--    日次取得（Go）と日次配信（TS）は同じ列を読んで対象を決める（片方だけが止まる状態を作らない）。
--    - 既定値を持たせない。既存の全店舗は利用中（NULL）のまま始まり、行を書き換えない。
--    - place_status とは独立で、ck_place_confirmed に触れない。停止しても店舗の身元（Place の確定）・
--      オーナー／代理店との関係・蓄積済みの匿名集計と日次データは変わらない（再開すると元へ戻る）。
--    - 索引は付けない。店舗数が少なく、確定店舗の抽出は全件走査で足りる。
--    - 書込元は dashboard-api の停止・再開の操作だけである（db/write-boundary.md）。列単位の書込権限は
--      infra/sql/grants.sql で別途絞る（line-webhook・survey-web はこの列を書けないようにする）。
--
-- 2. ck_audit_logs_action を 18 値で作り直す（Requirement 7.4）
--    0009 の 16 値に、停止と再開を表す 2 値を足す（target_type は既存の store、target_id は店舗 ID）。
--      store_suspended … 店舗を停止した
--      store_resumed   … 停止中の店舗を再開した
--    **DROP に IF EXISTS を付けない**（0009・0010 と同じ流儀）。制約の名前が想定と違えば旧 CHECK が
--    残り、新旧の CHECK が両方効いて新しい 2 値だけが拒否される。黙って残すより、ここで失敗させて止める。
--    DROP と ADD は同じ ALTER TABLE の中で行うので、CHECK の無い状態は外から観測できない。
--    値の集合の正典は TypeScript の AUDIT_LOG_ACTIONS（ts/packages/db/src/audit-logs.ts）であり、
--    ts/packages/db/test/audit-logs.db.test.ts が本 CHECK と集合・件数（18）の一致を照合する。
--
-- 旧コードと互換である: 列の追加（既定値なし・NULL 可）と値集合の拡大だけなので、旧イメージの
-- INSERT・UPDATE・監査の書込はそのまま通る。**本番へは、新しいコードより先に当てること。**
-- 逆順にすると、suspended_at IS NULL を含むイメージが先に出て、日次取得・配信・アンケート・LINE 応答・
-- 詳細画面が column does not exist で落ちる。
--
-- 事前確認（本番・表の所有者で実行する。ALTER TABLE は所有者でないと実行できない）:
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'audit_logs'::regclass AND contype = 'c';
--   → ck_audit_logs_action の 1 行だけであること。
-- 適用の確認（本番）:
--   SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
--    WHERE table_name = 'stores' AND column_name = 'suspended_at';
--   → timestamp with time zone・YES・NULL の 1 行。
--   SELECT count(*) FROM stores WHERE suspended_at IS NOT NULL;
--   → 0（適用の直後は全店舗が利用中）。
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'audit_logs'::regclass AND contype = 'c';
--   → ck_audit_logs_action の 1 行だけで、定義に store_suspended・store_resumed が入っていること。
--
-- ロールバック: 旧 16 値の CHECK へ戻す逆操作は、停止・再開の監査行が 1 行でもあると失敗する。
-- コードを戻しても本 migration は残してよい（旧コードは suspended_at を読まず、値集合は上位集合）。
--
-- 新テーブルは無い。書込責任は変わらず TypeScript（db/write-boundary.md）。
-- ============================================================
BEGIN;

ALTER TABLE stores
    ADD COLUMN suspended_at timestamptz NULL;

COMMENT ON COLUMN stores.suspended_at IS
    '店舗の利用停止の時刻。NULL = 利用中、値あり = 停止中。書込は dashboard-api の停止・再開の操作だけ（Issue #252）。';

ALTER TABLE audit_logs
    DROP CONSTRAINT ck_audit_logs_action,
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
      -- dashboard-user-edit（Issue #259・0009）
      'dashboard_user_promoted_to_operator',
      'dashboard_user_demoted_to_agency',
      'dashboard_user_agency_updated',
      'dashboard_user_display_name_updated',
      -- store-suspension（Issue #252）
      'store_suspended',
      'store_resumed'
    ));

COMMIT;
