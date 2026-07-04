# Implementation Plan

> 各 Terraform モジュールは `modules/<name>/` 配下（`main.tf` / `variables.tf` / `outputs.tf`）に file-disjoint で authoring する。単体検証は当該ディレクトリで `terraform init -backend=false && terraform validate` を用いる（apply・remote state 不要）。全モジュールを呼び出す `envs/prod/main.tf` の配線はタスク 4.3 に単一集約するため、モジュール authoring タスク同士はファイル競合せず並列（P）安全。実 GCP への apply は billing IAM を持つ人間が runbook 手順で行う（検証タスク 5.2 以降）。
>
> 注: 以下「要件 X.X」は requirements.md の番号、「タスク X.X」は本ファイルの番号を指す。

- [ ] 1. Foundation: Terraform 骨格と API 有効化
- [x] 1.1 Terraform ルートモジュール骨格・provider・Makefile・gitignore
  - `envs/prod/` に `backend.tf`（GCS backend・versioning 前提）、`providers.tf`（google `~> 7.0` + google-beta 同版・`required_version >= 1.11`）、`variables.tf`（型明示: `project_id`/`region`（既定 `asia-northeast1`）/`billing_account_id`/`budget_amount_jpy`/`alert_email`/`github_repository`・各 `description` 必須）、`outputs.tf`（空枠）、`terraform.tfvars.example` を作成
  - SA 命名規約を locals として固定（`sa-webhook`/`sa-survey-web`/`sa-dashboard-api`/`sa-daily-batch`）— 下流モジュールと `grants.sql` が参照する単一情報源
  - `Makefile` に `tf-init`/`tf-plan`/`tf-apply`/`tf-fmt` を追記、`.gitignore` に `*.tfvars`（example 除く）と `.terraform/` を追記
  - Observable: `envs/prod` で `terraform init -backend=false` 後に `terraform fmt -check` と `terraform validate` が exit 0（GCS state bucket はブートストラップ前提のためこの段階では backend 無効で検証。bucket 作成手順はタスク 4.4 runbook に記載）
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 8.1_

- [x] 1.2 project-services モジュール（API 有効化）
  - `google_project_service` を必要 API 分宣言（run / sqladmin / secretmanager / identitytoolkit / cloudscheduler / artifactregistry / iam / iamcredentials / sts / billingbudgets / cloudquotas / monitoring / firebase / places）
  - Observable: `modules/project-services` 単体 validate が exit 0、`plan`（root 経由）で全 API リソースが現れ、apply 後に手動 API 有効化が不要
  - _Requirements: 1.2_

- [ ] 2. Core: データ層・認証・秘匿の独立モジュール（file-disjoint・並列）
- [ ] 2.1 (P) database モジュール
  - Cloud SQL PostgreSQL 16 / `edition=ENTERPRISE` / `tier=db-f1-micro` / `availability_type=ZONAL` / SSD 10GB / `deletion_protection=true`、`backup_configuration`（有効・7 世代・PITR 無効）、`database_flags` に `cloudsql.iam_authentication=on`、`authorized_networks` 空、論理 DB `fwlm`。**IAM DB ユーザーは作らない**（consumer 側で co-locate）。instance 接続名を output
  - Observable: 単体 validate exit 0、`plan` に 1 インスタンス・backup 有効・iam 認証 on・authorized_networks 空・`google_sql_user` 不在
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 5.2, 7.3_
  - _Boundary: Database_

- [ ] 2.2 (P) auth モジュール
  - `google_firebase_project` + `google_identity_platform_config`（google-beta・`deletion_policy=ABANDON`）。Google IdP 有効化・OAuth クライアントは TF 管理外（runbook 手動手順）
  - Observable: 単体 validate exit 0、`plan` に `identity_platform_config`、パスワードプロバイダの定義が無い
  - _Requirements: 4.1, 4.2, 4.3, 5.2_
  - _Boundary: Auth_

- [ ] 2.3 (P) secrets モジュール（枠のみ）
  - secret 枠 ×5（`line-channel-secret` / `line-channel-access-token` / `gemini-api-key` / `places-api-key` / `db-admin-password`）を作成し secret id を output。**値も accessor IAM も所有しない**
  - Observable: 単体 validate exit 0、`plan` に 5 secret・secret version（値）ゼロ・accessor binding ゼロ
  - _Requirements: 5.1, 5.2_
  - _Boundary: Secrets_

- [ ] 2.4 (P) registry モジュール
  - Artifact Registry の docker リポジトリを 1 つ宣言（Cloud Run デプロイ先。イメージは Docker Hub でなく AR を使う方針）
  - Observable: 単体 validate exit 0、`plan` に docker リポジトリ 1
  - _Requirements: 6.1_
  - _Boundary: Registry_

- [ ] 2.5 (P) grants.sql（IAM DB ユーザーへの GRANT・版管理）
  - `infra/sql/grants.sql` に write-boundary（`db/write-boundary.md`）と整合する GRANT のみ記述（TS 層 3 SA → TS 書込テーブル、Go 層 SA → `competitors`/`rating_snapshots`、両層に read）。ユーザー名はタスク 1.1 の SA 命名規約由来の文字列を参照（terraform 依存なし・psql 実行前提）
  - Observable: `grants.sql` が全 IAM DB ユーザー分の GRANT を列挙し、`psql --set ON_ERROR_STOP=on -f`（ローカル PG16 でユーザーを仮作成した dry-run）で構文エラーゼロ
  - _Requirements: 3.2_
  - _Boundary: DatabaseGrants_

- [ ] 3. Core: 実行系モジュール（SA・DB user・accessor を自モジュールに co-locate・並列）
- [ ] 3.1 (P) run-services モジュール
  - ユーザー管理 SA ×3（命名規約準拠・Compute default SA 不使用）、Cloud Run v2 service ×3（`for_each`・hello placeholder image + `lifecycle.ignore_changes=[image]`・`ingress=INGRESS_TRAFFIC_ALL`・invoker を `allUsers`・`min_instance_count=0`）、自 SA 分の secret accessor binding（secret 単位・計 3: webhook→`line-channel-secret`+`line-channel-access-token`、survey-web→`gemini-api-key`、dashboard-api→なし）、自 SA 分の IAM DB ユーザー（`google_sql_user` type=CLOUD_IAM_SERVICE_ACCOUNT・password なし・`instance` は Database output を変数受け）、`roles/cloudsql.client`+`roles/cloudsql.instanceUser`、接続名 env。secret id・接続名は変数入力（配線は 4.3）
  - Observable: 単体 validate exit 0、`plan` に 3 service + 3 SA + 3 invoker binding + **3 accessor binding** + 3 IAM DB user・`min_instance_count>0` 皆無・SA JSON キー生成皆無
  - _Requirements: 2.1, 2.2, 2.6, 2.7, 5.2, 5.3, 5.4, 6.4, 7.3_
  - _Boundary: RunServices_

- [ ] 3.2 (P) batch-job モジュール
  - job 専用 SA、Cloud Run v2 job（hello placeholder image + `ignore_changes=[image]`・`max_retries=1`・`task_timeout=30m`）、Cloud Scheduler（cron `0 6 * * *`・`Asia/Tokyo`・target は `run.googleapis.com/v2/.../jobs/daily-batch:run`・**`oauth_token`**（OIDC でない）・scheduler SA に `roles/run.invoker`）、`places-api-key` の accessor binding、自 SA 分の IAM DB ユーザー（password なし・`instance` は Database output）、`roles/cloudsql.client`+`instanceUser`。失敗**検知**（アラートポリシー）は Guardrails 所有のため本モジュールには置かない
  - Observable: 単体 validate exit 0、`plan` に job + scheduler + job SA + scheduler SA invoker + 1 accessor + 1 IAM DB user、scheduler が `oauth_token` を使用。Job 実行履歴が要件 2.5 の「記録」を満たす
  - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 5.2, 5.3, 5.4_
  - _Boundary: BatchJob_

- [ ] 4. Integration: CI 認証・ガードレール・root 配線・runbook
- [ ] 4.1 (P) cicd-wif モジュール + WIF 検証ワークフロー
  - `google_iam_workload_identity_pool` + `_provider`（GitHub OIDC issuer・attribute mapping `attribute.repository=assertion.repository`・`attribute_condition` に `assertion.repository == var.github_repository`）、principalSet へ `roles/run.developer` + `roles/artifactregistry.writer` + 各ランタイム SA への `roles/iam.serviceAccountUser`（SA email は変数入力・配線は 4.3）。**deployer SA を作らない**（Direct WIF）。`.github/workflows/gcp-auth-smoke.yml`（`google-github-actions/auth@v2`・`workload_identity_provider` のみ・`service_account` 入力なし・`workflow_dispatch`・`gcloud run services list` まで）
  - Observable: 単体 validate exit 0、`plan` に pool+provider（`attribute_condition` に `github_repository` が反映）・SA キー resource 皆無。ワークフローが SA キーなしで認証する構成
  - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - _Boundary: CicdWif_

- [ ] 4.2 (P) guardrails モジュール
  - `google_monitoring_notification_channel`（email=`alert_email`）、`google_billing_budget`（`budget_amount_jpy`・`budget_filter.projects=[fwlm]`・threshold 50/90/100%・通知チャネル配線）、`google_cloud_quotas_quota_preference`（`places.googleapis.com`・**quota_id は実装時に `gcloud`/Cloud Quotas で実名確認してから固定**・推測で書かない）、daily-batch 失敗の `google_monitoring_alert_policy`（BatchJob の Job を名前で参照・通知チャネルへ配線）
  - Observable: 単体 validate exit 0、`plan` に budget（threshold 3 本）+ quota preference（places）+ notification channel + alert policy（channel と job に接続）
  - _Requirements: 2.5, 7.1, 7.2, 7.3_
  - _Boundary: Guardrails_

- [ ] 4.3 root モジュール配線 + outputs
  - `envs/prod/main.tf` に全 9 モジュール呼び出しを依存方向どおり配線し、モジュール間 output→変数を解決（database 接続名→run-services/batch-job、secrets secret id→run-services/batch-job、run-services/batch-job SA email→cicd-wif、batch-job Job→guardrails）。`outputs.tf` に service URL・SQL 接続名・WIF provider 名
  - Observable: root で `terraform init`（backend 有効・要 state bucket）後 `terraform validate` exit 0、全モジュール参照が解決、`terraform graph` に循環なし
  - _Requirements: 1.2, 1.5_
  - _Depends: 1.2, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 4.1, 4.2_

- [ ] 4.4 bootstrap runbook（infra/README.md）
  - IaC 例外リスト（プロジェクト作成 / billing 紐付け / GCS state bucket 作成（versioning 有効）/ Terraform 実行者の初期 API 有効化 / OAuth 同意画面 + Google IdP 有効化 / secret 値投入 / `postgres` 管理パスワード設定）、`make tf-*` 手順と実行者権限（Owner 相当 + billing account への `roles/billing.costsManager`）、`identity_platform_config` 既有効化時の `terraform import` 手順、migration 適用手順（Auth Proxy + psql → `db/migrations/*.sql` 番号順 → `infra/sql/grants.sql`）、staging 論理 DB（`fwlm_staging`）追加手順と「追加インスタンス禁止」明記、CI デプロイ契約（イメージ更新のみ・構成変更は Terraform 専権）、dev はローカル `make db-*` 完結の境界宣言
  - Observable: runbook が全手動手順を列挙し、各 IaC 例外に対応する具体手順が存在する
  - _Requirements: 1.2, 3.2, 3.5, 4.1, 8.1, 8.2, 8.3_
  - _Depends: 4.3_

- [ ] 5. Validation: 静的検証と apply 後の観察可能検証
- [ ] 5.1 静的検証（apply 前・GCP 不要）
  - 全モジュール + root で `terraform fmt -check` / `validate`、`terraform plan` 出力に平文 secret / password / client_secret が皆無であること、`plan` に VPC connector / Load Balancer / `min_instance_count>0` / SA JSON キー / dev 専用リソースが存在しないことを確認
  - Observable: fmt-check + validate exit 0、`plan` の grep で禁止パターン 0 件（秘匿値ゼロ・常時課金リソースは Cloud SQL のみ）
  - _Requirements: 1.3, 5.2, 6.2, 7.3, 8.1_
  - _Depends: 4.3_

- [ ] 5.2 apply 後: CI・実行系の稼働検証
  - runbook 手順で `make tf-apply`（人間・billing IAM）実行後、`make tf-plan` が差分ゼロ、`gcp-auth-smoke.yml` を `workflow_dispatch` 起動し WIF 認証 + `gcloud run services list` 成功、`attribute_condition` に対象リポジトリのみ許可されることを provider 定義で確認、`gcloud scheduler jobs run` の手動発火で Job 実行履歴に記録
  - Observable: `tf-plan` 0 差分（冪等）、smoke ワークフロー緑（SA キーなし認証）、scheduler 手動発火で daily-batch の実行履歴が残る
  - _Requirements: 1.3, 2.4, 2.5, 6.1, 6.2, 6.3, 6.4_
  - _Depends: 4.4_

- [ ] 5.3 apply 後: データ・秘匿・コストの検証
  - Auth Proxy + psql で `db/migrations/*.sql` 全適用 + `infra/sql/grants.sql` 適用 → 12 テーブル存在、Auth Proxy を介さない生 5432 直接続が拒否/タイムアウト、各サービス SA で自 secret の `versions access` 成功・他サービスの secret で 403、budget（¥10,000・threshold 3 本）と quota preference（places）を `gcloud`/Console で確認
  - Observable: migration 12 テーブル確認・直接続拒否・accessor 交差 403・budget/quota が可視
  - _Requirements: 3.2, 3.4, 5.2, 5.4, 7.1, 7.2_
  - _Depends: 5.2_

## Implementation Notes

- terraform CLI は環境に未導入だったため `brew install hashicorp/tap/terraform`（v1.15.7・`/opt/homebrew/bin`）で導入済み。以降のタスクは `export PATH="/opt/homebrew/bin:$PATH"` で terraform 利用可。
- 各モジュールは単体 `terraform init -backend=false && validate` で検証する運用。standalone validate には `required_providers` が必須のため、全モジュールに `versions.tf`（`google ~> 7.0`）を置くこと（project-services で確立したパターン）。
- `terraform fmt` はリスト末尾コメントを整列するため、authoring 後に `make tf-fmt`（= `terraform fmt -recursive infra`）を実行してから `fmt -check` すること。
- macOS には `timeout` が無い（GNU coreutils）。長時間コマンドを bound したい場合は `gtimeout`（`brew install coreutils`）か使わない。
- `.terraform.lock.hcl` は現状 gitignore。CI 確立（タスク 4.1）時に `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64` で複数プラットフォーム対応の lock を生成し、root の lock をコミットへ切替える。
- SA 命名規約の単一情報源は `infra/envs/prod/locals.tf`（`sa-webhook`/`sa-survey-web`/`sa-dashboard-api`/`sa-daily-batch`）。database の IAM DB user・grants.sql・cicd-wif は必ずこれを参照し、SA email 文字列を再定義しない。
