# Direct Workload Identity Federation（gcp-infra-foundation / Req 6.x）
#
# GitHub Actions → GCP をキーレス認証。attribute_condition で単一リポジトリに限定する。
# SA JSON キーは一切発行しない（Req 6.2）。
#
# 書き込み（本番へのイメージ反映）はデプロイ SA gha-deployer の偽装だけが持ち、その偽装は
# main の ref に限る（Issue #331）。principalSet（リポジトリ単位）へ直接付けるのは、drift 検証が
# 使う読み取りロールだけである。

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
    # デプロイ SA の偽装を main の ref に限るための属性（Issue #331）。値は refs/heads/<branch> の形。
    "attribute.ref" = "assertion.ref"
  }

  # 単一リポジトリのみ許可（Req 6.3）。他リポジトリのトークンは STS が拒否。
  attribute_condition = "assertion.repository == \"${var.github_repository}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

locals {
  pool_path     = "principalSet://iam.googleapis.com/projects/${var.project_number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}"
  principal_set = "${local.pool_path}/attribute.repository/${var.github_repository}"

  # デプロイ SA を偽装できる主体。provider の attribute_condition がリポジトリを 1 つに限っているので、
  # ref だけで絞れば「このリポジトリの main で走るワークフロー」になる（Issue #331）。
  deploy_principal_set = "${local.pool_path}/attribute.ref/${var.deploy_ref}"
}

# drift 検証（prod-image-drift の `gcloud run services list` / `jobs list`、gcp-auth-smoke）が使う
# Cloud Run の読み取り（Issue #331）。
#
# 以前はここで principalSet へ roles/run.developer と roles/artifactregistry.writer を、各ランタイム SA
# へ roles/iam.serviceAccountUser を直接付けていた。deploy-prod が gha-deployer の偽装へ移った（#316）
# 後は、どれも書き込みには使われていなかった。残っていると、このリポジトリの任意のブランチの
# ワークフローが Direct WIF のまま本番へ書き込める。
resource "google_project_iam_member" "ci_run_viewer" {
  project = var.project_id
  role    = "roles/run.viewer"
  member  = local.principal_set
}

# deploy-prod 専用のデプロイ SA（Issue #316）
#
# Direct WIF の連携トークンは寿命が元の GitHub OIDC トークンに縛られ、約 5 分で失効する
# （PR #317 で実測: auth の 5 分 25 秒後に docker push が unauthorized）。そのため Direct WIF の
# ままでは「1 度だけ取得して使い回す」ことができず、gcloud は呼び出しのたびに OIDC エンドポイントへ
# 往復する。deploy-prod はデプロイ成功後の検証段でその一過性障害に当たり、赤くなっていた。
#
# この SA を WIF 経由で偽装し、IAM Credentials の generateAccessToken で発行する SA のアクセストークン
# （寿命 1 時間・OIDC と独立）を deploy-prod の全ステップで使う。**SA キーは発行しない**（Req 6.2 は
# そのまま守られる。偽装の権限は principalSet にしか与えない）。
#
# gcp-infra-foundation の research.md は「WIF + SA impersonation」を「必要になった時点で追加」として
# 不採用にしていた。本 SA はその「必要になった時点」である。
#
# principalSet への書き込み系の直付与は Issue #331 で外した（上の ci_run_viewer の注記）。
resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = var.deployer_account_id
  display_name = "GitHub Actions deploy-prod"
  description  = "deploy-prod が WIF 経由で偽装するデプロイ SA（Issue #316）。キーは発行しない。"
}

resource "google_project_iam_member" "deployer_sa" {
  for_each = toset(["roles/run.developer", "roles/artifactregistry.writer"])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account_iam_member" "deployer_sa_act_as" {
  for_each = toset(var.runtime_service_account_emails)

  service_account_id = "projects/${var.project_id}/serviceAccounts/${each.value}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# 偽装できるのは、このリポジトリの main の ref で走るワークフローだけ（Issue #331）。
#
# deploy.yml の 2 つの起動経路（ts-ci 完了の workflow_run と、main からの workflow_dispatch）は、どちらも
# OIDC トークンの ref が refs/heads/main になる。main 以外のブランチから workflow_dispatch した場合や、
# ブランチへ push したワークフローは偽装を拒否される。以前はリポジトリ単位の principalSet に付けて
# いたため、任意のブランチの deploy.yml から偽装できた（#331 の対照実験で実測）。
resource "google_service_account_iam_member" "deployer_wif_user" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.deploy_principal_set
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

# 本番 DB スキーマの定期検証（Issue #251）
#
# Direct WIF の GitHub 主体へ Cloud SQL 権限を直接付けず、検証専用 SA だけを偽装させる。
# SA に付ける GCP 権限は接続・IAM DB login のみ。DB の表・列・行への権限は付与しない。
# Cloud SQL Auth Proxy の --auto-iam-authn がこの SA の ID で DB へログインする。
resource "google_service_account" "schema_drift" {
  project      = var.project_id
  account_id   = "gha-schema-drift"
  display_name = "GitHub Actions schema drift checker"
  description  = "Issue #251 の本番スキーマ存在確認専用。キーは発行しない。"
}

resource "google_project_iam_member" "schema_drift_cloudsql" {
  for_each = toset(["roles/cloudsql.client", "roles/cloudsql.instanceUser"])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.schema_drift.email}"
}

resource "google_service_account_iam_member" "schema_drift_wif_user" {
  service_account_id = google_service_account.schema_drift.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.principal_set
}
