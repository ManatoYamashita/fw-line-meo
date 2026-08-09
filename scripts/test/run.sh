#!/usr/bin/env bash
# Issue #90 ガードレール: scripts/ 配下のガード自身に自己テストが無く、ガードの回帰を
# 誰も検出できなかった。
#
# 背景: これらのガードは実装コードを守るのではなく **「緑が信用できるか」を守る装置** である。
# 装置が壊れたことを検出する手段が無いため、ガードの穴は「次に誰かが手で再現条件を組み立てる
# まで」発見されない。実際 check-test-code-coverage.sh だけで #70 / #78 / #83 / #81 と
# 4 回、事後に穴が見つかっている。
#
# とくに #81 は、653 行を読むだけでは見つからず **実走して初めて** 出た偽緑だった。
# ts/ 直下のコードファイルが 0 件になると check_root_files が早期 return するため、
# tsc が一度も走っていないのにガードが exit 0 を返していた。静的レビューでは届かない。
#
# 設計:
#   1. 各ガードは `ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"` で検証対象を決める。したがって
#      **合成ツリーの scripts/ へガードをコピーすれば**、対象ツリーを丸ごと差し替えられる。
#      5 本すべてがこの形なので、器は 1 つで足りる。
#   2. 赤ケースは exit code だけでなく **期待するエラー文字列まで照合する**。exit code だけを
#      見ると、別の原因で赤くなった実行を「意図どおり検出できた」と誤認する（それはこのハーネス
#      自身の空振りである）。
#   3. 赤ケースには可能な限り **対照（control）** を置く。同じ合成ツリーで条件を 1 つだけ戻すと
#      緑になることを示し、赤の原因が意図した条件であることを担保する。
#   4. ハーネス自身の空振り防止: アサーションを 1 件も実行できなければ exit 1 する。
#      ガードの空振りを検出する装置が空振りしては元の木阿弥である。
#
# 使い方:
#   bash scripts/test/run.sh              # 依存が無いケースは skip して続行
#   bash scripts/test/run.sh --require-full  # skip を失敗として扱う（CI 用）
#
#   read-only（対象は毎回 mktemp の合成ツリー・リポジトリには書き込まない）・bash 3.2 互換。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CASES_DIR="${SCRIPT_DIR}/cases"

REQUIRE_FULL=0
for arg in "$@"; do
  case "$arg" in
    --require-full) REQUIRE_FULL=1 ;;
    *) echo "ERROR: 未知の引数: ${arg}" >&2; exit 1 ;;
  esac
done

# 実 node_modules。check-test-code-coverage.sh は実物の tsc / eslint に問い合わせる設計のため、
# 合成ツリーから symlink で借用する（pnpm install も worktree 汚染も不要）。
REAL_NODE_MODULES="${ROOT}/ts/node_modules"

pass_count=0
fail_count=0
skip_count=0
assert_count=0
case_count=0

CURRENT_CASE=''
CURRENT_FAILED=0
CURRENT_SKIPPED=0
FX=''
OUT=''
RC=0

# --- ケース制御 -------------------------------------------------------------

t_begin() {
  CURRENT_CASE="$1"
  CURRENT_FAILED=0
  CURRENT_SKIPPED=0
  case_count=$((case_count + 1))
  FX="$(mktemp -d "${TMPDIR:-/tmp}/guard-selftest.XXXXXX")"
  mkdir -p "${FX}/scripts"
}

t_end() {
  if [ "$CURRENT_SKIPPED" -eq 1 ]; then
    skip_count=$((skip_count + 1))
  elif [ "$CURRENT_FAILED" -eq 0 ]; then
    pass_count=$((pass_count + 1))
    echo "  PASS  ${CURRENT_CASE}"
  else
    fail_count=$((fail_count + 1))
  fi
  fx_cleanup
  CURRENT_CASE=''
}

t_skip() {
  # skip は必ず理由を出す。黙って飛ばすと「実行したつもりの 0 件」になる。
  CURRENT_SKIPPED=1
  if [ "$REQUIRE_FULL" -eq 1 ]; then
    CURRENT_SKIPPED=0
    _t_fail "skip は --require-full では許容されません: $1"
  else
    echo "  SKIP  ${CURRENT_CASE}  （$1）"
  fi
}

t_skipped() { [ "$CURRENT_SKIPPED" -eq 1 ]; }

_t_fail() {
  CURRENT_FAILED=1
  echo "  FAIL  ${CURRENT_CASE}" >&2
  echo "        $1" >&2
  if [ -n "$OUT" ]; then
    echo "        --- ガードの出力 ---" >&2
    printf '%s\n' "$OUT" | sed 's/^/        /' >&2
  fi
}

# --- fixture 構築 -----------------------------------------------------------

fx_guard() {
  # 検証対象のガードを合成ツリーの scripts/ へ複製する。
  cp "${ROOT}/scripts/$1.sh" "${FX}/scripts/$1.sh"
}

fx_copy() {
  # リポジトリの実ファイルを合成ツリーへ複製する（$1 = リポジトリ相対パス）。
  mkdir -p "${FX}/$(dirname "$1")"
  cp "${ROOT}/$1" "${FX}/$1"
}

fx_write() {
  # 標準入力の内容を合成ツリーの $1 へ書く。
  mkdir -p "${FX}/$(dirname "$1")"
  cat > "${FX}/$1"
}

fx_flood() {
  # 一覧としてだけ嵩むファイルを大量に置く。
  #   $1 = 件数 / $2 = 合成ツリー相対の基点ディレクトリ / $3 = 拡張子（ドット込み） / $4 = 内容
  #
  # 効くのは件数ではなく **一覧のバイト数** である。一覧を「先頭数件だけ出す」ために
  # パイプで consumer を挟むと、上流は buffer 一杯まで書いて止まり、consumer が読み切って
  # 抜けた瞬間に EPIPE を受ける。件数だけ増やしても行が短ければ閾値へ届かない。
  #
  # **余裕は 2 buffer 分では足りない（実測）。** consumer は自身の入力 buffer（64KB）を
  # 一度満たしてから抜けるため、上流は「初回の 64KB」＋「読み出しで空いた 64KB」まで
  # 書き込める。合計が入力量を上回ると上流が先に完走してしまい、同じケースが赤にも緑にも
  # 転ぶ。実測では 87KB で 5 回中 1 回緑になった。1 行 250 バイト前後 × 十分な件数とし、
  # 総量が 128KB を大きく超えるようにしてある。
  fx_flood_dir="${2}/padding-directory-name-to-make-each-listed-path-long-enough"
  fx_flood_dir="${fx_flood_dir}/second-level-padding-segment-that-also-pads-the-path"
  fx_flood_dir="${fx_flood_dir}/third-level-padding-segment-that-also-pads-the-path"
  mkdir -p "${FX}/${fx_flood_dir}"
  fx_flood_i=0
  while [ "$fx_flood_i" -lt "$1" ]; do
    printf '%s\n' "$4" > "${FX}/${fx_flood_dir}/flooded-${fx_flood_i}${3}"
    fx_flood_i=$((fx_flood_i + 1))
  done
}

fx_link_node_modules() {
  # $1 = 合成ツリー相対のリンク先ディレクトリ（例: ts）
  mkdir -p "${FX}/$1"
  ln -s "$REAL_NODE_MODULES" "${FX}/$1/node_modules"
}

fx_has_real_toolchain() {
  [ -x "${REAL_NODE_MODULES}/.bin/tsc" ] && [ -x "${REAL_NODE_MODULES}/.bin/eslint" ]
}

fx_has_node() {
  # node コマンド単体（npm パッケージ不要）。check-markdown-emphasis.sh は Unicode の約物分類を
  # node へ委譲しているため、これが無いと走らない。
  command -v node >/dev/null 2>&1
}

fx_stub_npx_failing_tsc_in() {
  # $1 = cwd のグロブ（例: '*/ts'）。その cwd での tsc 呼び出しだけを失敗させ、
  # それ以外の呼び出し（別ディレクトリの tsc・あらゆる eslint）は実物へ委譲する npx スタブ。
  # 「tsc が動かない」状態を決定論的に再現するために使う（Issue #81 の再現条件と同じ手法）。
  # eslint まで殺すと別の ERROR が混ざり、赤の原因を特定できなくなる。
  real_npx="$(command -v npx)"
  mkdir -p "${FX}/stub"
  {
    echo '#!/usr/bin/env bash'
    echo 'case "$PWD" in'
    echo "  $1)"
    echo '    for a in "$@"; do [ "$a" = "tsc" ] && exit 1; done'
    echo '    ;;'
    echo 'esac'
    echo "exec \"${real_npx}\" \"\$@\""
  } > "${FX}/stub/npx"
  chmod +x "${FX}/stub/npx"
}

fx_cleanup() {
  [ -n "$FX" ] || return 0
  # **symlink を先に外す。** fixture は実 node_modules を symlink で借用しているため、
  # 撤去の実装が将来 `rm -rf` 以外（find -delete や cp -r 経由）へ変わったときに
  # 実体を巻き込む余地を残さない。
  find "$FX" -type l -exec rm -f {} + 2>/dev/null || true
  rm -rf "$FX"
  FX=''
}

# --- git 化 -----------------------------------------------------------------
#
# ガードは走査対象を git 管理下から列挙する（Issue #82）。したがって fixture も git work tree で
# なければならない。`git init` + `git add` だけで済み、commit しないので user.name / user.email の
# 設定は要らない（ネットワークも不要）。
#
# node_modules は除外する。実 node_modules への symlink を追跡させても実害は無いが、
# 実リポジトリでは .gitignore 済みで追跡されない。fixture を実態から乖離させない。
fx_track_now() {
  # ここまでに書いたファイルを追跡させる。**これ以降に書いたファイルは未追跡のまま残る。**
  # 「未追跡は走査されない」ことを検証するケースは、先に本関数を呼んでから壊す。
  [ -n "$FX" ] || return 0
  if [ ! -d "${FX}/.git" ]; then
    (cd "$FX" && git init -q && printf 'node_modules\n' > .git/info/exclude) >/dev/null 2>&1
  fi
  (cd "$FX" && git add -A) >/dev/null 2>&1 || true
}

# --- 実行とアサーション -----------------------------------------------------

fx_run() {
  # $1 = ガード名。$2 が 'stub' なら合成ツリーの stub/ を PATH の先頭へ置く。
  # fixture がまだ git 化されていなければ、ここで全ファイルを追跡させる。
  # 明示的に fx_track_now を呼んだケースでは .git が既に在るため、その後に書いた
  # ファイルは未追跡のまま保たれる。
  [ -d "${FX}/.git" ] || fx_track_now
  OUT=''
  RC=0
  if [ "${2:-}" = 'stub' ]; then
    OUT="$(cd "$FX" && PATH="${FX}/stub:$PATH" bash "scripts/$1.sh" 2>&1)" || RC=$?
  else
    OUT="$(cd "$FX" && bash "scripts/$1.sh" 2>&1)" || RC=$?
  fi
}

expect_green() {
  assert_count=$((assert_count + 1))
  if [ "$RC" -ne 0 ]; then
    _t_fail "緑を期待しましたが exit=${RC} でした。"
    return
  fi
  # exit 0 だけでは足りない。ガードが「OK:」を出さずに 0 で抜ける経路と区別する。
  case "$OUT" in
    *'OK:'*) ;;
    *) _t_fail "exit=0 でしたが 'OK:' 行がありません。" ;;
  esac
}

expect_red() {
  # $1 = 期待するエラー文字列（原因まで照合する。exit code だけでは別原因の赤と区別できない）
  assert_count=$((assert_count + 1))
  if [ "$RC" -eq 0 ]; then
    _t_fail "赤を期待しましたが exit=0 でした。期待した検出: $1"
    return
  fi
  case "$OUT" in
    *"$1"*) ;;
    *) _t_fail "赤にはなりましたが、期待したエラーが出ていません: $1" ;;
  esac
}

expect_absent() {
  # $1 = 出てはいけない文字列（同じ 1 つの原因が 2 種類の指示になる二重報告の検出に使う）
  assert_count=$((assert_count + 1))
  case "$OUT" in
    *"$1"*) _t_fail "出てはいけないメッセージが出ています: $1" ;;
    *) ;;
  esac
}

expect_output_matches() {
  # $1 = 期待する ERE。件数表示など「緑の中身」を照合するために使う。
  assert_count=$((assert_count + 1))
  if ! printf '%s\n' "$OUT" | grep -qE "$1"; then
    _t_fail "出力が期待パターンに一致しません: $1"
  fi
}

# --- 実行 -------------------------------------------------------------------

if [ ! -d "$CASES_DIR" ]; then
  echo "ERROR: ケースディレクトリがありません: ${CASES_DIR#$ROOT/}" >&2
  exit 1
fi

case_files="$(find "$CASES_DIR" -maxdepth 1 -type f -name '*.sh' | sort)"
if [ -z "$case_files" ]; then
  echo "ERROR: ${CASES_DIR#$ROOT/} にケースが 1 件もありません。" >&2
  exit 1
fi

echo "ガード自己テスト（Issue #90）"
while IFS= read -r case_file; do
  [ -n "$case_file" ] || continue
  echo "--- ${case_file#$CASES_DIR/} ---"
  # shellcheck source=/dev/null
  . "$case_file"
done <<EOF
$case_files
EOF

echo
# ハーネス自身の空振り防止。ガードの空振りを検出する装置が空振りしては元の木阿弥である。
if [ "$assert_count" -eq 0 ]; then
  echo "ERROR: アサーションを 1 件も実行できませんでした。ハーネスが空振りしています。" >&2
  exit 1
fi
if [ "$case_count" -eq 0 ]; then
  echo "ERROR: ケースを 1 件も実行できませんでした。ハーネスが空振りしています。" >&2
  exit 1
fi

echo "実行: ${case_count} ケース / ${assert_count} アサーション（PASS ${pass_count} / FAIL ${fail_count} / SKIP ${skip_count}）"

if [ "$fail_count" -ne 0 ]; then
  echo "NG: ガード自己テストに失敗があります（上記参照）。" >&2
  exit 1
fi

echo "OK: ガード自己テスト緑。"
exit 0
