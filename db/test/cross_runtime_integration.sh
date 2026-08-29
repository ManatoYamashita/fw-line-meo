#!/usr/bin/env bash
# クロスランタイム契約検証（task 7.1）のエントリポイント。
#
# db/test/cross_runtime_steps.sh を「単一の生きた postgres」に対して実行する。本体はそちらで、
# ここが決めるのは **その postgres を誰が用意するか** だけである。
#
# 既定（ローカル・`make cross-runtime-test`）:
#   ts/scripts/with-test-db.sh（docker/apple-container 不在でも動く native postgres ハーネス。
#   db/test/run.sh 相当の migrations 適用を行い DATABASE_URL を export した状態でコマンドを実行する）
#   がインスタンスを起動し、実行後に破棄する。
#
# CROSS_RUNTIME_USE_EXISTING_DB=1（CI・Issue #158 (b)）:
#   **すでに migrations が当たっている** postgres へ DATABASE_URL で繋ぎ、steps を直接実行する。
#   with-test-db.sh を CI で使わないのは、同スクリプトが initdb / pg_ctl を要求する一方で
#   ubuntu-latest ではこれらが PATH に無い（/usr/lib/postgresql/<ver>/bin）ためである。PATH 細工は
#   runner イメージのバージョンへの暗黙の結合を作る。service container なら ts-ci の既存ジョブと
#   同じ土俵で、そこには実績がある。
#
#   **入口はこのファイル 1 つのまま保つこと。** ワークフローから cross_runtime_steps.sh を直接
#   叩けばモードスイッチは要らないが、その瞬間に scripts/run-db-test-suites.sh の
#   「cross_runtime_steps.sh は内部ステップであり単体の入口ではない」という宣言が虚偽になる。
#   分岐の形は db/test/check_docs.sh の MANAGE_CONTAINER=0 と同じイディオムである。
#
# 使い方:
#   ローカル: db/test/cross_runtime_integration.sh
#   CI:       CROSS_RUNTIME_USE_EXISTING_DB=1 DATABASE_URL=... db/test/cross_runtime_integration.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STEPS="$ROOT/db/test/cross_runtime_steps.sh"

if [ "${CROSS_RUNTIME_USE_EXISTING_DB:-0}" = '1' ]; then
    # 既存 DB モードでは接続先を渡すのは呼出元の責務になる。未設定のまま steps へ落とすと、
    # 診断が「with-test-db.sh 経由で実行してください」という**このモードでは誤った案内**になる。
    : "${DATABASE_URL:?ERROR: CROSS_RUNTIME_USE_EXISTING_DB=1 のときは migrations 適用済みの DATABASE_URL を設定してください}"
    exec "$STEPS"
fi

exec "$ROOT/ts/scripts/with-test-db.sh" "$STEPS"
