-- 0016_survey_settings_audit_actions.sql
-- structured survey の店舗設定（Issue #437・#441 の PR2）: 店舗オーナーが LIFF の設定画面から自店の
-- アンケート設定（料理名・ドリンク名・予約・来店の表示）を変えた操作を、既存の audit_logs へ残す。
-- この migration は ck_audit_logs_action へ 7 値を足すだけで、表・列は足さない。
--
-- 追加する action（target_type は既存の store、target_id は店舗 ID、actor は owner / owners.id）:
--   survey_target_added                 … 料理名・ドリンク名を新しく登録した
--   survey_target_renamed               … 名前を変えた（変更前後の名前は記録しない）
--   survey_target_updated               … 名前と表示を 1 つの操作で同時に変えた
--   survey_target_disabled              … 非表示にした（行は消さない・active = false）
--   survey_target_enabled               … 非表示の行を再表示した（同名の再登録で再表示した場合も含む）
--   survey_targets_reordered            … 並び順を変えた
--   survey_category_visibility_updated  … カテゴリ（予約・来店など）の表示 / 非表示を変えた
-- **料理名・ドリンク名は監査記録へ写さない。** audit_logs に payload の列は無く、変化の種類を
-- action の名前に持たせる（0009 と同じ流儀）。どの Target かは store_survey_targets が持つ。
--
-- **DROP に IF EXISTS を付けない**（0009・0012 と同じ流儀）。制約の名前が想定と違えば旧 CHECK が残り、
-- 新しい 7 値だけが拒否される。黙って残すより、ここで失敗させて止める。DROP と ADD は同じ ALTER TABLE の
-- 中で行うので、CHECK の無い状態は外から観測できない。
-- 値の集合の正典は TypeScript の AUDIT_LOG_ACTIONS（ts/packages/db/src/audit-logs.ts）であり、
-- ts/packages/db/test/audit-logs.db.test.ts が本 CHECK と集合・件数（25）の一致を照合する。
--
-- 旧コードと互換である: 値集合の拡大だけなので、旧イメージの監査の書込はそのまま通る。
-- **本番へは、新しいコードより先に当てること。** 逆順にすると、設定画面の監査の書込が CHECK 違反で
-- 失敗する（設定の変更そのものは確定し、監査だけが欠けて警告が残る・db/write-boundary.md）。
--
-- 事前確認（本番・表の所有者で実行する）:
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'audit_logs'::regclass AND contype = 'c';
--   → ck_audit_logs_action の 1 行だけであること。
-- 適用の確認（本番）:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_audit_logs_action';
--   → 定義に survey_target_added など 7 値が入っていること。
--
-- ロールバック: 旧 18 値の CHECK へ戻す逆操作は、設定変更の監査行が 1 行でもあると失敗する。
-- コードを戻しても本 migration は残してよい（値集合は上位集合）。
--
-- 新テーブルは無い。書込責任は変わらず TypeScript（db/write-boundary.md）。
-- ============================================================
BEGIN;

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
      -- store-suspension（Issue #252・0012）
      'store_suspended',
      'store_resumed',
      -- structured survey の店舗設定（Issue #437）
      'survey_target_added',
      'survey_target_renamed',
      'survey_target_updated',
      'survey_target_disabled',
      'survey_target_enabled',
      'survey_targets_reordered',
      'survey_category_visibility_updated'
    ));

COMMIT;
