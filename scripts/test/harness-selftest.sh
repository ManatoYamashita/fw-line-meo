#!/usr/bin/env bash
# PR #101 レビュー追補: `scripts/test/run.sh`（ハーネス本体）そのものの自己テスト。
#
# 背景: `cases/` 配下の自己テストは「各ガードが壊れたときに壊れたと言えるか」を検証するが、
# **その検証を集計しているハーネス自身**には自己テストが無く、散文と手作業の再現に頼っていた。
# PR #101 のレビューで、ハーネスが黙って緑を返す経路が実測で 2 本見つかっている。
#
#   1. `expect_output_matches` へ評価できない ERE を渡すと `grep` が exit 2 を返し、標準出力が
#      空になる。`|| true` で握り潰していたため `matched` が空文字のまま `[ "$matched" -eq 0 ]`
#      へ渡り、test 自身が「整数ではない」で status 2 を返す。`if` が偽になるので `_t_fail` へ
#      到達せず、**壊れたアサーションが PASS として素通り**した。健全な実行と出力が完全に一致
#      （`56 ケース / 75 アサーション（PASS 56 / FAIL 0）`）し、痕跡は stderr の 1 行だけだった。
#   2. ケースファイル単位の緑赤照合は `file_ran > 0` を前提にしていたため、ファイルの中身が
#      消えた場合や読み込みに失敗した場合は **0 ケースのまま照合ごと飛び**、exit 0 を返した。
#      これは `check-guard-selftest-coverage.sh` が塞いだ「ファイルの消失」の一段内側であり、
#      ガードは `8/8 ガードにケース` と申告し続ける。
#
# 本スクリプトは mktemp の合成ツリーへ run.sh を複製し、意図的に壊したケースファイルを与えて
# **ハーネスが赤を返すこと**を確認する。対照として、健全なツリー・真の不一致・全 skip の
# ケースファイルでは従来どおりの挙動になることも確認する（skip 許容設計を壊していないことの担保）。
#
# 使い方: bash scripts/test/harness-selftest.sh
#   read-only（対象は毎回 mktemp の合成ツリー・リポジトリには書き込まない）・bash 3.2 互換。
#
# 再帰について: 合成ツリー側の run.sh は `GUARD_HARNESS_INNER=1` 付きで起動する。この印が
# 立っているとき run.sh は本スクリプトを呼ばない（呼ぶと無限に入れ子になる）。印が無い実行では
# run.sh が本ファイルの存在を必須にしているため、ファイルごと消せば赤になる。CI では設定しない。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

HARNESS="${SCRIPT_DIR}/run.sh"
COVERAGE_GUARD="${ROOT}/scripts/check-guard-selftest-coverage.sh"

# 合成ツリーの組み立てに要る部品が欠けたまま「シナリオ 0 件で緑」にならないようにする。
for required in "$HARNESS" "$COVERAGE_GUARD"; do
  if [ ! -f "$required" ]; then
    echo "ERROR: 自己テストの対象がありません: ${required#"$ROOT"/}" >&2
    exit 1
  fi
done

# シナリオを足したら必ずこの数も更新する。取りこぼしを件数で機械検出するための固定値。
EXPECTED_SCENARIOS=7

pass_count=0
fail_count=0
assert_count=0

TREE=''
OUT=''
RC=0

# --- 合成ツリー ---------------------------------------------------------------

tree_new() {
  # 最小の健全なツリー。ガード 1 本と、それに対応するケースファイル 1 件（緑 1 件・赤 1 件）。
  # ケースファイルは run.sh へ source されるため、`OUT` / `RC` を直接置けばガード本体を
  # 用意しなくてもアサーション経路だけを厳密に動かせる。
  TREE="$(mktemp -d "${TMPDIR:-/tmp}/harness-selftest.XXXXXX")"
  mkdir -p "${TREE}/scripts/test/cases"
  cp "$HARNESS" "${TREE}/scripts/test/run.sh"
  cp "$COVERAGE_GUARD" "${TREE}/scripts/check-guard-selftest-coverage.sh"
  # run.sh が起動時に要求するもの（存在しないとケースへ入る前に打ち切られ、ハーネスの
  # 挙動そのものを観測できなくなる）。**中身ではなく存在が要件**なので最小形で置く。
  #   共有 fixture   … 二層化（Issue #90）で tier を跨いでツリー定義を共有するため必須になった
  #   CI の tier 配線 … 全 tier が CI から走ることの検証（片方の tier が消えても残りの緑で通る形の防止）
  cat > "${TREE}/scripts/test/fixtures.sh" <<'EOF'
# shellcheck shell=bash  # 合成ツリー用の空 fixture（run.sh は存在だけを要求する）
EOF
  mkdir -p "${TREE}/.github/workflows"
  cat > "${TREE}/.github/workflows/ts-ci.yml" <<'EOF'
# 合成ツリー用の最小 CI 配線（run.sh の tier 配線検査を満たすためだけのもの）。
jobs:
  lint-build-test:
    steps:
      - run: bash scripts/test/run.sh --tier=a --require-full
      - run: bash scripts/test/run.sh --tier=b --require-full
EOF
  tree_write_primary_case 'OK: synthetic'
}

tree_write_primary_case() {
  # $1 = 緑ケースで `expect_output_matches` へ渡す ERE。
  cat > "${TREE}/scripts/test/cases/70-check-guard-selftest-coverage.sh" <<EOF
t_begin 'synthetic: 緑'
OUT='OK: synthetic'
RC=0
expect_green
expect_output_matches '$1'
t_end

t_begin 'synthetic: 赤'
OUT='ERROR: synthetic'
RC=1
expect_red 'ERROR: synthetic'
t_end
EOF
}

tree_add_case_file() {
  # 2 本目のガードと、その対応ケースファイルを足す。ケースファイルの中身は標準入力から読む。
  # ガード側を足さないと `check-guard-selftest-coverage.sh` が孤児ケースとして先に赤くなり、
  # ハーネス側の検出を観測できない。
  cat > "${TREE}/scripts/check-dummy.sh" <<'EOF'
#!/usr/bin/env bash
echo 'OK: dummy'
exit 0
EOF
  cat > "${TREE}/scripts/test/cases/10-check-dummy.sh"
}

tree_run() {
  # 合成ツリーの run.sh を実行する。$@ = run.sh へ渡す引数。
  OUT=''
  RC=0
  OUT="$(cd "$TREE" && GUARD_HARNESS_INNER=1 bash scripts/test/run.sh "$@" 2>&1)" || RC=$?
}

tree_cleanup() {
  [ -n "$TREE" ] || return 0
  rm -rf "$TREE"
  TREE=''
}

# --- アサーション -------------------------------------------------------------

_fail() {
  fail_count=$((fail_count + 1))
  echo "  FAIL  $1" >&2
  echo "        $2" >&2
  echo "        --- ハーネスの出力 ---" >&2
  printf '%s\n' "$OUT" | sed 's/^/        /' >&2
}

expect_harness_green() {
  # $1 = シナリオ名
  assert_count=$((assert_count + 1))
  if [ "$RC" -ne 0 ]; then
    _fail "$1" "緑を期待しましたが exit=${RC} でした。"
    return
  fi
  case "$OUT" in
    *'OK: ガード自己テスト緑'*)
      pass_count=$((pass_count + 1))
      echo "  PASS  $1"
      ;;
    *) _fail "$1" "exit=0 でしたが 'OK: ガード自己テスト緑' がありません。" ;;
  esac
}

expect_harness_red() {
  # $1 = シナリオ名、$2 = 期待するエラー文字列。exit code だけを見ると、別の原因で赤くなった
  # 実行を「意図どおり検出できた」と誤認する（cases/ 側と同じ規律）。
  assert_count=$((assert_count + 1))
  if [ "$RC" -eq 0 ]; then
    _fail "$1" "赤を期待しましたが exit=0 でした。期待した検出: $2"
    return
  fi
  case "$OUT" in
    *"$2"*)
      pass_count=$((pass_count + 1))
      echo "  PASS  $1"
      ;;
    *) _fail "$1" "赤にはなりましたが、期待したエラーが出ていません: $2" ;;
  esac
}

# --- シナリオ -----------------------------------------------------------------

echo "ハーネス自己テスト（PR #101 レビュー追補）"

# 対照: 健全なツリーは緑。以降の赤が「壊したから赤い」ことの前提になる。
tree_new
tree_run --require-full
expect_harness_green 'ハーネス: 健全な合成ツリーは緑（対照）'
tree_cleanup

# 指摘 1: 評価できない ERE。是正前は PASS 56 / FAIL 0 / exit 0 で素通りしていた。
tree_new
tree_write_primary_case 'OK: synthetic ('
tree_run --require-full
expect_harness_red 'ハーネス: 評価できない ERE を緑にしない（レビュー指摘 1）' 'パターンを評価できません'
tree_cleanup

# 対照: 真の不一致は従来どおり「一致しません」で赤。指摘 1 の是正が、
# 不一致と評価不能を同じ経路へ潰していないことを示す。
tree_new
tree_write_primary_case 'ZZZ-NEVER-MATCHES'
tree_run --require-full
expect_harness_red 'ハーネス: 対照 — 真の不一致は従来どおり赤' '出力が期待パターンに一致しません'
tree_cleanup

# 指摘 2: 中身が消えたケースファイル。ファイル名は残るため対応ガードでは検出できない。
tree_new
tree_add_case_file <<'EOF'
# 中身を消したケースファイル（ファイル名だけが残っている状態）
EOF
tree_run --require-full
expect_harness_red 'ハーネス: 0 ケースのケースファイルを緑にしない（レビュー指摘 2）' 'ケースを 1 件も定義していません'
tree_cleanup

# 指摘 2 の別型その 1: ケースの途中で構文エラーになったファイル。`t_begin` は実行済みのため
# ケース数は 1 以上になり、件数だけでは検出できない（t_end へ到達していないことで検出する）。
tree_new
tree_add_case_file <<'EOF'
t_begin '壊れたケース'
if [ 1 -eq 1 ; then
EOF
tree_run --require-full
expect_harness_red 'ハーネス: 途中で打ち切られたケースファイルを緑にしない' 'が閉じていません'
tree_cleanup

# 指摘 2 の別型その 2: 全ケースが閉じた後で打ち切られたファイル。ケース数も緑赤も揃うため、
# source の終了コードを見ないと「末尾に書かれていた検証が消えた」ことに気づけない。
tree_new
tree_add_case_file <<'EOF'
t_begin 'dummy: 緑'
OUT='OK: dummy'
RC=0
expect_green
t_end

t_begin 'dummy: 赤'
OUT='ERROR: dummy'
RC=1
expect_red 'ERROR: dummy'
t_end

if [ 1 -eq 1 ; then
EOF
tree_run --require-full
expect_harness_red 'ハーネス: 末尾が失われたケースファイルを緑にしない' '読み込みが exit='
tree_cleanup

# 対照: 全 skip のケースファイルは緑のまま。依存が無い環境で skip を許容する設計
# （`--require-full` なしの実行）を、指摘 2 の是正が壊していないことを示す。
tree_new
tree_add_case_file <<'EOF'
t_begin '依存が無いのでスキップする'
t_skip '合成ツリーには依存が無い'
t_end
EOF
tree_run
expect_harness_green 'ハーネス: 対照 — 全 skip のケースファイルは緑（skip 許容の維持）'
tree_cleanup

# --- 集計 ---------------------------------------------------------------------

echo
# 空振り防止: シナリオごと消えたときに「0 件で緑」にならないようにする。
if [ "$assert_count" -ne "$EXPECTED_SCENARIOS" ]; then
  echo "ERROR: シナリオ数が想定と違います（実行 ${assert_count} / 想定 ${EXPECTED_SCENARIOS}）。" >&2
  echo "       シナリオを増減したら EXPECTED_SCENARIOS も更新してください。" >&2
  exit 1
fi

if [ "$fail_count" -ne 0 ]; then
  echo "ハーネス自己テスト: ${assert_count} シナリオ（PASS ${pass_count} / FAIL ${fail_count}）"
  echo "NG: ハーネス自身が壊れたケースファイルを緑にしています（上記参照）。" >&2
  exit 1
fi

echo "OK: ハーネス自己テスト緑（${assert_count} シナリオ・PASS ${pass_count}）。"
exit 0
