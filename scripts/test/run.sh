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
# ---------------------------------------------------------------------------
# 二層構成（Tier A / Tier B）
#
# ケースは検証できる層が二つに分かれる。分けないと、実 node_modules を要する層に引きずられて
# **install 前には一行も検証できない**状態になり、逆に実物を使う層は「設定の実効範囲」という
# スタブでは原理的に届かない領域を失う。
#
#   Tier A  hermetic。実 node_modules を使わない。合成ツリーの npx スタブを **常に** PATH の
#           先頭へ置き、eslint / tsc の応答だけを模擬する。CI では install の前に走らせる。
#           検証できるのは走査範囲・担当分界・件数・**fail-closed 分岐の到達性**。
#   Tier B  実 ts/node_modules を symlink で借用し、本物の tsc / eslint に問い合わせる。
#           tsconfig の include の実効範囲、flat config の ignores の合成、@ts-check /
#           @ts-nocheck、#81 の偽緑 — スタブでは模擬できない層はここでしか検証できない。
#
# 所属は**ファイル名で決まる**。`*.tier-b.sh` が Tier B、それ以外は Tier A。ケース単位の宣言に
# しないのは、宣言を書き忘れた新規ケースが黙って片方の層から消えるのを避けるためである。
#
# 既定が Tier A であることは fail-loud である。Tier A は実 node_modules を**構造的に**使えない
# （スタブが PATH を占有し、fx_link_node_modules は Tier A で失敗する）ため、実物を要する
# ケースを Tier A のファイルへ置くと、開発機でも CI でも決定論的に落ちる。分界は宣言ではなく
# 機械で担保する。
# ---------------------------------------------------------------------------
#
# 使い方:
#   bash scripts/test/run.sh                 # 全 tier。依存が無いケースは skip して続行
#   bash scripts/test/run.sh --tier=a        # Tier A のみ（node_modules 不要）
#   bash scripts/test/run.sh --tier=b        # Tier B のみ
#   bash scripts/test/run.sh --require-full  # skip を失敗として扱う（CI 用）
#
#   read-only（対象は毎回 mktemp の合成ツリー・リポジトリには書き込まない）・bash 3.2 互換。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CASES_DIR="${SCRIPT_DIR}/cases"

REQUIRE_FULL=0
TIER_SELECT='all'
for arg in "$@"; do
  case "$arg" in
    --require-full) REQUIRE_FULL=1 ;;
    --tier=a | --tier=b | --tier=all) TIER_SELECT="${arg#--tier=}" ;;
    --tier=*)
      echo "ERROR: 未知の tier 指定: ${arg}（a / b / all のいずれか）" >&2
      exit 1
      ;;
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
# 実行中のケースファイルの tier（ファイル名から run.sh が決める。ケース側は書き換えない）。
CURRENT_TIER='a'
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
  # Tier A は hermetic にする。ケース側の呼び忘れで実物の npx へ落ちる余地を残さないため、
  # スタブの設置は**ケースの意思に依存させず**ここで必ず行う。
  [ "$CURRENT_TIER" = 'a' ] && fx_stub_toolchain
  return 0
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

fx_guard_mutate() {
  # ガードを複製したうえで **変異（mutation）** を当てる。
  #   $1 = ガード名 / $2 以降 = sed へそのまま渡す引数（-e '式' の形で書く）
  #
  # 用途は「分岐到達性」の検証である。赤ケースを期待エラー文字列まで照合しても、**判別子が
  # 定数化して片側の分岐が実質デッドコードになった**状態は緑のまま残る（PR #92 のレビューで
  # found_subdir_candidates が実際にこの劣化をしていた）。そこへ到達する最小改変が存在すること
  # 自体を assert する型を持つ。
  #
  # **変異が 1 箇所も当たらなければ即失敗させる。** 空振りした変異は無改変のガードを検査する
  # ことになり、「分岐へ到達した」と誤って報告する。それはこのハーネス自身の空振りである。
  fgm_name="$1"
  shift
  fx_guard "$fgm_name"
  fgm_dst="${FX}/scripts/${fgm_name}.sh"
  cp "$fgm_dst" "${fgm_dst}.orig"
  sed "$@" "${fgm_dst}.orig" > "$fgm_dst"
  assert_count=$((assert_count + 1))
  if cmp -s "${fgm_dst}.orig" "$fgm_dst"; then
    _t_fail "変異が 1 箇所も当たりませんでした（sed: $*）。無改変のガードを検査するところでした。"
    rm -f "${fgm_dst}.orig"
    return 1
  fi
  rm -f "${fgm_dst}.orig"
  return 0
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

fx_link_node_modules() {
  # $1 = 合成ツリー相対のリンク先ディレクトリ（例: ts）
  #
  # **Tier A では失敗させる。** これが Tier 分界の機械強制である。実物を要するケースが
  # Tier A のファイルへ紛れ込むと、install 前の CI ステップで初めて落ちる — あるいは
  # node_modules が存在する開発機では黙って通ってしまう。ここで断ち切る。
  if [ "$CURRENT_TIER" = 'a' ]; then
    _t_fail "Tier A のケースが実 node_modules を借用しようとしました。実物を要するケースは *.tier-b.sh へ置いてください。"
    return 1
  fi
  mkdir -p "${FX}/$1"
  ln -s "$REAL_NODE_MODULES" "${FX}/$1/node_modules"
}

fx_has_real_toolchain() {
  [ -x "${REAL_NODE_MODULES}/.bin/tsc" ] && [ -x "${REAL_NODE_MODULES}/.bin/eslint" ]
}

fx_stub_toolchain() {
  # Tier A の hermetic 実行に使う npx スタブを設置する（t_begin が必ず呼ぶ）。
  # ガードが問い合わせる 2 つの応答だけを模擬し、実 node_modules を一切使わない。
  mkdir -p "${FX}/stub"
  cat > "${FX}/stub/npx" <<'STUB'
#!/usr/bin/env bash
# Tier A 専用の npx スタブ。ガードが外部へ問い合わせるのは次の 2 つだけなので、それだけを模擬する。
#   eslint --format json <files>       → 「ignores に消されたか」の判定に使われる JSON
#   tsc -p <cfg> --noEmit --listFiles  → プログラム構成の一覧
#
# 挙動は $STUB_DIR 配下の制御ファイルの有無で決まる。ケース側は fixture を置くだけでよい。
#
# **include / ignores の意味論は模擬しない。** どのファイルがプログラムに入るかは制御ファイルで
# 直接与える。設定文字列の合成結果そのもの（extends・複数 ignores ブロック・@ts-nocheck）を
# 検証するのは Tier B の仕事であり、ここで真似ると「模擬した通りに動いた」だけの緑になる。
set -u

stub_dir="${STUB_DIR:-}"

# 最初の非フラグ引数がツール名。以降は --format / -p の値を読み飛ばしつつ対象ファイルを集める。
tool=''
seen_tool=0
skip_next=0
files=''
for a in "$@"; do
  if [ "$seen_tool" -eq 0 ]; then
    case "$a" in
      -*) continue ;;
      *) tool="$a"; seen_tool=1; continue ;;
    esac
  fi
  if [ "$skip_next" -eq 1 ]; then
    skip_next=0
    continue
  fi
  case "$a" in
    --format | -p | --project) skip_next=1 ;;
    -*) ;;
    # 合成ツリーのパスに空白は入れない前提で語分割へ載せる（bash 3.2 で配列を避けるため）。
    *) files="${files} ${a}" ;;
  esac
done

case "$tool" in
  eslint)
    # 判定結果そのものを返せない状態（eslint を実行できていない）の再現。
    [ -f "${stub_dir}/eslint-blank" ] && exit 0
    # JSON として解釈できない出力の再現（出力形式が変わった状態）。
    if [ -f "${stub_dir}/eslint-garbage" ]; then
      printf 'Oops! Something went wrong.\n'
      exit 0
    fi
    printf '['
    sep=''
    for f in $files; do
      msgs='[]'
      if [ -f "${stub_dir}/eslint-ignored" ]; then
        hits="$(grep -Fxc "$f" "${stub_dir}/eslint-ignored" || true)"
        if [ "${hits:-0}" -ne 0 ]; then
          msgs='[{"ruleId":null,"severity":1,"message":"File ignored because of a matching ignore pattern."}]'
        fi
      fi
      printf '%s{"filePath":"%s/%s","messages":%s}' "$sep" "$PWD" "$f" "$msgs"
      sep=','
    done
    printf ']\n'
    ;;
  tsc)
    if [ -f "${stub_dir}/tsc-blank" ]; then
      # 空ファイル = すべての cwd で空振り。行がある場合はその cwd グロブでだけ空振りさせる。
      if [ ! -s "${stub_dir}/tsc-blank" ]; then
        exit 0
      fi
      while IFS= read -r pat; do
        [ -n "$pat" ] || continue
        case "$PWD" in
          $pat) exit 0 ;;
        esac
      done < "${stub_dir}/tsc-blank"
    fi
    listing="$(find "$PWD" \( -name node_modules -o -name dist -o -name .next \) -prune -o \
      -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' \
         -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o -name '*.cjs' \) -print 2>/dev/null | sort)"
    if [ -f "${stub_dir}/tsc-exclude" ] && [ -s "${stub_dir}/tsc-exclude" ]; then
      printf '%s\n' "$listing" | grep -vFf "${stub_dir}/tsc-exclude" || true
    else
      printf '%s\n' "$listing"
    fi
    ;;
  *)
    # 模擬していない呼び出しは黙って 0 件を返さない。ガードから見れば空振りと同じ観測になり、
    # 「スタブが対応していない」ことが「ガードが壊れた」に化ける。
    echo "npx スタブが対応していないツールです: '${tool}'（Tier A の模擬範囲外）" >&2
    exit 1
    ;;
esac
STUB
  chmod +x "${FX}/stub/npx"
}

# --- Tier A スタブの挙動制御（いずれも fixture へ制御ファイルを置くだけ）-------

fx_stub_eslint_ignored() {
  # $@ = eslint へ渡される形（cwd 相対）のパス。それらを ignores 済みとして返させる。
  printf '%s\n' "$@" >> "${FX}/stub/eslint-ignored"
}

fx_stub_eslint_blank() {
  # eslint の判定結果を取得できない状態にする。
  : > "${FX}/stub/eslint-blank"
}

fx_stub_eslint_garbage() {
  # eslint の出力を JSON として解釈できない状態にする。
  : > "${FX}/stub/eslint-garbage"
}

fx_stub_tsc_exclude() {
  # $@ = 部分一致文字列。一致するパスを tsc のプログラム構成から落とす（include 漏れの再現）。
  printf '%s\n' "$@" >> "${FX}/stub/tsc-exclude"
}

fx_stub_tsc_blank() {
  # 引数なし = すべての cwd で tsc を空振りさせる。引数あり = その cwd グロブでだけ空振りさせる。
  if [ "$#" -eq 0 ]; then
    : > "${FX}/stub/tsc-blank"
  else
    printf '%s\n' "$@" >> "${FX}/stub/tsc-blank"
  fi
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

# --- 実行とアサーション -----------------------------------------------------

fx_run() {
  # $1 = ガード名。$2 が 'stub' なら合成ツリーの stub/ を PATH の先頭へ置く。
  # **Tier A では $2 に関わらず常にスタブ経由で走らせる。** ケース側の指定に委ねると、
  # 書き忘れた 1 件だけが実物の npx を掴み、install 済みの開発機でだけ緑になる。
  OUT=''
  RC=0
  if [ "$CURRENT_TIER" = 'a' ] || [ "${2:-}" = 'stub' ]; then
    OUT="$(cd "$FX" && PATH="${FX}/stub:$PATH" STUB_DIR="${FX}/stub" bash "scripts/$1.sh" 2>&1)" || RC=$?
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

# 合成ツリーの組み立ては tier を跨いで共有する（同じツリーを両層へ書くと片方だけ腐る）。
FIXTURES_FILE="${SCRIPT_DIR}/fixtures.sh"
if [ ! -f "$FIXTURES_FILE" ]; then
  echo "ERROR: 共有 fixture がありません: ${FIXTURES_FILE#$ROOT/}" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$FIXTURES_FILE"

if [ ! -d "$CASES_DIR" ]; then
  echo "ERROR: ケースディレクトリがありません: ${CASES_DIR#$ROOT/}" >&2
  exit 1
fi

all_case_files="$(find "$CASES_DIR" -maxdepth 1 -type f -name '*.sh' | sort)"
if [ -z "$all_case_files" ]; then
  echo "ERROR: ${CASES_DIR#$ROOT/} にケースが 1 件もありません。" >&2
  exit 1
fi

# tier で絞り込む。所属はファイル名（*.tier-b.sh が Tier B）で決まる。
case_files=''
while IFS= read -r case_file; do
  [ -n "$case_file" ] || continue
  case "$case_file" in
    *.tier-b.sh) file_tier='b' ;;
    *) file_tier='a' ;;
  esac
  if [ "$TIER_SELECT" != 'all' ] && [ "$TIER_SELECT" != "$file_tier" ]; then
    continue
  fi
  case_files="${case_files}
${file_tier} ${case_file}"
done <<EOF
$all_case_files
EOF

# **tier ごとの空振り防止。** 全体で 1 本だけ持っていると、`--tier=a` が 1 件も拾えない
# 構成でも「他の tier で走ったから」ではなく単に 0 件のまま緑になる。選択した層が空なら赤にする。
if [ -z "$(printf '%s' "$case_files" | tr -d '[:space:]')" ]; then
  echo "ERROR: tier=${TIER_SELECT} に該当するケースファイルが 1 件もありません。" >&2
  echo "       → 選択した層が空のまま緑を返すのは、この装置自身の空振りです。" >&2
  exit 1
fi

echo "ガード自己テスト（Issue #90）  tier=${TIER_SELECT}"
while IFS=' ' read -r file_tier case_file; do
  [ -n "$case_file" ] || continue
  CURRENT_TIER="$file_tier"
  echo "--- ${case_file#$CASES_DIR/}  [Tier $(printf '%s' "$file_tier" | tr 'ab' 'AB')] ---"
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
