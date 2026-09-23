#!/usr/bin/env bash
# 店舗の停止時刻（stores.suspended_at）の列単位の書込権限の検証（store-suspension task 1.4・
# Requirements 8.1, 8.3, 8.4）。
#
# 停止時刻を書いてよいのは dashboard-api（運営・代理店の停止・再開の操作）だけである。
# オーナーと客の面を持つ line-webhook と survey-web がこの列を書けると、オーナー自身による
# 配信停止の手段を「どの名前で・どの層に」足しても DB が受け付けてしまう（8.1, 8.3）。
# よって infra/sql/grants.sql は、この 2 つの SA に stores の INSERT・UPDATE を列単位で与え、
# suspended_at だけを列挙から外している。
#
# なぜ grants.sql を実際に適用して問うのか: grants.sql は CI のどこでも実行されず、
# 文字列として読まれるだけだった。文字列の照合では「テーブル単位の付与が残っていて列の絞りが
# 効いていない」（PostgreSQL は列の REVOKE をテーブル単位の権限より優先しない）を見分けられない。
# 実際にロールを作って当て、has_column_privilege で権限そのものを問う。
#
# 検証すること:
#   - dashboard: suspended_at を UPDATE できる
#   - line_webhook・survey: suspended_at を INSERT・UPDATE できない
#   - line_webhook・survey: suspended_at 以外の stores の**全列**を INSERT・UPDATE できる
#     （列の列挙は grants.sql への直書きなので、stores に列を足して列挙へ足し忘れると赤になる）
#   - batch・delivery・detail: suspended_at を UPDATE できない
#   - 走査した列が 1 以上であること（空振り防止）
#
# ロール名はクラスタ共有なので、grants.sql の `-v project=` へ本番と衝突しない専用の値
# （プロセス ID つき）を渡して 6 ロールを得る。終了時に、本スクリプトが作ったロールだけを
# DROP OWNED・DROP ROLE で片付ける。
#
# 実行ユーザーに CREATEROLE（または superuser）が要る。CI の service postgres とローカルの
# ts/scripts/with-test-db.sh の postgres は満たす。満たさなければ赤にし、黙って SKIP しない
# （SKIP すると、この検査が CI から消えても誰も気づけない）。
#
# 既知の限界: CI は superuser で grants.sql を当てるため、本番で問題になる「付与者の食い違いで
# REVOKE が警告だけで効かない」は再現できない。本番の確認は design.md の ProductionVerification の
# 照会が担う。
#
# 使い方: DATABASE_URL を設定して実行する（migrations 適用済みの DB を前提とする）。
#   ts/scripts/with-test-db.sh bash db/test/check_store_suspension_privileges.sh
# CI では scripts/run-db-test-suites.sh の RUN 表から呼ばれる（追加の env は不要）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GRANTS_SQL="${ROOT}/infra/sql/grants.sql"

: "${DATABASE_URL:?ERROR: DATABASE_URL が未設定です（with-test-db.sh 経由で実行してください）}"

fail_count=0
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

# ---------------------------------------------------------------------------
# (P0) 走査の前提: ロールを作れること・stores.suspended_at が存在すること
# ---------------------------------------------------------------------------
# 列の存在は pg_attribute で問う。information_schema.columns は接続ユーザーが権限を持つ列しか
# 返さないので、権限の弱いユーザーで繋ぐと「列が無い」「走査 0 件」と取り違える。
# ロール作成の権限を先に問うのも同じ理由で、原因を取り違えた赤を出さないためである。
echo ">> [privilege-check] (P0) 接続ユーザーがロールを作れること"
can_create_role="$(q "SELECT rolcreaterole OR rolsuper FROM pg_roles WHERE rolname = current_user;")"
if [ "$can_create_role" != 't' ]; then
    echo "FAIL: 接続ユーザーに CREATEROLE がありません。この検査は SKIP せず赤にします（CREATEROLE を持つユーザーで接続してください）" >&2
    exit 1
fi

STORES_COLUMNS_SQL="SELECT attname FROM pg_attribute WHERE attrelid = to_regclass('public.stores') AND attnum > 0 AND NOT attisdropped"

echo ">> [privilege-check] (P0) stores.suspended_at が存在すること（走査の前提）"
has_column="$(q "SELECT count(*) FROM (${STORES_COLUMNS_SQL}) c WHERE attname = 'suspended_at';")"
if [ "$has_column" != '1' ]; then
    echo "FAIL: stores.suspended_at がありません（migration 0012 が未適用です。走査の前提が崩れています）" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# ロールの作成と片付け
# ---------------------------------------------------------------------------
# grants.sql が導く名前と同じ式でロール名を組み立てる（sa-<名前>@<project>.iam）。
PROJECT="fwlm-privcheck-$$"
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

# 本スクリプトが作ったロールだけを記録し、それだけを片付ける（既存のロールに触れない）。
CREATED_ROLES=()
cleanup() {
    local rc=$?
    local r
    for r in ${CREATED_ROLES[@]+"${CREATED_ROLES[@]}"}; do
        # DROP OWNED は付与された権限も剥がす。これが無いと DROP ROLE が依存で失敗する。
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

# ---------------------------------------------------------------------------
# (P1) 停止時刻の書込権限
# ---------------------------------------------------------------------------
# priv <role key> <column> <INSERT|UPDATE> → t / f
priv() {
    local r
    r="$(role_name "$1")"
    q "SELECT has_column_privilege('${r}', 'public.stores', '$2', '$3');"
}

expect_priv() {
    local key="$1" column="$2" mode="$3" want="$4" got
    got="$(priv "$key" "$column" "$mode")"
    if [ "$got" = "$want" ]; then
        echo "PASS: ${key} の stores.${column} ${mode} = ${got}"
    else
        note_fail "${key} の stores.${column} ${mode} が ${got} です（期待 ${want}）"
    fi
}

echo ">> [privilege-check] (P1) 停止時刻を更新できるのはダッシュボードだけであること（8.1, 8.4）"
expect_priv dashboard suspended_at UPDATE t
for key in line_webhook survey; do
    expect_priv "$key" suspended_at INSERT f
    expect_priv "$key" suspended_at UPDATE f
done
for key in batch delivery detail; do
    expect_priv "$key" suspended_at UPDATE f
done

# ---------------------------------------------------------------------------
# (P2) 停止時刻以外の列は従来どおり書けること
# ---------------------------------------------------------------------------
echo ">> [privilege-check] (P2) LINE 応答と客向け Web が停止時刻以外の stores の全列を追加・更新できること"
columns="$(q "${STORES_COLUMNS_SQL} AND attname <> 'suspended_at' ORDER BY attnum;")"
scanned=0
for column in $columns; do
    scanned=$((scanned + 1))
    for key in line_webhook survey; do
        for mode in INSERT UPDATE; do
            got="$(priv "$key" "$column" "$mode")"
            if [ "$got" != 't' ]; then
                note_fail "${key} が stores.${column} を ${mode} できません（grants.sql の列の列挙へ足し忘れていませんか）"
            fi
        done
    done
done
if [ "$scanned" -eq 0 ]; then
    note_fail "走査した stores の列が 0 件です（走査の前提が崩れています）"
fi
echo "-- 走査した列: ${scanned} 件（suspended_at を除く）"

if [ "$fail_count" -ne 0 ]; then
    echo "NG: 停止時刻の列単位の書込権限に ${fail_count} 件の違反があります" >&2
    exit 1
fi
echo "OK: 停止時刻の列単位の書込権限は期待どおりです（走査 ${scanned} 列）"
