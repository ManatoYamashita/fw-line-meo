-- infra/sql/grants.sql
-- gcp-infra-foundation: IAM DB ユーザーへの GRANT（db/write-boundary.md と整合）
--
-- 適用: Auth Proxy 経由で fwlm DB に接続し、db/migrations 適用後に実行（runbook 手順）。
--   psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f infra/sql/grants.sql
--
-- IAM DB ユーザー名は Cloud SQL が SA email から .gserviceaccount.com を除いた形
-- （例: sa-line-webhook@fwlm.iam）。project 名は既定 fwlm。別プロジェクトは -v で上書き:
--   psql ... -v ON_ERROR_STOP=1 -v project=gen-fw-line-meo -f infra/sql/grants.sql
-- SA 命名は infra/envs/prod/locals.tf が単一情報源。
--
-- 書込境界（db/write-boundary.md・"整合する GRANT のみ"）:
--   TS 層（line_webhook / survey_web / dashboard_api）→ DML on
--     operators, agencies, dashboard_users, owners, stores,
--     survey_rating_tallies, survey_aspect_tallies, oauth_tokens,
--     agency_invite_codes, onboarding_sessions, line_webhook_events
--   Go 層（daily_batch）→ DML on competitors, rating_snapshots
--   categories, survey_aspects は seed 所有 → runtime は read のみ
--   読み取りは両層に許容 → 全 SA が全 15 テーブルを SELECT 可

\if :{?project}
\else
  \set project 'fwlm'
\endif
\set line_webhook 'sa-line-webhook@' :project '.iam'
\set survey       'sa-survey-web@' :project '.iam'
\set dashboard    'sa-dashboard-api@' :project '.iam'
\set batch        'sa-daily-batch@' :project '.iam'

BEGIN;

-- スキーマ利用権限（全ランタイム SA）
GRANT USAGE ON SCHEMA public TO :"line_webhook", :"survey", :"dashboard", :"batch";

-- 読み取りは両層に許容（全 15 テーブル SELECT）。categories / survey_aspects は
-- ここでの SELECT のみ = seed read-only（下の DML 付与に含めない）。
GRANT SELECT ON ALL TABLES IN SCHEMA public
  TO :"line_webhook", :"survey", :"dashboard", :"batch";

-- TS 層書込テーブルへの DML（3 TS SA）。
-- 付与単位は write-boundary.md の「TS 層書込所有」宣言に合わせる（SA 別の最小化はしない既存方針）。
-- agency_invite_codes は line_webhook の実行時利用が SELECT のみ（招待コード発行は MVP 境界外・
-- 運営側の事前オペレーション）だが、write-boundary.md が TS 層書込所有と宣言しているため、
-- oauth_tokens（第2フェーズまで休眠）と同じ扱いで DML を付与する。
GRANT INSERT, UPDATE, DELETE ON
  operators, agencies, dashboard_users, owners, stores,
  survey_rating_tallies, survey_aspect_tallies, oauth_tokens,
  agency_invite_codes, onboarding_sessions, line_webhook_events
  TO :"line_webhook", :"survey", :"dashboard";

-- Go 層書込テーブルへの DML（batch SA）
GRANT INSERT, UPDATE, DELETE ON
  competitors, rating_snapshots
  TO :"batch";

COMMIT;
