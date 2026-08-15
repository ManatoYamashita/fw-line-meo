# Direct Workload Identity Federation（gcp-infra-foundation / Req 6.x）
#
# GitHub Actions → GCP をキーレス認証。deployer SA を作らず（Direct WIF）、
# principalSet へ直接 IAM を付与する。attribute_condition で単一リポジトリに限定。
# SA JSON キーは一切発行しない（Req 6.2）。

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = var.pool_id
  display_name              = "GitHub Actions pool"
  description               = "fw-line-meo CI (Direct WIF, no SA keys)"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = var.provider_id
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.repository"       = "assertion.repository"
    "attribute.repository_owner" = "assertion.repository_owner"
  }

  # 単一リポジトリのみ許可（Req 6.3）。他リポジトリのトークンは STS が拒否。
  attribute_condition = "assertion.repository == \"${var.github_repository}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

locals {
  principal_set = "principalSet://iam.googleapis.com/projects/${var.project_number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/attribute.repository/${var.github_repository}"
}

# デプロイに必要な最小ロールを principalSet へ直接付与（Direct WIF）
resource "google_project_iam_member" "deployer" {
  for_each = toset(["roles/run.developer", "roles/artifactregistry.writer"])

  project = var.project_id
  role    = each.value
  member  = local.principal_set
}

# デプロイ時に各ランタイム SA を指定するための serviceAccountUser
resource "google_service_account_iam_member" "act_as" {
  for_each = toset(var.runtime_service_account_emails)

  service_account_id = "projects/${var.project_id}/serviceAccounts/${each.value}"
  role               = "roles/iam.serviceAccountUser"
  member             = local.principal_set
}

# シークレット実値の投入漏れを CI が定期検証するためのメタデータ読み取り（Issue #63）
#
# 付与するのは roles/secretmanager.viewer のみ。この事前定義ロールは secretmanager.secrets.get /
# secretmanager.versions.list / secretmanager.versions.get を含むが、**secretmanager.versions.access
# （payload の読み取り）を含まない**（gcloud iam roles describe で実測確認済み）。したがって CI は
# 「何番の version がいつ作られ、いま ENABLED か」までしか観測できず、値は一切読めない。
#
# **project 単位では付与しない**（Req 5.4。secrets モジュールが accessor を持たず consumer 側で
# co-locate するのと同じ規律）。副作用として CI は project 全体の `gcloud secrets list` を実行
# できない（secretmanager.secrets.list は project スコープで評価されるため）。
# scripts/check-secret-version-drift.sh はこれを前提に、宣言された secret を 1 件ずつ
# describe / versions list する設計になっている。
#
# 本モジュールが所有するのは、CI の principalSet が consumer だからである（secrets モジュール側へ
# 置くと secrets が WIF プールを知る必要が生じ、root の依存が逆流する）。
resource "google_secret_manager_secret_iam_member" "ci_metadata_viewer" {
  for_each = toset(var.metadata_viewer_secret_ids)

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.viewer"
  member    = local.principal_set
}
