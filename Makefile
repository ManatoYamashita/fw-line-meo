# fw-line-meo — 最初の BUILD/TEST/SMOKE コマンド（four-tier-data-model スキーマ）
# ランタイムは apple/container を既定とし、CONTAINER_CMD で差し替え可能。
#   例: make db-smoke CONTAINER_CMD=docker

CONTAINER_CMD ?= container
PG_IMAGE      ?= postgres:16
export CONTAINER_CMD PG_IMAGE

RUN := db/test/run.sh

# Terraform（gcp-infra-foundation）: 単一環境ルートは infra/envs/prod
TF_DIR ?= infra/envs/prod

.PHONY: db-migrate db-reset db-smoke db-test db-verify-docs tf-init tf-fmt tf-plan tf-apply ts-install ts-build ts-lint ts-test ts-test-db ts-test-e2e ts-test-perf go-build go-test help

help: ## 利用可能なターゲットを表示
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN{FS=":.*?## "}{printf "  %-14s %s\n", $$1, $$2}'

db-migrate: ## BUILD: 一時postgresへ migrations をクリーン適用
	$(RUN)

db-reset: db-migrate ## 一時postgresを破棄して再適用（greenfield 再適用）

db-smoke: ## SMOKE: migrations 適用後 db/test/smoke/*.sql を実行（本実行 1-3 の観察可能完了）
	$(RUN) db/test/smoke

db-test: ## TEST: migrations 適用後 db/test/assertions/*.sql を実行（task 5 の網羅スイート）
	$(RUN) db/test/assertions

db-verify-docs: ## DOCS: ERD/write-boundary と実スキーマの整合・書込境界単一所有を機械検証
	db/test/check_docs.sh

TF_STATE_BUCKET ?=

tf-init: ## TF: backend 込みで初期化（例: make tf-init TF_STATE_BUCKET=my-tfstate）
	@test -n "$(TF_STATE_BUCKET)" || { echo "ERROR: TF_STATE_BUCKET=<GCS バケット名> を指定してください"; exit 1; }
	terraform -chdir=$(TF_DIR) init -backend-config="bucket=$(TF_STATE_BUCKET)"

tf-fmt: ## TF: 全 infra ツリーを整形（-check は CI/検証用に -recursive）
	terraform fmt -recursive infra

tf-plan: ## TF: 差分計画を表示（要 terraform.tfvars）
	terraform -chdir=$(TF_DIR) plan

tf-apply: ## TF: 適用（billing IAM 保持者が runbook 手順で実行）
	terraform -chdir=$(TF_DIR) apply

# TypeScript モノレポ（ts/ pnpm workspace・review-acquisition ほかリアルタイム応答層）
TS_DIR ?= ts

ts-install: ## TS: pnpm workspace の依存を導入
	pnpm -C $(TS_DIR) install

ts-build: ## TS: 全ワークスペースパッケージを tsc ビルド
	pnpm -C $(TS_DIR) run build

ts-lint: ## TS: 全ワークスペースパッケージを ESLint 検査
	pnpm -C $(TS_DIR) run lint

ts-test: ## TS: 全ワークスペースパッケージのテスト（DB 不要・DB 依存は自動 skip）
	pnpm -C $(TS_DIR) run test

ts-test-db: ## TS: native postgres を起動し DB 依存テストを実行（docker/container 不要）
	$(TS_DIR)/scripts/with-test-db.sh pnpm -C $(TS_DIR) run test

ts-test-e2e: ## TS: 客向けフロー E2E（Playwright）。実行は CI 前提（要ブラウザ・起動アプリ・Gemini モック）
	pnpm -C $(TS_DIR) --filter @fwlm/survey-web exec playwright test

ts-test-perf: ## TS: 客向けページの JS バンドル予算チェック（要 ts-build。フル Lighthouse は CI）
	pnpm -C $(TS_DIR) --filter @fwlm/survey-web run perf:budget

# Go モジュール（go/ 日次バッチ層・competitive-daily-summary）
GO_DIR ?= go

go-build: ## Go: go/ 配下の全パッケージをビルド
	cd $(GO_DIR) && go build ./...

go-test: ## Go: go/ 配下の全パッケージのテストを実行
	cd $(GO_DIR) && go test ./...
