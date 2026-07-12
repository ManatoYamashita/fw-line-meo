# root 配線（gcp-infra-foundation / Task 4.3・Req 1.2,1.5）
#
# 全 9 モジュールを依存方向どおり配線する:
#   project-services → registry/database/auth/secrets → run-services/batch-job
#     → cicd-wif/guardrails
# モジュール間はすべて output→変数で受け渡し、逆参照はしない（非循環）。

data "google_project" "this" {
  project_id = var.project_id
}

# --- API 有効化（全モジュールの前提） ---
module "project_services" {
  source     = "../../modules/project-services"
  project_id = var.project_id
}

# --- 実行系の器・データ系・認証・秘匿 ---
module "registry" {
  source     = "../../modules/registry"
  project_id = var.project_id
  region     = var.region

  depends_on = [module.project_services]
}

module "database" {
  source     = "../../modules/database"
  project_id = var.project_id
  region     = var.region

  depends_on = [module.project_services]
}

module "auth" {
  source     = "../../modules/auth"
  project_id = var.project_id

  depends_on = [module.project_services]
}

module "secrets" {
  source     = "../../modules/secrets"
  project_id = var.project_id

  depends_on = [module.project_services]
}

# --- 実行系（database/secrets の output を消費） ---
module "run_services" {
  source             = "../../modules/run-services"
  project_id         = var.project_id
  region             = var.region
  db_instance_name   = module.database.instance_name
  db_connection_name = module.database.connection_name
  db_name            = module.database.database_name

  # secret id は各サービスの secret_env が保持（別途 secret_ids 変数は持たない）
  services = {
    "line-webhook" = {
      public         = true
      needs_cloudsql = true
      secret_env = {
        LINE_CHANNEL_SECRET = module.secrets.secret_ids["line-channel-secret"]
        PLACES_API_KEY      = module.secrets.secret_ids["places-api-key"]
      }
      env = {
        LINE_CHANNEL_ID            = var.line_channel_id
        LINE_RICHMENU_COMPLETED_ID = var.line_richmenu_completed_id
      }
    }
    "survey-web" = {
      public         = true
      needs_cloudsql = true
      secret_env = {
        GEMINI_API_KEY      = module.secrets.secret_ids["gemini-api-key"]
        SESSION_SIGNING_KEY = module.secrets.secret_ids["survey-session-key"]
      }
      env = {
        GEMINI_MODEL = var.gemini_model
      }
    }
    "dashboard-api" = {
      public         = true
      needs_cloudsql = true
      secret_env     = {}
      env = {
        SURVEY_BASE_URL = var.survey_base_url
      }
    }
    # competitive-daily-summary: LIFF 詳細閲覧（読取専用・design.md「TS / store-detail」）。
    # secret を持たない（LIFF_CHANNEL_ID・NEXT_PUBLIC_LIFF_ID は非秘匿の識別子・平文 env で足りる）。
    "store-detail" = {
      public         = true
      needs_cloudsql = true
      secret_env     = {}
      env = {
        LIFF_CHANNEL_ID     = var.liff_channel_id
        NEXT_PUBLIC_LIFF_ID = var.liff_id
      }
    }
  }

  depends_on = [module.project_services]
}

module "batch_job" {
  source             = "../../modules/batch-job"
  project_id         = var.project_id
  region             = var.region
  db_instance_name   = module.database.instance_name
  db_connection_name = module.database.connection_name
  db_name            = module.database.database_name
  places_secret_id   = module.secrets.secret_ids["places-api-key"]

  depends_on = [module.project_services]
}

# competitive-daily-summary: TS 配信ジョブ（毎時 HH:00 JST・design.md「infra/delivery-job」）
module "delivery_job" {
  source                              = "../../modules/delivery-job"
  project_id                          = var.project_id
  region                              = var.region
  db_instance_name                    = module.database.instance_name
  db_connection_name                  = module.database.connection_name
  db_name                             = module.database.database_name
  line_channel_secret_id              = module.secrets.secret_ids["line-channel-secret"]
  line_channel_access_token_secret_id = module.secrets.secret_ids["line-channel-access-token"]
  line_channel_id                     = var.line_channel_id
  liff_url                            = var.liff_url

  depends_on = [module.project_services]
}

# --- CI 認証・ガードレール（実行系の SA / Job を参照） ---
module "cicd_wif" {
  source            = "../../modules/cicd-wif"
  project_id        = var.project_id
  project_number    = data.google_project.this.number
  github_repository = var.github_repository

  runtime_service_account_emails = concat(
    values(module.run_services.service_account_emails),
    [module.batch_job.job_service_account_email],
    [module.delivery_job.job_service_account_email],
  )

  depends_on = [module.project_services]
}

module "guardrails" {
  source             = "../../modules/guardrails"
  project_id         = var.project_id
  project_number     = data.google_project.this.number
  billing_account_id = var.billing_account_id
  budget_amount_jpy  = var.budget_amount_jpy
  alert_email        = var.alert_email
  job_name           = module.batch_job.job_name
  places_quota_caps  = var.places_quota_caps

  depends_on = [module.project_services]
}
