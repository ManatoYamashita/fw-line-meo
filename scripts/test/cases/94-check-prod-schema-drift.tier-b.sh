# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-prod-schema-drift.sh の自己テスト（Issue #251）。
#
# PostgreSQL が実際に migration を適用して得る catalog が対象の正典であることを確かめる。
# 独自の SQL 抽出器や模擬 psql は使わず、CI の PostgreSQL service を利用する。

t_begin 'prod-schema-drift: migration を 1 本追加すると relation target が 1 件増える'
if [ -z "${DATABASE_URL:-}" ] || ! command -v psql >/dev/null 2>&1; then
  t_skip 'DATABASE_URL または psql が無いため PostgreSQL を使う Tier B の自己テストを実行できません。'
  t_end
else
  fx_guard check-prod-schema-drift
  fx_copy scripts/prod-schema-targets.sql
  mkdir -p "${FX}/db/migrations/base" "${FX}/db/migrations/with-probe"
  cp "${ROOT}"/db/migrations/*.sql "${FX}/db/migrations/base/"
  cp "${FX}"/db/migrations/base/*.sql "${FX}/db/migrations/with-probe/"
  highest_ordinal=0
  for migration in "${FX}"/db/migrations/base/[0-9][0-9][0-9][0-9]_*.sql; do
    [ -f "$migration" ] || continue
    migration_name="${migration##*/}"
    migration_ordinal="${migration_name%%_*}"
    numeric_ordinal=$((10#$migration_ordinal))
    if [ "$numeric_ordinal" -gt "$highest_ordinal" ]; then
      highest_ordinal="$numeric_ordinal"
    fi
  done
  probe_migration="$(printf 'db/migrations/with-probe/%04d_schema_drift_probe.sql' "$((highest_ordinal + 1))")"
  fx_write "$probe_migration" <<'EOF'
BEGIN;
CREATE TABLE schema_drift_probe (id integer NOT NULL);
COMMIT;
EOF

  OUT=''
  RC=0
  RC=0
  (cd "$FX" && EXPECTED_DATABASE_URL="$DATABASE_URL" \
    SCHEMA_MIGRATIONS_DIR="${FX}/db/migrations/base" \
    bash scripts/check-prod-schema-drift.sh --print-expected-targets \
    > "${FX}/baseline.tsv" 2> "${FX}/baseline.log") || RC=$?
  OUT="$(cat "${FX}/baseline.log" 2>/dev/null || true)"
  if [ "$RC" -ne 0 ] || [ ! -s "${FX}/baseline.tsv" ]; then
    _t_fail "現行 migration 群から正解 catalog を取得できませんでした（exit=${RC}）。"
  fi

  RC=0
  (cd "$FX" && EXPECTED_DATABASE_URL="$DATABASE_URL" \
    SCHEMA_MIGRATIONS_DIR="${FX}/db/migrations/with-probe" \
    bash scripts/check-prod-schema-drift.sh --print-expected-targets \
    > "${FX}/with-probe.tsv" 2> "${FX}/with-probe.log") || RC=$?
  OUT="$(cat "${FX}/with-probe.log" 2>/dev/null || true)"
  if [ "$RC" -ne 0 ] || [ ! -s "${FX}/with-probe.tsv" ]; then
    _t_fail "追加 migration 適用後の正解 catalog を取得できませんでした（exit=${RC}）。"
  fi

  baseline_relations="$(awk -F '\t' '$1 == "relation" { count++ } END { print count+0 }' "${FX}/baseline.tsv")"
  probe_relations="$(awk -F '\t' '$1 == "relation" { count++ } END { print count+0 }' "${FX}/with-probe.tsv")"
  relation_delta=$((probe_relations - baseline_relations))
  OUT="OK: migration 群への 1 本追加で relation target の差は ${relation_delta} 件です。"
  RC=0
  [ "$relation_delta" -eq 1 ] || RC=1
  expect_green
  expect_output_matches '1 件です'

  OUT=''
  RC=0
  OUT="$(cd "$FX" && PROJECT_ID=fixture \
    EXPECTED_SCHEMA_SNAPSHOT="${FX}/baseline.tsv" \
    PROD_SCHEMA_SNAPSHOT="${FX}/baseline.tsv" \
    bash scripts/check-prod-schema-drift.sh 2>&1)" || RC=$?
  expect_green

  OUT=''
  RC=0
  OUT="$(cd "$FX" && PROJECT_ID=fixture \
    EXPECTED_SCHEMA_SNAPSHOT="${FX}/with-probe.tsv" \
    PROD_SCHEMA_SNAPSHOT="${FX}/baseline.tsv" \
    bash scripts/check-prod-schema-drift.sh 2>&1)" || RC=$?
  expect_red '本番に存在しない対象: relation schema_drift_probe (-)'

  OUT=''
  RC=0
  OUT="$(cd "$FX" && PROJECT_ID=fixture \
    EXPECTED_SCHEMA_SNAPSHOT="${FX}/with-probe.tsv" \
    PROD_SCHEMA_SNAPSHOT="${FX}/with-probe.tsv" \
    bash scripts/check-prod-schema-drift.sh 2>&1)" || RC=$?
  expect_green
  t_end
fi

t_begin 'prod-schema-drift: 正解 snapshot が 0 件なら fail closed'
fx_guard check-prod-schema-drift
fx_write empty.tsv <<'EOF'
# intentionally empty
EOF
printf '%s\n' 'relation|stores|-' | tr '|' '\t' > "${FX}/live.tsv"
OUT=''
RC=0
OUT="$(cd "$FX" && PROJECT_ID=fixture EXPECTED_SCHEMA_SNAPSHOT="${FX}/empty.tsv" \
  PROD_SCHEMA_SNAPSHOT="${FX}/live.tsv" bash scripts/check-prod-schema-drift.sh 2>&1)" || RC=$?
expect_red 'expected の対象が 0 件です'
t_end

t_begin 'prod-schema-drift: 本番 snapshot が 0 件なら fail closed'
fx_guard check-prod-schema-drift
printf '%s\n' 'relation|stores|-' | tr '|' '\t' > "${FX}/expected.tsv"
fx_write empty.tsv <<'EOF'
# intentionally empty
EOF
OUT=''
RC=0
OUT="$(cd "$FX" && PROJECT_ID=fixture EXPECTED_SCHEMA_SNAPSHOT="${FX}/expected.tsv" \
  PROD_SCHEMA_SNAPSHOT="${FX}/empty.tsv" bash scripts/check-prod-schema-drift.sh 2>&1)" || RC=$?
expect_red 'production の対象が 0 件です'
t_end
