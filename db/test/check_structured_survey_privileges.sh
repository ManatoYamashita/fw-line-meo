#!/usr/bin/env bash
# structured survey の表の書込権限の検証（Issue #436・0015／店舗設定の書込面は Issue #437）。
#
# 新しい 7 表は、既存の表の「TS 層の 3 SA へ一律に DML」という付与を写さず、**今書く主体 × 今要る操作**
# だけを与える。どの主体が何を書けるかを、grants.sql を実ロールへ適用して has_table_privilege で問う
# （文字列の照合では「別の文の一律付与に紛れて付いている」を見分けられない・check_store_suspension_
# privileges.sh と同じ理由）。
#
# 期待する権限（許可される主体と、許可されない主体の両方を列挙する）:
#   survey_structured_material_tallies
#     - survey（客向けアンケート Web）: 列を絞った INSERT と count 列の UPDATE だけ（加算は UPSERT）。
#       表単位の INSERT・UPDATE は無い。UPDATE できるのは count だけで、店舗・月・厚みの列・has_comment・
#       id は UPDATE できない。INSERT できるのは incrementStructuredTallies が書く列だけ（id は既定値）。
#       DELETE は無い。この権限だけで incrementStructuredTallies 相当の UPSERT が通ることも実際に流して確かめる
#     - line_webhook・dashboard・batch・delivery・detail: どの列の INSERT・UPDATE も、DELETE も無い
#   survey_categories / survey_facets / survey_category_facets（taxonomy・seed が SoT）
#     - 全 6 SA: INSERT・UPDATE・DELETE のいずれも無い
#   store_survey_configs / store_survey_category_settings / store_survey_targets（店舗設定）
#     - detail（店舗オーナーの LIFF 面・Issue #437）: ts/packages/db/src/survey-settings.ts が書く列だけの
#       INSERT・UPDATE。表単位の INSERT・UPDATE・DELETE は無い。structured_enabled・store_id（Target の）・
#       category_code（Target の）・カテゴリの並び順は UPDATE できない
#     - line_webhook・survey・dashboard・batch・delivery: どの列の INSERT・UPDATE も、DELETE も無い
#     （客向けアンケート Web が店舗設定を書けないことも、ここで検証される）
#   store-detail のそれ以外（Issue #437）
#     - 店舗設定 3 表と audit_logs（列を絞った INSERT だけ）のほかに、public のどの表も書けない
#       （stores・owners・評価や集計の表・taxonomy を含む。表は catalog から列挙する）
#   上の 7 表すべて
#     - 全 6 SA: SELECT がある（読み取りは全層に許容する既存の方針）
#
# ロールの作り方・片付け方・CREATEROLE の前提は check_store_suspension_privileges.sh と同じ。
# 使い方: DATABASE_URL を設定して実行する（migrations 適用済みの DB を前提とする）。
#   ts/scripts/with-test-db.sh bash db/test/check_structured_survey_privileges.sh
# CI では scripts/run-db-test-suites.sh の RUN 表から呼ばれる（追加の env は不要）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GRANTS_SQL="${ROOT}/infra/sql/grants.sql"

: "${DATABASE_URL:?ERROR: DATABASE_URL が未設定です（with-test-db.sh 経由で実行してください）}"

fail_count=0
checked=0
note_fail() {
    fail_count=$((fail_count + 1))
    echo "FAIL: $1" >&2
}

q() {
    psql "$DATABASE_URL" -tA -X -v ON_ERROR_STOP=1 -c "$1"
}

if [ ! -f "$GRANTS_SQL" ]; then
    echo "FAIL: ${GRANTS_SQL} がありません（検査の前提が崩れています）" >&2
    exit 1
fi

TALLY_TABLE='survey_structured_material_tallies'
TAXONOMY_TABLES=(survey_categories survey_facets survey_category_facets)
CONFIG_TABLES=(store_survey_configs store_survey_category_settings store_survey_targets)

echo ">> [privilege-check] (P0) 接続ユーザーがロールを作れること"
can_create_role="$(q "SELECT rolcreaterole OR rolsuper FROM pg_roles WHERE rolname = current_user;")"
if [ "$can_create_role" != 't' ]; then
    echo "FAIL: 接続ユーザーに CREATEROLE がありません。この検査は SKIP せず赤にします（CREATEROLE を持つユーザーで接続してください）" >&2
    exit 1
fi

echo ">> [privilege-check] (P0) 検査する 7 表が存在すること（走査の前提）"
for t in "$TALLY_TABLE" "${TAXONOMY_TABLES[@]}" "${CONFIG_TABLES[@]}"; do
    if [ "$(q "SELECT to_regclass('public.${t}') IS NOT NULL;")" != 't' ]; then
        echo "FAIL: ${t} がありません（migration 0015 が未適用です。走査の前提が崩れています）" >&2
        exit 1
    fi
done

PROJECT="fwlm-structprivcheck-$$"
ROLE_KEYS=(line_webhook survey dashboard batch delivery detail)
role_name() {
    case "$1" in
        line_webhook) echo "sa-line-webhook@${PROJECT}.iam" ;;
        survey)       echo "sa-survey-web@${PROJECT}.iam" ;;
        dashboard)    echo "sa-dashboard-api@${PROJECT}.iam" ;;
        batch)        echo "sa-daily-batch@${PROJECT}.iam" ;;
        delivery)     echo "sa-summary-delivery@${PROJECT}.iam" ;;
        detail)       echo "sa-store-detail@${PROJECT}.iam" ;;
        *) echo "unknown role key: $1" >&2; return 1 ;;
    esac
}

CREATED_ROLES=()
cleanup() {
    local rc=$?
    local r
    for r in ${CREATED_ROLES[@]+"${CREATED_ROLES[@]}"}; do
        if ! psql "$DATABASE_URL" -tA -X -v ON_ERROR_STOP=1 -q \
            -c "DROP OWNED BY \"${r}\";" -c "DROP ROLE IF EXISTS \"${r}\";" >/dev/null; then
            echo "WARN: ロール ${r} の片付けに失敗しました（手動で DROP OWNED / DROP ROLE してください）" >&2
            [ "$rc" -ne 0 ] || rc=1
        fi
    done
    exit "$rc"
}
trap cleanup EXIT

echo ">> [privilege-check] 検証用の 6 ロールを作成する（project=${PROJECT}）"
for key in "${ROLE_KEYS[@]}"; do
    r="$(role_name "$key")"
    q "CREATE ROLE \"${r}\" NOLOGIN;" >/dev/null
    CREATED_ROLES+=("$r")
done

echo ">> [privilege-check] infra/sql/grants.sql を適用する"
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v project="$PROJECT" -f "$GRANTS_SQL" >/dev/null

# expect <role key> <table> <SELECT|INSERT|UPDATE|DELETE> <t|f>
expect() {
    local key="$1" table="$2" mode="$3" want="$4" r got
    r="$(role_name "$key")"
    got="$(q "SELECT has_table_privilege('${r}', 'public.${table}', '${mode}');")"
    checked=$((checked + 1))
    if [ "$got" = "$want" ]; then
        echo "PASS: ${key} の ${table} ${mode} = ${got}"
    else
        note_fail "${key} の ${table} ${mode} が ${got} です（期待 ${want}）"
    fi
}

# expect_column <role key> <table> <column> <INSERT|UPDATE> <t|f>
expect_column() {
    local key="$1" table="$2" column="$3" mode="$4" want="$5" r got
    r="$(role_name "$key")"
    got="$(q "SELECT has_column_privilege('${r}', 'public.${table}', '${column}', '${mode}');")"
    checked=$((checked + 1))
    if [ "$got" = "$want" ]; then
        echo "PASS: ${key} の ${table}.${column} ${mode} = ${got}"
    else
        note_fail "${key} の ${table}.${column} ${mode} が ${got} です（期待 ${want}）"
    fi
}

# incrementStructuredTallies（ts/packages/db/src/tallies.ts）が INSERT する列。id だけが既定値。
TALLY_INSERT_COLUMNS=" store_id period_month positive_group_count concern_group_count positive_target_count concern_target_count positive_facet_count concern_facet_count has_comment count "
# 列は catalog から列挙する（列を足したときに検査から漏れないように）。
# table_columns <table> — 削除済みでない通常の列を 1 行 1 列で返す。
table_columns() {
    q "SELECT attname FROM pg_attribute WHERE attrelid = 'public.${1}'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum;" | tr -d '\r'
}
mapfile -t TALLY_COLUMNS < <(q "SELECT attname FROM pg_attribute WHERE attrelid = 'public.${TALLY_TABLE}'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum;" | tr -d '\r')
if [ "${#TALLY_COLUMNS[@]}" -lt 11 ]; then
    echo "FAIL: ${TALLY_TABLE} の列を列挙できません（${#TALLY_COLUMNS[@]} 列。走査の前提が崩れています）" >&2
    exit 1
fi

echo ">> [privilege-check] (S1) 構造化の匿名集計を書けるのは客向けアンケート Web だけ（列を絞った INSERT・count の UPDATE のみ）"
# 表単位の INSERT・UPDATE は無い（列単位の付与だけ）。DELETE も無い。
expect survey "$TALLY_TABLE" INSERT f
expect survey "$TALLY_TABLE" UPDATE f
expect survey "$TALLY_TABLE" DELETE f
for col in "${TALLY_COLUMNS[@]}"; do
    case "$TALLY_INSERT_COLUMNS" in
        *" ${col} "*) expect_column survey "$TALLY_TABLE" "$col" INSERT t ;;
        *)            expect_column survey "$TALLY_TABLE" "$col" INSERT f ;;
    esac
    if [ "$col" = count ]; then
        expect_column survey "$TALLY_TABLE" "$col" UPDATE t
    else
        expect_column survey "$TALLY_TABLE" "$col" UPDATE f
    fi
done
for key in line_webhook dashboard batch delivery detail; do
    for mode in INSERT UPDATE DELETE; do
        expect "$key" "$TALLY_TABLE" "$mode" f
    done
    for col in "${TALLY_COLUMNS[@]}"; do
        for mode in INSERT UPDATE; do
            expect_column "$key" "$TALLY_TABLE" "$col" "$mode" f
        done
    done
done

echo ">> [privilege-check] (S1') 客向けアンケート Web の権限だけで、構造化集計の UPSERT が通る（count 以外は UPDATE できない）"
# incrementStructuredTallies と同じ 2 文（星の加算 → 厚みの UPSERT）を survey のロールで流す。
# 店舗の行は接続ユーザーで作り、全体を ROLLBACK するので DB に何も残さない。
SURVEY_ROLE="$(role_name survey)"
FIXTURE_STORE='a4360003-0000-4000-8000-000000000004'
upsert_sql="
INSERT INTO survey_rating_tallies (store_id, period_month, star, count)
VALUES ('${FIXTURE_STORE}', DATE '2026-10-01', 5, 1)
ON CONFLICT (store_id, period_month, star)
DO UPDATE SET count = survey_rating_tallies.count + 1;
INSERT INTO ${TALLY_TABLE}
  (store_id, period_month,
   positive_group_count, concern_group_count,
   positive_target_count, concern_target_count,
   positive_facet_count, concern_facet_count,
   has_comment, count)
VALUES ('${FIXTURE_STORE}', DATE '2026-10-01', 2, 1, 1, 1, 3, 0, true, 1)
ON CONFLICT (store_id, period_month,
             positive_group_count, concern_group_count,
             positive_target_count, concern_target_count,
             positive_facet_count, concern_facet_count,
             has_comment)
DO UPDATE SET count = ${TALLY_TABLE}.count + 1;"
upsert_rc=0
upsert_out="$(psql "$DATABASE_URL" -tA -X -q -v ON_ERROR_STOP=1 <<SQL 2>&1
BEGIN;
INSERT INTO operators (id, name) VALUES ('a4360003-0000-4000-8000-000000000001', '権限検査運営');
INSERT INTO agencies (id, operator_id, name)
  VALUES ('a4360003-0000-4000-8000-000000000002', 'a4360003-0000-4000-8000-000000000001', '権限検査代理店');
INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
  VALUES ('a4360003-0000-4000-8000-000000000003', 'a4360003-0000-4000-8000-000000000002', 'U-structured-privilege-check', 'active');
INSERT INTO stores (id, owner_id, name, place_id, place_status)
  VALUES ('${FIXTURE_STORE}', 'a4360003-0000-4000-8000-000000000003', '権限検査店舗', 'ChIJ_structured_privilege_check', 'confirmed');
SET LOCAL ROLE "${SURVEY_ROLE}";
${upsert_sql}
${upsert_sql}
SELECT 'count=' || count FROM ${TALLY_TABLE} WHERE store_id = '${FIXTURE_STORE}';
ROLLBACK;
SQL
)" || upsert_rc=$?
checked=$((checked + 1))
# 件数の判定は case で行う（printf | grep -q は EPIPE を pipefail が拾い得る・Issue #117）。
upsert_counted=no
case $'\n'"${upsert_out}"$'\n' in *$'\n'count=2$'\n'*) upsert_counted=yes ;; esac
if [ "$upsert_rc" -eq 0 ] && [ "$upsert_counted" = yes ]; then
    echo "PASS: survey の権限で UPSERT が 2 回通り、同じ行の count が 2 になる"
else
    note_fail "survey の権限で構造化集計の UPSERT が通りません（exit=${upsert_rc}）: ${upsert_out}"
fi

# count 以外の列の UPDATE と DELETE は、実際に流しても権限で拒否される。
for stmt in \
    "UPDATE ${TALLY_TABLE} SET store_id = store_id" \
    "UPDATE ${TALLY_TABLE} SET has_comment = has_comment" \
    "UPDATE ${TALLY_TABLE} SET positive_facet_count = positive_facet_count" \
    "DELETE FROM ${TALLY_TABLE}"; do
    deny_rc=0
    deny_out="$(psql "$DATABASE_URL" -tA -X -q -v ON_ERROR_STOP=1 \
        -c "BEGIN; SET LOCAL ROLE \"${SURVEY_ROLE}\"; ${stmt}; ROLLBACK;" 2>&1)" || deny_rc=$?
    checked=$((checked + 1))
    case "$deny_out" in *'permission denied'*) denied=yes ;; *) denied=no ;; esac
    if [ "$deny_rc" -ne 0 ] && [ "$denied" = yes ]; then
        echo "PASS: survey の「${stmt}」は権限で拒否される"
    else
        note_fail "survey の「${stmt}」が権限で拒否されません（exit=${deny_rc}）: ${deny_out}"
    fi
done

echo ">> [privilege-check] (S2) taxonomy 3 表は、どの SA も書けない（表単位・列単位とも）"
for t in "${TAXONOMY_TABLES[@]}"; do
    mapfile -t cols < <(table_columns "$t")
    for key in "${ROLE_KEYS[@]}"; do
        for mode in INSERT UPDATE DELETE; do
            expect "$key" "$t" "$mode" f
        done
        for col in "${cols[@]}"; do
            expect_column "$key" "$t" "$col" INSERT f
            expect_column "$key" "$t" "$col" UPDATE f
        done
    done
done

echo ">> [privilege-check] (S2') 店舗設定 3 表を書けるのは store-detail だけで、書く列だけ（Issue #437）"
# 期待する列（ts/packages/db/src/survey-settings.ts が書く列・infra/sql/grants.sql の付与と同じ）。
# 前後の空白は case の照合のため。表単位の INSERT・UPDATE・DELETE はどの SA にも無い。
config_insert_cols() {
    case "$1" in
        store_survey_configs)           echo " store_id " ;;
        store_survey_category_settings) echo " store_id category_code enabled sort_order " ;;
        store_survey_targets)           echo " store_id category_code label sort_order " ;;
    esac
}
config_update_cols() {
    case "$1" in
        store_survey_configs)           echo " revision updated_at " ;;
        store_survey_category_settings) echo " enabled " ;;
        store_survey_targets)           echo " label active sort_order updated_at " ;;
    esac
}
for t in "${CONFIG_TABLES[@]}"; do
    mapfile -t cols < <(table_columns "$t")
    ins="$(config_insert_cols "$t")"
    upd="$(config_update_cols "$t")"
    for key in "${ROLE_KEYS[@]}"; do
        for mode in INSERT UPDATE DELETE; do
            expect "$key" "$t" "$mode" f
        done
        for col in "${cols[@]}"; do
            want_ins=f
            want_upd=f
            if [ "$key" = detail ]; then
                case "$ins" in *" ${col} "*) want_ins=t ;; esac
                case "$upd" in *" ${col} "*) want_upd=t ;; esac
            fi
            expect_column "$key" "$t" "$col" INSERT "$want_ins"
            expect_column "$key" "$t" "$col" UPDATE "$want_upd"
        done
    done
done
# structured_enabled はどの SA も書けない（客向けの structured の画面が接続されるまで、オーナーも切り替えない）。
for key in "${ROLE_KEYS[@]}"; do
    expect_column "$key" store_survey_configs structured_enabled UPDATE f
done

echo ">> [privilege-check] (S4) store-detail は店舗設定 3 表と監査記録の追記のほかに、どの表も書けない（Issue #437）"
# 列挙は catalog から行う（表を足したときに検査から漏れないように）。
DETAIL_WRITABLE=" store_survey_configs store_survey_category_settings store_survey_targets audit_logs "
AUDIT_INSERT_COLS=" actor_type actor_id action target_type target_id occurred_at "
mapfile -t ALL_TABLES < <(q "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;" | tr -d '\r')
if [ "${#ALL_TABLES[@]}" -lt 30 ]; then
    echo "FAIL: public の表を列挙できません（${#ALL_TABLES[@]} 表。走査の前提が崩れています）" >&2
    exit 1
fi
for t in "${ALL_TABLES[@]}"; do
    case "$DETAIL_WRITABLE" in *" ${t} "*) continue ;; esac
    for mode in INSERT UPDATE DELETE; do
        expect detail "$t" "$mode" f
    done
    any="$(q "SELECT has_any_column_privilege('$(role_name detail)', 'public.${t}', 'INSERT') OR has_any_column_privilege('$(role_name detail)', 'public.${t}', 'UPDATE');")"
    checked=$((checked + 1))
    if [ "$any" = f ]; then
        echo "PASS: detail は ${t} のどの列も書けない"
    else
        note_fail "detail が ${t} のいずれかの列を書けます（店舗設定 3 表と監査記録のほかへ書込を広げていないか）"
    fi
done
mapfile -t audit_cols < <(table_columns audit_logs)
for mode in INSERT UPDATE DELETE; do
    expect detail audit_logs "$mode" f
done
for col in "${audit_cols[@]}"; do
    want=f
    case "$AUDIT_INSERT_COLS" in *" ${col} "*) want=t ;; esac
    expect_column detail audit_logs "$col" INSERT "$want"
    expect_column detail audit_logs "$col" UPDATE f
done

echo ">> [privilege-check] (S3) 7 表とも全 SA が読める"
for t in "$TALLY_TABLE" "${TAXONOMY_TABLES[@]}" "${CONFIG_TABLES[@]}"; do
    for key in "${ROLE_KEYS[@]}"; do
        expect "$key" "$t" SELECT t
    done
done

if [ "$checked" -eq 0 ]; then
    note_fail "検査した権限が 0 件です（走査の前提が崩れています）"
fi
if [ "$fail_count" -ne 0 ]; then
    echo "NG: structured survey の表の権限に ${fail_count} 件の違反があります" >&2
    exit 1
fi
echo "OK: structured survey の表の権限は期待どおりです（検査 ${checked} 件）"
