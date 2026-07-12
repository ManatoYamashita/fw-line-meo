-- infra/sql/grants.sql
-- gcp-infra-foundation: IAM DB ユーザーへの GRANT（db/write-boundary.md と整合）
--
-- 適用: Auth Proxy 経由で fwlm DB に接続し、db/migrations 適用後に実行（runbook 手順）。
--   psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f infra/sql/grants.sql
--
-- IAM DB ユーザー名は Cloud SQL が SA email から .gserviceaccount.com を除いた形
-- （例: sa-line-webhook@fwlm.iam）。project 名は既定 fwlm。別プロジェクトは -v で上書き:
--   psql ... -v ON_ERROR_STOP=1 -v project=gen-fw-line-meo -f infra/sql/grants.sql
-- SA 命名は各モジュール内で決定的に導出/直書き（run-services: sa-${each.key}・batch-job/delivery-job: 個別ハードコード）。
--
-- 書込境界（db/write-boundary.md・"整合する GRANT のみ"）:
--   TS 層（line_webhook / survey_web / dashboard_api）→ DML on
--     operators, agencies, dashboard_users, owners, stores,
--     survey_rating_tallies, survey_aspect_tallies, oauth_tokens,
--     agency_invite_codes, onboarding_sessions, line_webhook_events
--   Go 層（daily_batch）→ DML on competitors, rating_snapshots, daily_summaries
--     （daily_summaries は competitive-daily-summary 0004・INSERT/UPDATE は同日再実行の
--     ON CONFLICT DO UPDATE、DELETE は 30日超パージ。go/internal/repo/summaries.go 参照）
--   TS 配信ジョブ（summary_delivery・competitive-daily-summary 0004）→ DML on
--     summary_deliveries のみ（INSERT で retry_key 付き予約、UPDATE で結果記録。
--     DELETE は行わない = パージ対象外。ts/apps/delivery-job/src/deliveries.ts 参照）
--   TS 詳細閲覧（store_detail・competitive-daily-summary・task 6.2 で SA を Terraform 実体化）→
--     読取専用（DML なし）。ID トークン検証済みの自店データのみを API 層で絞り込む
--     （閲覧専用画面・design.md「書込操作を一切持たない」）
--   categories, survey_aspects は seed 所有 → runtime は read のみ
--   読み取りは全層に許容 → 全 SA が全テーブルを SELECT 可

\if :{?project}
\else
  \set project 'fwlm'
\endif
\set webhook   'sa-line-webhook@' :project '.iam'
\set survey    'sa-survey-web@' :project '.iam'
\set dashboard 'sa-dashboard-api@' :project '.iam'
\set batch     'sa-daily-batch@' :project '.iam'
\set delivery  'sa-summary-delivery@' :project '.iam'
\set detail    'sa-store-detail@' :project '.iam'

BEGIN;

-- スキーマ利用権限（全ランタイム SA）
GRANT USAGE ON SCHEMA public TO :"webhook", :"survey", :"dashboard", :"batch", :"delivery", :"detail";

-- 読み取りは全層に許容（全テーブル SELECT）。categories / survey_aspects は
-- ここでの SELECT のみ = seed read-only（下の DML 付与に含めない）。
GRANT SELECT ON ALL TABLES IN SCHEMA public
  TO :"webhook", :"survey", :"dashboard", :"batch", :"delivery", :"detail";

-- TS 層書込テーブルへの DML（3 TS SA）。
-- 付与単位は write-boundary.md の「TS 層書込所有」宣言に合わせる（SA 別の最小化はしない既存方針）。
-- agency_invite_codes は line_webhook の実行時利用が SELECT のみ（招待コード発行は MVP 境界外・
-- 運営側の事前オペレーション）だが、write-boundary.md が TS 層書込所有と宣言しているため、
-- oauth_tokens（第2フェーズまで休眠）と同じ扱いで DML を付与する。
GRANT INSERT, UPDATE, DELETE ON
  operators, agencies, dashboard_users, owners, stores,
  survey_rating_tallies, survey_aspect_tallies, oauth_tokens,
  agency_invite_codes, onboarding_sessions, line_webhook_events
  TO :"webhook", :"survey", :"dashboard";

-- Go 層書込テーブルへの DML（batch SA・daily_summaries は competitive-daily-summary 0004 で追加）
GRANT INSERT, UPDATE, DELETE ON
  competitors, rating_snapshots, daily_summaries
  TO :"batch";

-- TS 配信ジョブの書込テーブルへの DML（delivery SA・least privilege: summary_deliveries のみ・
-- DELETE は付与しない = パージ機能を持たないため不要）
GRANT INSERT, UPDATE ON
  summary_deliveries
  TO :"delivery";

-- store_detail（閲覧専用）は上記 SELECT ON ALL TABLES 以外の DML を一切付与しない。

COMMIT;
