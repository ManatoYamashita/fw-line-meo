# 配信ジョブ層（competitive-daily-summary / Req 3.1, 5.1）
#
# Cloud Run v2 Job（TS・LINE Flex Push）を毎時 Cloud Scheduler が起動する。
# gcp-infra-foundation の循環回避方針を踏襲し、job SA の派生（IAM DB ユーザー・
# LINE secret accessor・cloudsql ロール）を本モジュールに co-locate する
# （infra/modules/batch-job の構造をそのまま踏襲・design.md「infra/delivery-job」）。
#
# task 3.6/6.3 レビューで発見された batch-job の配線漏れ（DB_IAM_USER・DB_NAME が Job env に
# 無く Cloud SQL IAM 接続モードで起動失敗する）を本モジュールでは繰り返さない。
# run-services モジュールと同じく CLOUDSQL_CONNECTION_NAME・DB_NAME・DB_IAM_USER の3値を揃える
# （ts/packages/db/src/pool.ts の createPool が要求する必須 env と一致）。

# ジョブ実行 SA（DB / LINE secret にアクセス）
resource "google_service_account" "job" {
  project      = var.project_id
  account_id   = "sa-summary-delivery"
  display_name = "summary-delivery job runtime SA"
}

# スケジューラ専用 SA（最小権限: ジョブ invoker のみ）。
# batch-job モジュールの "sa-scheduler" とは別名にする（同一プロジェクト内で
# google_service_account の account_id は一意でなければならず、モジュールをまたいで
# 同名 SA を複数作成すると衝突するため）。
resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "sa-scheduler-delivery"
  display_name = "Cloud Scheduler invoker SA (summary-delivery)"
}

resource "google_cloud_run_v2_job" "delivery" {
  project  = var.project_id
  name     = var.job_name
  location = var.region

  deletion_protection = false

  template {
    template {
      service_account = google_service_account.job.email
      max_retries     = 1
      # 毎時起動・1回あたりの対象は限定的（daily-batch の30分より短い既定値）。
      timeout = "600s"

      containers {
        image = var.image

        # LINE チャネルシークレット（secret 由来 env・Stateless token 発行の client_secret）
        dynamic "env" {
          for_each = { "LINE_CHANNEL_SECRET" = var.line_channel_secret_id }
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

        # 平文 env（LINE チャネル ID・LIFF URL・Cloud SQL IAM 接続の3値）
        dynamic "env" {
          for_each = {
            LINE_CHANNEL_ID          = var.line_channel_id
            LIFF_URL                 = var.liff_url
            CLOUDSQL_CONNECTION_NAME = var.db_connection_name
            DB_NAME                  = var.db_name
            DB_IAM_USER              = trimsuffix(google_service_account.job.email, ".gserviceaccount.com")
          }
          content {
            name  = env.key
            value = env.value
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
  }
}

# スケジューラ SA にジョブ invoker を付与
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.delivery.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

# 毎時の起動（*.googleapis.com 宛のため oauth_token・OIDC ではない・batch-job パターン踏襲）
resource "google_cloud_scheduler_job" "hourly" {
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

# LINE チャネルシークレットの accessor（job SA・secret 単位・env としてマウント）
resource "google_secret_manager_secret_iam_member" "line_channel_secret_accessor" {
  project   = var.project_id
  secret_id = var.line_channel_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job.email}"
}

# LINE チャネルアクセストークンの accessor（job SA・secret 単位）。
# design.md「Modified Files」「Security Considerations」の明示指示に基づき accessor のみ付与する
# （research.md で発見された既存ギャップ: 従来 webhook SA のみに付与されていた）。
# 現行実装（Stateless token 発行方式）は本 secret を env としては消費しないため、
# Job のコンテナ env へは意図的にマウントしない（CONCERNS 参照）。
resource "google_secret_manager_secret_iam_member" "line_channel_access_token_accessor" {
  project   = var.project_id
  secret_id = var.line_channel_access_token_secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job.email}"
}

# IAM DB ユーザー（password なし・batch-job パターン踏襲）
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
