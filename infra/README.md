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
7. **Places API クォータ ID の確認と設定**（Req 7.2）。実名は Cloud Quotas API の `quotaInfos` が正典:
   ```bash
   curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
     -H "x-goog-user-project: gen-fw-line-meo" \
     "https://cloudquotas.googleapis.com/v1/projects/gen-fw-line-meo/locations/global/services/places.googleapis.com/quotaInfos?pageSize=200"
   ```
   返る `quotaInfos[].quotaId` が実名である。バッチが使う日次エンドポイント（`SearchTextRequestPerDayPerProject` / `SearchNearbyRequestPerDayPerProject` / `GetPlaceRequestPerDayPerProject`）を `terraform.tfvars` の `places_quota_caps`（`quota_id => 上限値` の map）へ設定してから apply する（空 `{}` だと上限が作られず Req 7.2 未達）。

   **gcloud に quota 用のコマンド群は無い。** 575.0.0 で `gcloud services quota` は `Invalid choice: 'quota'`、`gcloud quotas` も `Invalid choice: 'quotas'` を返す（`gcloud alpha quotas` はコンポーネント追加を要求するため既定では使えない）。ここで REST を直接叩いているのはそのためである。
8. **GitHub リポジトリ変数の設定**（WIF 検証ワークフロー用）: `vars.WIF_PROVIDER = terraform output wif_provider_name`、`vars.GCP_PROJECT_ID = gen-fw-line-meo`
9. **LIFF チャネル作成**（competitive-daily-summary / store-detail 用。LINE Developers コンソールでの手動作業・Terraform 管理外。LINE は LIFF/LINE Login チャネルの Terraform provider を持たないため恒久的に手動）:
   - Messaging API チャネルと **同一プロバイダー配下**に LINE Login チャネルを新規作成する（`ts/apps/store-detail/lib/liff-auth.ts` の userId 突合はプロバイダー一致が前提）
   - その LINE Login チャネル配下に LIFF アプリを追加し、エンドポイント URL に store-detail の Cloud Run URL（`terraform output service_names` の `store-detail` から解決）を設定する
   - 取得した LINE Login チャネル ID・LIFF アプリ ID・LIFF URL をそれぞれ `terraform.tfvars` の `liff_channel_id`・`liff_id`・`liff_url` に設定し `make tf-apply` する（#6 LINE 基盤チームと共同で実施・design.md「Open Questions / Risks」参照。line-onboarding は既にマージ済みのため、Messaging API チャネル自体は準備済み）

10. **人のアカウントの IAM**（Terraform は SA とワークロードの権限だけを持つ）。現在の付与は次の表が正典で、足すとき・外すときは同じ PR でこの表を更新する。確かめ方: `gcloud projects get-iam-policy gen-fw-line-meo --flatten=bindings --filter="bindings.members:user" --format="value(bindings.role,bindings.members)"`

    | アカウント | ロール | 理由 | 期限 |
    |---|---|---|---|
    | `gen.gourmet1234@gmail.com` | `roles/owner` | Terraform の ADC（§9-2-a） | 恒久 |
    | `manapuraza@gmail.com` | `roles/owner` | 運用・gcloud・Search Console の所有権確認（§9-2-a） | 恒久 |
    | `firstweb.sato@gmail.com` | `roles/oauthconfig.editor`・`roles/browser` | 同意画面のユーザーサポートメールに自分のアドレスを選ぶため、同意画面をこのアカウントで設定する（選べるのは設定者自身のアドレスか、その人が管理する Google グループだけ）。Editor は本番リソースまで変更できるので使わない | 同意画面の設定が済んだら外す（2026-09-23 付与・Issue #146） |

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
psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f db/migrations/0004_competitive_daily_summary.sql
psql "host=127.0.0.1 dbname=fwlm" -v ON_ERROR_STOP=1 -f infra/sql/grants.sql   # IAM ロール名は grants.sql が :project から組み立てる
```

- migration は `db/migrations/` に存在する番号を実際に確認してから番号順に適用すること（本書の例を鵜呑みにしない）。`infra/sql/grants.sql` は `daily_summaries`/`summary_deliveries`（0004）を含む全テーブルへの GRANT を前提とするため、0004 未適用のまま grants.sql を実行すると失敗する（task 6.1 レビューで発見）。

- `infra/sql/grants.sql` は IAM DB ユーザー（`sa-*@gen-fw-line-meo.iam`）へ `db/write-boundary.md` と整合する GRANT を付与する版管理ファイル。手順書内に生 SQL を埋め込まない（再現性）。ロール名は `:project` から組み立てるため、**この既定値が GCP プロジェクト ID であること**が前提になる（2026-08-24 まで既定が DB 名の `fwlm` になっており、上のコマンドは `role "sa-line-webhook@fwlm.iam" does not exist` で全 GRANT がロールバックしていた・PR #144 で是正）。

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
- **監視構成の定期検証（Issue #230）**: `.github/workflows/monitoring-drift.yml`（`monitoring-drift`）が 6 時間ごとに、`infra/modules/guardrails/main.tf` の宣言と本番の alert policy / ログベース指標を **両方向で** 突き合わせる。**read-only の照会のみ**（`gcloud monitoring policies list` と Monitoring の `metricDescriptors`）であり、構成変更も state への書き込みも行わないため本契約に抵触しない。CI に付く IAM は `roles/monitoring.viewer` のみで、**`gcloud logging metrics list` の経路は採らない**（それに必要な `logging.logMetrics.*` はこのロールに含まれず、代わりに `roles/logging.viewer` を付けると `logging.logEntries.list` まで付いて CI がログ本文を読めるようになる。Req 5.4 に反する）。
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

daily-batch の「成功」の観察可能な証拠は、この実行サマリーログ 1 行が出力され、かつ `daily_summaries`（Go 書込）に該当日の行が増えていること（§3 の Auth Proxy 経由 `psql` で確認）。

summary-delivery（毎時 Job）も同様に `gcloud run jobs execute summary-delivery ...`／`resource.labels.job_name="summary-delivery"` で確認できる。**ただし「送った件数」も「`summary_deliveries` に該当日の行が増えたこと」も成功の条件ではない**（Issue #256）。通知は**変化があった日にだけ**送るので、1 通も送らない実行が正常でありうるうえ、送らないと決めた対象も理由つきで同じ表へ行を残すため、行の増加は「送った」ことを意味しない。実行サマリー（`jsonPayload.event="delivery-job.run"`）に対して見るのは次の 4 点である。

- 失敗（`failed`）が 0 件
- 上限超過（`quotaExceeded`）が 0 件
- 完了後メニューの準備判定（`reportMenuReady`）が true（差し替え漏れを緑にしないため・§10）
- すべての対象が数えられている（`delivered` ＋ `failed` ＋ `quotaExceeded` ＋ `skipped` ＋ `skippedNoChange` ＋ `skippedNotComparable` ＋ `skippedMenuUnavailable` ＝ `targetsTotal`）

この判定は `scripts/run-e2e-prod-checks.sh` の 6 が行う（`PROJECT_ID=gen-fw-line-meo make e2e-prod-checks`・読み取りのみ・運用者用）。同じ期間に致命的な失敗（`delivery-job.fatal`）が無いことも併せて見る。手順書は `docs/testing/e2e.md`。

### 7-4. CI 化する場合

§5 の CI デプロイ契約（イメージ更新のみ・WIF・SA キー不使用）に従う。`scripts/push-images.sh` は CI からもそのまま呼び出せる（`gcloud auth configure-docker` は WIF 認証後であれば動作する）。

**実装済み（Issue #23）**: `.github/workflows/deploy.yml`（`deploy-prod`）が本フローを自動化する。`ts-ci` が `main` で緑になった後（`workflow_run`・テスト赤のまま出荷しない）、または `workflow_dispatch`（手動）で、3イメージを build → push → `gcloud run jobs/services update --image` で反映する。契約遵守のため `gcloud run deploy` や env/scaling 変更・terraform state 操作は一切行わない。**追加で必要なリポジトリ変数**: `vars.NEXT_PUBLIC_LIFF_ID`（tfvars `liff_id` と同値。store-detail の client bundle へ `next build` 時にインライン化される値のため build-arg で渡す。ランタイム env では効かない）。値未設定なら push-images.sh が hard-fail し、空の LIFF ID を焼き込んだイメージの出荷を防ぐ。LIFF ID を変更する際は tfvars `liff_id` と `vars.NEXT_PUBLIC_LIFF_ID` の両方を更新すること。

**実装済み（Issue #91）**: `.github/workflows/prod-image-drift.yml`（`prod-image-drift`）が 6 時間ごとに稼働実態と `origin/main` の乖離を検証する（read-only）。`deploy-prod` にも失敗通知ジョブを持たせ、いずれも `scripts/report-ci-issue.sh` でラベル単位の追跡 Issue を 1 本だけ維持する（`prod-image-drift` / `deploy-prod-failure`）。復旧を検出すると自動で閉じる。手動での即時確認と赤の実証は `gh workflow run prod-image-drift.yml --ref main` で行う（`snapshot` 入力に TSV を渡すと gcloud を叩かずに任意の状態を再現できる）。

---

## 8. 外部 API 実疎通の手順（Issue #125）

`infra/secrets-provisioned.tsv` の二層検証（§5）は「宣言どおりの version が入っている」までしか言えず、**値そのものの正当性は原理的に検出できない**。プレースホルダー文字列・失効キー・別プロジェクトのキー・課金無効はいずれもメタデータからは見えない。到達手段は実際に外部 API を叩いて成功を観測することだけである。

**この手順は CI では走らない。** 実疎通には値そのものが要るが、CI へ `roles/secretmanager.secretAccessor` を付けることは Req 5.4 に反する（§5 の契約）。実行するのは運用者であり、使うのは運用者自身の `gcloud` 資格情報である。

実施記録の正典は `infra/external-api-smoke.tsv`。**外部 API に依存する機能は、この記録が `PENDING` でなくなるまで go-live を完了扱いにしない。**

### キーの設定は 1 回・確認は 14 日ごと

この 2 つを混同しないこと。**API キーに寿命はなく、定期的な再発行も更新も不要である**。にもかかわらず確認が要るのは、**値が正しいまま使えなくなる経路が実在する**からである。

| 起きること | Secret Manager の値 | メタデータ検証（§5）で見えるか |
|---|---|---|
| 課金が止まる | 変わらない | 見えない |
| コンソールでキーを失効・再生成する | 変わらない | 見えない |
| プロジェクトで API が無効化される | 変わらない | 見えない |
| クォータやプランが変わる | 変わらない | 見えない |
| 別プロジェクトのキーだと後から判明する | 変わらない | 見えない |

本プロジェクトは **2026-08-02〜09 に実際に課金失効を踏んでいる**（7 日間気づかなかった。§5 と steering の #91 を参照）。その手前では #63 の「設定したつもりで値がプレースホルダーのまま 4 週間」も踏んでいる。**「1 回設定したから大丈夫」は、この 2 回に裏切られた前提である**。

したがって **有効期間 14 日はキーの寿命ではない**。「壊れていることに気づかないまま過ごしてよい上限」である。叩き直しの作業は**キーに一切触らない** — 再発行も値の書き換えもせず、「今も生きているか」だけを見る。

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
- **チャネルアクセストークンの枠は存在しない**（Issue #141 で撤去済み）。送信側の 2 消費者（`ts/apps/delivery-job/src/line.ts` / `ts/apps/line-webhook/src/line/client.ts`）はどちらもチャネル ID とシークレットから stateless token を都度発行するため、長期トークンを Secret Manager に置く必要が無い。したがって `line-channel-secret` の正当性が証明できれば、LINE 送信系の資格情報はすべて証明できている。

### 8-4. 記録の更新

実疎通が全て PASS したら、同じ PR で `infra/external-api-smoke.tsv` の該当行を更新する。

- `<最終確認日>`: 実施日（JST・`YYYY-MM-DD`）。`PENDING` を置き換える。`run-external-api-smoke.sh` が出す行は実行環境の TZ に依らず JST で押してあるので、そのまま貼ってよい（鮮度検証の基準日も JST 固定で、両者は必ず同じ暦の上で比較される）。
- `<証拠>`: 後から辿れる短い識別子（実行日時・run URL・execution id 等）。空欄や `-` は層1 ガードが赤にする。

`scripts/check-external-api-smoke.sh`（ts-ci）が構造を、`scripts/check-external-api-smoke-freshness.sh`（`external-api-smoke-freshness` ワークフロー・日次）が鮮度を検証する。後者は `PENDING` と期限切れを赤にし、`scripts/report-ci-issue.sh` がラベル `external-api-smoke` の追跡 Issue を 1 本だけ維持する。記録を更新すると次の実行で自動的に閉じる。

**有効期限は最終確認日 + 14 日**で、その日の検証までは有効、翌日の検証から期限切れ（赤）になる。期限切れの翌朝に初めて鳴るのでは叩き直しが間に合わないため、**残り 2 日以内（経過 12〜14 日）は期限間近として予告する**。

| 経過日数 | 判定 | ジョブ | 追跡 Issue（ラベル `external-api-smoke`） |
|---|---|---|---|
| 0〜11 日 | 有効 | 緑 | あれば閉じる |
| 12〜14 日 | 期限間近（`WARN`） | 緑のまま | 「期限間近」として起票（既にあればコメント） |
| 15 日以上・`PENDING` | 期限切れ・未実施 | 赤 | 起票（既にあれば同じ Issue へコメント） |

予告の Issue には有効期限と、叩き直すコマンド（§8-0 の `bash scripts/run-external-api-smoke.sh --place-id … --model … --channel-id …`）が載る。期限までに §8-0 で叩き直し、本節の手順で記録を更新して main へ載せれば、次の実行で緑になり Issue は自動で閉じる。叩き直さないまま期限を過ぎると、翌日の実行から赤になり同じ Issue へ期限切れとしてコメントが付く（ラベルごとに 1 本で、予告と期限切れで Issue を分けない）。予告の間は状態が変わらないためコメントは増えない。予告の窓は検証スクリプトの定数 `WARN_WITHIN_DAYS` が決める。

**日付だけを更新して実疎通を省略しないこと。** このガードは人間の実施を強制できず、記録の鮮度しか見ていない。`<証拠>` 欄は、後から「本当に叩いたのか」を第三者が辿るための唯一の手掛かりである。

## 9. GBP 連携の Google 審査（Issue #146 / 機能2・機能1-b の前提）

Google ビジネスプロフィール（GBP）への投稿作成・クチコミ返信（第2フェーズ・Issue #8）を本番で動かすには、**Google の審査を 2 つ通す**必要がある。どちらも所要期間が非公開でクリティカルパスであり、実装の完成を待たずに着手する（これが Issue #146 の趣旨。前身の #7 は審査要件の調査と本節の整備を終えて 2026-08-22 にクローズ済み）。

この節は**審査を通すための手順だけ**を持つ。OAuth クライアントの作成・secret 実値の投入・稼働確認は実装（`ts/apps/line-webhook/src/gbp/`）と対になるため、実装 PR 側の手順書に置く。

### 9-0. 全体像（2 つの Google 関門）

| 関門 | 何を承認するか | 通らないと | 前提 |
|---|---|---|---|
| A. GBP API 利用審査 | v4 API（投稿・返信）の呼び出しクォータ | クォータ 0 で全呼び出しが権限エラー | 60 日以上 verified な GBP の管理権限 |
| B. OAuth アプリ検証 | `business.manage` スコープの同意画面 | Testing のままだと refresh token が 7 日で失効し、全店舗が毎週再連携 | 自己所有の独自ドメイン |

**2 つの前提は互いに独立している。** 関門 A は GBP を、関門 B は独自ドメインを待つ。片方が揃わないことを理由にもう片方を止めないこと。

### 9-1. 関門 A: GBP API 利用審査（access request・人手）

GCP コンソールで GBP API を有効化しただけでは使えない。**別途の利用申請が承認されるまでクォータは 0**（承認で 300 QPM）。

**申請フォームへ入れる値（実測・2026-08-17）**

| 欄 | 値 |
|---|---|
| Google Cloud Project Number | `903142718720`（`gcloud projects describe gen-fw-line-meo --format="value(projectNumber)"`） |
| 連絡先メール | 対象 GBP の**オーナー/マネージャーに登録済み**のアドレスであること（別アドレスだと弾かれる） |
| ドロップダウン | `Application for Basic API Access` |

- **前提条件**（満たさないと申請が通らない）: 申請アカウントが **60 日以上 verified かつ active な GBP を管理**・その GBP に Web サイトが登録済み・オーナー/マネージャー権限。GBP のプロフィールは最新かつ記入漏れが無い状態にしておくこと（審査の所要を左右する）。
- **手順**: GBP API のコンタクトフォームから申請 → メールで可否連絡 + クォータ反映。
- **承認の観察可能な証拠**: 正典は Cloud Console のクォータ画面（未承認 0 QPM → 承認 300 QPM）。CLI からの簡易判定は次で足りる。**未承認の間、v4 の `mybusiness.googleapis.com` はこのプロジェクトの API ライブラリに現れない**。

  ```bash
  gcloud services list --available --project=gen-fw-line-meo \
    --filter="config.name=mybusiness.googleapis.com" --format="value(config.name)"
  # 空 = 未承認 / 1 行返る = 承認済み（有効化できる状態）
  ```

  実測: 2026-08-17 と 2026-08-21 のいずれも **0 件（未承認）**。同じ時点で新 API 群 8 本（`mybusinessaccountmanagement` ほか）は列挙されるので、フィルタが空振りしているわけではない。有効化済み API（`--enabled`）にも GBP 系は 1 本も無い。

  **`gcloud services quota list` というコマンドは存在しない**（gcloud 575.0.0 で `Invalid choice: 'quota'`）。以前この節と §1 項目 7 の両方に書いていた誤りで、いずれも是正済み（Places のクォータ実名確認は §1 項目 7 の Cloud Quotas REST を使う）。

- **承認後に有効化する API**: 公式手順は Business Profile 関連の **8 本すべて**の有効化を要求する（Google My Business API / My Business Account Management / Business Information / Lodging / Place Actions / Notifications / Verifications / Q&A）。実装が実際に叩くのは次の 3 ホストだが、審査側の前提に合わせて 8 本を有効化しておくのが安全: `mybusiness.googleapis.com`（v4・投稿と返信）/ `mybusinessaccountmanagement.googleapis.com`（v1）/ `mybusinessbusinessinformation.googleapis.com`（v1）。

#### 9-1-a. 前提 GBP の確保

**この関門は工学の問題ではなく事業の問題である。** 60 日要件は文言上**プロフィール自体の年齢**に掛かっており、「自社のものでもクライアントのものでもよい」と明記されている。取り得る経路は 3 本で、優劣が明確に違う。

| 経路 | 申請可能になる時期 | 判定 |
|---|---|---|
| B. クライアント／代理店の既存 GBP にマネージャー権限をもらう | プロフィールが既に 60 日超なら**即日** | **推奨。実質これ一本** |
| A. 運営自身の既存 GBP を使う | 即日 | 保有していれば最速。2026-08-21 時点で無し |
| C. 運営が新規に GBP を作って verify する | 最短でも 60 日後 | **成立しない可能性が高い**。下記 |

**C が危ういのは待ち時間ではなく資格である。** GBP は「営業時間中に顧客と対面接触する事業」に限られ、**オンライン専業の事業・ブランド・組織は対象外**と明記されている（実店舗を持つか、顧客のもとへ出向くサービスエリア型のいずれかであること）。加えて「リード獲得の代理業」も不適格例として名指しされている。本サービスの運営が対面接触を伴わない形態なら、**GBP を作ること自体ができない**。実態の無いプロフィールを作るのはガイドライン違反であり、停止処分と申請否認のリスクを自ら作ることになる。

したがって **Phase2 の本番解禁は「最初の実クライアント（または代理店）との関係が立つこと」に依存する**。その相手の GBP は通常すでに 60 日を超えているため、マネージャー権限をもらえた時点で関門 A の年齢条件は満たされる。ロードマップ上、ここはエンジニアリングのタスクではなくセールスのマイルストーンとして扱うこと。

**権限付与後の注意**: オーナー／マネージャーになってから **7 日間は一部機能が操作できない**。権限をもらったその日に全部が動くとは考えないこと。

### 9-2. 関門 B: OAuth アプリ検証の提出物

`business.manage` は sensitive スコープのため Google の OAuth 検証が必要で、**審査は最大 10 日**。ここで揃える提出物は**デモ動画を除いて GBP に依存しない**。関門 A が事業側で詰まっている間に、ここを空にしておくと承認後の待ち時間が最小になる。

| 提出物 | 要件 | 2026-09-23 時点（状態の正典は Issue #146） |
|---|---|---|
| 独自ドメイン | 自己所有・Search Console で所有権検証済み | **`firstweb-works.com` を取得済み**（お名前.com・2026-09-22 登録。9-2-a） |
| ドメイン所有権の検証 | **Project Owner** のアカウントで、Search Console の **Domain property（DNS の TXT）** を検証する（9-2-a） | **確認済み**（2026-09-23・`manapuraza@…`・DNS の TXT） |
| OAuth コールバックのドメイン | リダイレクト URI のドメインも承認済みドメインに含める。`run.app` のままでは入れられない（9-2-b） | 割り当て済み（2026-09-23・`api.firstweb-works.com` → line-webhook）。redirect URI の差し替えは Phase2 と対（Issue #282） |
| 公開ホームページ | ログイン不要で閲覧でき、アプリ／ブランドを正確に説明し、プライバシーポリシーへリンクすること。ログイン画面だけの構成は不可 | 実装済み（ManatoYamashita/fw-website）・独自ドメインでの公開待ち |
| プライバシーポリシー | **ホームページと同一ドメイン**に置く。ホームページと OAuth 同意画面の両方からリンクし、**両者のリンク先 URL が一致**すること。Google ユーザーデータの取得・利用・保存・共有をどう行うか明記する | 同上 |
| スコープ正当性 | `business.manage` を要求する理由と、より狭いスコープでは不十分な理由。参考リンクは最大 3 本まで添付可 | 下書き済み（fw-website `docs/google-review.md`） |
| ブランディング | アプリ名・ロゴ・デベロッパー連絡先が実体と一致していること | 下書き済み（同上） |
| デモ動画 | YouTube へ Unlisted で上げる。**英語**で OAuth 同意フローを流し、同意画面にアプリ名が正しく出ること・**ブラウザのアドレスバーに OAuth クライアント ID が見えること**を映し、要求スコープが実際に何を可能にするかを実演する | **関門 A 承認後**（実 API 呼び出しの実演が要るため、唯一 GBP を待つ提出物） |

**Testing のまま放置しないこと。** 「未確認アプリ」警告に加え、テストユーザーの承認自体が **7 日で失効**する。IT に不慣れなオーナーへ毎週の再連携を強いることになり、本サービスの存在意義に反する。**検証結果の有効期間も 7 日**で、その間に Published へ切り替えないと再検証がいる。承認が出たら速やかに公開すること。

#### 9-2-a. 独自ドメインと所有権の検証

**運営のドメインは `firstweb-works.com`**（お名前.com で 2026-09-22 に登録・更新期限 2027-09-22）。それまでの公開面は Cloud Run の `*.run.app` だけだった。

**`*.run.app` は承認済みドメインに使えない。** Google は「public suffix 上で登録可能なドメイン成分」＝ top private domain の所有権検証を要求するが、`run.app` は Google が管理する public suffix であり、その配下のホスト名を自分のドメインとして Search Console で検証することはできない（`github.io` や `herokuapp.com` と同型の制約）。

DNS は Cloudflare で持つ（ホームページ・ポリシーは Cloudflare Workers の fw-website が配信する。公開の手順は fw-website `docs/google-review.md`）。この順序で進める:

1. お名前.com のネームサーバーを、Cloudflare が zone に割り当てた 2 つへ書き換える
2. **Project Owner** のアカウントで Search Console に **Domain property** を作り、DNS の TXT レコードで検証する
3. fw-website を apex に載せ、ホームページとプライバシーポリシーを公開する（同一ドメイン）
4. OAuth コールバックを `api.firstweb-works.com` へ移す（9-2-b）
5. OAuth 同意画面の承認済みドメインへ `firstweb-works.com` を登録し、プライバシーポリシー URL をホームページ側のリンクと一致させる

1〜4 は GBP と無関係に進む。**関門 A の事業ゲートを待つ理由にはならない。**

**検証は Project Owner が DNS の Domain property で行う。** 公式要件は 2 ページにまたがり、厳しい側に揃える。

- Google Cloud Help「Domain Verification」（support.google.com/cloud/answer/13804266・2026-09-23 確認）: `You must verify the Domain Property (DNS-level), rather than a 'URL prefix' or 'Site,' property.` と `The domain verification must be performed by a Google account that is currently a Project Owner of your Google Cloud Project.`
- sensitive scope 検証のページ: `Use a Google Account that's associated with your API Console project as an Owner or an Editor.`

この節は 2026-08-22 版で後者だけを根拠に「Owner または Editor で足り、検証方式の指定は無い」と書いていた。**それは前者のページを見落とした誤りである**（Issue #146 の 2026-09-15 のコメントで指摘）。前者を満たせば後者も満たすので、Project Owner による Domain property の検証だけを行う。

検証するアカウントは gcloud で使うアカウントと揃える。Cloud Run のドメインマッピング（9-2-b）は、**所有者として確認済みのアカウントでしか作れない**（公式: `You must verify domain ownership the first time you use that domain in the Google Cloud project`）。確かめ方:

```bash
gcloud domains list-user-verified   # firstweb-works.com が並べば、今の gcloud アカウントで割り当てを作れる
```

**Terraform は gcloud のアカウントではなく ADC で呼ぶ。** 2026-09-23 の初回の apply は、gcloud が `manapuraza@…`（確認済み）でも ADC が `gen.gourmet1234@…`（未確認）だったため、`Caller is not authorized to administer the domain api.firstweb-works.com` で落ちた（割り当ては失敗状態のまま state に tainted で残り、次の apply で作り直された）。ADC の主体は次で確かめる:

```bash
curl -s "https://oauth2.googleapis.com/tokeninfo?access_token=$(gcloud auth application-default print-access-token)" | grep email
```

食い違うときは、確認済みアカウントのトークンでその apply だけを行う（権限の付与を増やさない）:

```bash
GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token --account=<確認済みのアカウント>)" \
  terraform -chdir=infra/envs/prod apply -target=google_cloud_run_domain_mapping.gbp_oauth_callback
```

割り当ての作成・削除だけがドメインの権限を要する。作った後の plan（読み取り）は ADC のままで通る。

#### 9-2-b. OAuth コールバックを独自ドメインへ移す（Issue #282）

OAuth ブランド検証のページ（developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification・2026-09-15 確認）は `The Authorized domains section also needs to include the redirect URIs or JavaScript origins authorized in your "Web application" OAuth client types.` と定める。**コールバックが `run.app` のままでは、承認済みドメインに入れられず関門 B を通らない。**

`api.firstweb-works.com` を line-webhook に割り当てる。宣言は `infra/envs/prod/custom-domain.tf`（Cloud Run のドメインマッピング）。

**ドメインマッピングを選んだ理由と、その代償。** 公式は `Cloud Run domain mappings are in the preview launch stage. Due to latency issues, they are not production-ready` と明記する（asia-northeast1 は対応リージョン）。ここを通るのはオーナー 1 人につき 1 回の OAuth コールバックだけなので、遅延は実害にならない。常時費用のかかるロードバランサ（公式推奨）は選ばなかった。**LINE の Webhook など、応答時間が効く経路をこのドメインへ載せないこと。** 載せる必要が出たらロードバランサへ移す。

手順（9-2-a の検証が済んでから）:

```bash
# 1. 割り当てだけを作る（素の apply は承認待ちの module.guardrails を巻き込む・§10「apply の作法」）
terraform -chdir=infra/envs/prod plan  -target=google_cloud_run_domain_mapping.gbp_oauth_callback
terraform -chdir=infra/envs/prod apply -target=google_cloud_run_domain_mapping.gbp_oauth_callback

# 2. 求められる DNS レコードと状態を読む（サブドメインは CNAME ghs.googlehosted.com.）。
#    gcloud の domain-mappings は beta コンポーネントを要するので、state から読む。
terraform -chdir=infra/envs/prod state show google_cloud_run_domain_mapping.gbp_oauth_callback
```

3. Cloudflare の DNS に `api` の CNAME を `ghs.googlehosted.com` で作る。**プロキシは OFF（DNS only）にする。** ON だと Google が証明書の発行時にドメインへ到達できず、割り当てが `CertificatePending` のまま止まる。
4. 証明書の発行を待つ（数十分〜）。`terraform apply -refresh-only -target=…` の後に 2 を読み直し、`status` の `Ready` が `True` になれば終わり。
5. 到達を確かめる。line-webhook の `/health` が run.app と同じ応答を返せば、TLS と割り当ての両方が通っている（`/gbp/oauth/callback` は Phase2 のコードがデプロイされるまで 404 でよい）。

```bash
curl -s -w ' %{http_code}\n' https://api.firstweb-works.com/health   # {"status":"ok"} 200
```

6. Phase2 の設定を差し替える（Issue #8 の実装と対。`infra/README.md` の Phase2 側 §10）:
   - tfvars の `gbp_oauth_redirect_url` を `https://api.firstweb-works.com/gbp/oauth/callback` にして apply する
   - OAuth クライアント（Web アプリケーション）の承認済みリダイレクト URI を**同じ値**に差し替える（1 文字でも違えば `redirect_uri_mismatch`）
   - 同意画面の承認済みドメインに `firstweb-works.com` を登録する（ホームページ・ポリシーと同じ top private domain なので 1 つで足りる）

### 9-3. 進捗の追跡

この節は**手順の正典**であり、状態の正典ではない。承認・却下・提出の事実は Issue #146 のコメントへ実測の証拠つきで残すこと（9-1 の判定コマンドの出力、クォータ画面のスクリーンショット、申請日と受領メールの日付）。

実装側の手順（OAuth クライアントの作成・リダイレクト URI・secret 実値の投入・稼働確認）は Issue #8 の PR に付属する。両審査が通るまで、その PR は Draft から出せない。

---

## 10. 完了後リッチメニューの差し替え（Issue #195 / #256）

**「PNG の差し替えはコード変更ゼロ」は真だが「反映コストゼロ」は偽である。**
`.claude/skills/messaging-api/references/rich-menu.md` が明記するとおり、LINE は
アップロード済みの画像を上書きできない（*Cannot replace an image once uploaded — must create
a new rich menu and re-upload.*）。区画と action も作った後では変えられない。差し替えは常に
**新しいメニューの作成と、既存オーナー全員の張り替え**になる。

**Issue #256 以降、これは絵の入れ替えではなく配信の関門である。** 完了後メニューはレポートの
3 導線（新着口コミ・競合店との比較・直近の推移）を持ち、配信ジョブは設定された完了後メニューが
その 3 導線を持つことを確かめるまで通知を送らない（見送りの理由 `skipped_menu_unavailable`）。
差し替えが終わるまで通知は 1 通も出ない。

**CI では一切検証できない。** `ts/apps/line-webhook/test/scripts/` の試験が見るのは、区画が
重ならず面を覆うこと・postback が符号器の出力と一致すること・宣言した寸法が実 PNG の IHDR と
一致すること・張り替えの 4 分類と削除の条件までである。実チャネルへの反映が正しいかは実機でしか
分からない。**デモ直前に触らないこと。**

### 10-0. 前提と、差し替えを置く位置

差し替えは公開手順の Step C である（`.kiro/specs/line-on-demand-report/design.md`「Migration
Strategy」）。**順序を入れ替えない。** CI はイメージだけを差し替え、env は Terraform が持つので、
env を足す変更は必ずイメージより先に、外す変更は必ずイメージより後に出す。

| Step | 何をするか | 手順の在処 |
|---|---|---|
| A | `summary_deliveries.status` の migration と、配信ジョブへの `LINE_RICHMENU_COMPLETED_ID` の配線（値は旧メニューの ID のまま） | §3 → 下の「apply の作法」 |
| B | コードのマージとデプロイ。設定値は旧メニューを指すので通知は出ない | §7-2。巻き戻しは §7-2 の「1 つ前のイメージへ戻す」 |
| C | **完了後メニューの差し替え（本節 10-1〜10-5）** | 本節 |
| D | 配信ジョブの `LIFF_URL` の配線を外す（実機確認の後） | 下の「apply の作法」 |

**apply の作法（Step A・C・D に共通・素の `make tf-apply` を打たない）**

`module.guardrails`（Issue #232・ログバケットの分離）は main に入っているが、費用の承認待ちで
意図的に本番へ当てていない。`-target` を付けない apply は、それを一緒に作ってしまう。

```bash
# 1. そのコミットの deploy-prod が終わってから行う（保存した plan を当てない）。
#    in-place の更新は plan を作った時点のイメージの値を送るので、デプロイ前の plan を
#    当てるとイメージが巻き戻る。
gh run list --repo ManatoYamashita/fw-line-meo --workflow deploy-prod --limit 3

# 2. plan で差分を読む。属性まで下りて見る（`client` と `client_version` の 7 件は既存のずれ）。
terraform -chdir=infra/envs/prod plan -target=<アドレス>

# 3. 同じ -target で当てる。
terraform -chdir=infra/envs/prod apply -target=<アドレス>
```

Step ごとのアドレス:

| Step | `-target` に渡すアドレス |
|---|---|
| A | `module.delivery_job.google_cloud_run_v2_job.delivery` |
| C | `module.run_services.google_cloud_run_v2_service.svc["line-webhook"]` と `module.delivery_job.google_cloud_run_v2_job.delivery` の **2 つを同じ apply に入れる**（`line_richmenu_completed_id` は両方が読む。片方だけだと 2 つが別々のメニューへ張り合う） |
| D | `module.delivery_job.google_cloud_run_v2_job.delivery` |

#232 が承認されて `module.guardrails` を本番へ当てた後は、この絞り込みは要らなくなる。

着手前に確かめること:

- **パイロットと実演の実施期間内には行わない**（Req 9.4）。判断の正典はリリース計画（Issue #256）
  である。2026-09-13 に置いた計画ではパイロットが 2026-10-26 から始まるので、それより前に
  差し替えを終える。**計画の日付は動くので、この節の日付ではなく Issue を見ること。**
- Step B のイメージが本番で動いていること（`PROJECT_ID=gen-fw-line-meo make e2e-prod-checks` の
  1 が PASS で、デプロイ待ちの WARN も出ていないこと）。
- 画像とコード定数（`ONBOARDING_MENU_SIZE` / `COMPLETED_MENU_SIZE`・
  `ts/apps/line-webhook/scripts/rich-menu-definitions.ts`）がメニューごとに一致した状態が `main`
  にあること。寸法はメニューごとに異なる（オンボーディング用は Half 2500x843、完了後は
  Full 2500x1686）。食い違いも、画像そのものの仕様（PNG 署名・1MB 以下・アルファ無し）も
  `pnpm -C ts --filter @fwlm/line-webhook run test` が実 PNG のバイト列に対して赤にする。
  **画像の検査点はここ 1 箇所だけである**（別立ての shell ガードは置かない。同じことを二重に
  見る層は、片方が腐ったときに腐ったと言えない）。
- 焼き元は `ts/apps/line-webhook/assets/source/*.html`。**正典は PNG であり HTML は出所である**
  （フォント描画が描画機に依存するため、同じ HTML から同じ PNG は出ない）。

手順が要求する env は次のとおり。**シークレットを argv へ置かない**（§8-1・§8-3 と同じ理由）。
チャネルアクセストークンはスクリプトが env のチャネル ID とシークレットから自分で発行するので、
トークンを手で作って渡す必要は無い。

| env | 出典 | 本番での値 |
|---|---|---|
| `LINE_CHANNEL_ID` | `ts/apps/line-webhook/scripts/setup-rich-menus.ts` | 本番 `line-webhook` の同名 env（§8-0 の方法で確認する） |
| `LINE_CHANNEL_SECRET` | 同上 | `gcloud secrets versions access latest --secret=line-channel-secret` の出力 |
| `LIFF_STORE_DETAIL_URL` | 同上 | 本番 `line-webhook` の同名 env（`terraform.tfvars` の `liff_url` と同値・`infra/envs/prod/main.tf`） |
| `DATABASE_URL` | `ts/apps/line-webhook/scripts/relink-completed-menu.ts` | §3 の Auth Proxy 経由の接続文字列 |

要求する組は段ごとに違う。10-1 のメニュー作成は上の 3 つ（`DATABASE_URL` は読まない）、10-3 の
張り替えは `LINE_CHANNEL_ID`・`LINE_CHANNEL_SECRET`・`DATABASE_URL` である。どれか 1 つでも欠けた
まま実行すると、**LINE も DB も 1 度も呼ばずに** `<NAME> is required` で落ちる
（`throw new Error('<NAME> is required')` の形で自己申告しているため）。

**pnpm の引数に `--` を挟まない。** pnpm 10 は `--` を区切りとして食わず、そのまま引数として
スクリプトへ渡す（実測: `pnpm run relink-completed-menu -- --to X` は
`relink-completed-menu: unknown argument --` で落ちる）。下のコマンドの形で書くこと。

### 10-1. 段 1: 完了後メニューだけを作る

```bash
# 共有パッケージの dist（/line-report・/db）を先に作る。クリーンな checkout では
# dist が無く、build:scripts だけでは解決に失敗する。
pnpm -C ts run build:packages
cd ts/apps/line-webhook
pnpm run build:scripts
SECRET="$(gcloud secrets versions access latest --secret=line-channel-secret --project=gen-fw-line-meo)"
LINE_CHANNEL_ID='<§8-0 の方法で確認する>' \
LINE_CHANNEL_SECRET="$SECRET" \
LIFF_STORE_DETAIL_URL='<§8-0 の方法で確認する>' \
  pnpm run setup-rich-menus --completed-only
```

- **`--completed-only` を必ず付ける。** 付けないとオンボーディング用メニューまで作り直し、
  `setDefaultRichMenu` で既定を差し替える。既定はオンボーディング用のままでなければならず
  （Req 2.6）、差し替えで既定に触る理由は無い。
- 出力は完了用の `richMenuId` が 1 つだけ。次の段で使うので控える。
- 完了後メニューの `name` は新旧とも `line-onboarding-completed-menu` である。差し替えの最中は
  同名の 2 面が一覧に並ぶので、**名前ではなく ID で区別する。**
- `LIFF_STORE_DETAIL_URL` に本番と違う値を渡すと、下段左の「詳細を見る」だけが別の URL を指す
  メニューができる。作った後では直せないので、ここで値を間違えない。

### 10-2. 段 2: 完了用 ID を Terraform へ

`infra/envs/prod/terraform.tfvars`（gitignore・main worktree にある）の
`line_richmenu_completed_id` を段 1 の ID に差し替えてから:

```bash
terraform -chdir=infra/envs/prod plan \
  -target='module.run_services.google_cloud_run_v2_service.svc["line-webhook"]' \
  -target='module.delivery_job.google_cloud_run_v2_job.delivery'

terraform -chdir=infra/envs/prod apply \
  -target='module.run_services.google_cloud_run_v2_service.svc["line-webhook"]' \
  -target='module.delivery_job.google_cloud_run_v2_job.delivery'
```

- **2 つのアドレスを同じ apply で指定する。** `LINE_RICHMENU_COMPLETED_ID` は line-webhook
  （店舗確定の瞬間に個別リンクを張る側）と summary-delivery（通知の前に 3 導線を確かめる側）の
  両方が読む。片方だけ当てると、2 つが別々のメニューへ張り合う。
- `make tf-plan` / `make tf-apply` を使わないのは `-target` を渡せないためである。絞るのは
  承認待ちの `module.guardrails`（Issue #232）を巻き込まないためであり、承認が済んだら素の
  `make tf-plan` / `make tf-apply` へ戻す。
- 保存した plan をデプロイと並走させない。in-place の更新は plan の時点のイメージの値を送るので、
  デプロイ前の plan を後から当てるとイメージが巻き戻る。
- **`client` / `client_version` の in-place 更新が出るのは既存ドリフト**であり自分の差分では
  ない（デプロイパイプラインが刻み、tf 側は宣言していないため毎回出る）。切り分けは resource 名
  ではなく attribute まで下りて見ること。自分の差分は `LINE_RICHMENU_COMPLETED_ID` の値だけである。
- **この段を飛ばすと、張り替えても通知は出ない。** 配信ジョブが見るのは env の ID であって、
  実際に張られたメニューではない。line-webhook 側では、以後に店舗を確定したオーナーが旧 ID へ
  張られる（失敗は握り潰して業務処理を継続する設計だが、Issue #228 以降は記録が残る:
  `line-webhook.richmenu_link_failed`。成功時は `line-webhook.richmenu_linked`）。

### 10-3. 段 3: 店舗特定済みオーナーを張り替える

**旧メニューを削除する前に必ず行う。** 段 1 は既定メニューに触れず、`setDefaultRichMenu` も
per-user リンクには触れない。店舗特定済みオーナーは `ts/apps/line-webhook/src/onboarding/conversation.ts`
が `linkRichMenu` で個別に張った**旧完了メニューに繋がったまま**である。再リンクが起きる経路は
店舗確定の瞬間だけなので、完了済みのオーナーは二度とそこを通らない。放置すれば、レポートの
3 導線を持たない古い面が恒久的に出続ける。

まず試行だけを流し、対象の件数を見る（LINE へのリンクと削除を行わない。DB は読み出しだけ）:

```bash
# 共有パッケージの dist（/line-report・/db）を先に作る。クリーンな checkout では
# dist が無く、build:scripts だけでは解決に失敗する。
pnpm -C ts run build:packages
cd ts/apps/line-webhook
pnpm run build:scripts
SECRET="$(gcloud secrets versions access latest --secret=line-channel-secret --project=gen-fw-line-meo)"
LINE_CHANNEL_ID='<§8-0 の方法で確認する>' \
LINE_CHANNEL_SECRET="$SECRET" \
DATABASE_URL='<§3 の Auth Proxy 経由の接続文字列>' \
  pnpm run relink-completed-menu --to '<段 1 の richMenuId>' --dry-run
```

試行では、張り替え先の照会（読み取り）と対象の読み出しだけを行い、`張り替え先: <ID>（レポート
3 導線を確認しました）`・`対象のオーナー: N 件`・`--dry-run のため、リンクと削除は行いません。`
を出して終わる。

件数を確かめたら、`--dry-run` を外して本番へ張る（同じシェルで続け、`SECRET` を引き継ぐ）。
旧 ID（削除の候補）は、段 2 で書き換える前の `terraform.tfvars` の `line_richmenu_completed_id`
である:

```bash
LINE_CHANNEL_ID='<§8-0 の方法で確認する>' \
LINE_CHANNEL_SECRET="$SECRET" \
DATABASE_URL='<§3 の Auth Proxy 経由の接続文字列>' \
  pnpm run relink-completed-menu --to '<段 1 の richMenuId>' --delete-old '<旧 richMenuId>'
```

本番へ張る実行は次の順に動く（`--dry-run` は 1 と 2 で止まる）。

1. `--to` のメニューがレポートの 3 導線を持つことを、誰かに張る前に確かめる。持たなければ
   **誰にも張らずに**非ゼロで終わる（押しても答えの返らない面を配らないため）。
2. `owners.onboarding_status = 'store_identified'` の LINE ユーザーを読む（この経路は DB へ書かない）。
3. 1 人ずつ張り、メニューを照会して 4 つに分ける。
4. 分類ごとの件数と、確認できなかったユーザーの**先頭 8 文字**を出す（記録に識別子の全体を出さない。
   運用記録へ貼っても漏れない形にしてある）。

| 分類 | 何が起きたか | 運用での扱い |
|---|---|---|
| 張れた（`verified`） | 照会が新しい `richMenuId` を返した | 完了 |
| 到達不能（`unreachable`） | 新 ID が返らず、プロフィールの照会が 404（ブロック中・友だち解除・退会済み） | メニューを表示しようがない相手。削除を妨げない。一覧は実施記録へ残す。ブロックが解ければ友だち追加のイベントで張り直される |
| 不一致（`mismatch`） | 新 ID が返らず、プロフィールは取れた（友だちなのに張れていない） | 原因を調べて流し直す |
| 判定不能（`error`） | ネットワークや 5xx で判定できなかった | 流し直す |

**「張った」ことは成功の証拠にならない。** LINE はブロック中・友だち解除・退会済みのユーザーへの
リンクを 200 で受理して黙って失敗する（`references/rich-menu.md` の Link conditions）。だから
照会で新しい ID が返ることまで確かめ、返らなかったときはプロフィールの照会で到達不能と不一致を
見分ける。分類の件数と先頭 8 文字は、そのまま実施記録に残す（Req 9.5 の確認の証拠になる）。

### 10-4. 段 4: 旧メニューの削除は、同じ実行が条件つきで行う

**削除を手で叩かない。** `--delete-old <旧 ID>` を渡した実行が、**不一致と判定不能がともに 0 件の
ときに限り**旧メニューを削除する。Req 9.5 の「全員分の確認」を、全員が「張れた」か「到達不能」の
どちらかに確定したことと読むためである。条件を満たさなければ削除せず、非ゼロで終わる
（`旧メニュー … は削除しません（不一致 N 件・判定不能 M 件）。原因を調べて流し直してください。`）。

- 順序を逆にすると穴が開く。段 2 より前に消せば env が死んだ ID を指し、段 3 より前に消せば
  店舗特定済みオーナーのリンクが外れて既定（「登録を再開」の面）へ落ちる。
- 削除を指定しない実行（`--delete-old` なし）でも、確認できなかったオーナーが残れば非ゼロで
  終わる。**終了コードが 0 でない実行を「だいたい終わった」と読まない。**
- 旧メニューを消すまでは巻き戻せる。tfvars を旧 ID に戻して段 2 を当て直し、同じスクリプトを
  `--to <旧 ID>` で流す。消した後は作り直しになる。

### 10-5. 段 5: 実機で確かめる（Req 9.6）

**ここは自動化できない。** デプロイの成功も、張り替えの分類も、コードと LINE の状態しか言わない。

- 確かめるのは、レポートの 3 導線・複数店舗の選択・Reply 応答・既存導線（「詳細を見る」と
  「ステータス確認」）である。手順は `docs/testing/e2e.md` §4。
- 検証用のテナントを使い回す。本番のテナントは消す経路が無い（Issue #252）ので、実機確認のために
  新しい店舗・オーナーを作らない。
- 併せて `PROJECT_ID=gen-fw-line-meo make e2e-prod-checks` の 6 を読み、完了後メニューの準備判定
  （`reportMenuReady`）が true に変わったことを見る。差し替えの前は意図どおり FAIL である。

### 10-6. 張り替えの対象は実在する（「対象が存在しない」は古い）

この節は 2026-09-06 の実測に基づいて「本番では対象が存在しない」と書いていた。**その記述は古い。**
2026-09-13 の本番 E2E の時点で、完了済み（`onboarding_status = 'store_identified'`）の検証用
オーナーが実在することが確かめられている。本番のテナントは消す経路が無い（Issue #252）ので、
対象が消えて無くなることもない。したがって**段 3 の張り替えは省略できない。** 対象が 1 人でも、
やらなければその 1 人に古い面が恒久的に出る。

一方で「全員へ再リンクするか旧メニューを残すか」という運用方針の判断は要らない。旧メニューは
区画も画像も差し替えられず、レポートの 3 導線を持たないままなので、残す選択肢が無いためである。

**件数は実施の直前に引き直す。** 引き直す道具は 10-3 の `--dry-run` である（`対象のオーナー: N 件`
を出し、LINE へのリンクと削除を行わない）。DB を直接見るなら §3 の Auth Proxy 経由で:

```sql
SELECT onboarding_status, count(*) FROM owners GROUP BY 1;
```

なお DB の件数は「実際に完了メニューへ繋がっている人数」の上限である（切り替えの成否は owners の
状態遷移と独立に決まるため）。個々のオーナーの実状は張り替えスクリプトの分類が示す。Issue #228
以降、切り替えの成否は記録からも読める（`line-webhook.richmenu_linked` /
`line-webhook.richmenu_link_failed` の件数）。

---

## 11. 監視とアラート（Issue #230）

宣言の正典は `infra/modules/guardrails/main.tf` である。本番の実物は Terraform だけが作り、
手で作らない。

| 資産 | 対象 | 鳴る条件 |
|---|---|---|
| `google_monitoring_alert_policy.job_failure` | Cloud Run **Job** 全部（名前で絞らない） | 失敗 execution > 0 / 5 分 |
| `google_monitoring_alert_policy.service_5xx_rate` | Cloud Run **Service** 全部（名前で絞らない） | 5xx 率 > 5% が 5 分継続 |
| `google_monitoring_alert_policy.customer_latency` | 客向け 2 面（`store-detail` / `survey-web`） | p95 遅延 > 2000ms が 5 分継続 |
| `google_monitoring_alert_policy.webhook_signature_failure` | `line-webhook` | 署名検証失敗 > 5 件 / 5 分 |
| `google_logging_metric.webhook_signature_failures` | 同上（上のアラートの入力） | — |
| `google_logging_metric.survey_funnel` | `survey-web`（Issue #137） | — |

通知先はすべて `google_monitoring_notification_channel.email`（`var.alert_email`）である。

### 11-1. 二度と失われないための 2 層

2026-09-06、この監視は本番へ apply されたが **対応する .tf が commit されないまま消えた**。
9 月 9 日の実測時点で本番には 4 ポリシー + 1 指標が稼働し、terraform state（serial 38）も
それを保持していたが、`origin/main` にも 49 本のリモートブランチのいずれにもコードが無かった。
**次の `terraform apply` がこれを destroy する寸前だった。**

さらにアプリ側の出力コードも一緒に失われたため、`webhook_signature_failures` は
「指標は存在するのに一致するログが 1 件も出ない」状態で生き残っていた（`line-webhook` は
401 を返すだけで何も記録しない実装に戻っていた）。

この 2 つは別の失敗であり、別の網が要る。

| 層 | 仕組み | 捕まえるもの |
|---|---|---|
| 静的（ts-ci） | `scripts/check-monitoring-coverage.sh` | 5xx がサービス名を述語に持つ／遅延監視の列挙が実在しない／**指標が数える事象をアプリが出していない**／通知先・`auto_close` の欠落 |
| 定期（6 時間） | `scripts/check-monitoring-drift.sh` + `monitoring-drift` ワークフロー | 宣言に在って本番に無い（apply 忘れ）／**本番に在って宣言に無い（コードが失われた）** |

静的な層は「宣言の中で辻褄が合っているか」までしか言えない。コードが消えている間、ts-ci は
何度でも緑になる。**「コードが消えても本番は生きている」を検出できるのは定期の層だけ**である。

### 11-2. `undeclared-in-prod` が出たときの手順

**先に `make tf-plan` を打つこと。** 宣言に無いものは削除対象なので、確認せずに
`make tf-apply` すると監視が消える。

1. `make tf-plan` で destroy 予定に入っていないか確認する
2. 意図して作った監視なら `guardrails/main.tf` へ書き起こす。**state のリソースアドレスに
   厳密一致させること**（ずれると destroy→create になり、その隙間に起きた障害が誰にも
   通知されない）。state の実属性は次で読める:

```bash
gcloud storage cat gs://<TF_STATE_BUCKET>/terraform/state/default.tfstate
```

3. 不要なら宣言と本番の両方から消す（片方だけ消すと同じ乖離が残る）

### 11-3. アラートの発火を実測する

閾値と条件式が実データに対して正しいことは、鳴らしてみるまで分からない。署名検証失敗は
**客に一切影響が無い**（401 を返すだけ）ので、実測はここで行う。

```bash
# 稼働リビジョンを確認する
gcloud run services describe line-webhook --project="$PROJECT_ID" --region=asia-northeast1 \
  --format='value(status.traffic[0].revisionName,spec.template.spec.containers[0].image)'

# 無効署名を閾値超（5 分に 6 回以上）送る。**本物のチャネルシークレットは使わない。**
SVC_URL="$(gcloud run services describe line-webhook --project="$PROJECT_ID" \
  --region=asia-northeast1 --format='value(status.url)')"
for i in $(seq 1 12); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "${SVC_URL}/webhook" \
    -H 'Content-Type: application/json' \
    -H 'x-line-signature: aW52YWxpZC1zaWduYXR1cmU=' \
    -d '{"destination":"U0","events":[]}'
done

# ログが出ているか（**署名値も本文も載っていないこと**を同時に確認する）
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="line-webhook" AND jsonPayload.event="webhook_signature_verification_failed"' \
  --project="$PROJECT_ID" --limit=20 --freshness=10m \
  --format='value(timestamp,resource.labels.revision_name,jsonPayload.reason)'

# Incident が立ったか
gcloud alpha monitoring policies list --project="$PROJECT_ID" \
  --filter='displayName:"line-webhook signature verification failures"' --format='value(name)'
```

発火通知と復旧通知の両方がメールに届くところまで見る。**復旧まで見ないと `auto_close` が
効いていることを確認できない**（開いたままのインシデントは「今も壊れている」ことを意味しなく
なる）。5xx と遅延は本番へ意図的に障害を起こす必要があるため、条件式が実データに一致すること
（系列が返ること）の照会に留める。

記録は Issue へ残す。**署名値・鍵・応答本文は載せない。**

### 11-4. 相関 ID からログを束ねる（Issue #229）

Cloud Run のリクエストログには `X-Cloud-Trace-Context`（未提供時は `traceparent`）から抽出した
トレース ID を `logging.googleapis.com/trace` として出力する。画面や LINE のエラーに表示された
サポートコードはその先頭 8 文字であり、個人や店舗の識別子ではない。ログ本文や DB へ保存せず、
問い合わせ時だけ次の検索へ置き換える。

```bash
TRACE_ID="<サポートコードに対応する完全な trace ID>"
gcloud logging read \
  "resource.type=\"cloud_run_revision\" AND trace=\"projects/${PROJECT_ID}/traces/${TRACE_ID}\"" \
  --project="$PROJECT_ID" --limit=50 --freshness=1h \
  --format='value(timestamp,resource.labels.service_name,jsonPayload.event,severity)'
```

Cloud Run Job は HTTP トレースを持たないため、`CLOUD_RUN_EXECUTION` を同じ項目へ載せる。
Webhook から後続の配信 Job への非同期処理はトレースで接続せず、業務キー（店舗 ID）で照合する。

## 12. Cloud Logging の用途別バケット（Issue #232 / #227）

宣言の正典は `infra/modules/guardrails/main.tf` である。#231 の `audit_logs` は DB を正本とし、
Cloud Logging の監査バケットは「直近の補助証跡」として扱う。Cloud Logging だけを監査の正本に
すると、ログ保持設定の変更で業務証跡まで失われるためである。

| バケット | 保持 | 収容するもの | 長期調査の正本 |
|---|---:|---|---|
| `fwlm-audit` | 30日 | 監査対応イベント、リッチメニュー切替の成否 | DB `audit_logs` |
| `fwlm-app-error` | 90日 | event 名で分類したエラー・警告・無視イベント | 当該バケット |
| `fwlm-app-info` | 30日 | その他の Cloud Run アプリイベント | ログベース指標（24か月） |

`_Default` sink は Logging が作成したものを import して管理下へ置くが、**その既定 filter
（`cloudaudit.*` / `externalaudit.*` の 6 種を除外する式）を宣言で保つこと**。filter を書かない
宣言は「空 = 全件」として送られ、`_Required` が 400 日無料で保持している監査ログが `_Default`
（30 日・課金）へも二重に入る。exclusions を足すことと既定 filter を保つことは別の操作である。
2026-09-22 の apply 直前の plan で、この欠落（`filter -> null`）を実際に検出した（本番の該当ログは
7 日で 882 件）。機械強制は `scripts/check-log-sink-default-filter.sh`（ts-ci）。

同一プロジェクトのログバケットへ流す sink には **writer identity が存在しない**（2026-09-22 の
apply で実測）。`roles/logging.bucketWriter` の付与が要るのは宛先が別プロジェクトのバケットの
ときだけで、同一プロジェクトでの付与を宣言すると member が空文字になり apply が失敗する。

振り分けの述語は **Cloud Run のサービスとジョブの両方**を覆う（`cloud_run_revision` と
`cloud_run_job`）。初版はサービスだけを書いており、本番の構造化ログ 13 行のうち 12 行を占める
ジョブ（`daily-batch` / `summary-delivery`）の記録が、どのカスタムバケットにも入らなかった
（2026-09-22 実測）。#227 が挙げる #151 の実害は、まさにそのジョブの失敗が無音だった事故である。
述語は `local.log_resource_types` の 1 箇所だけが持ち、各フィルタへ書き写さない。機械強制は
`scripts/check-log-routing-resource-coverage.sh`（デプロイ正典の service / job と両方向で照合）。

振り分けは `severity` ではなく `jsonPayload.event` で行う。アプリの水準値が集約基盤の
`severity` と一致することに依存すると、イベントは出ているのに別バケットへ入らない「静かな0」を
作るためである。#231 のDB監査行そのものは Cloud Logging へコピーせず、ログ側は補助イベントだけを
保持する。`_Default` sink には同じ Cloud Run 行の除外を追加し、カスタムバケットとの二重保存を避ける。
既存の `_Default` sink は prod root の import block で state へ取り込む。

### 12-1. 費用見積り（apply 前の仮定）

実際のログ量が未確定のため、10 GiB/月のアプリログが均等に発生し、そのうち全量を
`app-error` とした保守的な上限例を置く。30日保持を基準にすると、90日保持による追加の平均保存量は
およそ 20 GiB-month である。30日超のログ保持単価を $0.01/GiB-month として、追加分は
**約 $0.20/月（無料枠・リージョン・実際の圧縮率を考慮する前）** となる。

計算式は `max(0, app_error_GiB_per_month * 2) * $0.01`。30日以内の保持とログルーティング自体は
この差分見積りに含めない。除外は受信後に適用されるため、API受信量の削減にはならない。apply後は
Billing の Logs Storage と実際の月間 GiB を7日後・30日後に確認し、この仮定を実測値へ更新する。

### 12-2. 適用前後の手順

1. `make tf-plan` で、既存 `_Default` sink が import 対象になっていること、監査・エラー・情報の
   3バケットと writer IAM だけが追加されることを確認する。
2. 上の費用見積りと実測方法について承認を得る。
3. 承認後に `make tf-apply` を実行する。未承認の本番 apply は行わない。
4. `gcloud logging sinks describe _Default` と各カスタム sink の destination/filter を確認し、
   `_Default` に同じ Cloud Run 行が残っていないことを観測する。
5. 30日を超えた個別アプリログの調査は `app-error` の保持窓外となるため、エラーの再現と
   DB `audit_logs` の業務証跡照会へ切り替える。ファネルの期間比較は対応する logging metric を使う。
