-- infra/sql/grants.sql
-- gcp-infra-foundation: IAM DB ユーザーへの GRANT（db/write-boundary.md と整合）
--
-- 適用: Auth Proxy 経由で fwlm DB に接続し、db/migrations 適用後に実行（runbook 手順）。
--   psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f infra/sql/grants.sql
--
-- IAM DB ユーザー名は Cloud SQL が SA email から .gserviceaccount.com を除いた形
-- （本番実測: sa-line-webhook@gen-fw-line-meo.iam）。**`project` は GCP プロジェクト ID であって
-- DB 名ではない。** 既定を 'fwlm'（＝DB 名／インスタンス名の接頭辞）にしていたため、runbook
-- どおりに `-v project=` 無しで実行すると 1 文目で
-- `role "sa-line-webhook@fwlm.iam" does not exist` になり、BEGIN 済みの GRANT が全て
-- ロールバックしていた（2026-08-24・PR #144 の 0006 本番適用で実測）。README §3 の
-- 「IAM DB ユーザー（sa-*@gen-fw-line-meo.iam）」という記述とも食い違っていた。
-- 別プロジェクトへ流すときだけ -v で上書きする:
--   psql ... -v ON_ERROR_STOP=1 -v project=<gcp-project-id> -f infra/sql/grants.sql
-- SA 命名は各モジュール内で決定的に導出/直書き（run-services: sa-${each.key}・batch-job/delivery-job: 個別ハードコード）。
--
-- 書込境界（db/write-boundary.md・"整合する GRANT のみ"）:
--   TS 層（line_webhook / survey_web / dashboard_api）→ DML on
--     operators, agencies, dashboard_users, owners, stores,
--     survey_rating_tallies, survey_aspect_tallies, survey_concern_tallies, survey_material_tallies,
--     survey_review_link_tallies（review-acquisition 0014・投稿導線の押下件数・Issue #401）,
--     oauth_tokens,
--     agency_invite_codes, onboarding_sessions, line_webhook_events,
--     gbp_locations, gbp_sessions（gbp-post-review-reply 0013・GBP 連携の身元と会話セッション）
--     （ただし stores.suspended_at を書けるのは dashboard_api だけ。line_webhook / survey_web の
--     stores の INSERT・UPDATE は suspended_at を除く列単位の付与・store-suspension）
--   Go 層（daily_batch）→ DML on competitors, rating_snapshots, daily_summaries
--     （daily_summaries は competitive-daily-summary 0004・INSERT/UPDATE は同日再実行の
--     ON CONFLICT DO UPDATE、DELETE は 30日超パージ。go/internal/repo/summaries.go 参照）
--   TS 配信ジョブ（summary_delivery・competitive-daily-summary 0004）→ DML on
--     summary_deliveries のみ（INSERT で retry_key 付き予約、UPDATE で結果記録。
--     DELETE は行わない = パージ対象外。ts/apps/delivery-job/src/deliveries.ts 参照）
--   TS 詳細閲覧（store_detail・competitive-daily-summary・task 6.2 で SA を Terraform 実体化）→
--     読取専用（DML なし）。ID トークン検証済みの自店データのみを API 層で絞り込む
--     （閲覧専用画面・design.md「書込操作を一切持たない」）
--   TS 客向けアンケート Web（survey_web）だけ → 列を絞った INSERT と UPDATE (count) on
--     survey_structured_material_tallies（structured survey 0015・素材の厚みの匿名集計・Issue #436）。
--     **既存の tallies の 3 SA 一律付与を写さない。** 書くのは客向けアンケート Web だけで、加算は UPSERT
--     なので INSERT（書く列だけ）と count の UPDATE だけを与える（DELETE は使わない）。他の主体が要るように
--     なったら、その機能を足す PR で付与する
--   categories, survey_aspects, survey_categories, survey_facets, survey_category_facets は
--     seed 所有 → runtime は read のみ（後 3 表は structured survey の taxonomy・0015）
--   store_survey_configs, store_survey_category_settings, store_survey_targets（structured survey の
--     店舗別設定・0015）は TS 層の書込所有だが、**書込面（店舗オーナーが書く SA）は #437 で決める。**
--     それまでどの SA にも DML を付与しない（SELECT のみ）。db/test/check_docs.sh の
--     PENDING_WRITE_GRANTS が、ここへ DML が紛れ込んだら赤にする
--   読み取りは全層に許容 → 全 SA が全テーブルを SELECT 可

\if :{?project}
\else
  \set project 'gen-fw-line-meo'
\endif
\set line_webhook 'sa-line-webhook@' :project '.iam'
\set survey    'sa-survey-web@' :project '.iam'
\set dashboard 'sa-dashboard-api@' :project '.iam'
\set batch     'sa-daily-batch@' :project '.iam'
\set delivery  'sa-summary-delivery@' :project '.iam'
\set detail    'sa-store-detail@' :project '.iam'

BEGIN;

-- スキーマ利用権限（全ランタイム SA）
GRANT USAGE ON SCHEMA public TO :"line_webhook", :"survey", :"dashboard", :"batch", :"delivery", :"detail";

-- 読み取りは全層に許容（全テーブル SELECT）。categories / survey_aspects は
-- ここでの SELECT のみ = seed read-only（下の DML 付与に含めない）。
GRANT SELECT ON ALL TABLES IN SCHEMA public
  TO :"line_webhook", :"survey", :"dashboard", :"batch", :"delivery", :"detail";

-- TS 層書込テーブルへの DML（3 TS SA）。
-- 付与単位は write-boundary.md の「TS 層書込所有」宣言に合わせる（SA 別の最小化はしない既存方針）。
-- agency_invite_codes は line_webhook の実行時利用が SELECT のみ（招待コード発行は MVP 境界外・
-- 運営側の事前オペレーション）だが、write-boundary.md が TS 層書込所有と宣言しているため、
-- oauth_tokens（第2フェーズまで休眠）と同じ扱いで DML を付与する。
GRANT INSERT, UPDATE, DELETE ON
  operators, agencies, dashboard_users, owners, stores,
  survey_rating_tallies, survey_aspect_tallies, survey_concern_tallies, survey_material_tallies,
  survey_review_link_tallies,
  oauth_tokens, agency_invite_codes, onboarding_sessions, line_webhook_events,
  gbp_locations, gbp_sessions
  TO :"line_webhook", :"survey", :"dashboard";

-- stores の停止時刻（suspended_at・store-suspension・Issue #252）を書けるのは dashboard だけにする。
-- line_webhook と survey はオーナー・客の面を持つため、この列を書けるとオーナー自身による配信停止の
-- 手段をどこに足しても DB が受け付けてしまう（store-suspension Requirement 8.1, 8.3）。
-- 上の一律付与から stores の INSERT・UPDATE をテーブル単位で剥がし、suspended_at を除く列を列挙して
-- 与え直す。**テーブル単位の REVOKE を必ず先に行う。** テーブル単位の権限が残っていると、列を列挙から
-- 外しても全列を書けたままになる（PostgreSQL の仕様）。DELETE と SELECT はテーブル単位のまま残す。
-- stores に列を足したら、ここの列挙へも足すこと（db/test/check_store_suspension_privileges.sh が
-- 足し忘れを赤にする）。
-- 本番へ再適用するときは、既存の権限を付与したのと同じ DB ユーザーで流すこと。REVOKE は自分が付与した
-- 権限しか剥がせず、剥がせなくても WARNING で終わり ON_ERROR_STOP では止まらない
-- （手順は .kiro/specs/store-suspension/design.md の ProductionVerification）。
REVOKE INSERT, UPDATE ON stores FROM :"line_webhook", :"survey";
GRANT
  INSERT (id, owner_id, category_code, name, latitude, longitude, place_id, place_status, created_at),
  UPDATE (id, owner_id, category_code, name, latitude, longitude, place_id, place_status, created_at)
  ON stores
  TO :"line_webhook", :"survey";

-- 監査記録は TS 層が追記する。証跡の改変を防ぐため UPDATE/DELETE は付与しない。
GRANT INSERT ON audit_logs TO :"line_webhook", :"dashboard";

-- Go 層書込テーブルへの DML（batch SA・daily_summaries は competitive-daily-summary 0004 で追加）
GRANT INSERT, UPDATE, DELETE ON
  competitors, rating_snapshots, daily_summaries
  TO :"batch";

-- TS 配信ジョブの書込テーブルへの DML（delivery SA・least privilege: summary_deliveries のみ・
-- DELETE は付与しない = パージ機能を持たないため不要）
GRANT INSERT, UPDATE ON
  summary_deliveries
  TO :"delivery";

-- structured survey の素材の厚みの匿名集計（Issue #436・0015）。書くのは客向けアンケート Web だけ。
-- 加算は ON CONFLICT DO UPDATE の UPSERT なので、列を絞って INSERT と UPDATE だけを与え、DELETE は
-- 与えない。INSERT は incrementStructuredTallies が書く列だけ（id は既定値に任せる）、UPDATE は
-- 加算する count だけ（店舗・月・厚みの列は一度書いたら変えない）。ON CONFLICT が参照する列の
-- SELECT は、上の全表 SELECT で足りる。
-- 他の SA へ広げない（新しい表では最小権限を優先する。必要になった機能の PR で付与する）。
-- 主体・列ごとの有無は db/test/check_structured_survey_privileges.sh が実ロールで検証する。
GRANT
  INSERT (store_id, period_month,
          positive_group_count, concern_group_count,
          positive_target_count, concern_target_count,
          positive_facet_count, concern_facet_count,
          has_comment, count),
  UPDATE (count)
  ON survey_structured_material_tallies
  TO :"survey";

-- store_detail（閲覧専用）は上記 SELECT ON ALL TABLES 以外の DML を一切付与しない。

COMMIT;
