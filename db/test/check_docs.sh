#!/usr/bin/env bash
# Docs ↔ schema 整合チェック:
#  - 実テーブルが db/write-boundary.md のマッピング表行にちょうど 1 回出現＝書込責任層が単一（Req 9.1, 9.4）
#  - 実テーブルが db/ERD.md に出現（Req 11.1, 11.2）
#  - write-boundary.md の書込所有テーブルに infra/sql/grants.sql で該当層 SA への DML GRANT があること
#  - 走査したテーブルが 1 件以上あること（空振り防止・Issue #156）
#
# 既定: apple/container で一時 postgres を起動し migrations を適用して実テーブル一覧を取得。
# 既存 DB を使う場合: MANAGE_CONTAINER=0 かつ PSQL_EXEC を設定（例: MANAGE_CONTAINER=0 PSQL_EXEC=psql、PG* 環境変数で接続）。
#
# CI からは `scripts/run-db-test-suites.sh` が MANAGE_CONTAINER=0 / PSQL_EXEC="psql $DATABASE_URL" で
# 呼ぶ（Issue #156）。それ以前は本スクリプトを実行するワークフローが存在せず、
# 書込境界の単一所有は `make db-verify-docs` を手元で打った人にだけ効く規律だった。
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
# grep の一致件数を stdout へ返す。**無一致（exit 1）は 0 件として正常に返し、評価不能
# （exit 2 以上）はその終了コードのまま返す**（Issue #162）。
#
# 旧版は各所で `|| true` を使っており、grep が exit 2 を返した場合に空文字が件数として流れていた。
# その空文字は `[ "$c" -ne 1 ]` へ渡って test 自身を status 2 で落とし、`if` が偽になるため、
# **壊れたパターンが PASS として素通りする**（Issue #120 に記録された形そのもの）。
# 本ファイルは #156 以降 CI から毎 PR 実行されているのに、#162 まで機械強制の外にあった。
count_matches() {   # $1.. = grep へ渡す引数（-E / -F / -w など）
    cm_rc=0
    cm_out="$(grep -c "$@")" || cm_rc=$?
    [ "$cm_rc" -le 1 ] || return "$cm_rc"
    printf '%s\n' "${cm_out:-0}"
}

grants_flat=$(sed 's/--.*//' "$GRANTS" | tr '\n' ' ' | tr ';' '\n')

# GRANT 文の抽出は 2 段に分ける。**1 本のパイプへ繋いではならない** — pipefail が返すのは
# 右端の非ゼロ終了なので、前段が評価不能（2）で後段が無一致（1）だと 2 が 1 に化ける。
grant_rc=0
grants_dml="$(printf '%s\n' "$grants_flat" | grep -E 'GRANT[[:space:]]+INSERT')" || grant_rc=$?
if [ "$grant_rc" -gt 1 ]; then
    echo "FAIL: grants.sql の GRANT 文を走査できません（grep exit=${grant_rc}）"
    exit 1
fi
ts_rc=0
ts_dml="$(printf '%s\n' "$grants_dml" | grep -E ':"(line_webhook|survey|dashboard|delivery)"')" || ts_rc=$?
if [ "$ts_rc" -gt 1 ]; then
    echo "FAIL: TS 層 SA への DML GRANT を走査できません（grep exit=${ts_rc}）"
    exit 1
fi
go_rc=0
go_dml="$(printf '%s\n' "$grants_dml" | grep -F ':"batch"')" || go_rc=$?
if [ "$go_rc" -gt 1 ]; then
    echo "FAIL: Go 層 SA への DML GRANT を走査できません（grep exit=${go_rc}）"
    exit 1
fi

bq='`'; fail=0; n=0

# **原因を断定しない。** GRANT INSERT が 1 件も無い状態は「全書込所有テーブルが未付与」でも
# 「抽出（sed / tr による平坦化）の前提が崩れた」でも起こる。前者なら下のテーブルごとの
# FAIL が実体を列挙するので、**ここで打ち切らない**（このスクリプトは集約実行である）。
# 上位の 1 行として「どちらであれ照合が成立していない」ことだけを先に出す。
if [ -z "$grants_dml" ]; then
    echo "FAIL: grants.sql に GRANT INSERT の文が 1 件もありません（全書込所有テーブルが未付与か、抽出の前提が崩れたかのどちらかです）"
    fail=1
fi
while IFS= read -r t; do
    [ -z "$t" ] && continue
    n=$((n + 1))

    wb_rc=0
    c="$(count_matches -E "^\| ${bq}${t}${bq} \|" "$WB")" || wb_rc=$?
    if [ "$wb_rc" -ne 0 ]; then
        echo "FAIL: write-boundary.md を走査できません（grep exit=${wb_rc}・テーブル '$t'）"; fail=1; continue
    fi
    if [ "$c" -ne 1 ]; then echo "FAIL: '$t' は write-boundary.md のマッピング表に ${c} 行（期待 1）"; fail=1; fi

    # 旧版は `! grep -qwF` で、評価不能を無一致と同一視して「ERD.md に存在しない」と誤診していた
    # （赤にはなるが原因が読み手に伝わらない）。件数判定へ替えて両者を分ける。
    erd_rc=0
    e="$(count_matches -wF "$t" "$ERD")" || erd_rc=$?
    if [ "$erd_rc" -ne 0 ]; then
        echo "FAIL: ERD.md を走査できません（grep exit=${erd_rc}・テーブル '$t'）"; fail=1
    elif [ "$e" -eq 0 ]; then
        echo "FAIL: '$t' が ERD.md に存在しない"; fail=1
    fi

    # 書込所有テーブルは grants.sql に該当層 SA への DML GRANT が必要（write-boundary.md との整合）。
    # 抽出と整形を 1 本のパイプへ繋がない。pipefail 下では grep の無一致（exit 1）が
    # 代入ごと失敗させ、**set -e がここでスクリプトを打ち切る**（集約実行が静かに壊れる）。
    layer_rc=0
    layer_line="$(grep -E "^\| ${bq}${t}${bq} \|" "$WB")" || layer_rc=$?
    if [ "$layer_rc" -gt 1 ]; then
        echo "FAIL: write-boundary.md の所有層を走査できません（grep exit=${layer_rc}・テーブル '$t'）"; fail=1; continue
    fi
    layer="$(printf '%s\n' "$layer_line" | awk -F'|' '{print $3}')"

    # 件数判定にする。`printf | grep -q` は最初の一致で抜けるため上流が EPIPE で 141 になり、
    # pipefail がそれを伝播する（入力サイズ依存の偽陽性・Issue #117 / #162）。
    case "$layer" in
        *TS*)
            hit_rc=0
            hit="$(printf '%s\n' "$ts_dml" | count_matches -w "$t")" || hit_rc=$?
            if [ "$hit_rc" -ne 0 ]; then
                echo "FAIL: TS 層の DML GRANT を走査できません（grep exit=${hit_rc}・テーブル '$t'）"; fail=1
            elif [ "$hit" -eq 0 ]; then
                echo "FAIL: TS 書込所有 '$t' への DML GRANT が grants.sql に無い"; fail=1
            fi
            ;;
        *Go*)
            hit_rc=0
            hit="$(printf '%s\n' "$go_dml" | count_matches -w "$t")" || hit_rc=$?
            if [ "$hit_rc" -ne 0 ]; then
                echo "FAIL: Go 層の DML GRANT を走査できません（grep exit=${hit_rc}・テーブル '$t'）"; fail=1
            elif [ "$hit" -eq 0 ]; then
                echo "FAIL: Go 書込所有 '$t' への DML GRANT が grants.sql に無い"; fail=1
            fi
            ;;
    esac
done <<< "$tables"

# **空振り防止（Issue #156）。** テーブルが 0 件なら上の while は一度も回らず、`fail` は 0 のまま
# `n` も 0 のままになる。素朴に書くと `OK: … 0 テーブル …` を出して **exit 0** するので、
# 「接続先に migrations が当たっていない」「別の DB を指した」という**検査の前提が崩れた状態**を、
# CI の緑がお墨付きにしてしまう。違反 0 件と対象 0 件は別物である。
# 実測（Issue #156 の作業時）: 空の DB を指すと `OK: … 0 テーブル …` / exit 0 を返した。
if [ "$n" -eq 0 ]; then
    echo "FAIL: public に BASE TABLE が 1 件もありません（接続先に migrations が当たっていない可能性。検査の前提が崩れています）"
    fail=1
fi

if [ "$fail" -eq 0 ]; then echo "OK: docs と schema と grants.sql が整合（${n} テーブル・書込境界は各 1 所有・所有層へ DML GRANT あり）"; fi
exit $fail
