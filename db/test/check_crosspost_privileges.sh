#!/usr/bin/env bash
# line-crosspost（Issue #494・0019）の書き込み権限を、実ロールに infra/sql/grants.sql を当てて検証する。
#
# 期待（db/write-boundary.md・design.md「Data Models」）:
#   - crosspost_drafts・crosspost_media・crosspost_deliveries の INSERT・UPDATE・DELETE を持つのは
#     line-webhook の SA だけ
#   - 例外: 配信ジョブ（delivery）は保存期間の削除のために crosspost_drafts・crosspost_media の DELETE だけを持つ
#     （INSERT・UPDATE は持たない・crosspost_deliveries は CASCADE で消えるので直接の DELETE は持たない）
#   - 客向け Web・ダッシュボード API・店舗詳細・日次バッチは、3 表とも読むだけ（SELECT）
#
# なぜ要るか: 3 表は店主の承認と投稿の実行に直結する。ほかの面（客の面・代理店の面）が書けると、
# アプリにどんな経路を足しても DB が受け付けてしまう。既存の TS 3 SA の一律付与へ足し間違えたときに、
# check_docs.sh（所有層のどれかへ DML があるか）だけでは緑のまま通る。
#
# 接続ユーザーに CREATEROLE が要る（無ければ SKIP せず赤）。作ったロールは終了時に片付ける。
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
    psql "$DATABASE_URL" -tA -X -v ON_ERROR_STOP=1 -c "$1" | tr -d '\r'
}

TABLES=(crosspost_drafts crosspost_media crosspost_deliveries)

if [ "$(q "SELECT rolcreaterole OR rolsuper FROM pg_roles WHERE rolname = current_user;")" != 't' ]; then
    echo "FAIL: 接続ユーザーに CREATEROLE がありません。この検査は SKIP せず赤にします" >&2
    exit 1
fi
for t in "${TABLES[@]}"; do
    if [ "$(q "SELECT to_regclass('public.${t}') IS NOT NULL;")" != 't' ]; then
        echo "FAIL: ${t} がありません（migration 0019 が未適用です。走査の前提が崩れています）" >&2
        exit 1
    fi
done

PROJECT="fwlm-crosspostprivcheck-$$"
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

for key in "${ROLE_KEYS[@]}"; do
    r="$(role_name "$key")"
    q "CREATE ROLE \"${r}\" NOLOGIN;" >/dev/null
    CREATED_ROLES+=("$r")
done

psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v project="$PROJECT" -f "$GRANTS_SQL" >/dev/null

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

for t in "${TABLES[@]}"; do
    for mode in SELECT INSERT UPDATE DELETE; do
        expect line_webhook "$t" "$mode" t
    done
    for key in survey dashboard batch delivery detail; do
        expect "$key" "$t" SELECT t
        for mode in INSERT UPDATE DELETE; do
            want=f
            if [ "$key" = delivery ] && [ "$mode" = DELETE ] && [ "$t" != crosspost_deliveries ]; then
                want=t
            fi
            expect "$key" "$t" "$mode" "$want"
        done
    done
done

# 空振りの防止: 3 表 × (line_webhook 4 + 他 5 ロール × 4) = 72 件
if [ "$checked" -ne 72 ]; then
    note_fail "検査件数が ${checked} 件です（期待 72 件。走査が壊れています）"
fi

if [ "$fail_count" -ne 0 ]; then
    echo "NG: line-crosspost の書き込み権限が宣言と食い違っています（${fail_count} 件）" >&2
    exit 1
fi
echo "OK: line-crosspost の 3 表を書けるのは line-webhook の SA だけ（配信ジョブは保存期間の削除だけ・${checked} 件）"
