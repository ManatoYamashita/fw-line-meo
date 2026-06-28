#!/usr/bin/env bash
# Docs ↔ schema 整合チェック:
#  - 実テーブルが db/write-boundary.md のマッピング表行にちょうど 1 回出現＝書込責任層が単一（Req 9.1, 9.4）
#  - 実テーブルが db/ERD.md に出現（Req 11.1, 11.2）
#
# 既定: apple/container で一時 postgres を起動し migrations を適用して実テーブル一覧を取得。
# 既存 DB を使う場合: MANAGE_CONTAINER=0 かつ PSQL_EXEC を設定（例: MANAGE_CONTAINER=0 PSQL_EXEC=psql、PG* 環境変数で接続）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WB="$ROOT/db/write-boundary.md"
ERD="$ROOT/db/ERD.md"

MANAGE_CONTAINER="${MANAGE_CONTAINER:-1}"
CONTAINER_CMD="${CONTAINER_CMD:-container}"
PG_IMAGE="${PG_IMAGE:-postgres:16}"
CONTAINER_NAME="${CONTAINER_NAME:-fwlm_pg_docs}"
DB="${POSTGRES_DB:-fwlm}"
PGUSER="${POSTGRES_USER:-postgres}"

if [ "$MANAGE_CONTAINER" = 1 ]; then
    PSQL_EXEC="$CONTAINER_CMD exec -i $CONTAINER_NAME psql -U $PGUSER -d $DB"
    cleanup() { "$CONTAINER_CMD" delete --force "$CONTAINER_NAME" >/dev/null 2>&1 || true; }
    trap cleanup EXIT
    "$CONTAINER_CMD" delete --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
    "$CONTAINER_CMD" run -d --name "$CONTAINER_NAME" \
        -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$DB" "$PG_IMAGE" >/dev/null
    for _ in $(seq 1 60); do
        "$CONTAINER_CMD" exec "$CONTAINER_NAME" pg_isready -U "$PGUSER" -d "$DB" >/dev/null 2>&1 && break
        sleep 1
    done
    for f in "$ROOT"/db/migrations/*.sql; do $PSQL_EXEC -v ON_ERROR_STOP=1 -q < "$f" >/dev/null; done
else
    PSQL_EXEC="${PSQL_EXEC:?MANAGE_CONTAINER=0 のときは PSQL_EXEC を設定すること}"
fi

tables=$($PSQL_EXEC -tAq -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name;")

bq='`'; fail=0; n=0
while IFS= read -r t; do
    [ -z "$t" ] && continue
    n=$((n + 1))
    c=$(grep -cE "^\| ${bq}${t}${bq} \|" "$WB" || true)
    if [ "$c" -ne 1 ]; then echo "FAIL: '$t' は write-boundary.md のマッピング表に ${c} 行（期待 1）"; fail=1; fi
    if ! grep -qwF "$t" "$ERD"; then echo "FAIL: '$t' が ERD.md に存在しない"; fail=1; fi
done <<< "$tables"

if [ "$fail" -eq 0 ]; then echo "OK: docs と schema が整合（${n} テーブル・書込境界は各 1 所有）"; fi
exit $fail
