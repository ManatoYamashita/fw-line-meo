# Cloud SQL PostgreSQL 16（gcp-infra-foundation / Req 3.x・唯一の常時課金リソース）
#
# 設計上の要点:
# - Enterprise edition + shared-core db-f1-micro + ZONAL（MVP 最小・Req 7.3）
# - 自動バックアップ 7 世代・PITR 無効（コスト）
# - public IP 有効だが authorized_networks 空・IAM DB 認証 on（Req 3.4）
#   → 到達経路はランタイム SA の Language Connector と運用者の Auth Proxy のみ
# - IAM DB ユーザー（google_sql_user）は本モジュールでは作らない。SA を作る
#   consumer 側（run-services / batch-job）へ co-locate し循環を回避する。
resource "google_sql_database_instance" "main" {
  project             = var.project_id
  name                = var.instance_name
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.deletion_protection

  settings {
    tier              = var.tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_type         = "PD_SSD"
    disk_size         = var.disk_size_gb

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = false

      backup_retention_settings {
        retained_backups = 7
        retention_unit   = "COUNT"
      }
    }

    ip_configuration {
      ipv4_enabled = true
      # authorized_networks を宣言しない = 空（Req 3.4: 直接続の許可リストなし）
    }

    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
  }
}

resource "google_sql_database" "app" {
  project  = var.project_id
  name     = var.database_name
  instance = google_sql_database_instance.main.name
}
