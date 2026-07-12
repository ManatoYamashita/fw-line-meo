# 日次バッチ層（gcp-infra-foundation / Req 2.3,2.4,2.5,2.6,2.7,5.x）
#
# Cloud Run v2 Job（Go・Places API 取得）を毎朝 Cloud Scheduler が起動する。
# 循環回避方針に基づき、job SA の派生（IAM DB ユーザー・places accessor・
# cloudsql ロール）を本モジュールに co-locate。失敗「検知」（アラートポリシー）は
# Guardrails 所有のため本モジュールには置かない（Job 実行履歴が Req 2.5 の「記録」）。

# ジョブ実行 SA（DB / Places にアクセス）
resource "google_service_account" "job" {
  project      = var.project_id
  account_id   = "sa-daily-batch"
  display_name = "daily-batch job runtime SA"
}

# スケジューラ専用 SA（最小権限: ジョブ invoker のみ）
resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "sa-scheduler"
  display_name = "Cloud Scheduler invoker SA (daily-batch)"
}

resource "google_cloud_run_v2_job" "batch" {
  project  = var.project_id
  name     = var.job_name
  location = var.region

  deletion_protection = false

  template {
    template {
      service_account = google_service_account.job.email
      max_retries     = 1
      timeout         = "1800s"

      containers {
        image = var.image

        # Places API キー（secret 由来 env）
        dynamic "env" {
          for_each = { "PLACES_API_KEY" = var.places_secret_id }
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }

        env {
          name  = "CLOUDSQL_CONNECTION_NAME"
          value = var.db_connection_name
        }

        # task 3.6/6.3 レビューで発見: config.Load() が DBModeCloudSQLIAM で必須とする
        # DB_IAM_USER・DB_NAME が未配線だった（delivery-job モジュールの配線パターンを踏襲）。
        env {
          name  = "DB_NAME"
          value = var.db_name
        }

        env {
          name  = "DB_IAM_USER"
          value = trimsuffix(google_service_account.job.email, ".gserviceaccount.com")
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
  }
}

# スケジューラ SA にジョブ invoker を付与（Req 2.6 非公開側）
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.batch.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# 毎朝の起動（*.googleapis.com 宛のため oauth_token・OIDC ではない・Req 2.4）
resource "google_cloud_scheduler_job" "daily" {
  project   = var.project_id
  region    = var.region
  name      = "${var.job_name}-trigger"
  schedule  = var.schedule
  time_zone = var.timezone

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${var.job_name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
}

# Places API キーの accessor（job SA・secret 単位・Req 5.4）
resource "google_secret_manager_secret_iam_member" "places_accessor" {
  project   = var.project_id
  secret_id = var.places_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job.email}"
}

# IAM DB ユーザー（password なし・Req 5.2）
resource "google_sql_user" "job_iam" {
  project  = var.project_id
  instance = var.db_instance_name
  name     = trimsuffix(google_service_account.job.email, ".gserviceaccount.com")
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

# Cloud SQL 接続用プロジェクトロール
resource "google_project_iam_member" "job_cloudsql" {
  for_each = toset(["roles/cloudsql.client", "roles/cloudsql.instanceUser"])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.job.email}"
}
