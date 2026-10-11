#!/usr/bin/env bash
# native postgres の一時インスタンスを起動し、db/migrations/*.sql を適用したうえで
# DATABASE_URL をエクスポートして引数のコマンドを実行する。
# docker / apple-container が無い環境向けの db/test/run.sh 相当（同じ migrations を流用）。
#
#   例: ts/scripts/with-test-db.sh pnpm -C ts run test
#       ts/scripts/with-test-db.sh --print-server-bindir   # initdb / pg_ctl の場所だけを出す
#
# 接続は unix socket のみ（TCP 無効）でポート衝突を回避。終了時にインスタンスと一時領域を破棄する。
#
# root で実行されたとき（Claude Code on the web のコンテナ等）は、サーバー側（initdb / pg_ctl）
# だけを postgres ユーザーで動かす。initdb は root での実行を拒否するため。クライアント側
# （createdb / psql / 引数のコマンド）は呼び出し元のユーザーのまま socket と trust 認証で繋ぐ。
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: with-test-db.sh <command> [args...] | --print-server-bindir" >&2
  exit 2
fi

# apt（Debian / Ubuntu）の postgres は initdb / pg_ctl を /usr/lib/postgresql/<ver>/bin にしか
# 置かず、PATH には入れない（Homebrew は入れる）。PATH に無ければ最も新しい版を探す。
# run-e2e-local.sh の前提確認も --print-server-bindir でこれを呼ぶ（探し方を 2 箇所に持たない）。
resolve_server_bindir() {
  if command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v initdb)"
    return 0
  fi
  local dir
  for dir in $(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V -r); do
    if [ -x "$dir/initdb" ] && [ -x "$dir/pg_ctl" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
  done
  return 1
}

if [ "$1" = "--print-server-bindir" ]; then
  resolve_server_bindir || {
    echo "ERROR: initdb / pg_ctl が見つかりません（native postgres が必要です）" >&2
    exit 1
  }
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MIGRATIONS_DIR="$ROOT/db/migrations"

if SERVER_BINDIR="$(resolve_server_bindir)"; then
  PATH="$SERVER_BINDIR:$PATH"
fi

SERVER_USER=''
if [ "$(id -u)" -eq 0 ]; then
  SERVER_USER=postgres
  id "$SERVER_USER" >/dev/null 2>&1 || {
    echo "ERROR: root で実行されていますが '$SERVER_USER' ユーザーがありません（initdb は root で動きません）" >&2
    exit 1
  }
fi

# 呼び出し元の cwd（/root 等）を postgres ユーザーが読めないことがあるため、一時領域へ移ってから動かす。
as_server_user() {
  if [ -n "$SERVER_USER" ]; then
    (cd "$WORKDIR" && runuser -u "$SERVER_USER" -- env PATH="$PATH" "$@")
  else
    "$@"
  fi
}

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
[ -z "$SERVER_USER" ] || chown -R "$SERVER_USER" "$WORKDIR"
DBNAME=fwlm

cleanup() {
  as_server_user pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

as_server_user initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
as_server_user pg_ctl -D "$PGDATA" -o "-k $SOCKDIR -c listen_addresses=''" -w -t 60 start >/dev/null

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
