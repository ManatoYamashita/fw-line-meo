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
- [x] 2.1 (P) database モジュール
  - Cloud SQL PostgreSQL 16 / `edition=ENTERPRISE` / `tier=db-f1-micro` / `availability_type=ZONAL` / SSD 10GB / `deletion_protection=true`、`backup_configuration`（有効・7 世代・PITR 無効）、`database_flags` に `cloudsql.iam_authentication=on`、`authorized_networks` 空、論理 DB `fwlm`。**IAM DB ユーザーは作らない**（consumer 側で co-locate）。instance 接続名を output
  - Observable: 単体 validate exit 0、`plan` に 1 インスタンス・backup 有効・iam 認証 on・authorized_networks 空・`google_sql_user` 不在
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 5.2, 7.3_
  - _Boundary: Database_

- [x] 2.2 (P) auth モジュール
  - `google_firebase_project` + `google_identity_platform_config`（google-beta・`deletion_policy=ABANDON`）。Google IdP 有効化・OAuth クライアントは TF 管理外（runbook 手動手順）
  - Observable: 単体 validate exit 0、`plan` に `identity_platform_config`、パスワードプロバイダの定義が無い
  - _Requirements: 4.1, 4.2, 4.3, 5.2_
  - _Boundary: Auth_

- [x] 2.3 (P) secrets モジュール（枠のみ）
  - secret 枠 ×5（`line-channel-secret` / `line-channel-access-token` / `gemini-api-key` / `places-api-key` / `db-admin-password`）を作成し secret id を output。**値も accessor IAM も所有しない**
  - Observable: 単体 validate exit 0、`plan` に 5 secret・secret version（値）ゼロ・accessor binding ゼロ
  - _Requirements: 5.1, 5.2_
  - _Boundary: Secrets_

- [x] 2.4 (P) registry モジュール
  - Artifact Registry の docker リポジトリを 1 つ宣言（Cloud Run デプロイ先。イメージは Docker Hub でなく AR を使う方針）
  - Observable: 単体 validate exit 0、`plan` に docker リポジトリ 1
  - _Requirements: 6.1_
  - _Boundary: Registry_

- [x] 2.5 (P) grants.sql（IAM DB ユーザーへの GRANT・版管理）
  - `infra/sql/grants.sql` に write-boundary（`db/write-boundary.md`）と整合する GRANT のみ記述（TS 層 3 SA → TS 書込テーブル、Go 層 SA → `competitors`/`rating_snapshots`、両層に read）。ユーザー名はタスク 1.1 の SA 命名規約由来の文字列を参照（terraform 依存なし・psql 実行前提）
  - Observable: `grants.sql` が全 IAM DB ユーザー分の GRANT を列挙し、`psql --set ON_ERROR_STOP=on -f`（ローカル PG16 でユーザーを仮作成した dry-run）で構文エラーゼロ
  - _Requirements: 3.2_
  - _Boundary: DatabaseGrants_

- [ ] 3. Core: 実行系モジュール（SA・DB user・accessor を自モジュールに co-locate・並列）
- [x] 3.1 (P) run-services モジュール
  - ユーザー管理 SA ×3（命名規約準拠・Compute default SA 不使用）、Cloud Run v2 service ×3（`for_each`・hello placeholder image + `lifecycle.ignore_changes=[image]`・`ingress=INGRESS_TRAFFIC_ALL`・invoker を `allUsers`・`min_instance_count=0`）、自 SA 分の secret accessor binding（secret 単位・計 3: webhook→`line-channel-secret`+`line-channel-access-token`、survey-web→`gemini-api-key`、dashboard-api→なし）、自 SA 分の IAM DB ユーザー（`google_sql_user` type=CLOUD_IAM_SERVICE_ACCOUNT・password なし・`instance` は Database output を変数受け）、`roles/cloudsql.client`+`roles/cloudsql.instanceUser`、接続名 env。secret id・接続名は変数入力（配線は 4.3）
  - Observable: 単体 validate exit 0、`plan` に 3 service + 3 SA + 3 invoker binding + **3 accessor binding** + 3 IAM DB user・`min_instance_count>0` 皆無・SA JSON キー生成皆無
  - _Requirements: 2.1, 2.2, 2.6, 2.7, 5.2, 5.3, 5.4, 6.4, 7.3_
  - _Boundary: RunServices_

- [x] 3.2 (P) batch-job モジュール
  - job 専用 SA、Cloud Run v2 job（hello placeholder image + `ignore_changes=[image]`・`max_retries=1`・`task_timeout=30m`）、Cloud Scheduler（cron `0 6 * * *`・`Asia/Tokyo`・target は `run.googleapis.com/v2/.../jobs/daily-batch:run`・**`oauth_token`**（OIDC でない）・scheduler SA に `roles/run.invoker`）、`places-api-key` の accessor binding、自 SA 分の IAM DB ユーザー（password なし・`instance` は Database output）、`roles/cloudsql.client`+`instanceUser`。失敗**検知**（アラートポリシー）は Guardrails 所有のため本モジュールには置かない
  - Observable: 単体 validate exit 0、`plan` に job + scheduler + job SA + scheduler SA invoker + 1 accessor + 1 IAM DB user、scheduler が `oauth_token` を使用。Job 実行履歴が要件 2.5 の「記録」を満たす
  - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 5.2, 5.3, 5.4_
  - _Boundary: BatchJob_

- [ ] 4. Integration: CI 認証・ガードレール・root 配線・runbook
- [x] 4.1 (P) cicd-wif モジュール + WIF 検証ワークフロー
  - `google_iam_workload_identity_pool` + `_provider`（GitHub OIDC issuer・attribute mapping `attribute.repository=assertion.repository`・`attribute_condition` に `assertion.repository == var.github_repository`）、principalSet へ `roles/run.developer` + `roles/artifactregistry.writer` + 各ランタイム SA への `roles/iam.serviceAccountUser`（SA email は変数入力・配線は 4.3）。**deployer SA を作らない**（Direct WIF）。`.github/workflows/gcp-auth-smoke.yml`（`google-github-actions/auth@v2`・`workload_identity_provider` のみ・`service_account` 入力なし・`workflow_dispatch`・`gcloud run services list` まで）
  - Observable: 単体 validate exit 0、`plan` に pool+provider（`attribute_condition` に `github_repository` が反映）・SA キー resource 皆無。ワークフローが SA キーなしで認証する構成
  - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - _Boundary: CicdWif_

- [x] 4.2 (P) guardrails モジュール
  - `google_monitoring_notification_channel`（email=`alert_email`）、`google_billing_budget`（`budget_amount_jpy`・`budget_filter.projects=[fwlm]`・threshold 50/90/100%・通知チャネル配線）、`google_cloud_quotas_quota_preference`（`places.googleapis.com`・**quota_id は実装時に `gcloud`/Cloud Quotas で実名確認してから固定**・推測で書かない）、daily-batch 失敗の `google_monitoring_alert_policy`（BatchJob の Job を名前で参照・通知チャネルへ配線）
  - Observable: 単体 validate exit 0、`plan` に budget（threshold 3 本）+ quota preference（places）+ notification channel + alert policy（channel と job に接続）
  - _Requirements: 2.5, 7.1, 7.2, 7.3_
  - _Boundary: Guardrails_

- [x] 4.3 root モジュール配線 + outputs
  - `envs/prod/main.tf` に全 9 モジュール呼び出しを依存方向どおり配線し、モジュール間 output→変数を解決（database 接続名→run-services/batch-job、secrets secret id→run-services/batch-job、run-services/batch-job SA email→cicd-wif、batch-job Job→guardrails）。`outputs.tf` に service URL・SQL 接続名・WIF provider 名
  - Observable: root で `terraform init`（backend 有効・要 state bucket）後 `terraform validate` exit 0、全モジュール参照が解決、`terraform graph` に循環なし
  - _Requirements: 1.2, 1.5_
  - _Depends: 1.2, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 4.1, 4.2_

- [x] 4.4 bootstrap runbook（infra/README.md）
  - IaC 例外リスト（プロジェクト作成 / billing 紐付け / GCS state bucket 作成（versioning 有効）/ Terraform 実行者の初期 API 有効化 / OAuth 同意画面 + Google IdP 有効化 / secret 値投入 / `postgres` 管理パスワード設定）、`make tf-*` 手順と実行者権限（Owner 相当 + billing account への `roles/billing.costsManager`）、`identity_platform_config` 既有効化時の `terraform import` 手順、migration 適用手順（Auth Proxy + psql → `db/migrations/*.sql` 番号順 → `infra/sql/grants.sql`）、staging 論理 DB（`fwlm_staging`）追加手順と「追加インスタンス禁止」明記、CI デプロイ契約（イメージ更新のみ・構成変更は Terraform 専権）、dev はローカル `make db-*` 完結の境界宣言
  - Observable: runbook が全手動手順を列挙し、各 IaC 例外に対応する具体手順が存在する
  - _Requirements: 1.2, 3.2, 3.5, 4.1, 8.1, 8.2, 8.3_
  - _Depends: 4.3_

- [ ] 5. Validation: 静的検証と apply 後の観察可能検証
- [x] 5.1 静的検証（apply 前・GCP 不要）
  - 全モジュール + root で `terraform fmt -check` / `validate`、`terraform plan` 出力に平文 secret / password / client_secret が皆無であること、`plan` に VPC connector / Load Balancer / `min_instance_count>0` / SA JSON キー / dev 専用リソースが存在しないことを確認
  - Observable: fmt-check + validate exit 0、`plan` の grep で禁止パターン 0 件（秘匿値ゼロ・常時課金リソースは Cloud SQL のみ）
  - _Requirements: 1.3, 5.2, 6.2, 7.3, 8.1_
  - _Depends: 4.3_

- [x] 5.2 apply 後: CI・実行系の稼働検証（実 GCP gen-fw-line-meo で検証済み）
  - runbook 手順で `make tf-apply`（人間・billing IAM）実行後、`make tf-plan` が差分ゼロ、`gcp-auth-smoke.yml` を `workflow_dispatch` 起動し WIF 認証 + `gcloud run services list` 成功、`attribute_condition` に対象リポジトリのみ許可されることを provider 定義で確認、`gcloud scheduler jobs run` の手動発火で Job 実行履歴に記録
  - Observable: `tf-plan` 0 差分（冪等）、smoke ワークフロー緑（SA キーなし認証）、scheduler 手動発火で daily-batch の実行履歴が残る
  - _Requirements: 1.3, 2.4, 2.5, 6.1, 6.2, 6.3, 6.4_
  - _Depends: 4.4_
  - _Verified(live): `terraform apply` 完了（65 リソース）→ `plan` 差分ゼロ（Req 1.3 ✓）。`gcloud scheduler jobs run daily-batch-trigger` で実行 daily-batch-l2ww8 が履歴に記録（Req 2.4/2.5 ✓）。PR #11 マージ後、gcp-auth-smoke ワークフロー（run 28738415700）が **success**: 「Authenticate (Direct WIF, no SA key)」「list Cloud Run services」ステップ成功＝キーレス認証がエンドツーエンド動作（Req 6.1/6.2/6.3 ✓）。デプロイ失敗時の旧リビジョン維持は Cloud Run リビジョン機構で担保（Req 6.4）。_

- [x] 5.3 apply 後: データ・秘匿・コストの検証（実 GCP gen-fw-line-meo で検証済み）
  - Auth Proxy + psql で `db/migrations/*.sql` 全適用 + `infra/sql/grants.sql` 適用 → 12 テーブル存在、Auth Proxy を介さない生 5432 直接続が拒否/タイムアウト、各サービス SA で自 secret の `versions access` 成功・他サービスの secret で 403、budget（¥10,000・threshold 3 本）と quota preference（places）を `gcloud`/Console で確認
  - Observable: migration 12 テーブル確認・直接続拒否・accessor 交差 403・budget/quota が可視
  - _Requirements: 3.2, 3.4, 5.2, 5.4, 7.1, 7.2_
  - _Depends: 5.2_
  - _Verified(live): Auth Proxy 経由で migration + grants(`-v project=gen-fw-line-meo`) 適用 → 12 テーブル（Req 3.2 ✓）。実 IAM DB ユーザーで境界確認（webhook→stores 可/competitors 不可、batch→rating_snapshots 可/operators 不可・Req 5.4 ✓）。公開 IP 34.146.212.7:5432 への直接続は timeout（Req 3.4 ✓）。IAM DB ユーザーは password 属性なし（Req 5.2 ✓）。billing budget「fwlm monthly budget」¥10,000 を確認（Req 7.1 ✓）。_
  - _Verified(2): Places API の quota preference（Req 7.2 ✓）を Cloud Quotas API で実名確認し、バッチが使う日次エンドポイント（SearchText / SearchNearby / GetPlace の PerDayPerProject）を各 1000/日に上限設定。3 preference が apply 済み・Cloud Quotas API で preferred_value=1000 を確認・plan 差分ゼロ。guardrails モジュールは複数 quota を map で受ける形に拡張。_

## Implementation Notes

- terraform CLI は環境に未導入だったため `brew install hashicorp/tap/terraform`（v1.15.7・`/opt/homebrew/bin`）で導入済み。以降のタスクは `export PATH="/opt/homebrew/bin:$PATH"` で terraform 利用可。
- 各モジュールは単体 `terraform init -backend=false && validate` で検証する運用。standalone validate には `required_providers` が必須のため、全モジュールに `versions.tf`（`google ~> 7.0`）を置くこと（project-services で確立したパターン）。
- `terraform fmt` はリスト末尾コメントを整列するため、authoring 後に `make tf-fmt`（= `terraform fmt -recursive infra`）を実行してから `fmt -check` すること。
- macOS には `timeout` が無い（GNU coreutils）。長時間コマンドを bound したい場合は `gtimeout`（`brew install coreutils`）か使わない。
- `.terraform.lock.hcl` は現状 gitignore。CI 確立（タスク 4.1）時に `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64` で複数プラットフォーム対応の lock を生成し、root の lock をコミットへ切替える。
- SA 命名規約の単一情報源は `infra/envs/prod/locals.tf`（`sa-webhook`/`sa-survey-web`/`sa-dashboard-api`/`sa-daily-batch`）。database の IAM DB user・grants.sql・cicd-wif は必ずこれを参照し、SA email 文字列を再定義しない。
- `google-beta` provider の初回 DL は重い（~150MB）。`terraform init` は registry 往復でネットワーク待ちに陥ることがある。回避策: 同一 provider で初期化済みモジュール（例 project-services）の `.terraform` と `.terraform.lock.hcl` を検証対象モジュールにコピーして `validate` する（オフライン・高速）。または `TF_PLUGIN_CACHE_DIR` を種付けして共有。
- Cloud SQL の IAM DB ユーザー名 = SA email から `.gserviceaccount.com` を除いた形（例 `sa-webhook@fwlm.iam`）。`@`/`.` を含むため SQL では二重引用符が必要。`grants.sql` は psql の `:"var"`（識別子引用展開）を使う。task 3.x の `google_sql_user` も `name = "<account_id>@<project>.iam"` 形式で作る。
- grants.sql のローカル dry-run: scratchpad パスは unix socket の 103byte 制限を超える。native PG は `-c unix_socket_directories=''`（unix socket 無効）+ `listen_addresses=127.0.0.1` で起動し TCP 接続する。
- `google_identity_platform_config` は `deletion_policy` 引数を持たない。削除不可の事故防止は `lifecycle { prevent_destroy = true }` を使用（auth モジュールで確立）。
- `google_cloud_run_v2_job` は **template が二重ネスト**（`template { template { containers {...} } }`）。image の `ignore_changes` パスは `template[0].template[0].containers[0].image`（service は `template[0].containers[0].image`）。
- Scheduler → Cloud Run v2 job 起動: `google_cloud_scheduler_job.http_target.uri = "https://run.googleapis.com/v2/projects/${p}/locations/${r}/jobs/${name}:run"` + `oauth_token`（`*.googleapis.com` 宛は OIDC でなく OAuth）。scheduler SA に `roles/run.invoker`。
- batch-job は job SA（`sa-daily-batch`・DB/Places アクセス）と scheduler SA（`sa-scheduler`・invoker のみ）を分離。**scheduler SA は DB ユーザーにしない**（grants.sql の 4 ユーザーに含めない）。
- run-services の `services` 変数は `default = {}`。実体 3 サービスの map は Task 4.3 の root 配線で渡す（標準 validate は値不要で成立）。task 4.3 wiring では secret_env に secrets output の secret id、db_instance_name/db_connection_name に database output を渡す。
- run-services には **独立した `secret_ids` 変数は無い**（secret id は `services[].secret_env` が保持）。root から `secret_ids=...` を渡すと `terraform init` が "argument not expected" で失敗する。
- root 配線の offline 検証: `terraform init -backend=false`（`TF_PLUGIN_CACHE_DIR` 種付け + 既存 lock）でローカルモジュール登録＋provider キャッシュ利用。project number は `data "google_project"` で取得し budget filter と WIF principalSet に供給。
- `google_billing_budget` は `billing_account`（project でない）を取り、`specified_amount.units` は **文字列**（`tostring(...)`）。apply には billing account への `roles/billing.costsManager` が必要。
- Places API の `google_cloud_quotas_quota_preference` は `quota_id` を `count` でゲート（既定 "" で非作成）。Req 7.2 充足には runbook 手順で実名確認して `terraform.tfvars` に設定必須。task 5.3 で quota の存在を確認する。
- task 5.1（静的検証）は GCP 不要で完了: root `terraform validate` Success（全9モジュール）+ fmt clean + 禁止パターン静的 grep（VPC connector/LB 不在=Cloud SQL のみ常時課金・min_instance_count 0 のみ・SA JSON キー不在・平文 secret 不在・envs は prod のみ）。plan ベースの部分は config 静的確認で代替（禁止リソースは config に存在しない）。
- task 5.2/5.3 は実 GCP プロジェクト **gen-fw-line-meo**（PROJECT_ID=`fwlm` は 6 文字未満で不可のため既存の空プロジェクトを再利用）に apply して **全項目を live 検証済み**（16/16 サブタスク完了）。WIF ワークフローは PR #11 マージ後に success 確認、Places quota は 3 preference を apply 済み。
- **実 apply で判明した順序依存**（初回 apply は 65→54 成功。以下を対処して収束）:
  1. Cloud Run が `secret_key_ref version=latest` を要求 → 先に secret 値を投入してから再 apply（アプリは hello イメージなので API キー4本はプレースホルダで可・本番前に差し替え）。
  2. IAM DB ユーザーは Cloud SQL の IAM 認証がアクティブになってから（インスタンス作成直後は `role cloudsqliamserviceaccount does not exist` レース）→ 再 apply で解消。
  3. `google_billing_budget` は ADC 利用時 `user_project_override=true`+`billing_project` が必要（provider に追加）。
  4. Cloud Run v2 は `deletion_protection` 既定 true → tainted 置換が阻止される。ステートレス層は `deletion_protection=false`（DB は true 維持）。
  5. `scaling{min_instance_count=0}` は API が既定値を返さず perpetual diff → ブロック削除で既定 0 に（差分ゼロ達成）。
  6. `google_firebase_project` は firebase 固有権限で 403 → 削除し `identity_platform_config` 単独に（認証基盤 Req 4 は成立）。
- gcloud で billing budget を list する際は ADC quota project 制約で `--billing-project=<id>` が必要。
