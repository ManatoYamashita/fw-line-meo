#!/usr/bin/env bash
# Docs ↔ schema 整合チェック:
#  - 実テーブルが db/write-boundary.md のマッピング表行にちょうど 1 回出現＝書込責任層が単一（Req 9.1, 9.4）
#  - 実テーブルが db/ERD.md に出現（Req 11.1, 11.2）
#  - write-boundary.md の書込所有テーブルに infra/sql/grants.sql で該当層 SA への DML GRANT があること
#
# 既定: apple/container で一時 postgres を起動し migrations を適用して実テーブル一覧を取得。
# 既存 DB を使う場合: MANAGE_CONTAINER=0 かつ PSQL_EXEC を設定（例: MANAGE_CONTAINER=0 PSQL_EXEC=psql、PG* 環境変数で接続）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WB="$ROOT/db/write-boundary.md"
ERD="$ROOT/db/ERD.md"
GRANTS="$ROOT/infra/sql/grants.sql"

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

# grants.sql の GRANT 文を「コメント除去 → 1 文 1 行」に平坦化し、
# TS 層 SA / Go 層 SA への DML（INSERT を含む GRANT）文を抽出する。
# TS 層は複数 SA（line_webhook/survey/dashboard の共有文＋delivery の最小権限文）に
# DML が分かれるため、いずれかの TS 層 SA への GRANT に現れれば「TS 層に付与済み」とみなす
# （detail は読取専用で DML を持たないため対象外）。
grants_flat=$(sed 's/--.*//' "$GRANTS" | tr '\n' ' ' | tr ';' '\n')
ts_dml=$(printf '%s\n' "$grants_flat" | grep -E 'GRANT[[:space:]]+INSERT' | grep -E ':"(line_webhook|survey|dashboard|delivery)"' || true)
go_dml=$(printf '%s\n' "$grants_flat" | grep -E 'GRANT[[:space:]]+INSERT' | grep -F ':"batch"' || true)

bq='`'; fail=0; n=0
while IFS= read -r t; do
    [ -z "$t" ] && continue
    n=$((n + 1))
    c=$(grep -cE "^\| ${bq}${t}${bq} \|" "$WB" || true)
    if [ "$c" -ne 1 ]; then echo "FAIL: '$t' は write-boundary.md のマッピング表に ${c} 行（期待 1）"; fail=1; fi
    if ! grep -qwF "$t" "$ERD"; then echo "FAIL: '$t' が ERD.md に存在しない"; fail=1; fi
    # 書込所有テーブルは grants.sql に該当層 SA への DML GRANT が必要（write-boundary.md との整合）
    layer=$(grep -E "^\| ${bq}${t}${bq} \|" "$WB" | awk -F'|' '{print $3}')
    case "$layer" in
        *TS*) printf '%s\n' "$ts_dml" | grep -qw "$t" || { echo "FAIL: TS 書込所有 '$t' への DML GRANT が grants.sql に無い"; fail=1; } ;;
        *Go*) printf '%s\n' "$go_dml" | grep -qw "$t" || { echo "FAIL: Go 書込所有 '$t' への DML GRANT が grants.sql に無い"; fail=1; } ;;
    esac
done <<< "$tables"

if [ "$fail" -eq 0 ]; then echo "OK: docs と schema と grants.sql が整合（${n} テーブル・書込境界は各 1 所有・所有層へ DML GRANT あり）"; fi
exit $fail
