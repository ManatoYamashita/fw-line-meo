# 共有定数（gcp-infra-foundation / design: Database 循環回避決定）
#
# サービスアカウント account_id の命名規約を単一情報源として固定する。
# 下流モジュール（run-services / batch-job / cicd-wif）と infra/sql/grants.sql は
# この規約由来の文字列を参照する。IAM DB ユーザー名は
# "<account_id>@<project_id>.iam" 形式で決定論的に導出できるため、
# database モジュールが consumer の SA リソースを参照する循環を避けられる。
locals {
  service_accounts = {
    webhook          = "sa-webhook"
    survey_web       = "sa-survey-web"
    dashboard_api    = "sa-dashboard-api"
    daily_batch      = "sa-daily-batch"
    summary_delivery = "sa-summary-delivery" # competitive-daily-summary: infra/modules/delivery-job
  }
}
