# fw-line-meo インフラ運用手順（bootstrap runbook）

`gcp-infra-foundation` spec の Terraform（`infra/`）を単一 GCP プロジェクト **`fwlm`**（`asia-northeast1`）へ適用・運用するための手順書。**手動手順の単一情報源**であり、ここに列挙された作業以外は Terraform が宣言的に管理する（Req 1.2）。

- 単一環境ルートモジュール: `infra/envs/prod/`（dev 用クラウド環境は作らない。dev は `make db-*` ローカルハーネスで完結 = Req 8.1/8.2）
- モジュール群: `infra/modules/`（将来のプロジェクト分離の退路として境界を維持 = Req 1.5）

---

## 1. IaC 例外リスト（手動が正当な唯一の集合）

以下は Terraform 管理外。`terraform apply` の前後に人手で実施する。これ以外の手動リソース作成は禁止（Req 1.2 の境界）。

1. **GCP プロジェクト `fwlm` 作成** と **請求先アカウント紐付け**
2. **GCS state バケット作成**（versioning 有効・uniform bucket-level access）。名前は `infra/envs/prod/backend.tf` の `bucket` と一致させる（既定 `fwlm-tfstate`）
3. **Terraform 実行者の初期 API 有効化**: 最低限 `serviceusage`・`cloudresourcemanager`（残りは `project-services` モジュールが有効化）
4. **OAuth 同意画面の設定 + Google ログイン IdP の有効化**（Identity Platform）。client secret を TF state に入れないため手動（Req 5.2）
5. **Secret Manager の値投入**（枠は Terraform 済み・値は out-of-band = Req 5.2）:
   ```bash
   printf %s "<VALUE>" | gcloud secrets versions add line-channel-secret       --data-file=- --project=fwlm
   printf %s "<VALUE>" | gcloud secrets versions add line-channel-access-token --data-file=- --project=fwlm
   printf %s "<VALUE>" | gcloud secrets versions add gemini-api-key            --data-file=- --project=fwlm
   printf %s "<VALUE>" | gcloud secrets versions add places-api-key            --data-file=- --project=fwlm
   printf %s "<VALUE>" | gcloud secrets versions add db-admin-password         --data-file=- --project=fwlm
   ```
6. **`postgres` 管理ユーザーのパスワード設定**（値は `db-admin-password` 枠へ）:
   ```bash
   gcloud sql users set-password postgres --instance=fwlm-pg --project=fwlm --prompt-for-password
   ```
7. **Places API クォータ ID の確認と設定**（Req 7.2）:
   ```bash
   gcloud services quota list --service=places.googleapis.com --project=fwlm
   ```
   確認した quota_id と上限値を `terraform.tfvars` の `places_quota_id` / `places_quota_limit` に設定してから apply（未設定だと上限が作られず Req 7.2 未達）。
8. **GitHub リポジトリ変数の設定**（WIF 検証ワークフロー用）: `vars.WIF_PROVIDER = terraform output wif_provider_name`、`vars.GCP_PROJECT_ID = fwlm`
9. **LIFF チャネル作成**（competitive-daily-summary / store-detail 用。LINE Developers コンソールでの手動作業・Terraform 管理外。LINE は LIFF/LINE Login チャネルの Terraform provider を持たないため恒久的に手動）:
   - Messaging API チャネルと **同一プロバイダー配下**に LINE Login チャネルを新規作成する（`ts/apps/store-detail/lib/liff-auth.ts` の userId 突合はプロバイダー一致が前提）
   - その LINE Login チャネル配下に LIFF アプリを追加し、エンドポイント URL に store-detail の Cloud Run URL（`terraform output service_names` の `store-detail` から解決）を設定する
   - 取得した LINE Login チャネル ID・LIFF アプリ ID・LIFF URL をそれぞれ `terraform.tfvars` の `liff_channel_id`・`liff_id`・`liff_url` に設定し `make tf-apply` する（#6 LINE 基盤チームと共同で実施・design.md「Open Questions / Risks」参照）

---

## 2. Terraform 適用手順

**実行者の権限要件**: プロジェクト Owner 相当 + **請求先アカウントへの `roles/billing.costsManager`**（budget 作成に必須）。CI（WIF）は state に触れず、インフラ変更は人間が実行する（research.md 決定）。

```bash
make tf-init    # terraform -chdir=infra/envs/prod init（要 state バケット）
make tf-fmt     # terraform fmt -recursive infra
make tf-plan    # 差分計画（要 terraform.tfvars）
make tf-apply   # 適用
```

- 冪等性の確認（Req 1.3）: `make tf-apply` 直後の `make tf-plan` が差分ゼロであること。
- ローカルの静的検証のみ行う場合（GCP 不要）: 各モジュールディレクトリで `terraform init -backend=false && terraform validate`。

### 2-1. Identity Platform が既に有効化済みの場合

`google_identity_platform_config` は初期化時に一度だけ作成され削除不可。Console/Firebase で既に有効化済みだと apply が "already exists" で失敗するため import する:

```bash
terraform -chdir=infra/envs/prod import 'module.auth.google_identity_platform_config.default' "projects/fwlm/config"
```

---

## 3. データベース migration 適用

Cloud SQL は public IP でも authorized_networks 空・IAM 認証必須のため、**Cloud SQL Auth Proxy** 経由でのみ到達できる（Req 3.4）。

```bash
# Auth Proxy 起動（別ターミナル・要 roles/cloudsql.client）
cloud-sql-proxy fwlm:asia-northeast1:fwlm-pg --port 5432

# migration を番号順に適用 → その後 GRANT を適用
psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f db/migrations/0001_four_tier_baseline.sql
psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f db/migrations/0002_reference_seed.sql
psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f db/migrations/0004_competitive_daily_summary.sql
psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f infra/sql/grants.sql
```

- migration は `db/migrations/` に存在する番号を実際に確認してから番号順に適用すること（本書の例を鵜呑みにしない）。`infra/sql/grants.sql` は `daily_summaries`/`summary_deliveries`（0004）を含む全テーブルへの GRANT を前提とするため、0004 未適用のまま grants.sql を実行すると失敗する（task 6.1 レビューで発見）。

- `infra/sql/grants.sql` は IAM DB ユーザー（`sa-*@fwlm.iam`）へ `db/write-boundary.md` と整合する GRANT を付与する版管理ファイル。手順書内に生 SQL を埋め込まない（再現性）。

---

## 4. staging（必要時のみ）

staging 検証が要る場合は **同一インスタンス内に論理 DB を追加**する。**追加の Cloud SQL インスタンスは作らない**（Req 3.5/8.3・常時課金を 1 台に固定 = Req 7.3）。

```bash
gcloud sql databases create fwlm_staging --instance=fwlm-pg --project=fwlm
# migration/grants を fwlm_staging に対して同様に適用
```

---

## 5. CI デプロイ契約（構成所有権の seam）

- CI（GitHub Actions + WIF）に許可される変更は **コンテナイメージの更新のみ**:
  - サービス: `gcloud run services update <svc> --image=<AR_IMAGE> --region=asia-northeast1`
  - ジョブ: `gcloud run jobs update daily-batch --image=<AR_IMAGE> --region=asia-northeast1`
- env・スケーリング・リソース制限など **構成変更は Terraform 専権**。CI から `gcloud run deploy`（フル構成デプロイ）を行わない。これを破ると `ignore_changes = [image]` の範囲外で drift が生じ、`tf-plan` 差分ゼロ（Req 1.3）が恒常的に破れる。
- デプロイ失敗時は Cloud Run のリビジョン機構により旧リビジョンが維持される（Req 6.4）。`--no-traffic` 等でトラフィックを明示操作しないこと。
- 検証: `.github/workflows/gcp-auth-smoke.yml` を `workflow_dispatch` で起動 → SA キーなしで認証し `gcloud run services list` が成功すること（Req 6.1/6.2）。
- per-app のビルド/デプロイワークフローは各アプリ spec がこの雛形を基に追加する。

---

## 6. dev 環境の境界

- **dev 用クラウドリソースは作らない**（Req 8.1）。DB スキーマの開発検証は既存ローカルハーネスで完結（Req 8.2）:
  ```bash
  make db-migrate   # 一時 postgres へ migrations 適用
  make db-smoke     # smoke
  make db-test      # assertions
  make db-verify-docs
  ```
- クラウド上での検証が必要な場合は本番相当の単一環境（および §4 の論理 DB）で行い、恒常的な検証環境を新設しない（Req 8.3）。
