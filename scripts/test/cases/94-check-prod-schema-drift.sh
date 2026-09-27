# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-prod-schema-drift.sh の hermetic 自己テスト（Issue #251）。

pds_snapshot() {
  pds_path="$1"
  shift
  for pds_row in "$@"; do
    printf '%s\n' "$pds_row"
  done | tr '|' '\t' > "${FX}/${pds_path}"
}

pds_run() {
  OUT=''
  RC=0
  OUT="$(cd "$FX" && PROJECT_ID=fixture \
    EXPECTED_SCHEMA_SNAPSHOT="${FX}/expected.tsv" \
    PROD_SCHEMA_SNAPSHOT="${FX}/production.tsv" \
    bash scripts/check-prod-schema-drift.sh 2>&1)" || RC=$?
}

t_begin 'check-prod-schema-drift: 同じ対象集合なら緑で件数を報告する'
fx_guard check-prod-schema-drift
pds_snapshot expected.tsv \
  'relation|stores|-' \
  'column|id|stores' \
  'index|stores_pkey|stores' \
  'enum_label|Responded?|survey_status'
pds_snapshot production.tsv \
  'relation|stores|-' \
  'column|id|stores' \
  'index|stores_pkey|stores' \
  'enum_label|Responded?|survey_status'
pds_run
expect_green
expect_output_matches 'expected=4 / production=4'
expect_output_matches 'SCHEMA-DRIFT-SIGNATURE: missing=;extra=;'
t_end

t_begin 'check-prod-schema-drift: migration 対象の欠落と migration 外対象を別々に検出する'
fx_guard check-prod-schema-drift
pds_snapshot expected.tsv \
  'relation|stores|-' \
  'relation|agencies|-' \
  'column|id|stores'
pds_snapshot production.tsv \
  'relation|stores|-' \
  'relation|manual_table|-' \
  'column|id|stores'
pds_run
expect_red '本番に存在しない対象: relation agencies (-)'
expect_output_matches 'migration に無い本番対象: relation manual_table \(-\)'
expect_output_matches 'SCHEMA-DRIFT-SIGNATURE: missing=relation:agencies@-,'
t_end

t_begin 'check-prod-schema-drift: 空または不正な snapshot は fail closed'
fx_guard check-prod-schema-drift
pds_snapshot production.tsv 'relation|stores|-'
fx_write expected.tsv <<'EOF'
# intentionally empty
EOF
pds_run
expect_red 'expected の対象が 0 件です'

pds_snapshot expected.tsv 'relation|stores|-'
fx_write production.tsv <<'EOF'
# intentionally empty
EOF
pds_run
expect_red 'production の対象が 0 件です'

fx_write expected.tsv <<'EOF'
relation	stores
EOF
pds_run
expect_red 'expected の TSV 形式が不正です'

pds_snapshot expected.tsv 'relation|stores|-' 'relation|stores|-'
pds_snapshot production.tsv 'relation|stores|-'
pds_run
expect_red 'expected に重複した対象があります'
t_end
