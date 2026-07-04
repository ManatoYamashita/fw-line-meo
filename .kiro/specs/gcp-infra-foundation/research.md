# Research & Design Decisions: gcp-infra-foundation

## Summary
- **Feature**: `gcp-infra-foundation`
- **Discovery Scope**: New Feature（グリーンフィールド・フル discovery 実施）
- **Key Findings**:
  - Terraform google provider の現行は v7.x。Cloud Run は `google_cloud_run_v2_service` / `google_cloud_run_v2_job` が現行リソース（v1 は legacy）。GCS backend の state ロックは標準装備で追加設定不要。
  - Cloud SQL PostgreSQL 16 は Enterprise edition で shared-core `db-f1-micro` が利用可能（SLA 対象外だが MVP には十分）。東京リージョン概算 $13–16/月で、これが唯一の常時課金リソースになる。
  - IAM データベース認証（`google_sql_user` type=`CLOUD_IAM_SERVICE_ACCOUNT`）を採用すると、ランタイムの DB パスワードが Terraform state にも Secret Manager にも一切存在しなくなる（Req 5.2 を構造的に満たす）。
  - Direct WIF（SA impersonation なし）が現行推奨。`attribute_condition = "assertion.repository == '<owner>/<repo>'"` で単一リポジトリに制限できる。
  - `google_identity_platform_config` は一度作成すると削除不可。Console/Firebase で既に有効化済みの場合は `terraform import` で取り込む。

## Research Log

### ローカル GCP スキル群のカバレッジ（/google 指示）
- **Context**: ユーザー指示によりローカルの Google Cloud スキル群（`.claude/skills/` → `.agents/skills/` symlink）を設計調査に活用。
- **Sources Consulted**: `cloud-run-basics`（SKILL.md / iac-usage.md / iam-security.md）、`cloud-sql-basics`（iac-usage.md / iam-security.md / core-concepts.md）、`firebase-basics`（iac-usage.md）、`google-cloud-recipe-auth`、`google-cloud-waf-cost-optimization`
- **Findings**:
  - Cloud Run: v2 リソースの TF 例あり。ingress は `all` / `internal` / `internal-and-cloud-load-balancing`。サービスごとにユーザー管理 SA を割当て、Compute default SA に依存しないこと。コンテナは `0.0.0.0:$PORT` で listen 必須。イメージは Artifact Registry を使う（Docker Hub はキャッシュ問題）。
  - Cloud SQL: TF 例の `password = "changeme"` ハードコードは state 漏洩アンチパターン。IAM DB 認証（PostgreSQL 対応・`roles/cloudsql.instanceUser`）が推奨。Cloud Run からは Auth Proxy 系接続＋`roles/cloudsql.client`。
  - Firebase/Identity Platform: `google_identity_platform_config` は google-beta provider。個別 IdP 有効化のローカル例は無し。
  - Secret Manager / WIF / Budget / Terraform レイアウトはローカルスキル未収録 → 外部一次情報で補完（下記）。
- **Implications**: Cloud Run・Cloud SQL・Firebase はローカルスキルの型を踏襲。それ以外は provider 公式ドキュメント準拠で設計。

### Terraform provider と Cloud Run リソース世代
- **Sources Consulted**: HashiCorp blog（provider 7.0 GA, 2025-08）、provider releases
- **Findings**: 現行メジャー v7.x。`google_cloud_run_v2_service` / `_job` が現行。v2 系では `network_interfaces` と `connector` が排他。7.0 で write-only 属性導入（Terraform 1.11+）。
- **Implications**: `required_providers { google = "~> 7.0" }` を採用。v1 Cloud Run リソースは使用禁止。

### Cloud SQL PG16 最小構成とコスト
- **Sources Consulted**: docs.cloud.google.com/sql（create-instance / machine-series-overview / pricing）
- **Findings**: PG Enterprise edition で `db-f1-micro`（shared-core・ZONAL・SLA 対象外）が利用可能。SSD 10GB＋自動バックアップ 7 世代で東京概算 $13–16/月（要 pricing calculator 確定）。PITR は WAL ストレージ課金増のため MVP では無効。
- **Implications**: `edition = "ENTERPRISE"`, `tier = "db-f1-micro"`, `availability_type = "ZONAL"`, `disk_size = 10`。

### Cloud Run → Cloud SQL 接続パターン（2026）
- **Sources Consulted**: docs.cloud.google.com/sql/docs/postgres/connect-run
- **Findings**: private IP なし MVP では (a) built-in Cloud SQL 接続（unix socket `/cloudsql/...`）か (b) Cloud SQL Language Connector。Serverless VPC Access connector は常時 VM 課金（$14+/月）で不利・新規非推奨方向。後継の Direct VPC egress は private IP + VPC 設定が前提。built-in socket は自動 IAM 認証非対応、Language Connector（Node: `@google-cloud/cloud-sql-connector` / Go: `cloudsqlconn`)は auto-IAM-authn 対応。
- **Implications**: 合意済み「Cloud SQL Connector」= Language Connector + IAM DB 認証で確定。VPC リソースは一切作らない（ゼロ常時課金維持）。private IP + Direct VPC egress は第2フェーズの昇格パス。

### WIF for GitHub Actions
- **Sources Consulted**: github.com/google-github-actions/auth（@v2 README）、IAM WIF deployment-pipelines docs
- **Findings**: Direct WIF（`principalSet://.../attribute.repository/<owner>/<repo>` へ直接 IAM 付与・SA 不在）が推奨。SA impersonation が必要なのは Firebase Admin SDK・signBlob・DWD 等の federated token 非対応箇所のみ（本 spec のデプロイ操作には不要）。attribute mapping `attribute.repository = assertion.repository` ＋ `attribute_condition` で単一リポ制限。`assertion.repository_owner` での owner 制限も併用推奨。
- **Implications**: deployer SA を作らない Direct WIF を採用。principalSet へ `roles/run.developer`・`roles/artifactregistry.writer`・各ランタイム SA への `roles/iam.serviceAccountUser` を付与。

### Identity Platform の Terraform 化の癖
- **Sources Consulted**: registry.terraform.io（identity_platform_config）、provider GH issue #17322
- **Findings**: config は初期化時に一度だけ作成・削除不可。billing 有効プロジェクト必須。Console/Firebase で既有効化済みだと作成時エラー → `terraform import` が定石。Google IdP（`google_identity_platform_default_supported_idp_config`）は OAuth client id/secret を引数に取る＝**client secret が TF state に平文で入る**。
- **Implications**: TF 管理は `identity_platform_config`（＋`google_firebase_project`）まで。**Google IdP の有効化は bootstrap runbook の手動 Console 手順**とし、Req 5.2（state に平文を残さない）を守る。

### Cloud Scheduler → Cloud Run Job 起動
- **Sources Consulted**: docs.cloud.google.com/run/docs/execute/jobs-on-schedule、scheduler http-target-auth
- **Findings**: `http_target` で POST `https://run.googleapis.com/v2/projects/{P}/locations/{R}/jobs/{J}:run`。`*.googleapis.com` 宛は **`oauth_token`**（`oidc_token` ではない）に SA email を指定。必要ロールは当該 SA への `roles/run.invoker` のみ。実行は非同期で即 200。
- **Implications**: scheduler 専用 SA を 1 つ作成し Job に invoker 付与。ジョブ失敗はスケジューラには返らないため、失敗検知は Monitoring アラート側で担う。

### Billing Budget と API クォータ
- **Sources Consulted**: registry.terraform.io（billing_budget / service_usage_consumer_quota_override）、service-usage terraform-integration docs、provider GH issue #25478
- **Findings**: `google_billing_budget` は請求先アカウントレベル権限（`roles/billing.costsManager` 等）を実行プリンシパルに要求。`budget_filter.projects` で単一プロジェクトに絞れる。クォータ上限は現行 GA の `google_cloud_quotas_quota_preference` を推奨（旧 consumer_quota_override は beta）。Places API (New) のサービス名は `places.googleapis.com`（旧 `places-backend.googleapis.com`）。正確な quota_id/metric 名は実プロジェクトで要確認。
- **Implications**: budget を含む terraform apply は billing IAM を持つ人間が実行（CI からは実行しない）。quota_id は実装タスク時に `gcloud`/Cloud Quotas コンソールで実名確認してから固定。

### GCS backend
- **Sources Consulted**: developer.hashicorp.com/terraform（state/locking, backends/gcs）
- **Findings**: GCS backend はネイティブロックがデフォルト有効（S3 の `use_lockfile` とは別物・追加設定不要）。versioning 有効化＋uniform bucket-level access を推奨。
- **Implications**: bootstrap で state バケットを手動作成（versioning 有効）。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| env-per-dir（envs/dev, envs/prod） | 環境ごとにルートモジュールを複製 | 環境差分が明示的 | dev クラウド環境を持たない本件では空回り | 不採用（dev はローカル完結が合意事項） |
| **単一 env + modules/ 分割（採用）** | `envs/prod` 1 つ＋機能領域別モジュール | 合意事項（単一プロジェクト）に一致・将来分離の退路を維持 | モジュール境界の設計規律が必要 | 採用 |
| Terraform workspaces | 同一コードで複数 state | 手軽 | 環境差分が暗黙化しやすい | 不採用 |
| Direct WIF | principalSet へ直接 IAM 付与 | SA・キー・impersonation 全部不要 | federated token 非対応 API では使えない | 採用（デプロイ操作は全て対応） |
| WIF + SA impersonation | deployer SA を経由 | 非対応 API もカバー | SA が増え attack surface 拡大 | 不採用（必要になった時点で追加） |

## Design Decisions

### Decision: ランタイム DB 認証は IAM データベース認証（パスワードレス）
- **Context**: Req 5.2（シークレットを state に残さない）と合意済み「DB パスワードを Secret Manager 管理」の整合。`google_sql_user` のパスワードは state に平文で残る。
- **Alternatives Considered**:
  1. パスワード認証＋Secret Manager — 値の投入経路が増え、TF で user を作るなら state 漏洩
  2. IAM DB 認証（type=CLOUD_IAM_SERVICE_ACCOUNT）— パスワード自体が存在しない
- **Selected Approach**: ランタイム SA（TS 層・Go 層）は IAM DB 認証。`postgres` 管理ユーザーのパスワードのみ Secret Manager に枠を確保し、値は runbook で out-of-band 投入（migration・運用作業用）。
- **Rationale**: パスワードレスが最小攻撃面・最小運用。合意済みの「DB パスワード」枠は管理ユーザー用として存続。
- **Trade-offs**: アプリ実装側は Language Connector + auto-IAM-authn の利用が前提になる（後続 spec への Revalidation Trigger）。
- **Follow-up**: DB 内 GRANT（IAM ユーザーへの権限付与 SQL）は migration ではなく runbook 手順とするか実装タスクで確定。

### Decision: Google IdP 有効化は Terraform 外（手動 Console 手順）
- **Context**: `default_supported_idp_config` は OAuth client secret を TF state に平文で持ち込む＝Req 5.2 違反。
- **Selected Approach**: TF は `identity_platform_config` の有効化まで。Google ログインプロバイダの有効化・OAuth クライアント設定は bootstrap runbook の手動手順。
- **Trade-offs**: IaC カバレッジが 1 手順分欠ける（Req 1.2 の例外として runbook に明記）。
- **Follow-up**: 将来 client secret の write-only 属性対応が provider に入れば TF 化を再検討。

### Decision: terraform apply は人間実行、CI はアプリデプロイのみ（MVP）
- **Context**: billing budget が請求先アカウント IAM を要求。CI principalSet に billing 権限を撒くのは過剰。
- **Selected Approach**: `make tf-plan` / `tf-apply` を owner 権限の人間がローカル実行。CI（WIF）はイメージ push と Cloud Run デプロイ権限のみ。
- **Rationale**: 権限分離が明確・MVP のインフラ変更頻度は低い。
- **Trade-offs**: インフラ変更に人手が要る（許容）。
- **Follow-up**: 第2フェーズで CI plan（PR コメント）導入を検討。

### Decision: Cloud Run サービスは placeholder イメージで作成し、image は lifecycle ignore
- **Context**: アプリコード未着手のため実イメージが存在しない。TF がサービス定義を、CI がリビジョン（イメージ）を所有する分業。
- **Selected Approach**: 初期イメージは Google 公開の hello イメージ（`us-docker.pkg.dev/cloudrun/container/hello`）。`lifecycle { ignore_changes = [template[0].containers[0].image] }` で CI デプロイと衝突させない。
- **Trade-offs**: TF state 上のイメージと実リビジョンが乖離する（意図した設計）。

### Synthesis 結果（Generalization / Build vs Adopt / Simplification）
- **Generalization**: Cloud Run サービス 3 つは同一パターン（SA + service + invoker + secret accessor）→ `run-services` モジュール内で for_each によるサービス定義マップに一般化。インターフェース（サービス定義 map）を一般化し、実装は 3 サービス分のみ。
- **Build vs Adopt**: 認証は Identity Platform（自前認証を作らない）、CI 認証は google-github-actions/auth@v2（自前トークン交換を書かない）、state ロックは GCS ネイティブ（外部ロック機構不要）。すべて adopt。
- **Simplification**: VPC・Serverless VPC connector・Load Balancer・カスタムドメイン・deployer SA・dev 環境リソースを全て排除。モジュールは 9 個に留め、1 モジュール = 1 責務。

### Decision: 設計レビュー（/kiro-validate-design）反映 3 件
- **Context**: GO 判定に付帯した 3 つの Critical Issue をユーザー承認のうえ design.md に反映（2026-07-04）。
- **反映内容**:
  1. **CI デプロイ契約**: CI はイメージ更新（`gcloud run services/jobs update --image`）のみ許可。構成変更は Terraform 専権。`ignore_changes=[image]` の範囲外 drift による冪等性（1.3）崩壊を防ぐ。
  2. **`line-channel-access-token` を secret 枠に追加**（枠 ×4 → ×5）: 機能1 の毎朝 Push 配信・機能3 の応答に必須のため初期から枠を確保（5.1）。webhook SA に accessor 付与。
  3. **GRANT SQL の版管理化**: IAM DB ユーザーへの GRANT を runbook 内の生 SQL ではなく `infra/sql/grants.sql` として版管理（1.2 の精神・再現性）。

### Decision: タスクグラフ・サニティレビュー反映（モジュール循環の全面除去）
- **Context**: `/kiro-spec-tasks` の独立サニティレビューが NEEDS_FIXES を返し、`secrets ↔ run-services` と同型の循環が **IAM DB ユーザー**にも残っていたと指摘（database モジュールが consumer の SA を参照）。
- **反映内容**:
  1. **IAM DB ユーザーの co-locate**: `google_sql_user`（type=CLOUD_IAM_SERVICE_ACCOUNT）の作成を database → **run-services / batch-job**（SA を作る側）へ移設。database は instance 名を output するのみ。SA account_id は固定命名規約（`sa-webhook` / `sa-survey-web` / `sa-dashboard-api` / `sa-daily-batch`）とし、`grants.sql` は規約由来の文字列を参照（terraform 依存なし）。
  2. **batch 失敗アラートの所有権を Guardrails に一本化**: 通知チャネルと同じモジュールに `google_monitoring_alert_policy` を集約。BatchJob は Job 実行履歴（要件 2.5 前半）、Guardrails はアラート（2.5 後半）。
  3. **run-services の accessor binding 数を 3 に訂正**（webhook 2 + survey-web 1、dashboard-api 0）。
  4. **authoring 用の cross-module `_Depends` を除去**: モジュールは各 dir で file-disjoint に authoring・`terraform validate` 可能。実依存（output 配線）は root wiring（タスク 4.3）に集約し、そこにのみ全モジュール `_Depends` を置く。これで Core 群の `(P)` 並列主張と依存グラフが一致。
- **Rationale**: 全モジュール境界を非循環・単一所有に。並列安全性（file-disjoint）を設計と一致させた。

## Risks & Mitigations
- **Identity Platform 既有効化との衝突**（作成時 already-enabled エラー）— runbook に `terraform import` 手順を明記
- **Places API quota_id の不確実性** — 実装タスクで実名確認してから固定（推測で書かない）
- **db-f1-micro は SLA 対象外** — MVP では許容。トラフィック増加時に `db-custom-*` へ tier 変更（TF 1 行、再起動を伴う）
- **billing budget の IAM 前提** — apply 実行者要件（billing.costsManager）を runbook に明記
- **hello placeholder のまま公開される期間** — 中身のない応答のみでリスク低。アプリ spec デプロイで解消

## References
- https://www.hashicorp.com/en/blog/terraform-provider-for-google-cloud-7-0-is-now-ga — provider v7 GA
- https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloud_run_v2_service — Cloud Run v2
- https://docs.cloud.google.com/sql/docs/postgres/connect-run — Cloud Run→SQL 接続パターン
- https://docs.cloud.google.com/sql/docs/postgres/create-instance — PG16 / tier
- https://github.com/google-github-actions/auth — Direct WIF 推奨と attribute condition
- https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/identity_platform_config — 削除不可の注意
- https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/billing_budget — billing IAM 要件
- https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule — Scheduler→Job（oauth_token）
- https://developer.hashicorp.com/terraform/language/state/locking — GCS ネイティブロック
- ローカル: `.claude/skills/cloud-run-basics` / `cloud-sql-basics` / `firebase-basics` / `google-cloud-recipe-auth` / `google-cloud-waf-cost-optimization`
