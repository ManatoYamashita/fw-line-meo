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
#
# **for_each の要素には plan 時点で確定する値（枠名）しか渡してはならない。** computed な
# google_secret_manager_secret.id を渡すと、枠を 1 件でも新規に足した時点で set が確定せず
# `Invalid for_each argument` になり、prod env の plan ごと落ちる。secret_id は project を
# 併記すれば短い枠名で解決される（フルパスの .id も API 上は通るが、それは確定しない値である）。
resource "google_secret_manager_secret_iam_member" "ci_metadata_viewer" {
  for_each = toset(var.metadata_viewer_secret_ids)

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.viewer"
  member    = local.principal_set
}

# 本番の監視構成の乖離を CI が定期検証するための読み取り（Issue #230）
#
# #230 は「apply されたがコードが失われた」状態が 3 日以上誰にも気づかれなかった事故である。
# 静的な照合では原理的に届かない（コードが消えている間、CI は何度でも緑になる）ため、
# monitoring-drift ワークフローが 6 時間ごとに本番へ照会する。
#
# **付与するのは roles/monitoring.viewer だけで、logging 系のロールは付けない。**
# ログベース指標の存在確認には Monitoring の metricDescriptors を使う（実測: 本番の
# logging.googleapis.com/user/* 3 件が monitoring.metricDescriptors.list で返る）。
# `gcloud logging metrics list` の方が素直に見えるが、それに必要な logging.logMetrics.* は
# roles/monitoring.viewer に含まれず（gcloud iam roles describe で実測確認済み）、代わりに
# roles/logging.viewer を付けると logging.logEntries.list まで付いてくる。それは
# **CI がログ本文を読めるようになる**ということであり、#227「越えてはならない線」と Req 5.4 の
# 思想に反する。監視を直すために、監視より広い読み取り面を開いてはならない。
#
# secret と違い project 単位で付与しているのは、この検証が「本番に在って宣言に無いもの」を
# 見つけることそのものを目的としているためである。対象を列挙して 1 件ずつ照会する形にすると、
# 列挙に無いものは原理的に見えず、**今回の事故（宣言に無いものが本番に在る）を検出できない**。
# monitoring.viewer が読めるのは監視の構成とメトリクスの時系列だけで、そこに来訪客の識別子は
# 構造的に存在しない（ログベース指標のラベルは storeId のみ = 事業者側の識別子・Req 5.7）。
resource "google_project_iam_member" "ci_monitoring_viewer" {
  project = var.project_id
  role    = "roles/monitoring.viewer"
  member  = local.principal_set
}
