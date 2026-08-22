# fw-line-meo インフラ運用手順（bootstrap runbook）

`gcp-infra-foundation` spec の Terraform（`infra/`）を単一 GCP プロジェクト **`gen-fw-line-meo`**（`asia-northeast1`）へ適用・運用するための手順書。**手動手順の単一情報源**であり、ここに列挙された作業以外は Terraform が宣言的に管理する（Req 1.2）。

- 単一環境ルートモジュール: `infra/envs/prod/`（dev 用クラウド環境は作らない。dev は `make db-*` ローカルハーネスで完結 = Req 8.1/8.2）
- モジュール群: `infra/modules/`（将来のプロジェクト分離の退路として境界を維持 = Req 1.5）

---

## 1. IaC 例外リスト（手動が正当な唯一の集合）

以下は Terraform 管理外。`terraform apply` の前後に人手で実施する。これ以外の手動リソース作成は禁止（Req 1.2 の境界）。

1. **GCP プロジェクト `gen-fw-line-meo` 作成** と **請求先アカウント紐付け**
2. **GCS state バケット作成**（versioning 有効・uniform bucket-level access）。名前は `infra/envs/prod/backend.tf` の `bucket` と一致させる（既定 `gen-fw-line-meo-tfstate`）
3. **Terraform 実行者の初期 API 有効化**: 最低限 `serviceusage`・`cloudresourcemanager`（残りは `project-services` モジュールが有効化）
4. **OAuth 同意画面の設定 + Google ログイン IdP の有効化**（Identity Platform）。client secret を TF state に入れないため手動（Req 5.2）
5. **Secret Manager の値投入**（枠は Terraform 済み・値は out-of-band = Req 5.2）:
   ```bash
   printf %s "<VALUE>" | gcloud secrets versions add line-channel-secret       --data-file=- --project=gen-fw-line-meo
   printf %s "<VALUE>" | gcloud secrets versions add line-channel-access-token --data-file=- --project=gen-fw-line-meo
   printf %s "<VALUE>" | gcloud secrets versions add gemini-api-key            --data-file=- --project=gen-fw-line-meo
   printf %s "<VALUE>" | gcloud secrets versions add places-api-key            --data-file=- --project=gen-fw-line-meo
   printf %s "<VALUE>" | gcloud secrets versions add db-admin-password         --data-file=- --project=gen-fw-line-meo
   printf %s "<VALUE>" | gcloud secrets versions add survey-session-key        --data-file=- --project=gen-fw-line-meo
   ```

   投入したら **同じ PR で `infra/secrets-provisioned.tsv` を更新すること**（`<secret_id>` / `<version>` / `<投入日>` / `<Issue-PR>`）。この宣言ファイルが「実値が投入済みである」ことの正典であり、`scripts/check-secret-declaration-coverage.sh`（ts-ci）が正典・手順書・消費側配線と両方向で照合する（Issue #63）。

   旧 version は投入直後に disable すること: `gcloud secrets versions disable <n> --secret=<id> --project=gen-fw-line-meo`。Cloud Run は `version = "latest"` でマウントしており、旧 version が ENABLED のまま残ると「どの値が読まれているか」が宣言から決まらない。`destroy` は不可逆なので使わない（`disable` は `enable` で戻せる）。

   新しい枠を Terraform へ足す PR では、apply されるまで version を作れないため実 version 番号を宣言できない。宣言へ `<secret_id>` / `PENDING` / `-` / `#<Issue>` の行を足すこと。`PENDING` は ts-ci では緑・定期検証では必ず赤になるため、投入漏れが「行が無い」という不可視の形ではなく「宣言された未完了」として残る。

6. **`postgres` 管理ユーザーのパスワード設定**（値は `db-admin-password` 枠へ）:
   ```bash
   gcloud sql users set-password postgres --instance=fwlm-pg --project=gen-fw-line-meo --prompt-for-password
   ```
7. **Places API クォータ ID の確認と設定**（Req 7.2）:
   ```bash
   gcloud services quota list --service=places.googleapis.com --project=gen-fw-line-meo
   ```
   確認した quota_id と上限値を `terraform.tfvars` の `places_quota_id` / `places_quota_limit` に設定してから apply（未設定だと上限が作られず Req 7.2 未達）。
8. **GitHub リポジトリ変数の設定**（WIF 検証ワークフロー用）: `vars.WIF_PROVIDER = terraform output wif_provider_name`、`vars.GCP_PROJECT_ID = gen-fw-line-meo`
9. **LIFF チャネル作成**（competitive-daily-summary / store-detail 用。LINE Developers コンソールでの手動作業・Terraform 管理外。LINE は LIFF/LINE Login チャネルの Terraform provider を持たないため恒久的に手動）:
   - Messaging API チャネルと **同一プロバイダー配下**に LINE Login チャネルを新規作成する（`ts/apps/store-detail/lib/liff-auth.ts` の userId 突合はプロバイダー一致が前提）
   - その LINE Login チャネル配下に LIFF アプリを追加し、エンドポイント URL に store-detail の Cloud Run URL（`terraform output service_names` の `store-detail` から解決）を設定する
   - 取得した LINE Login チャネル ID・LIFF アプリ ID・LIFF URL をそれぞれ `terraform.tfvars` の `liff_channel_id`・`liff_id`・`liff_url` に設定し `make tf-apply` する（#6 LINE 基盤チームと共同で実施・design.md「Open Questions / Risks」参照。line-onboarding は既にマージ済みのため、Messaging API チャネル自体は準備済み）

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
terraform -chdir=infra/envs/prod import 'module.auth.google_identity_platform_config.default' "projects/gen-fw-line-meo/config"
```

---

## 3. データベース migration 適用

Cloud SQL は public IP でも authorized_networks 空・IAM 認証必須のため、**Cloud SQL Auth Proxy** 経由でのみ到達できる（Req 3.4）。

```bash
# Auth Proxy 起動（別ターミナル・要 roles/cloudsql.client）
cloud-sql-proxy gen-fw-line-meo:asia-northeast1:fwlm-pg --port 5432

# migration を番号順に適用 → その後 GRANT を適用
psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f db/migrations/0001_four_tier_baseline.sql
psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f db/migrations/0002_reference_seed.sql
psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f db/migrations/0003_line_onboarding.sql
psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f db/migrations/0004_competitive_daily_summary.sql
psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f db/migrations/0005_agency_dashboard.sql
psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f db/migrations/0006_gbp_post_review_reply.sql
psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f infra/sql/grants.sql
```

- migration は `db/migrations/` に存在する番号を実際に確認してから番号順に適用すること（本書の例を鵜呑みにしない）。`infra/sql/grants.sql` は `daily_summaries`/`summary_deliveries`（0004）を含む全テーブルへの GRANT を前提とするため、0004 未適用のまま grants.sql を実行すると失敗する（task 6.1 レビューで発見）。

- **新しい migration を適用したら `infra/sql/grants.sql` を必ず再実行する。** `GRANT SELECT ON ALL TABLES IN SCHEMA public` は**実行時点に存在するテーブルにしか効かず**、`ALTER DEFAULT PRIVILEGES` も置いていないため、後から作られた表には SELECT すら付かない。再実行を怠ると、アプリは起動できるのにその表へ触った瞬間だけ `permission denied` で落ちる（PR #121 レビュー指摘）。

- `infra/sql/grants.sql` は IAM DB ユーザー（`sa-*@gen-fw-line-meo.iam`）へ `db/write-boundary.md` と整合する GRANT を付与する版管理ファイル。手順書内に生 SQL を埋め込まない（再現性）。

---

## 4. staging（必要時のみ）

staging 検証が要る場合は **同一インスタンス内に論理 DB を追加**する。**追加の Cloud SQL インスタンスは作らない**（Req 3.5/8.3・常時課金を 1 台に固定 = Req 7.3）。

```bash
gcloud sql databases create fwlm_staging --instance=fwlm-pg --project=gen-fw-line-meo
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
- **稼働実態の定期検証（Issue #91）**: `.github/workflows/prod-image-drift.yml`（`prod-image-drift`）が 6 時間ごとに、稼働イメージのタグと `origin/main` を突き合わせる。**read-only の照会のみ**（`gcloud run services/jobs list`）であり、イメージ更新も構成変更も行わないため本契約に抵触しない。`deploy-prod` はマージ契機でしか動かず、main が動かない期間は run 自体が生成されない（＝失敗という兆候すら出ない）ため、時間で回す検証がこの穴を埋める。
- **シークレット実値の定期検証（Issue #63）**: `.github/workflows/secret-version-drift.yml`（`secret-version-drift`）が 6 時間ごとに、`infra/secrets-provisioned.tsv` の宣言と本番の version 構成を突き合わせる。**read-only のメタデータ照会のみ**（`gcloud secrets describe` / `versions list`）であり、値（payload）は読まないため本契約に抵触しない。CI に付く IAM は secret 単位の `roles/secretmanager.viewer` だけで、このロールは `secretmanager.versions.access` を含まない。project 単位の付与は行わない（Req 5.4）。
- **外部 API への実疎通は CI では行わない（Issue #125）**: 実疎通には値そのものが要るが、CI の責務はイメージ更新であり外部 API 呼出ではない。CI へ `roles/secretmanager.secretAccessor` を付けることは Req 5.4（各実行環境は自身の責務に必要なシークレットのみ読み取り可能）に反するため行わない。実疎通は §8 の手順で運用者が自分の資格情報で実行し、CI は `infra/external-api-smoke.tsv` の宣言の構造と鮮度だけを検証する。
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

---

## 7. コンテナイメージの push と既設 Job/Service の実体化（competitive-daily-summary / task 6.3）

daily-batch Job・summary-delivery Job・store-detail Service はいずれも `lifecycle { ignore_changes = [image] }`（§5 の CI デプロイ契約と同じ理由）でプレースホルダイメージ（`us-docker.pkg.dev/cloudrun/container/hello`）のまま Terraform 管理外に置かれている。実イメージへの反映は **`terraform apply` の外** で行う手動（または CI）手順であり、以下がその単一の手順書。

### 7-0. 前提

- **既知のブロッカー**: `infra/modules/batch-job/main.tf` は現状 `CLOUDSQL_CONNECTION_NAME`・`PLACES_API_KEY` のみを Job env に配線しており、Go 側 `config.Load()` が Cloud SQL IAM モードで必須とする `DB_IAM_USER`・`DB_NAME` が未配線（task 3.6/6.3 レビューで発見・delivery-job モジュールは同じ配線漏れを踏まないよう最初から3値を揃え済み・`infra/modules/delivery-job/main.tf` 冒頭コメント参照）。**この Terraform 変更（`google_sql_user.job_iam.name` の trimsuffix 導出値を `DB_IAM_USER` に、`database` モジュールの DB 名を `DB_NAME` に追加する）が先に `terraform apply` されていないと、daily-batch は本手順でイメージを実体化しても起動直後に env 読取エラーで即終了する**。本 README の変更はこの Terraform 修正そのものを含まない（別タスクで `infra/modules/batch-job/main.tf` を修正し apply すること）。
- Artifact Registry: `infra/modules/registry`（既定 `repository_id=fwlm`・`region=asia-northeast1`）。push 先ベース URL は `asia-northeast1-docker.pkg.dev/gen-fw-line-meo/fwlm`（`terraform output` の `registry` module 出力 `repository_url` と一致させる）。
- 実行者は `roles/artifactregistry.writer`（push）・対象 Job/Service への `roles/run.developer` 相当（`gcloud run jobs update`/`gcloud run services update`）を持つこと。`gcloud auth login`（人間）または WIF（CI・§5 の契約範囲内）で認証済みであること。

### 7-1. 3イメージの build + push

```bash
# 3イメージまとめて（既定 PROJECT_ID=gen-fw-line-meo REGION=asia-northeast1 REPOSITORY=fwlm・TAG=git短SHA）
make image-push

# 1イメージだけ・タグを明示する場合
scripts/push-images.sh --image daily-batch
TAG=v0.1.0 scripts/push-images.sh

# push せずローカル build のみ確認したい場合（CI の検証ジョブ・動作確認用）
make image-build
```

`scripts/push-images.sh` は内部で `gcloud auth configure-docker asia-northeast1-docker.pkg.dev` を実行してから `docker build`/`docker push` する（Dockerfile とビルドコンテキストは `go/Dockerfile`・`ts/apps/delivery-job/Dockerfile`・`ts/apps/store-detail/Dockerfile` 冒頭コメントの規約と一致）。push 完了時に次の 7-2 コマンドをタグ入りで標準出力に表示する。

### 7-2. 既設 Job/Service へのイメージ反映（apply 外・`ignore_changes=[image]` の運用側）

```bash
IMAGE_BASE=asia-northeast1-docker.pkg.dev/gen-fw-line-meo/fwlm
TAG=<7-1 で push したタグ>

# daily-batch（Go・毎朝 06:00 JST Scheduler・infra/modules/batch-job）
gcloud run jobs update daily-batch \
  --image="${IMAGE_BASE}/daily-batch:${TAG}" \
  --region=asia-northeast1 --project=gen-fw-line-meo

# summary-delivery（TS 配信ジョブ・毎時 Scheduler・infra/modules/delivery-job）
gcloud run jobs update summary-delivery \
  --image="${IMAGE_BASE}/summary-delivery:${TAG}" \
  --region=asia-northeast1 --project=gen-fw-line-meo

# store-detail（TS LIFF 詳細閲覧・常時公開 Service・infra/modules/run-services）
gcloud run services update store-detail \
  --image="${IMAGE_BASE}/store-detail:${TAG}" \
  --region=asia-northeast1 --project=gen-fw-line-meo
```

適用後、`make tf-plan` を実行して差分ゼロ（Req 1.3 相当）を確認する。`image` 以外に差分が出た場合はイメージ更新の副作用ではなく別の drift のため原因を切り分けること。

### 7-3. daily-batch の手動実行と実行サマリーログの確認

```bash
# 手動トリガー（毎朝 06:00 JST の Scheduler を待たずに検証する場合）
gcloud run jobs execute daily-batch --region=asia-northeast1 --project=gen-fw-line-meo --wait

# 実行結果の一覧（最新の execution を確認）
gcloud run jobs executions list --job=daily-batch --region=asia-northeast1 --project=gen-fw-line-meo --limit=5

# 実行サマリーログ（go/cmd/daily-batch/main.go が出す構造化ログ 1 行・固定フィールド）を Cloud Logging から取得
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="daily-batch"' \
  --project=gen-fw-line-meo --limit=20 --format=json
```

summary-delivery（毎時 Job）も同様に `gcloud run jobs execute summary-delivery ...`／`resource.labels.job_name="summary-delivery"` で確認できる。「成功」の観察可能な証拠は、この実行サマリーログ 1 行が出力され、かつ `daily_summaries`（Go 書込）／`summary_deliveries`（TS 書込）に該当日の行が増えていること（§3 の Auth Proxy 経由 `psql` で確認）。

### 7-4. CI 化する場合

§5 の CI デプロイ契約（イメージ更新のみ・WIF・SA キー不使用）に従う。`scripts/push-images.sh` は CI からもそのまま呼び出せる（`gcloud auth configure-docker` は WIF 認証後であれば動作する）。

**実装済み（Issue #23）**: `.github/workflows/deploy.yml`（`deploy-prod`）が本フローを自動化する。`ts-ci` が `main` で緑になった後（`workflow_run`・テスト赤のまま出荷しない）、または `workflow_dispatch`（手動）で、3イメージを build → push → `gcloud run jobs/services update --image` で反映する。契約遵守のため `gcloud run deploy` や env/scaling 変更・terraform state 操作は一切行わない。**追加で必要なリポジトリ変数**: `vars.NEXT_PUBLIC_LIFF_ID`（tfvars `liff_id` と同値。store-detail の client bundle へ `next build` 時にインライン化される値のため build-arg で渡す。ランタイム env では効かない）。値未設定なら push-images.sh が hard-fail し、空の LIFF ID を焼き込んだイメージの出荷を防ぐ。LIFF ID を変更する際は tfvars `liff_id` と `vars.NEXT_PUBLIC_LIFF_ID` の両方を更新すること。

**実装済み（Issue #91）**: `.github/workflows/prod-image-drift.yml`（`prod-image-drift`）が 6 時間ごとに稼働実態と `origin/main` の乖離を検証する（read-only）。`deploy-prod` にも失敗通知ジョブを持たせ、いずれも `scripts/report-ci-issue.sh` でラベル単位の追跡 Issue を 1 本だけ維持する（`prod-image-drift` / `deploy-prod-failure`）。復旧を検出すると自動で閉じる。手動での即時確認と赤の実証は `gh workflow run prod-image-drift.yml --ref main` で行う（`snapshot` 入力に TSV を渡すと gcloud を叩かずに任意の状態を再現できる）。

---

## 8. 外部 API 実疎通の手順（Issue #125）

`infra/secrets-provisioned.tsv` の二層検証（§5）は「宣言どおりの version が入っている」までしか言えず、**値そのものの正当性は原理的に検出できない**。プレースホルダー文字列・失効キー・別プロジェクトのキー・課金無効はいずれもメタデータからは見えない。到達手段は実際に外部 API を叩いて成功を観測することだけである。

**この手順は CI では走らない。** 実疎通には値そのものが要るが、CI へ `roles/secretmanager.secretAccessor` を付けることは Req 5.4 に反する（§5 の契約）。実行するのは運用者であり、使うのは運用者自身の `gcloud` 資格情報である。

実施記録の正典は `infra/external-api-smoke.tsv`。**外部 API に依存する機能は、この記録が `PENDING` でなくなるまで go-live を完了扱いにしない。**

### 8-0. 一括実行

```bash
# 3 API をまとめて叩き、TSV へ貼る行を生成する（要 roles/secretmanager.secretAccessor 相当・人間の資格情報）
bash scripts/run-external-api-smoke.sh \
  --place-id <本番 stores.place_id のいずれか> \
  --model <本番の GEMINI_MODEL> \
  --channel-id <本番の LINE_CHANNEL_ID>
```

出力は PASS/FAIL・HTTP ステータス・API が返した `status` フィールドだけに絞ってある。応答本文をそのまま出さないのは、キーや URL がエコーされた本文をターミナル履歴や貼り付け先へ残さないためである。個別に確認したい場合は以下の 8-1〜8-3 を手で叩く。`--api gemini` のように対象を絞って再実行することもできる。

**引数に既定値を持たせていないのは意図的である。** アプリ側コードの既定値を写経すると、本番が別モデル・別チャネルへ移った瞬間に「動くはずのない構成が緑」になる。値は次の 3 つから取る。

- `--place-id`: 本番 `stores.place_id` の実値（§3 の Auth Proxy 経由 `psql` で取得）
- `--model`: 本番 `survey-web` の env `GEMINI_MODEL`（`terraform.tfvars` の `gemini_model` と同値）
- `--channel-id`: 本番 `line-webhook` の env `LINE_CHANNEL_ID`（`terraform.tfvars` の `line_channel_id` と同値）

稼働中の実値を確認する場合は Cloud Run のリビジョンを読む（`gemini_model` / `line_channel_id` は Terraform の input variable であり `terraform output` には出ない）:

```bash
gcloud run services describe survey-web   --region=asia-northeast1 --project=gen-fw-line-meo --format=json
gcloud run services describe line-webhook --region=asia-northeast1 --project=gen-fw-line-meo --format=json
```

出力の `spec.template.spec.containers[].env` から `GEMINI_MODEL` / `LINE_CHANNEL_ID` を読む。

### 8-1. gemini: 口コミ下書き生成（survey-web / 機能3）

```bash
KEY="$(gcloud secrets versions access latest --secret=gemini-api-key --project=gen-fw-line-meo)"
MODEL='<本番の GEMINI_MODEL・§8-0 の方法で確認する>'
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST "https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent" \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"parts":[{"text":"ping"}]}],"generationConfig":{"maxOutputTokens":1}}' \
  -K - <<CFG
header = "x-goog-api-key: ${KEY}"
CFG
```

- 成功の観察可能な証拠: HTTP `200`。キーが不正なら `400`（`API_KEY_INVALID`）、課金・API 無効なら `403`。
- **鍵を `-H` でコマンドラインへ置かない。** argv は同一ホストの他ユーザーが `ps` で読める。`-K -` で標準入力の設定として渡す（`run-external-api-smoke.sh` が 600 の一時ファイルを使うのと同じ理由）。本文（`-d`）は鍵を含まないのでそのままでよい。
- 応答本文を出さない（`-o /dev/null`）のは、Google の 400 応答がリクエスト URL を含むことがあり、素朴に出すとターミナル履歴や貼り付け先へ残るためである。
- 課金と副作用: 出力 1 トークン上限の呼び出し 1 回。外部に何も残らない。
- モデル名は本番の env `GEMINI_MODEL`（tfvars `gemini_model`）と揃えること。アプリ側コードの既定値を写経すると、本番が別モデルへ移った瞬間に「動くはずのない構成が緑」になる。

### 8-2. places: 競合データ取得（daily-batch / line-webhook / dashboard-api / 機能1）

```bash
KEY="$(gcloud secrets versions access latest --secret=places-api-key --project=gen-fw-line-meo)"
curl -sS -o /dev/null -w '%{http_code}\n' \
  "https://places.googleapis.com/v1/places/<PLACE_ID>" \
  -H 'X-Goog-FieldMask: id' \
  -K - <<CFG
header = "X-Goog-Api-Key: ${KEY}"
CFG
```

- 成功の観察可能な証拠: HTTP `200`。キーが不正なら `400`、クォータ超過なら `429`。
- **鍵は `-K -` で渡す**（§8-1 と同じ理由。argv に置くと `ps` で読める）。
- 課金と副作用: read-only の Place Details 1 回。`X-Goog-FieldMask` を `id` だけに絞ると最安の Essentials SKU に収まる（`go/internal/places/client.go` の 2 種のマスクは使わない）。
- `<PLACE_ID>` は本番 `stores.place_id` の実値を使う（§3 の Auth Proxy 経由 `psql` で取得）。

### 8-3. line-messaging: 配信とオンボーディング（delivery-job / line-webhook / 機能1 配信）

```bash
SECRET="$(gcloud secrets versions access latest --secret=line-channel-secret --project=gen-fw-line-meo)"
CHANNEL_ID='<本番の LINE_CHANNEL_ID・§8-0 の方法で確認する>'
# printf はシェル組み込みなので、チャネルシークレットがどのプロセスの argv にも現れない。
TOKEN="$(printf 'grant_type=client_credentials&client_id=%s&client_secret=%s' "$CHANNEL_ID" "$SECRET" \
  | curl -sS -X POST 'https://api.line.me/oauth2/v3/token' \
      -H 'Content-Type: application/x-www-form-urlencoded' --data @- \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"
curl -sS -o /dev/null -w '%{http_code}\n' 'https://api.line.me/v2/bot/info' -K - <<CFG
header = "Authorization: Bearer ${TOKEN}"
CFG
```

- 成功の観察可能な証拠: 2 本目が HTTP `200`。トークン発行に失敗していれば `TOKEN` が空になり `401` が返る。
- **チャネルシークレットもトークンも argv へ置かない**（§8-1 と同じ理由）。本文は `--data @-` で標準入力から、トークンは `-K -` で設定として渡す。
- 課金と副作用: **なし。`/v2/bot/info` は read-only であり、メッセージを一切送信しない。**
- **push / multicast / broadcast を実疎通に使ってはならない。** 実送信は受信者への迷惑であり、無料メッセージ通数枠を消費する。トークンが発行できて `/v2/bot/info` が 200 を返せば、チャネル資格情報の正当性は証明できる。
- `line-channel-access-token` は実疎通の対象ではない。2 つの消費者（`ts/apps/delivery-job/src/line.ts` / `ts/apps/line-webhook/src/line/client.ts`）はどちらもチャネル ID とシークレットから stateless token を都度発行しており、この枠はコードから読まれていない。

### 8-4. gbp: Google 連携の OAuth クライアント（line-webhook / 機能2・機能1-b）

**この節は §10 の認証情報投入が済むまで実行できない**（`gbp-oauth-client-secret` が未投入のため）。宣言は `PENDING` のまま、層2 の `external-api-smoke-freshness` は意図どおり赤で残る（`infra/secrets-provisioned.tsv` の 2 行と同じ「未完の可視化」）。

```bash
CLIENT_SECRET="$(gcloud secrets versions access latest --secret=gbp-oauth-client-secret --project=gen-fw-line-meo)"
CLIENT_ID='<本番の GBP_OAUTH_CLIENT_ID・§8-0 の方法で確認する>'
# printf はシェル組み込みなので、クライアントシークレットがどのプロセスの argv にも現れない。
printf 'grant_type=refresh_token&refresh_token=smoke-invalid&client_id=%s&client_secret=%s' \
    "$CLIENT_ID" "$CLIENT_SECRET" \
  | curl -sS -X POST 'https://oauth2.googleapis.com/token' \
      -H 'Content-Type: application/x-www-form-urlencoded' --data @- \
  | sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([a-z_]*\)".*/\1/p'
```

- **成功の観察可能な証拠: `invalid_grant`。** 意図的に無効な refresh token を送っているので、クライアント資格情報が正当なら Google は「grant が無効」とだけ答える。つまり `invalid_grant` が返ること自体が client_id / client_secret の組の正当性を証明する。
- **失敗: `invalid_client`。** client_id と client_secret の組が誤っている（出典: Google Identity「OAuth 2.0 for Web Server Applications」のエラー一覧。`invalid_client` は "The OAuth client secret is incorrect"）。
- **HTTP ステータスで判定しないこと。** Google はこの 2 ケースの HTTP コードを公開文書に明記していない。判定は `error` フィールドで行う（アプリ側 `ts/apps/line-webhook/src/gbp/token-store.ts` の `isInvalidGrantError` も同じく `error` を一次情報にしている）。
- 課金と副作用: **なし。** ユーザー認可を要さず、トークンも発行されず、GBP 側に何も残らない。
- **`business.manage` のクォータは検証できない。** これはクライアント資格情報の疎通確認であって、GBP API 利用審査（§9 関門 A）の承認状態は別物である。審査の確認方法は §9-1 を参照。

### 8-5. 記録の更新

実疎通が全て PASS したら、同じ PR で `infra/external-api-smoke.tsv` の該当行を更新する。

- `<最終確認日>`: 実施日（JST・`YYYY-MM-DD`）。`PENDING` を置き換える。`run-external-api-smoke.sh` が出す行は実行環境の TZ に依らず JST で押してあるので、そのまま貼ってよい（鮮度検証の基準日も JST 固定で、両者は必ず同じ暦の上で比較される）。
- `<証拠>`: 後から辿れる短い識別子（実行日時・run URL・execution id 等）。空欄や `-` は層1 ガードが赤にする。

`scripts/check-external-api-smoke.sh`（ts-ci）が構造を、`scripts/check-external-api-smoke-freshness.sh`（`external-api-smoke-freshness` ワークフロー・日次）が鮮度を検証する。後者は `PENDING` と期限切れを赤にし、`scripts/report-ci-issue.sh` がラベル `external-api-smoke` の追跡 Issue を 1 本だけ維持する。記録を更新すると次の実行で自動的に閉じる。

**日付だけを更新して実疎通を省略しないこと。** このガードは人間の実施を強制できず、記録の鮮度しか見ていない。`<証拠>` 欄は、後から「本当に叩いたのか」を第三者が辿るための唯一の手掛かりである。

## 10. GBP 連携の実装側セットアップ（gbp-post-review-reply / 機能2・機能1-b）

Google ビジネスプロフィール（GBP）への投稿作成・クチコミ返信を本番で動かすための**実装側**手順。コード（`ts/apps/line-webhook/src/gbp/`）は実装・検証済みだが、認証情報を投入するまで本番では動かない。

**Google の審査 2 関門（A: GBP API 利用審査 / B: OAuth アプリ検証）の手順は §9 が正典**であり、Issue #7 として実装とは独立に進む。この節はその承認が出た後に実施する手順だけを持つ。両審査が通るまで、本 PR は Draft から出せない。

**節番号について**: §8 は #125 の外部 API 実疎通が占有済み（main 統合で本ファイルにも入った）。**§9 は #7 の GBP 審査手順（PR #140）が入るまで欠番**であり、本節が参照する §9 / §9-2 / §9-2-a は #140 が main へマージされた時点で解決する。§8 を GBP に使うと `8-1` が 2 つ存在する文書になり、`scripts/check-external-api-smoke.sh` の見出し抽出は `^### 8-[0-9]+\. [a-z][a-z-]+:`（小文字始まり + コロン）なので大文字始まりの GBP 見出しには当たらず**CI は緑のまま壊れる**。この節を §8 へ戻さないこと。

### 10-1. OAuth クライアントの作成（人手・§9-2 の検証申請と対で行う）

店舗オーナーが LINE から連携する際の Google 認可画面。§1.4 の Identity Platform 用同意画面とは**別の OAuth クライアント**を作る（用途が異なる）。

1. **OAuth 同意画面を構成**（External）: `https://www.googleapis.com/auth/business.manage` スコープを追加（コードの `GBP_SCOPE` と一致・単一）。プライバシーポリシー URL・承認済みドメインを設定する。**その 2 つの前提（自己所有ドメインと同一ドメイン上のプライバシーポリシー）は §9-2-a の通り未取得である。**
2. **OAuth クライアント（Web アプリケーション）を作成**し、**承認済みリダイレクト URI** に次を**そのまま**設定する（コードの callback ルート `app.get('/gbp/oauth/callback')`（`ts/apps/line-webhook/src/app.ts`）と 1 文字も違わせないこと。OAuth 失敗の第 1 位はここの不一致）。得られる client_id / client_secret を 10-2 で投入する。

   ```
   https://line-webhook-vdqjgfvkma-an.a.run.app/gbp/oauth/callback
   ```

   （2026-08-17 実測。`gcloud run services describe line-webhook --project=gen-fw-line-meo --region=asia-northeast1 --format="value(status.url)"`。この値をそのまま tfvars の `gbp_oauth_redirect_url` にも入れる）
3. **検証を申請し Published へ切り替える**: 手順と提出物は §9-2 が正典。**実装側にとっての意味はここにある**。Testing のまま放置すると refresh token が 7 日で失効し、`gbp_sessions` に保存した認可が全店舗分まとめて毎週無効になる。IT に不慣れなオーナーへ毎週の再連携を強いる形になり、本サービスの存在意義に反する。

コードの認可要求は `access_type=offline` + `prompt=consent` + `include_granted_scopes=false`（refresh token を確実に取得）で固定済み（`ts/apps/line-webhook/src/gbp/oauth.ts`）。

**§1.4 の Identity Platform 用クライアント（`903142718720-o43fa5ch35aefmdrcaqqjuf2fjs6ekhk...`）を流用しないこと。** 用途もリダイレクト URI も別で、混ぜるとダッシュボードのログインごと巻き込んで壊れる。

### 10-2. 認証情報の投入（§1.5 と同じ out-of-band 規律）

secret 枠は Terraform の**宣言**済み（`infra/modules/secrets/main.tf` の `gbp-oauth-client-secret`・`gbp-token-cipher-key`）だが、**本番にはまだ枠自体が無い**（2026-08-17 実測。`gcloud secrets list --project=gen-fw-line-meo` は既存 6 本のみ）。順序は必ず次:

0. **DB を先に整える。** §3 の Auth Proxy 経由で `db/migrations/0006_gbp_post_review_reply.sql` を適用し、**続けて `infra/sql/grants.sql` を再実行する**
1. `make tf-apply` で**枠を作る**
2. 下の `gcloud secrets versions add` で**値を入れる**
3. `infra/secrets-provisioned.tsv` の 2 行を `PENDING` から実 version 番号・投入日へ更新する（同じ PR で）
4. **その後で** PR #121 を main へマージする

順序を逆にすると `deploy-prod` が env 未設定の新イメージを出荷し、`loadConfig()` の fail-fast で line-webhook の新リビジョンが起動失敗する。

**手順 0 を飛ばすと fail-fast は助けにならない。** env は揃っているのでリビジョンは正常に起動し、`gbp_locations` / `gbp_sessions` が無い（または `grants.sql` 未再実行で権限が無い）状態のまま本番へ出る。`line-webhook` は店舗特定済みオーナーのテキストを受けるたびに `gbp_sessions` を引くため、**GBP を使っていないオーナーの通常メッセージまで内部エラー案内に化ける**（PR #121 レビュー指摘）。`GRANT SELECT ON ALL TABLES` が実行時点のテーブルにしか効かないことは §3 の注記を参照。

値のみ手動投入する。

```bash
# 10-1 で作成した OAuth クライアントシークレット
printf %s "<CLIENT_SECRET>" | gcloud secrets versions add gbp-oauth-client-secret --data-file=- --project=gen-fw-line-meo

# refresh token 暗号化鍵（AES-256-GCM・32 byte base64・コードが GBP_TOKEN_CIPHER_KEY で消費）
openssl rand -base64 32 | gcloud secrets versions add gbp-token-cipher-key --data-file=- --project=gen-fw-line-meo
```

非秘匿の 2 値は `terraform.tfvars` へ設定して `make tf-apply`（`infra/envs/prod/main.tf` が line-webhook へ env 配線済み）:

```hcl
gbp_oauth_client_id    = "000000000000-xxxxxxxx.apps.googleusercontent.com"   # 10-1 の client_id
gbp_oauth_redirect_url = "https://<line-webhook の Cloud Run URL>/gbp/oauth/callback"  # 10-1 のリダイレクト URI と同一値
```

コード側の env は `GBP_OAUTH_CLIENT_ID`・`GBP_OAUTH_CLIENT_SECRET`・`GBP_OAUTH_REDIRECT_URL`・`GBP_TOKEN_CIPHER_KEY`・`GEMINI_API_KEY` を必須とし、欠落時は `config.Load()` 相当で起動時 fail-fast する（`ts/apps/line-webhook/src/config.ts`）。`gemini-api-key` は既存枠を line-webhook へも配線済み（機能2/1-b の下書き生成で使用）。

### 10-3. 稼働確認

1. **設定の健全性**: secret 投入 + tfvars apply 後にデプロイ。env 欠落があれば line-webhook が起動時に落ちる（fail-fast が防波堤）。
2. **鍵の注意**: `openssl rand -base64 32` の出力は末尾改行を含むが、コードの base64 デコードは空白を無視するため 32 byte が正しく得られる（実装確認済み）。
3. **手動 E2E**（tasks.md 6.3・両審査承認後にのみ実施可能）: 実 Google アカウント・検証用店舗で 連携 → 投稿 → 返信 → 解除 の一連を確認する。これが Issue #8 完了条件（連携済み店舗が LINE から Google 投稿・返信を実行できる）の実証。
4. **契約の同期**: サマリー Flex・リッチメニューの postback data（`a=g_post`/`a=g_reply`/`a=g_status`）は line-webhook の `encodeGbpPostback` とリテラルで整合させている（apps 間 import 不可のため）。action 名を変える際は両側同時更新（design の Revalidation Trigger）。
