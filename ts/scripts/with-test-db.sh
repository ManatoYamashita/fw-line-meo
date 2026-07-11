#!/usr/bin/env bash
# native postgres の一時インスタンスを起動し、db/migrations/*.sql を適用したうえで
# DATABASE_URL をエクスポートして引数のコマンドを実行する。
# docker / apple-container が無い環境向けの db/test/run.sh 相当（同じ migrations を流用）。
#
#   例: ts/scripts/with-test-db.sh pnpm -C ts run test
#
# 接続は unix socket のみ（TCP 無効）でポート衝突を回避。終了時にインスタンスと一時領域を破棄する。
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: with-test-db.sh <command> [args...]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATIONS_DIR="$ROOT/db/migrations"

for bin in initdb pg_ctl createdb psql; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "ERROR: '$bin' が見つかりません（native postgres が必要です）" >&2
    exit 1
  }
done

# socket path は 103 byte 制限を避けるため短い /tmp 配下に置く。
WORKDIR="$(mktemp -d /tmp/fwlm-td.XXXXXX)"
PGDATA="$WORKDIR/data"
SOCKDIR="$WORKDIR/sock"
mkdir -p "$SOCKDIR"
DBNAME=fwlm

cleanup() {
  pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
pg_ctl -D "$PGDATA" -o "-k $SOCKDIR -c listen_addresses=''" -w -t 60 start >/dev/null

createdb -h "$SOCKDIR" -U postgres "$DBNAME"
for f in "$MIGRATIONS_DIR"/*.sql; do
  psql -v ON_ERROR_STOP=1 -h "$SOCKDIR" -U postgres -d "$DBNAME" -f "$f" >/dev/null
done

export DATABASE_URL="postgres://postgres@/$DBNAME?host=$SOCKDIR"
export PGHOST="$SOCKDIR"
export PGUSER=postgres
export PGDATABASE="$DBNAME"

rc=0
"$@" || rc=$?
exit "$rc"
