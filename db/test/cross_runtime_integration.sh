#!/usr/bin/env bash
# クロスランタイム契約検証（task 7.1）のエントリポイント。
#
# ts/scripts/with-test-db.sh（docker/apple-container 不在でも動く native postgres ハーネス。
# db/test/run.sh 相当の migrations 適用を行い DATABASE_URL を export した状態でコマンドを実行する）
# に db/test/cross_runtime_steps.sh を渡すことで、単一の postgres インスタンス上で
# 「Go バッチ実行 → TS 配信ジョブ実行 → 能力不在チェック」を順に行い、実行後に破棄する。
#
# 使い方: db/test/cross_runtime_integration.sh
#   （Makefile ターゲット `make cross-runtime-test` から呼ばれる想定）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

exec "$ROOT/ts/scripts/with-test-db.sh" "$ROOT/db/test/cross_runtime_steps.sh"
