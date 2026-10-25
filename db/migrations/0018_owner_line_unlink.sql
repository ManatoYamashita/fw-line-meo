-- 0018_owner_line_unlink.sql
-- オーナーの LINE 紐づけの解除と店舗の引継ぎ（owner-line-unlink・Issue #487）: owners に連携状態を
-- 表す 3 列と不変条件の CHECK を足し、解除・引継ぎの監査 action 3 値を ck_audit_logs_action へ足す。
--
-- owners の変更:
--   line_user_id              … NOT NULL を外す（UNIQUE は残す。PostgreSQL の UNIQUE は NULL を重複と
--                               みなさないので、解除済みのオーナーは何人いてもよく、連携中の 2 人が同じ
--                               ID を持つことは従来どおり拒否される）
--   line_unlinked_at          … 解除の時刻。NULL = 連携中、値あり = 解除済み
--   menu_pending_line_user_id … 解除した元の LINE ユーザー ID のうち、完了後メニューをまだ外せていない
--                               ものだけを一時的に残す。外せたら NULL へ戻す（個人に紐づく識別子を
--                               必要以上に保持しない）
--   taken_over_by_owner_id    … 解除済みのオーナーの店舗を引き継いだオーナー（同じ表を参照する）
-- 3 列とも既定値を持たない。既存の全オーナーは連携中（line_user_id あり・3 列とも NULL）から始まる。
--
-- 状態と不変条件:
--   連携中                 … line_user_id あり・line_unlinked_at NULL・menu_pending_line_user_id NULL
--   解除済み・メニュー未解除 … line_user_id NULL・line_unlinked_at あり・menu_pending_line_user_id あり
--   解除済み               … line_user_id NULL・line_unlinked_at あり・menu_pending_line_user_id NULL
--   引継ぎ済み             … 解除済みに加えて taken_over_by_owner_id が引き継いだオーナーを指す
--   ck_owner_line_link    … 解除時刻が無いこと ⇔ LINE ユーザー ID があること
--   ck_owner_menu_pending … メニュー未解除の印を持てるのは解除済みのオーナーだけ
--   ck_owner_taken_over   … 引継ぎ先を持てるのは解除済みのオーナーだけで、自分自身を指さない
-- 解除済みから連携中へは戻らない（取り消しは引継ぎで表す）。引継ぎ先は ON DELETE RESTRICT とし、
-- 参照されているオーナーの行を消せないようにする（owners の他の参照と同じ流儀）。
--
-- 追加する監査 action:
--   owner_line_unlinked      … 運営・代理店がオーナーの紐づけを解除した（対象: owner）
--   owner_stores_taken_over  … 新しいオーナーが解除済みオーナーの店舗を引き継いだ（対象: 旧 owner）
--   store_taken_over         … 引き継いだ店舗 1 つずつ（対象: store）
-- **DROP に IF EXISTS を付けない**（0009・0012・0016 と同じ流儀）。制約の名前が想定と違えば旧 CHECK が
-- 残り、新しい 3 値だけが拒否される。黙って残すより、ここで失敗させて止める。DROP と ADD は同じ
-- ALTER TABLE の中で行うので、CHECK の無い状態は外から観測できない。
-- 値の集合の正典は TypeScript の AUDIT_LOG_ACTIONS（ts/packages/db/src/audit-logs.ts）であり、
-- ts/packages/db/test/audit-logs.db.test.ts が本 CHECK と集合・件数（28）の一致を照合する。
-- 列名は不在検査 (A1) の denylist（delivery_enabled・opted_out など）と衝突しない。
--
-- 旧コードと互換である: 列の追加・NOT NULL の緩和・値集合の拡大だけで、旧コードは line_user_id が
-- NULL の行を作らない。**本番へは、実装 PR のマージより先に当てること**（マージが自動デプロイを
-- 起動するため）。
--
-- 事前確認（本番・表の所有者で実行する）:
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'audit_logs'::regclass AND contype = 'c';
--   → ck_audit_logs_action の 1 行だけであること。
--   SELECT count(*) FROM owners WHERE line_user_id IS NULL;
--   → 0 であること（NOT NULL の下では必ず 0。ck_owner_line_link の追加は既存の全行を検査する）。
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'owners'::regclass
--      AND conname IN ('ck_owner_line_link', 'ck_owner_menu_pending', 'ck_owner_taken_over');
--   → 0 行であること。
-- 適用の確認（本番）:
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'owners'
--      AND column_name IN ('line_user_id', 'line_unlinked_at', 'menu_pending_line_user_id',
--                          'taken_over_by_owner_id');
--   → 4 行・すべて is_nullable = YES であること。
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'owners'::regclass AND contype = 'c';
--   → ck_owner_line_link・ck_owner_menu_pending・ck_owner_taken_over の 3 行があること。
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'ck_audit_logs_action';
--   → 定義に owner_line_unlinked・owner_stores_taken_over・store_taken_over が入っていること。
-- 適用の直後に、2026-10-24 の手作業の切り離し行（line_user_id LIKE 'detached-%'）を解除済みへ移す
-- 一回限りの手順がある（design.md の Migration Strategy・docs/testing/e2e.md）。本 migration は
-- データを書き換えない。
--
-- ロールバック: NOT NULL を戻す逆操作は解除済みのオーナーが 1 人でもいると失敗し、旧 25 値の CHECK へ
-- 戻す逆操作は解除・引継ぎの監査行が 1 行でもあると失敗する。コードを戻しても本 migration は
-- 残してよい（旧コードは line_user_id が NULL のオーナーを引けないだけで動き続ける）。
--
-- 新テーブルは無い。owners の書込責任は変わらず TypeScript（db/write-boundary.md）。
-- ============================================================
BEGIN;

ALTER TABLE owners
    ALTER COLUMN line_user_id DROP NOT NULL,
    ADD COLUMN line_unlinked_at timestamptz NULL,
    ADD COLUMN menu_pending_line_user_id text NULL,
    ADD COLUMN taken_over_by_owner_id uuid NULL REFERENCES owners(id) ON DELETE RESTRICT,
    ADD CONSTRAINT ck_owner_line_link
        CHECK ((line_unlinked_at IS NULL) = (line_user_id IS NOT NULL)),
    ADD CONSTRAINT ck_owner_menu_pending
        CHECK (menu_pending_line_user_id IS NULL OR line_unlinked_at IS NOT NULL),
    ADD CONSTRAINT ck_owner_taken_over
        CHECK (taken_over_by_owner_id IS NULL
               OR (line_unlinked_at IS NOT NULL AND taken_over_by_owner_id <> id));

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
      -- structured survey の店舗設定（Issue #437・0016）
      'survey_target_added',
      'survey_target_renamed',
      'survey_target_updated',
      'survey_target_disabled',
      'survey_target_enabled',
      'survey_targets_reordered',
      'survey_category_visibility_updated',
      -- owner-line-unlink（Issue #487・0018）
      'owner_line_unlinked',
      'owner_stores_taken_over',
      'store_taken_over'
    ));

COMMIT;
