-- infra/sql/grants.sql
-- gcp-infra-foundation: IAM DB ユーザーへの GRANT（db/write-boundary.md と整合）
--
-- 適用: Auth Proxy 経由で fwlm DB に接続し、db/migrations 適用後に実行（runbook 手順）。
--   psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f infra/sql/grants.sql
--
-- IAM DB ユーザー名は Cloud SQL が SA email から .gserviceaccount.com を除いた形
-- （例: sa-webhook@fwlm.iam）。project 名は既定 fwlm。別プロジェクトは -v で上書き:
--   psql ... -v ON_ERROR_STOP=1 -v project=gen-fw-line-meo -f infra/sql/grants.sql
-- SA 命名は infra/envs/prod/locals.tf が単一情報源。
--
-- 書込境界（db/write-boundary.md・"整合する GRANT のみ"）:
--   TS 層（webhook / survey_web / dashboard_api）→ DML on
--     operators, agencies, dashboard_users, owners, stores,
--     survey_rating_tallies, survey_aspect_tallies, oauth_tokens
--   Go 層（daily_batch）→ DML on competitors, rating_snapshots
--   categories, survey_aspects は seed 所有 → runtime は read のみ
--   読み取りは両層に許容 → 全 SA が全 12 テーブルを SELECT 可

\if :{?project}
\else
  \set project 'fwlm'
\endif
\set webhook   'sa-webhook@' :project '.iam'
\set survey    'sa-survey-web@' :project '.iam'
\set dashboard 'sa-dashboard-api@' :project '.iam'
\set batch     'sa-daily-batch@' :project '.iam'

BEGIN;

-- スキーマ利用権限（全ランタイム SA）
GRANT USAGE ON SCHEMA public TO :"webhook", :"survey", :"dashboard", :"batch";

-- 読み取りは両層に許容（全 12 テーブル SELECT）。categories / survey_aspects は
-- ここでの SELECT のみ = seed read-only（下の DML 付与に含めない）。
GRANT SELECT ON ALL TABLES IN SCHEMA public
  TO :"webhook", :"survey", :"dashboard", :"batch";

-- TS 層書込テーブルへの DML（3 TS SA）
GRANT INSERT, UPDATE, DELETE ON
  operators, agencies, dashboard_users, owners, stores,
  survey_rating_tallies, survey_aspect_tallies, oauth_tokens
  TO :"webhook", :"survey", :"dashboard";

-- Go 層書込テーブルへの DML（batch SA）
GRANT INSERT, UPDATE, DELETE ON
  competitors, rating_snapshots
  TO :"batch";

COMMIT;
