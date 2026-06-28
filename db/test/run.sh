#!/usr/bin/env bash
# スキーマテストハーネス（言語非依存）。
# 一時 postgres コンテナを起動 → migrations を順に適用 → 指定 dir の *.sql をアサーション実行 → 破棄。
# 各 SQL は psql -v ON_ERROR_STOP=1 で実行。RAISE EXCEPTION 等で非ゼロ終了 → 本スクリプト失敗。
#
# ランタイムは CONTAINER_CMD で差し替え可能（既定: apple/container の `container`）。
# 例: CONTAINER_CMD=docker db/test/run.sh db/test/smoke
#
# 使い方: run.sh [ASSERT_DIR]
#   ASSERT_DIR 省略時は migrations 適用のみ（BUILD 相当）。
set -euo pipefail

ASSERT_DIR="${1:-}"
CONTAINER_CMD="${CONTAINER_CMD:-container}"
PG_IMAGE="${PG_IMAGE:-postgres:16}"
CONTAINER_NAME="${CONTAINER_NAME:-fwlm_pg_test}"
DB="${POSTGRES_DB:-fwlm}"
PGUSER="${POSTGRES_USER:-postgres}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIG="$ROOT/db/migrations"

psql_run() { # stdin から SQL を読む
    "$CONTAINER_CMD" exec -i "$CONTAINER_NAME" psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$DB" "$@"
}

cleanup() { "$CONTAINER_CMD" delete --force "$CONTAINER_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# 既存コンテナを掃除して新規起動
"$CONTAINER_CMD" delete --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
"$CONTAINER_CMD" run -d --name "$CONTAINER_NAME" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$DB" "$PG_IMAGE" >/dev/null

# 起動待ち
ready=0
for _ in $(seq 1 60); do
    if "$CONTAINER_CMD" exec "$CONTAINER_NAME" pg_isready -U "$PGUSER" -d "$DB" >/dev/null 2>&1; then
        ready=1; break
    fi
    sleep 1
done
[ "$ready" = 1 ] || { echo "ERROR: postgres not ready" >&2; exit 1; }

# マイグレーションを順に適用（各 .sql が自前で BEGIN;...COMMIT; を持つため -1 は付けない）
for f in "$MIG"/*.sql; do
    echo ">> applying $(basename "$f")"
    psql_run < "$f"
done

# アサーション SQL を実行（dir 指定時のみ）。各ファイルが自前でトランザクション管理（smoke は ROLLBACK）。
if [ -n "$ASSERT_DIR" ] && [ -d "$ROOT/$ASSERT_DIR" ]; then
    shopt -s nullglob
    files=("$ROOT/$ASSERT_DIR"/*.sql)
    for f in "${files[@]}"; do
        echo ">> asserting $(basename "$f")"
        psql_run < "$f"
    done
fi

echo "OK"
