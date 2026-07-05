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
