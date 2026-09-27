#!/usr/bin/env bash
# Issue #251 ガードレール: db/migrations を空の PostgreSQL へ適用して得たスキーマ対象と、
# 本番 PostgreSQL の pg_catalog にある対象を定期照合する。
#
# SQL を独自に解析しない。正解側は一時スキーマへ全 migration を実際に適用してから
# scripts/prod-schema-targets.sql で対象名を取得する。適用対象が増えれば catalog の行が増える。
# 本番側でも同じ query を使い、pg_catalog の名前だけを読む。表・ビュー・関数等の中身の行は読まない。
#
# 対象: relation / column / index / constraint / type / enum label / routine / trigger / policy / rule。
# 各対象の定義内容（列型・既定値・制約式・関数本文など）は比較しない。migration が DDL を
# トランザクション内で適用することを前提に、対象の存在漏れと migration 外の対象を検出する。
# 0002_reference_seed.sql のようなデータだけを変える migration の行内容は検査範囲外。
#
# 使い方（通常）:
#   PROJECT_ID=<id> EXPECTED_DATABASE_URL=<使い捨て PostgreSQL> PROD_DATABASE_URL=<Auth Proxy 接続> \
#     bash scripts/check-prod-schema-drift.sh
#
# 注入:
#   EXPECTED_SCHEMA_SNAPSHOT=<正解 TSV> PROD_SCHEMA_SNAPSHOT=<本番 TSV> bash ...
#   workflow_dispatch の snapshot は PROD_SCHEMA_SNAPSHOT へ渡す。
#
#   --print-expected-targets は migration を適用して得た正解 TSV だけを stdout へ出す。
#   自己テストで「migration を 1 本足したとき target が増える」ことを確認するための口。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_SQL="$SCRIPT_DIR/prod-schema-targets.sql"

PROJECT_ID="${PROJECT_ID:-}"
EXPECTED_DATABASE_URL="${EXPECTED_DATABASE_URL:-}"
PROD_DATABASE_URL="${PROD_DATABASE_URL:-}"
EXPECTED_SCHEMA_SNAPSHOT="${EXPECTED_SCHEMA_SNAPSHOT:-}"
PROD_SCHEMA_SNAPSHOT="${PROD_SCHEMA_SNAPSHOT:-}"
SCHEMA_MIGRATIONS_DIR="${SCHEMA_MIGRATIONS_DIR:-$ROOT/db/migrations}"

fail_early() {
  reason="$1"
  shift
  for line in "$@"; do echo "$line" >&2; done
  echo "SCHEMA-DRIFT-SIGNATURE: early-exit=${reason};"
  exit 1
}

if [ "$#" -gt 0 ]; then
  case "$1" in
    -h|--help)
      sed -n '2,38p' "$0"
      exit 0
      ;;
    --print-expected-targets)
      if [ "$#" -ne 1 ]; then
        fail_early config-error "ERROR: --print-expected-targets は単独で指定してください。"
      fi
      print_expected=1
      ;;
    *) fail_early config-error "ERROR: 未知の引数です: $1" ;;
  esac
else
  print_expected=0
fi

TMPWORK="$(mktemp -d "${TMPDIR:-/tmp}/prod-schema-drift.XXXXXX")"
EXPECTED_SCHEMA_NAME=''
cleanup() {
  if [ -n "$EXPECTED_SCHEMA_NAME" ] && [ -n "$EXPECTED_DATABASE_URL" ]; then
    psql "$EXPECTED_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
      -c "DROP SCHEMA IF EXISTS \"$EXPECTED_SCHEMA_NAME\" CASCADE" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMPWORK"
}
trap cleanup EXIT

injected=''
if [ -n "$EXPECTED_SCHEMA_SNAPSHOT" ]; then injected="${injected}EXPECTED_SCHEMA_SNAPSHOT "; fi
if [ -n "$PROD_SCHEMA_SNAPSHOT" ]; then injected="${injected}PROD_SCHEMA_SNAPSHOT "; fi
if [ -n "$SCHEMA_MIGRATIONS_DIR" ] && [ "$SCHEMA_MIGRATIONS_DIR" != "$ROOT/db/migrations" ]; then
  injected="${injected}SCHEMA_MIGRATIONS_DIR "
fi
if [ -n "$injected" ]; then
  echo "WARNING: 注入モードで実行中です（本番の実測ではありません）: ${injected}" >&2
fi

capture_expected_snapshot() {
  if [ -n "$EXPECTED_SCHEMA_SNAPSHOT" ]; then
    [ -f "$EXPECTED_SCHEMA_SNAPSHOT" ] || fail_early config-error \
      "ERROR: EXPECTED_SCHEMA_SNAPSHOT が見つかりません: $EXPECTED_SCHEMA_SNAPSHOT"
    cat "$EXPECTED_SCHEMA_SNAPSHOT"
    return 0
  fi

  [ -n "$EXPECTED_DATABASE_URL" ] || fail_early config-error \
    "ERROR: EXPECTED_DATABASE_URL が未設定です（migration 適用用の使い捨て PostgreSQL が必要です）。"
  [ -f "$TARGET_SQL" ] || fail_early config-error \
    "ERROR: catalog query が見つかりません: ${TARGET_SQL#"$ROOT"/}"
  [ -d "$SCHEMA_MIGRATIONS_DIR" ] || fail_early config-error \
    "ERROR: migration ディレクトリが見つかりません: $SCHEMA_MIGRATIONS_DIR"

  migration_count=0
  for migration in "$SCHEMA_MIGRATIONS_DIR"/[0-9][0-9][0-9][0-9]_*.sql; do
    [ -f "$migration" ] || continue
    migration_count=$((migration_count + 1))
  done
  [ "$migration_count" -gt 0 ] || fail_early migration-empty \
    "ERROR: migration を 1 件も見つけられませんでした。"

  # 接続先 public を変更せず、作業用 schema だけに全 migration を適用する。
  EXPECTED_SCHEMA_NAME="schema_drift_${$}_${RANDOM}"
  case "$EXPECTED_SCHEMA_NAME" in *[!a-zA-Z0-9_]*) fail_early config-error "ERROR: 内部 schema 名が不正です。" ;; esac
  if ! psql "$EXPECTED_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
    -c "CREATE SCHEMA \"$EXPECTED_SCHEMA_NAME\"" >/dev/null; then
    fail_early expected-db-unavailable \
      "ERROR: 期待スキーマ用 PostgreSQL に接続できないか、一時 schema を作成できません。"
  fi

  expected_pgoptions="${PGOPTIONS:-}"
  expected_pgoptions="${expected_pgoptions}${expected_pgoptions:+ }-c search_path=${EXPECTED_SCHEMA_NAME}"
  for migration in "$SCHEMA_MIGRATIONS_DIR"/[0-9][0-9][0-9][0-9]_*.sql; do
    [ -f "$migration" ] || continue
    if ! PGOPTIONS="$expected_pgoptions" psql "$EXPECTED_DATABASE_URL" -X -q \
      -v ON_ERROR_STOP=1 -f "$migration" >/dev/null; then
      fail_early migration-apply-failed \
        "ERROR: 期待スキーマへの migration 適用に失敗しました: $(basename "$migration")"
    fi
  done

  if ! PGOPTIONS="$expected_pgoptions" psql "$EXPECTED_DATABASE_URL" -X -qAt \
    -F "$(printf '\t')" -v ON_ERROR_STOP=1 -f "$TARGET_SQL" > "$TMPWORK/expected.tsv"; then
    fail_early expected-catalog-query-failed "ERROR: 期待スキーマの catalog query に失敗しました。"
  fi
  # 一時 schema は出力を取り終えた直後に消し、終了時まで残さない。
  psql "$EXPECTED_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA \"$EXPECTED_SCHEMA_NAME\" CASCADE" >/dev/null || fail_early expected-schema-cleanup-failed \
      "ERROR: 期待スキーマの一時 schema を削除できませんでした。"
  EXPECTED_SCHEMA_NAME=''
  cat "$TMPWORK/expected.tsv"
}

if [ "$print_expected" -eq 1 ]; then
  capture_expected_snapshot
  exit 0
fi

[ -n "$PROJECT_ID" ] || fail_early config-error "ERROR: PROJECT_ID が未設定です。"

capture_live_snapshot() {
  if [ -n "$PROD_SCHEMA_SNAPSHOT" ]; then
    [ -f "$PROD_SCHEMA_SNAPSHOT" ] || fail_early config-error \
      "ERROR: PROD_SCHEMA_SNAPSHOT が見つかりません: $PROD_SCHEMA_SNAPSHOT"
    cat "$PROD_SCHEMA_SNAPSHOT"
    return 0
  fi
  [ -n "$PROD_DATABASE_URL" ] || fail_early config-error \
    "ERROR: PROD_DATABASE_URL が未設定です（本番 Auth Proxy への接続が必要です）。"
  if ! psql "$PROD_DATABASE_URL" -X -qAt -F "$(printf '\t')" \
    -v ON_ERROR_STOP=1 -f "$TARGET_SQL" > "$TMPWORK/production.tsv"; then
    fail_early production-catalog-query-failed \
      "ERROR: 本番 Cloud SQL の catalog query に失敗しました（project=${PROJECT_ID}）。" \
      "       → WIF の偽装・Cloud SQL Client / Instance User・IAM DB user と Auth Proxy の設定を確認してください。"
  fi
  cat "$TMPWORK/production.tsv"
}

expected_raw="$(capture_expected_snapshot)" || fail_early expected-capture-failed \
  "ERROR: 期待対象の取得に失敗しました。"
production_raw="$(capture_live_snapshot)" || fail_early production-capture-failed \
  "ERROR: 本番対象の取得に失敗しました。"

validate_snapshot() {
  snapshot_name="$1"
  snapshot_raw="$2"
  output_file="$3"
  if [ -z "$snapshot_raw" ]; then
    fail_early "${snapshot_name}-empty" "ERROR: ${snapshot_name} の対象が 0 件です（空振り防止）。"
  fi
  printf '%s\n' "$snapshot_raw" > "$output_file.raw"
  if ! awk -F '\t' '
    /^[[:space:]]*(#|$)/ { next }
    NF != 3 { bad = 1; next }
    $1 !~ /^(relation|column|index|constraint|type|enum_label|routine|trigger|policy|rule)$/ { bad = 1; next }
    $2 == "" || $2 ~ /[[:cntrl:]]/ { bad = 1; next }
    $3 == "" || $3 ~ /[[:cntrl:]]/ { bad = 1; next }
    { print }
    END { if (bad) exit 1 }
  ' "$output_file.raw" > "$output_file.unsorted"; then
    fail_early "${snapshot_name}-malformed" \
      "ERROR: ${snapshot_name} の TSV 形式が不正です（3 列の catalog 対象が必要です）。"
  fi
  if [ ! -s "$output_file.unsorted" ]; then
    fail_early "${snapshot_name}-empty" "ERROR: ${snapshot_name} の対象が 0 件です（空振り防止）。"
  fi
  LC_ALL=C sort "$output_file.unsorted" > "$output_file"
  LC_ALL=C sort "$output_file.unsorted" | uniq -d > "$output_file.duplicates"
  if [ -s "$output_file.duplicates" ]; then
    fail_early "${snapshot_name}-duplicate" "ERROR: ${snapshot_name} に重複した対象があります。"
  fi
}

validate_snapshot expected "$expected_raw" "$TMPWORK/expected"
validate_snapshot production "$production_raw" "$TMPWORK/production"

expected_count="$(wc -l < "$TMPWORK/expected" | tr -d '[:space:]')"
production_count="$(wc -l < "$TMPWORK/production" | tr -d '[:space:]')"
comm -23 "$TMPWORK/expected" "$TMPWORK/production" > "$TMPWORK/missing.tsv"
comm -13 "$TMPWORK/expected" "$TMPWORK/production" > "$TMPWORK/extra.tsv"

missing_count="$(wc -l < "$TMPWORK/missing.tsv" | tr -d '[:space:]')"
extra_count="$(wc -l < "$TMPWORK/extra.tsv" | tr -d '[:space:]')"
if [ "$missing_count" -gt 0 ] || [ "$extra_count" -gt 0 ]; then
  echo "ERROR: 本番スキーマが db/migrations 適用後の catalog と一致しません（expected=${expected_count} / production=${production_count}）。" >&2
  while IFS="$(printf '\t')" read -r kind object parent; do
    [ -n "${kind:-}" ] || continue
    echo "ERROR: 本番に存在しない対象: ${kind} ${object} (${parent})" >&2
  done < "$TMPWORK/missing.tsv"
  while IFS="$(printf '\t')" read -r kind object parent; do
    [ -n "${kind:-}" ] || continue
    echo "ERROR: migration に無い本番対象: ${kind} ${object} (${parent})" >&2
  done < "$TMPWORK/extra.tsv"
  missing_signature="$(awk -F '\t' '{ printf "%s:%s@%s,", $1, $2, $3 }' "$TMPWORK/missing.tsv")"
  extra_signature="$(awk -F '\t' '{ printf "%s:%s@%s,", $1, $2, $3 }' "$TMPWORK/extra.tsv")"
  echo "SCHEMA-DRIFT-SIGNATURE: missing=${missing_signature};extra=${extra_signature};"
  exit 1
fi

echo "OK: 本番スキーマは db/migrations 適用後の catalog と一致しています（expected=${expected_count} / production=${production_count}）。"
echo "SCHEMA-DRIFT-SIGNATURE: missing=;extra=;"
