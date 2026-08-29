#!/usr/bin/env bash
# Issue #156 ガードレール: `db/test/` の検査資産が **どのワークフローからも実行されていなかった**。
#
# `db/test/assertions/*.sql`・`db/test/smoke/*.sql`・`db/test/check_docs.sh` は、Requirement 5
# （客の個人情報を一切取得しない・Place 単位の匿名集計のみ）を構造で担保し、Req 9.1/9.4
# （書込境界の単一所有）を機械検証する装置である。にもかかわらず `git log -S 'db/test' -- .github/`
# は 0 件で、**一度も CI に載ったことがなかった**。`db/migrations/0006_survey_material_tallies.sql`
# は自身のコメントで「この構造は 30_compliance.sql の列 allowlist が機械強制する」と宣言していたが、
# 強制の実行主体が存在しないため、その記述は書かれた時点から偽だった。
#
# **壊れ方は「差分に痕跡が残らない」である。** #33（tf のサービスが push 対象に無い）・
# #51（typecheck が定義されているのに CI から呼ばれない）・#70 / #78 / #83（コードが検査の器に
# 入っていない）・#90（ケースファイルが消えても残りの緑で通る）と同型で、本リポジトリが最も
# 繰り返し踏んでいる形である。実行装置（`scripts/run-db-test-suites.sh`）を足しただけでは、
# ワークフロー側の 1 行を消せば同じ状態へ戻り、しかも残りの CI は全緑を返す。
#
# 本スクリプトは以下を機械検証する（read-only の走査・DB へ一切接続しない・bash 3.2 でも走る）:
#   1. 実行装置 `scripts/run-db-test-suites.sh` が存在する
#   2. それが `.github/workflows/*.yml` / `*.yaml` の **非コメント行**から参照されている
#   3. 参照しているワークフローが `push` または `pull_request` で発火する
#      （`workflow_dispatch` だけのワークフローへ移されると「器に入っているが蓋が閉じている」形になる）
#   4. 追跡下の `db/test/*.sh` がすべて実行装置の RUN 表か SKIP 表に宣言されている
#      （「置いたのに誰も呼ばない」＝ 本 Issue そのものを二度と無言で起こさない）
#   5. SKIP 宣言に Issue 番号がある（理由と追跡先の無い除外を作らない）
#   6. SKIP 宣言の指すファイルが実在する（指す対象が消えた宣言は虚偽である）
#   7. 空振り防止: ワークフロー 0 件・`db/test/*.sh` 0 件・スイートディレクトリ 0 件はいずれも赤
#      （走査の前提が崩れたまま「違反 0 件だから緑」を返さない）
#
# 実行装置側にも 4〜6 と同等の検査がある（あちらは実行時）。二重に見えるが役割が違う。
# **ステップが消されたときに鳴るのはこちらだけである**（実行されない装置は何も報告しない）。
# 本スクリプトは DB も node_modules も要らないので、CI では checkout 直後の grep ガード群に並べる。
#
# 既知の限界:
#   - 3 の発火判定は `on:` 直下の `push` / `pull_request` を行頭インデント付きで探す近似である。
#     YAML を解釈しないので、極端な書き方（フロースタイルの `on: {push: ...}`）は拾えない。
#   - 参照が「実際に走るジョブの中」にあるかまでは見ない。ジョブ単位の `if:` で無効化された場合は
#     検出できない。
#
# 使い方: bash scripts/check-db-test-ci-coverage.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKFLOW_DIR="${ROOT}/.github/workflows"
RUNNER_REL='scripts/run-db-test-suites.sh'
RUNNER="${ROOT}/${RUNNER_REL}"

fail=0
note_fail() {
    fail=1
    echo "ERROR: $1" >&2
}

# --- 1. 実行装置の存在 ----------------------------------------------------------
if [ ! -f "$RUNNER" ]; then
    echo "ERROR: 実行装置がありません: ${RUNNER_REL}（走査の前提が崩れています）。" >&2
    echo "       → db/test のスイートを CI から回す入口が消えています。" >&2
    exit 1
fi

if [ ! -d "$WORKFLOW_DIR" ]; then
    echo "ERROR: ワークフローディレクトリがありません: .github/workflows（走査の前提が崩れています）。" >&2
    exit 1
fi

# --- 2-3. ワークフローからの参照と、その発火条件 ---------------------------------
wf_total=0
ref_total=0
ref_triggered=0
for wf in "${WORKFLOW_DIR}"/*.yml "${WORKFLOW_DIR}"/*.yaml; do
    [ -f "$wf" ] || continue
    wf_total=$((wf_total + 1))

    # 説明文中の言及を配線と数えないよう、行頭 `#` のコメント行は落とす。
    # 終了コードを捕捉し、無一致（exit 1）と評価不能・読めない（exit 2 以上）を分ける（Issue #120）。
    rc=0
    hits="$(grep -F "$RUNNER_REL" "$wf" | grep -vE '^[[:space:]]*#')" || rc=$?
    if [ "$rc" -gt 1 ]; then
        note_fail "${wf#${ROOT}/} を走査できません（grep exit=${rc}）。"
        continue
    fi
    [ -n "$hits" ] || continue
    ref_total=$((ref_total + 1))

    trc=0
    triggers="$(grep -cE '^[[:space:]]+(push|pull_request):?[[:space:]]*$' "$wf")" || trc=$?
    if [ "$trc" -gt 1 ]; then
        note_fail "${wf#${ROOT}/} のトリガを走査できません（grep exit=${trc}）。"
        continue
    fi
    if [ "${triggers:-0}" -gt 0 ]; then
        ref_triggered=$((ref_triggered + 1))
    else
        note_fail "${wf#${ROOT}/} は ${RUNNER_REL} を参照していますが、push / pull_request で発火しません（器に入っていても蓋が閉じています）。"
    fi
done

if [ "$wf_total" -eq 0 ]; then
    echo "ERROR: .github/workflows にワークフローファイルが 1 件もありません（走査の前提が崩れています）。" >&2
    exit 1
fi
if [ "$ref_total" -eq 0 ]; then
    note_fail "${RUNNER_REL} を実行しているワークフローが 1 件もありません（db/test のスイートが CI から外れています）。"
elif [ "$ref_triggered" -eq 0 ]; then
    note_fail "${RUNNER_REL} を参照するワークフローはありますが、どれも push / pull_request で発火しません。"
fi

# --- 4-6. db/test/*.sh の宣言網羅 -----------------------------------------------
# 実行装置の RUN 表 / SKIP 表から宣言済みのファイル名を取り出す。
# `sed` は範囲抽出と置換のみで `q` を持たない（早期終了 consumer を作らない・steering 規律 2）。
table_names() {   # $1 = 配列変数名
    # RUN 行は `'name'`、SKIP 行は `'name|#Issue|理由'`。**`|` を必須にしない。**
    # 必須にすると RUN 表から第 2 列を外した瞬間に抽出が 0 件へ落ち、check_docs.sh が
    # 「未宣言」として誤検出される（PR #159 レビュー指摘 1 の是正で実際に踏んだ）。
    sed -n "/^${1}=(/,/^)/p" "$RUNNER" | sed -n "s/^[[:space:]]*'\([^|']*\).*/\1/p"
}
run_names="$(table_names RUN_SCRIPTS)"
skip_names="$(table_names SKIP_SCRIPTS)"

declared_count=0
for nm in $run_names $skip_names; do
    declared_count=$((declared_count + 1))
done
if [ "$declared_count" -eq 0 ]; then
    note_fail "${RUNNER_REL} の RUN 表 / SKIP 表から宣言を 1 件も抽出できません（表の書式が変わった可能性。走査の前提が崩れています）。"
fi

# **非 ASCII パスの取りこぼしを防ぐため `-c core.quotePath=false` を必ず併用する**（steering 規律 1）。
sh_paths="$(git -C "$ROOT" -c core.quotePath=false ls-files -- 'db/test/*.sh')"
sh_total=0
while IFS= read -r p; do
    [ -n "$p" ] || continue
    sh_total=$((sh_total + 1))
    base="${p##*/}"
    found=0
    for nm in $run_names $skip_names; do
        [ "$nm" = "$base" ] && found=1
    done
    if [ "$found" -eq 0 ]; then
        note_fail "${p} が ${RUNNER_REL} の RUN 表にも SKIP 表にも宣言されていません（置いたのに誰も呼ばない状態です）。"
    fi
done <<EOF
$sh_paths
EOF

if [ "$sh_total" -eq 0 ]; then
    note_fail "db/test/*.sh が 1 件もありません（走査の前提が崩れています）。"
fi

# SKIP 行は Issue 番号を伴い、実体を指していること。
skip_lines="$(sed -n '/^SKIP_SCRIPTS=(/,/^)/p' "$RUNNER" | sed -n "s/^[[:space:]]*'\(.*\)'.*/\1/p")"
skip_total=0
while IFS= read -r line; do
    [ -n "$line" ] || continue
    skip_total=$((skip_total + 1))
    nm="${line%%|*}"
    rest="${line#*|}"
    issue="${rest%%|*}"
    case "$issue" in
        '#'[0-9]*) ;;
        *) note_fail "SKIP 宣言 '${nm}' に Issue 番号がありません（理由と追跡先の無い除外を作らない）。" ;;
    esac
    if [ ! -f "${ROOT}/db/test/${nm}" ]; then
        note_fail "SKIP 宣言の db/test/${nm} が存在しません（指す対象が消えた宣言は虚偽です）。"
    fi
done <<EOF
$skip_lines
EOF

# --- 7. スイートディレクトリの空振り防止 -----------------------------------------
# 実行装置はディレクトリをリテラル列挙せず構造導出するので、ここで見るのは
# 「導出元が空でないこと」だけである（何を実行するかは実行装置の責務）。
suite_sql="$(git -C "$ROOT" -c core.quotePath=false ls-files -- 'db/test/*/*.sql')"
suite_dirs=''
while IFS= read -r p; do
    [ -n "$p" ] || continue
    d="${p%/*}"
    case " ${suite_dirs} " in
        *" ${d} "*) ;;
        *) suite_dirs="${suite_dirs}${d} " ;;
    esac
done <<EOF
$suite_sql
EOF
dir_total=0
for d in $suite_dirs; do
    dir_total=$((dir_total + 1))
done
if [ "$dir_total" -eq 0 ]; then
    note_fail "db/test/ に *.sql を持つスイートディレクトリが 1 件もありません（走査の前提が崩れています）。"
fi

# --- 結果 -----------------------------------------------------------------------
if [ "$fail" -ne 0 ]; then
    echo "NG: db/test の CI カバレッジに違反があります。" >&2
    exit 1
fi
echo "OK: db/test は CI から実行されている（ワークフロー ${wf_total} 件中 ${ref_total} 件が参照 / スイート ${dir_total} ディレクトリ / db/test の shell ${sh_total} 件を宣言済み・うち SKIP ${skip_total} 件）"
