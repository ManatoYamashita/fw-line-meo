#!/usr/bin/env bash
# オーナーの LINE 連携状態（owners の解除の列）の列単位の書込権限の検証（owner-line-unlink task 1.2・
# Requirements 8.1, 8.3, 8.4）。
#
# 紐づけを解除してよいのは dashboard-api（運営・担当代理店の操作）だけである。オーナーと客の面を持つ
# line-webhook と survey-web が解除の列を書けると、オーナー自身による解除・配信停止の手段を
# 「どの名前で・どの層に」足しても DB が受け付けてしまう（8.1, 8.3）。
# よって infra/sql/grants.sql は、この 2 つの SA に owners の INSERT・UPDATE を列単位で与え、
#   - line_user_id は INSERT だけ（オーナーの作成で書く。既存の行の LINE ユーザー ID は書き換えない）
#   - line_unlinked_at・menu_pending_line_user_id は INSERT も UPDATE も与えない
#   - taken_over_by_owner_id は UPDATE だけ（引継ぎで line-webhook が書く。CHECK により解除済みの行にしか
#     値を持てないので、配信を止める手段にはならない）
#   - invite_code_id は INSERT だけ（オーナーの作成で登録に用いた招待コードを書く・agency-dashboard
#     Req 8.1。登録の記録なので、作成の後に書き換えさせない）
# としている。
#
# なぜ grants.sql を実際に適用して問うのか: 文字列の照合では「テーブル単位の付与が残っていて列の絞りが
# 効いていない」（PostgreSQL は列の REVOKE をテーブル単位の権限より優先しない）を見分けられない。
# 実際にロールを作って当て、has_column_privilege で権限そのものを問う（check_store_suspension_privileges.sh
# と同じ方式）。
#
# 検証すること:
#   - dashboard: 解除の 3 列（line_user_id・line_unlinked_at・menu_pending_line_user_id）を UPDATE できる
#   - line_webhook・survey: line_user_id を UPDATE できない（INSERT はできる）
#   - line_webhook・survey: line_unlinked_at・menu_pending_line_user_id を INSERT も UPDATE もできない
#   - line_webhook・survey: taken_over_by_owner_id を INSERT できない（UPDATE はできる）
#   - line_webhook・survey: invite_code_id を UPDATE できない（INSERT はできる）
#   - line_webhook・survey: 上の 5 列以外の owners の**全列**を INSERT・UPDATE できる
#     （列の列挙は grants.sql への直書きなので、owners に列を足して列挙へ足し忘れると赤になる。
#     足す列が解除・配信停止に関わるなら、列挙へ足さずにこの検査の個別の期待へ加えること）
#   - batch・delivery・detail: 解除の 3 列を UPDATE できない
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
# REVOKE が警告だけで効かない」は再現できない。本番の確認は .kiro/specs/owner-line-unlink/design.md の
# Migration Strategy（Step C の has_column_privilege の照会）が担う。
#
# 使い方: DATABASE_URL を設定して実行する（migrations 適用済みの DB を前提とする）。
#   ts/scripts/with-test-db.sh bash db/test/check_owner_line_privileges.sh
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

# 個別に期待を持つ列。走査（P3）はこれ以外の列を「INSERT・UPDATE とも書ける」と期待する。
UNLINK_COLUMNS=(line_user_id line_unlinked_at menu_pending_line_user_id)
SPECIAL_COLUMNS=(line_user_id line_unlinked_at menu_pending_line_user_id taken_over_by_owner_id invite_code_id)

# ---------------------------------------------------------------------------
# (P0) 走査の前提: ロールを作れること・個別に期待を持つ列が存在すること
# ---------------------------------------------------------------------------
# 列の存在は pg_attribute で問う。information_schema.columns は接続ユーザーが権限を持つ列しか
# 返さないので、権限の弱いユーザーで繋ぐと「列が無い」「走査 0 件」と取り違える。
# ロール作成の権限を先に問うのも同じ理由で、原因を取り違えた赤を出さないためである。
echo ">> [owner-line-privilege-check] (P0) 接続ユーザーがロールを作れること"
can_create_role="$(q "SELECT rolcreaterole OR rolsuper FROM pg_roles WHERE rolname = current_user;")"
if [ "$can_create_role" != 't' ]; then
    echo "FAIL: 接続ユーザーに CREATEROLE がありません。この検査は SKIP せず赤にします（CREATEROLE を持つユーザーで接続してください）" >&2
    exit 1
fi

OWNERS_COLUMNS_SQL="SELECT attname FROM pg_attribute WHERE attrelid = to_regclass('public.owners') AND attnum > 0 AND NOT attisdropped"

echo ">> [owner-line-privilege-check] (P0) owners に個別に期待を持つ列が存在すること（走査の前提）"
for column in "${SPECIAL_COLUMNS[@]}"; do
    has_column="$(q "SELECT count(*) FROM (${OWNERS_COLUMNS_SQL}) c WHERE attname = '${column}';")"
    if [ "$has_column" != '1' ]; then
        echo "FAIL: owners.${column} がありません（migration 0017・0018 が未適用です。走査の前提が崩れています）" >&2
        exit 1
    fi
done

# ---------------------------------------------------------------------------
# ロールの作成と片付け
# ---------------------------------------------------------------------------
# grants.sql が導く名前と同じ式でロール名を組み立てる（sa-<名前>@<project>.iam）。
PROJECT="fwlm-ownerline-$$"
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

echo ">> [owner-line-privilege-check] 検証用の 6 ロールを作成する（project=${PROJECT}）"
for key in "${ROLE_KEYS[@]}"; do
    r="$(role_name "$key")"
    q "CREATE ROLE \"${r}\" NOLOGIN;" >/dev/null
    CREATED_ROLES+=("$r")
done

echo ">> [owner-line-privilege-check] infra/sql/grants.sql を適用する"
psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -v project="$PROJECT" -f "$GRANTS_SQL" >/dev/null

# priv <role key> <column> <INSERT|UPDATE> → t / f
priv() {
    local r
    r="$(role_name "$1")"
    q "SELECT has_column_privilege('${r}', 'public.owners', '$2', '$3');"
}

expect_priv() {
    local key="$1" column="$2" mode="$3" want="$4" got
    got="$(priv "$key" "$column" "$mode")"
    if [ "$got" = "$want" ]; then
        echo "PASS: ${key} の owners.${column} ${mode} = ${got}"
    else
        note_fail "${key} の owners.${column} ${mode} が ${got} です（期待 ${want}）"
    fi
}

# ---------------------------------------------------------------------------
# (P1) 解除の列を書けるのはダッシュボードだけであること
# ---------------------------------------------------------------------------
echo ">> [owner-line-privilege-check] (P1) 解除の列を更新できるのはダッシュボードだけであること（8.1, 8.3）"
for column in "${UNLINK_COLUMNS[@]}"; do
    expect_priv dashboard "$column" UPDATE t
done
for key in line_webhook survey; do
    expect_priv "$key" line_user_id UPDATE f
    expect_priv "$key" line_unlinked_at INSERT f
    expect_priv "$key" line_unlinked_at UPDATE f
    expect_priv "$key" menu_pending_line_user_id INSERT f
    expect_priv "$key" menu_pending_line_user_id UPDATE f
    expect_priv "$key" taken_over_by_owner_id INSERT f
    expect_priv "$key" invite_code_id UPDATE f
done
for key in batch delivery detail; do
    for column in "${UNLINK_COLUMNS[@]}"; do
        expect_priv "$key" "$column" UPDATE f
    done
done

# ---------------------------------------------------------------------------
# (P2) オーナーの作成と引継ぎに要る書込は残っていること
# ---------------------------------------------------------------------------
echo ">> [owner-line-privilege-check] (P2) オーナーの作成で LINE ユーザー ID と招待コードを、引継ぎで引継ぎ先を書けること"
for key in line_webhook survey; do
    expect_priv "$key" line_user_id INSERT t
    expect_priv "$key" taken_over_by_owner_id UPDATE t
    expect_priv "$key" invite_code_id INSERT t
done

# ---------------------------------------------------------------------------
# (P3) 連携状態以外の列は従来どおり書けること
# ---------------------------------------------------------------------------
echo ">> [owner-line-privilege-check] (P3) LINE 応答と客向け Web が連携状態以外の owners の全列を追加・更新できること"
exclude_list=""
for column in "${SPECIAL_COLUMNS[@]}"; do
    exclude_list="${exclude_list:+${exclude_list}, }'${column}'"
done
columns="$(q "${OWNERS_COLUMNS_SQL} AND attname NOT IN (${exclude_list}) ORDER BY attnum;")"
scanned=0
for column in $columns; do
    scanned=$((scanned + 1))
    for key in line_webhook survey; do
        for mode in INSERT UPDATE; do
            got="$(priv "$key" "$column" "$mode")"
            if [ "$got" != 't' ]; then
                note_fail "${key} が owners.${column} を ${mode} できません（grants.sql の列の列挙へ足し忘れていませんか）"
            fi
        done
    done
done
if [ "$scanned" -eq 0 ]; then
    note_fail "走査した owners の列が 0 件です（走査の前提が崩れています）"
fi
echo "-- 走査した列: ${scanned} 件（連携状態の ${#SPECIAL_COLUMNS[@]} 列を除く）"

if [ "$fail_count" -ne 0 ]; then
    echo "NG: オーナーの連携状態の列単位の書込権限に ${fail_count} 件の違反があります" >&2
    exit 1
fi
echo "OK: オーナーの連携状態の列単位の書込権限は期待どおりです（走査 ${scanned} 列）"
