# API 有効化（gcp-infra-foundation / Req 1.2）
#
# 全モジュールが依存する API を宣言的に有効化する。IaC 定義に存在しない手動
# 有効化を持たないための単一情報源。disable_dependent_services=false で
# 依存 API の巻き込み無効化を防ぐ。
locals {
  services = [
    "run.googleapis.com",              # Cloud Run（services / jobs）
    "sqladmin.googleapis.com",         # Cloud SQL 管理
    "secretmanager.googleapis.com",    # Secret Manager
    "identitytoolkit.googleapis.com",  # Identity Platform / Firebase Auth
    "cloudscheduler.googleapis.com",   # Cloud Scheduler（日次バッチ起動）
    "artifactregistry.googleapis.com", # Artifact Registry
    "iam.googleapis.com",              # IAM
    "iamcredentials.googleapis.com",   # 短命トークン発行（WIF）
    "sts.googleapis.com",              # Security Token Service（WIF 交換）
    "billingbudgets.googleapis.com",   # Budget（Req 7.1）
    "cloudquotas.googleapis.com",      # Cloud Quotas（Places API cap・Req 7.2）
    "monitoring.googleapis.com",       # Monitoring（バッチ失敗アラート）
    "firebase.googleapis.com",         # Firebase プロジェクト（Identity Platform 前提）
    "places.googleapis.com",           # Places API (New)（競合データ取得）
  ]
}

resource "google_project_service" "enabled" {
  for_each = toset(local.services)

  project = var.project_id
  service = each.value

  disable_dependent_services = false
  disable_on_destroy         = var.disable_on_destroy
}
