#!/usr/bin/env bash
# Issue #156 実行装置: db/test のスイート（assertions / smoke / docs 整合）を CI から回す。
#
# **これは静的ガードではなく実行装置である。** DB へ接続して SQL を流すので、`scripts/check-*.sh`
# の「すべて read-only」という契約には属さない。名前を `run-*` にしているのはそのためで、
# `scripts/run-external-api-smoke.sh` と同じ系統である。配線が正しいことの静的検証は
# `scripts/check-db-test-ci-coverage.sh` が別に持つ（そちらは DB へ一切繋がない）。
#
# なぜ必要か: `db/test/assertions/*.sql`・`db/test/smoke/*.sql`・`db/test/check_docs.sh` は
# **一度も CI から実行されたことがなかった**（`git log -S 'db/test' -- .github/` が 0 件）。
# この 3 つが担うのは Requirement 5（客の個人情報を一切取得しない・Place 単位の匿名集計のみ）の
# 構造的担保と、Req 9.1/9.4（書込境界の単一所有）である。CI に無い以上、
# 「一言の本文を保存する列を足す migration」も「書込責任層を宣言しない新テーブル」も
# PR を全緑にしたまま main へ入りうる（PR #144 のレビュー中に実測）。
#
# なぜ `db/test/run.sh` を使わないか: run.sh は `$CONTAINER_CMD run -d` で必ずコンテナを起動する
# （`check_docs.sh` が持つ `MANAGE_CONTAINER=0` 相当の口を持たない）。CI は service container の
# postgres へ `DATABASE_URL` で繋ぐので、入口そのものが違う。
#
# なぜワークフローのインライン shell にしないか: `scripts/**/*.sh` は
# `check-grep-exit-codes.sh` と `check-shell-pipe-consumers.sh` の走査対象だが、
# ワークフローの `run:` ブロックは**対象外**である。本リポジトリが最も繰り返し踏んでいる罠
# （`grep -c` の素代入・`|| true` による exit 2 の飲み込み・パイプ下流の早期終了 consumer）を、
# 新しく書く箇所だけ機械強制の外へ置くことになる。合成点が 1 本に集まる利点もある
# （ワークフロー側に 3 行並べると、そのうち 1 行が消えても残り 2 行が緑を返す）。
#
# 実行順の前提: **migrations だけが当たった状態**で呼ばれること。assertions はその前提で
# 書かれている。ts-ci では `apply migrations` の直後・`pnpm -C ts -r test` の直前に置く。
# 逆順にすると TS 統合テストが残した行の上で assertions が走る。現在の assertions は自
# トランザクション内の行しか数えないので当面は通るが、前提が崩れたまま緑になるのは同じ穴である。
# 逆に前へ置くのは安全である: スイートは書き込みを伴う全ファイルが `BEGIN … ROLLBACK` で
# 閉じており、閉じていない 4 件（assertions/0000・assertions/30・smoke/12・smoke/13）は
# information_schema / pg_type / count(*) の参照のみで、後続の DB を汚さない。
#
# **最初の失敗で止めない（集約実行）。** 全ファイルを流し切ってから非ゼロ終了する。1 回の違反注入が
# 複数のスイートを同時に赤にすることを 1 つの run で観察できるようにするためで、これは Issue #156 の
# 完了条件「空振りでないことを対照で示す」の証拠の取りやすさに直結する。
#
# 使い方:
#   CI:       DATABASE_URL=... bash scripts/run-db-test-suites.sh
#   ローカル: ts/scripts/with-test-db.sh bash scripts/run-db-test-suites.sh
#              （docker / apple-container が無い環境向け。native postgres を起動して接続情報を export する）

set -euo pipefail

# glob の展開順を環境の collation に依存させない（適用順＝辞書順が assertions の前提）。
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_DIR="${ROOT}/db/test"

: "${DATABASE_URL:?ERROR: DATABASE_URL が未設定です（CI は job レベル env、ローカルは ts/scripts/with-test-db.sh 経由で渡してください）}"

# --- db/test/*.sh の網羅宣言 ----------------------------------------------------
# ディレクトリ（スイート）は構造的に導出するが、直下のシェルスクリプトは**自動実行できない**。
# `run.sh` のようにコンテナを起動するものが混ざるためで、拾い方を間違えると CI が別のものを
# 起動する。よって 1 本ずつ RUN か SKIP かを宣言し、どちらにも載っていないファイルは赤にする。
# 「db/test へ置いたのに誰も呼ばない」（＝ Issue #156 そのもの）が二度と無言で起きないようにする。
#
# RUN 形式: `<ファイル名>` のみ。**env を表の 1 フィールドとして持たせてはならない。**
# `PSQL_EXEC` の値は空白を含むため語分割で壊れ、「表に書いたが実際には使わない」形になる。
# 宣言と挙動の乖離はこのスクリプト自身が禁じている当のものなので、env は下の case が唯一の
# 情報源とし、表は「呼ぶか呼ばないか」だけを宣言する（PR #159 レビュー指摘 1）。
RUN_SCRIPTS=(
    'check_docs.sh'
)

# SKIP 形式: `<ファイル名>|<Issue>|<理由>`。**理由と追跡先の無い SKIP を作らない。**
# 「調べたうえで外した」と「気づかず落とした」を、リポジトリ上で区別できる形にしておく。
SKIP_SCRIPTS=(
    'run.sh|#156|コンテナランタイムを自前で起動するローカルハーネス。CI は service postgres へ DATABASE_URL で繋ぐので入口が違う'
    'check_no_optional_capabilities.sh|#158|DATABASE_URL だけで走るので CI 化は安いが、Req 1.4/3.10 は本 Issue が扱う Req 5 / Req 9 とは別契約で、独立した対照実験が要る'
    'cross_runtime_integration.sh|#158|actions/setup-go とビルド済み TS を要し、service container ではなく自前の native postgres を起動する。別ジョブとしての設計が要る'
    'cross_runtime_steps.sh|#158|上の内部ステップであり単体の入口ではない'
)

fail=0
sql_total=0
dir_total=0

note_fail() {
    fail=1
    echo "FAIL: $1" >&2
}

# --- 1. スイートディレクトリを構造的に導出して実行 -------------------------------
# **リテラルの列挙を持たない。** `db/test/` 直下のディレクトリはすべてスイートである、を規約とする。
# 列挙を持つと「新しいスイートを足したのに CI から呼ばれない」が再発しうる（Issue #156 の再演）。
# 逆に、実行対象でない SQL を置くディレクトリ（fixtures 等）を作ると誤って実行される。
# これは意図したトレードオフで、上の規約がそれを禁じている。
for suite_dir in "${TEST_DIR}"/*/; do
    [ -d "$suite_dir" ] || continue
    dir_total=$((dir_total + 1))
    suite_name="$(basename "$suite_dir")"

    sql_count=0
    for sql in "${suite_dir}"*.sql; do
        # 無一致のとき glob はリテラルのまま残る。ファイルとして開けないものは数えない
        # （件数 0 は直後で明示的に赤にする。「リテラルを psql へ渡すと落ちる」という
        #  偶然の fail-closed には頼らない）。
        [ -f "$sql" ] || continue
        sql_count=$((sql_count + 1))
        rel="${sql#${ROOT}/}"
        echo ">> [${suite_name}] ${rel}"
        if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$sql"; then
            note_fail "${rel} が非ゼロ終了しました"
        fi
    done

    if [ "$sql_count" -eq 0 ]; then
        note_fail "db/test/${suite_name}/ に *.sql が 1 件もありません（スイートが空のまま緑を返さない）"
    fi
    echo "-- db/test/${suite_name}: ${sql_count} ファイル"
    sql_total=$((sql_total + sql_count))
done

# **空振り防止。** ディレクトリ 0 件は「走査の前提が崩れている」であって「違反 0 件」ではない。
if [ "$dir_total" -eq 0 ]; then
    note_fail "db/test/ にスイートディレクトリが 1 件もありません（走査の前提が崩れています）"
fi

# --- 2. db/test/*.sh の宣言照合と実行 -------------------------------------------
sh_total=0
for sh_path in "${TEST_DIR}"/*.sh; do
    [ -f "$sh_path" ] || continue
    sh_total=$((sh_total + 1))
    sh_name="$(basename "$sh_path")"

    # **空配列を素で展開しない。** bash 3.2（macOS 既定）は `set -u` 下の `"${a[@]}"` を
    # unbound variable として落とす。宣言表が空になるのはこのリポジトリでは常態で、
    # 既存ガード 7 本はいずれも `${a[@]+"${a[@]}"}` の防御形を使っている（PR #159 レビュー指摘 3）。
    declared=0
    should_run=0
    for entry in ${RUN_SCRIPTS[@]+"${RUN_SCRIPTS[@]}"}; do
        if [ "$entry" = "$sh_name" ]; then
            declared=1
            should_run=1
        fi
    done
    for entry in ${SKIP_SCRIPTS[@]+"${SKIP_SCRIPTS[@]}"}; do
        if [ "${entry%%|*}" = "$sh_name" ]; then
            declared=1
            should_run=0
        fi
    done

    if [ "$declared" -eq 0 ]; then
        note_fail "db/test/${sh_name} が RUN にも SKIP にも宣言されていません（scripts/run-db-test-suites.sh の表へ追記してください）"
        continue
    fi
    [ "$should_run" -eq 1 ] || continue

    # RUN するスクリプトごとの env はここが唯一の情報源である。追加時はここへ 1 節足すこと。
    run_env=()
    case "$sh_name" in
        check_docs.sh)
            # 既定のコンテナ起動を止め、CI / with-test-db.sh が用意済みの postgres へ繋がせる。
            run_env=(MANAGE_CONTAINER=0 "PSQL_EXEC=psql ${DATABASE_URL}")
            ;;
    esac

    echo ">> [docs] db/test/${sh_name}"
    if ! env ${run_env[@]+"${run_env[@]}"} bash "$sh_path"; then
        note_fail "db/test/${sh_name} が非ゼロ終了しました"
    fi
done

if [ "$sh_total" -eq 0 ]; then
    note_fail "db/test/ に *.sh が 1 件もありません（走査の前提が崩れています）"
fi

# 宣言だけが残って実体が消えた場合も赤にする。指す対象が消えた宣言は虚偽であり、
# 「SKIP に載っているから安心」という読み手の判断を静かに裏切る。
for entry in ${SKIP_SCRIPTS[@]+"${SKIP_SCRIPTS[@]}"}; do
    skip_name="${entry%%|*}"
    if [ ! -f "${TEST_DIR}/${skip_name}" ]; then
        note_fail "SKIP 宣言の db/test/${skip_name} が存在しません（宣言を消してください）"
    fi
done

# --- 3. 結果 --------------------------------------------------------------------
run_count="${#RUN_SCRIPTS[@]}"
if [ "$fail" -ne 0 ]; then
    echo "NG: db/test スイートに失敗があります（${dir_total} ディレクトリ / ${sql_total} SQL / ${run_count} スクリプト）" >&2
    exit 1
fi
echo "OK: db/test スイート緑（${dir_total} ディレクトリ / ${sql_total} SQL / ${run_count} スクリプト）"
