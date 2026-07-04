# fw-line-meo — 最初の BUILD/TEST/SMOKE コマンド（four-tier-data-model スキーマ）
# ランタイムは apple/container を既定とし、CONTAINER_CMD で差し替え可能。
#   例: make db-smoke CONTAINER_CMD=docker

CONTAINER_CMD ?= container
PG_IMAGE      ?= postgres:16
export CONTAINER_CMD PG_IMAGE

RUN := db/test/run.sh

# Terraform（gcp-infra-foundation）: 単一環境ルートは infra/envs/prod
TF_DIR ?= infra/envs/prod

.PHONY: db-migrate db-reset db-smoke db-test db-verify-docs tf-init tf-fmt tf-plan tf-apply help

help: ## 利用可能なターゲットを表示
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN{FS=":.*?## "}{printf "  %-12s %s\n", $$1, $$2}'

db-migrate: ## BUILD: 一時postgresへ migrations をクリーン適用
	$(RUN)

db-reset: db-migrate ## 一時postgresを破棄して再適用（greenfield 再適用）

db-smoke: ## SMOKE: migrations 適用後 db/test/smoke/*.sql を実行（本実行 1-3 の観察可能完了）
	$(RUN) db/test/smoke

db-test: ## TEST: migrations 適用後 db/test/assertions/*.sql を実行（task 5 の網羅スイート）
	$(RUN) db/test/assertions

db-verify-docs: ## DOCS: ERD/write-boundary と実スキーマの整合・書込境界単一所有を機械検証
	db/test/check_docs.sh

tf-init: ## TF: backend 込みで初期化（要 state バケット・実運用）
	terraform -chdir=$(TF_DIR) init

tf-fmt: ## TF: 全 infra ツリーを整形（-check は CI/検証用に -recursive）
	terraform fmt -recursive infra

tf-plan: ## TF: 差分計画を表示（要 terraform.tfvars）
	terraform -chdir=$(TF_DIR) plan

tf-apply: ## TF: 適用（billing IAM 保持者が runbook 手順で実行）
	terraform -chdir=$(TF_DIR) apply
