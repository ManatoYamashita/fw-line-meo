# Cloud Run v2 リアルタイム応答層（gcp-infra-foundation / Req 2.1,2.2,2.6,2.7,5.x,6.4,7.3）
#
# 循環回避方針: SA を作る本モジュールが、自 SA 分の派生リソース
# （IAM DB ユーザー・secret accessor・cloudsql ロール）を co-locate する。
# database / secrets の値は変数入力（配線は Task 4.3）。

locals {
  # (service, env→secret) を平坦化 → secret accessor / env mount の for_each キー
  service_secret_pairs = flatten([
    for svc_key, svc in var.services : [
      for env_name, secret_id in svc.secret_env : {
        svc       = svc_key
        env_name  = env_name
        secret_id = secret_id
      }
    ]
  ])

  cloudsql_roles = ["roles/cloudsql.client", "roles/cloudsql.instanceUser"]
  cloudsql_bindings = flatten([
    for svc_key, svc in var.services : [
      for role in local.cloudsql_roles : {
        svc  = svc_key
        role = role
      } if svc.needs_cloudsql
    ]
  ])
}

# サービスごとのユーザー管理 SA（Compute default SA 不使用・命名は locals 規約）
resource "google_service_account" "svc" {
  for_each     = var.services
  project      = var.project_id
  account_id   = "sa-${each.key}"
  display_name = "Cloud Run ${each.key} runtime SA"
}

resource "google_cloud_run_v2_service" "svc" {
  for_each = var.services

  project  = var.project_id
  name     = each.key
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  # ステートレスなアプリサービスは置換・削除を許可（DB のみ deletion_protection=true）
  deletion_protection = false

  template {
    service_account = google_service_account.svc[each.key].email

    # min_instance_count は Cloud Run 既定の 0（ゼロスケール・Req 2.2・7.3）。
    # 明示的に scaling{min=0} を書くと API が既定値を返さず perpetual diff になるため
    # ブロック自体を書かない（既定で 0 スケールが担保される）。

    containers {
      image = var.image

      # secret 由来の env（value_source.secret_key_ref）
      dynamic "env" {
        for_each = each.value.secret_env
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

      # Cloud SQL 接続用の平文 env（needs_cloudsql の場合のみ）。
      # pool（packages/db）の IAM 認証経路が要求する 3 値を単一情報源から注入する:
      #   CLOUDSQL_CONNECTION_NAME=接続名 / DB_NAME=論理DB名 / DB_IAM_USER=SA 派生ユーザー名
      #   （DB_IAM_USER は google_sql_user と同じ trimsuffix 名で一致させる）。
      dynamic "env" {
        for_each = each.value.needs_cloudsql ? {
          CLOUDSQL_CONNECTION_NAME = var.db_connection_name
          DB_NAME                  = var.db_name
          DB_IAM_USER              = trimsuffix(google_service_account.svc[each.key].email, ".gserviceaccount.com")
        } : {}
        content {
          name  = env.key
          value = env.value
        }
      }

      # 平文 env（非シークレット・GEMINI_MODEL / SURVEY_BASE_URL 等）
      dynamic "env" {
        for_each = each.value.env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  # イメージは CI が更新（構成は TF 専権）。ignore_changes で drift を避ける。
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }
}

# 公開サービスの invoker（allUsers）。非公開は本 binding を持たない（Req 2.6）。
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = { for k, v in var.services : k => v if v.public }

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.svc[each.key].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# secret 単位 accessor（自 SA 分を co-locate・project 単位付与は禁止・Req 5.4）
resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = { for p in local.service_secret_pairs : "${p.svc}.${p.env_name}" => p }

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.svc[each.value.svc].email}"
}

# IAM DB ユーザー（password なし = state に秘匿情報ゼロ・Req 5.2）
resource "google_sql_user" "iam" {
  for_each = { for k, v in var.services : k => v if v.needs_cloudsql }

  project  = var.project_id
  instance = var.db_instance_name
  name     = trimsuffix(google_service_account.svc[each.key].email, ".gserviceaccount.com")
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

# Cloud SQL 接続用のプロジェクトロール（Language Connector + IAM 認証）
resource "google_project_iam_member" "cloudsql" {
  for_each = { for b in local.cloudsql_bindings : "${b.svc}.${b.role}" => b }

  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.svc[each.value.svc].email}"
}
