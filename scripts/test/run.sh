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

# ハーネス起動時の PATH。Tier A ではケース実行中だけスタブを先頭へ差し込み、t_end で必ずここへ戻す。
FX_BASE_PATH="$PATH"

pass_count=0
fail_count=0
skip_count=0
assert_count=0
case_count=0
# 依存不足で飛ばしたケース数。skip_count とは別に持つ理由は t_skip の注記を参照。
dep_skip_count=0

# ケースファイル単位のカバレッジ。Issue #90 の受入条件「各ガードへ緑ケース 1 件 + 赤ケース
# 1 件以上」を機械強制するために使う（散文の約束のままだと、ファイル内でケースが痩せても
# 総アサーション数が 0 にならない限り緑で通る）。source ループの各反復で 0 へ戻す。
#
# `file_cases`（t_begin の回数）と `file_ran`（skip せず完了した回数）を分けて数えるのが要点。
# 緑赤の照合は「実際に走ったケースがある」ファイルにしか課せない（依存が無く全 skip になる
# ファイルへ課すと skip 許容の設計と矛盾する）が、`file_ran` だけを見ると **ケースが 1 件も
# 定義されていないファイル**まで照合の外へ出てしまう。PR #101 のレビューで実測したとおり、
# 中身を消したファイルや source に失敗したファイルは 0 ケースのまま exit 0 で緑になっていた。
file_green=0
file_red=0
file_ran=0
file_cases=0

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
  # 前ケースの出力を持ち越さない。_t_fail は $OUT を「ガードの出力」として添えるため、
  # fx_run より前に失敗したケース（変異の空振り等）へ**無関係な前ケースの出力**が付き、
  # 原因を取り違える材料になる。
  OUT=''
  RC=0
  # skip されたかどうかに関わらず「そのファイルがケースを定義したか」を数える。
  file_cases=$((file_cases + 1))
  FX="$(mktemp -d "${TMPDIR:-/tmp}/guard-selftest.XXXXXX")"
  mkdir -p "${FX}/scripts"
  # Tier A は hermetic にする。ケース側の呼び忘れで実物の npx へ落ちる余地を残さないため、
  # スタブの設置は**ケースの意思に依存させず**ここで必ず行う。
  if [ "$CURRENT_TIER" = 'a' ]; then
    fx_stub_toolchain
    # **PATH の差し込みは runner ではなくここで行う。** runner 側（fx_run）だけに置くと、
    # 引数を取るガード用の fx_run_args / fx_run_stdout や、ケースが自前で持つ runner
    # （60-check-prod-image-drift.sh の pid_run のように環境変数を注入するもの）が、そのまま
    # 実物の npx を掴む。install 済みの開発機でだけ緑になる — fx_run へ hermetic 化を寄せた
    # ときに潰したはずの形が、runner を増やすたびに戻ってくる。プロセスの PATH を替えれば
    # どの runner から起動しても子プロセスへ継承され、書き忘れの余地が構造的に無くなる。
    PATH="${FX}/stub:${FX_BASE_PATH}"
    STUB_DIR="${FX}/stub"
    export STUB_DIR
    # 分界の自己検査。「Tier A は実 node_modules を構造的に使えない」という主張は、
    # **どの runner から起動しても** npx がスタブへ解決されて初めて成立する。ここが崩れた
    # 瞬間に全 Tier A ケースが落ちる形にしておく（assert_count は増やさない。ケースの
    # 検証項目ではなく、ハーネスが満たすべき前提条件であるため）。
    if [ "$(command -v npx || true)" != "${FX}/stub/npx" ]; then
      _t_fail "Tier A なのに npx が合成ツリーのスタブへ解決されていません。PATH の差し込みが壊れています。"
    fi
  fi
  return 0
}

t_end() {
  if [ "$CURRENT_SKIPPED" -eq 1 ]; then
    skip_count=$((skip_count + 1))
  else
    # 非 skip で完了したケースだけをファイル単位カバレッジの母数にする。
    # 依存が無く全ケースが skip されたファイルへ「緑と赤が両方要る」を課すと、
    # skip を許容する設計（--require-full なしの実行）と矛盾するため。
    file_ran=$((file_ran + 1))
    if [ "$CURRENT_FAILED" -eq 0 ]; then
      pass_count=$((pass_count + 1))
      echo "  PASS  ${CURRENT_CASE}"
    else
      fail_count=$((fail_count + 1))
    fi
  fi
  # 差し込んだ PATH は必ず戻す。撤去済みの合成ツリーを次のケースの mktemp / cp が引かないため。
  PATH="$FX_BASE_PATH"
  unset STUB_DIR
  fx_cleanup
  CURRENT_CASE=''
}

t_skip() {
  # skip は必ず理由を出す。黙って飛ばすと「実行したつもりの 0 件」になる。
  #
  # **依存不足の件数は --require-full の有無に関わらず数える。** --require-full は skip を
  # 失敗へ変えるため skip_count が 0 のままになり、末尾の診断が「依存が足りない」と
  # 「ハーネスが空振りしている」を取り違える。しかも取り違えるのは CI と同じ経路の側である。
  dep_skip_count=$((dep_skip_count + 1))
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

fx_has_node() {
  # node コマンド単体（npm パッケージ不要）。check-markdown-emphasis.sh は Unicode の約物分類を
  # node へ委譲しているため、これが無いと走らない。
  command -v node >/dev/null 2>&1
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
  #
  # **Tier B 専用。** これは実物の npx へ委譲するスタブであり、Tier A で使うと t_begin が
  # 置いた hermetic なスタブを上書きして実 node_modules へ手が伸びる。Tier A の空振り再現には
  # fx_stub_tsc_blank を使う。
  if [ "$CURRENT_TIER" = 'a' ]; then
    _t_fail "Tier A で実 npx への委譲スタブが使われました。空振りの再現は fx_stub_tsc_blank を使ってください。"
    return 1
  fi
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
  # $1 = ガード名。$2 が 'stub' なら合成ツリーの stub/ を PATH の先頭へ置く（**Tier B 専用**。
  # fx_stub_npx_failing_tsc_in が置く委譲スタブを掴ませるために使う）。
  # **Tier A では指定は要らない。** t_begin がプロセスの PATH を差し替えており、この runner に
  # 限らずどの経路から起動してもスタブへ解決される。runner ごとの書き忘れが起き得ない形にした。
  OUT=''
  RC=0
  if [ "${2:-}" = 'stub' ]; then
    OUT="$(cd "$FX" && PATH="${FX}/stub:$PATH" STUB_DIR="${FX}/stub" bash "scripts/$1.sh" 2>&1)" || RC=$?
  else
    OUT="$(cd "$FX" && bash "scripts/$1.sh" 2>&1)" || RC=$?
  fi
}

fx_run_args() {
  # $1 = ガード名、以降 = ガードへ渡す引数。出力は fx_run と同じく stdout/stderr を混ぜて OUT へ。
  # 引数を取るガード（check-deploy-image-coverage --print-targets 等）のために用意する。
  # Tier A のスタブは t_begin が差し込んだプロセスの PATH から継承する（ここには書かない）。
  OUT=''
  RC=0
  fx_guard_name="$1"
  shift
  OUT="$(cd "$FX" && bash "scripts/${fx_guard_name}.sh" "$@" 2>&1)" || RC=$?
}

fx_run_stdout() {
  # $1 = ガード名、以降 = 引数。**stdout だけ**を OUT へ入れる（stderr は捨てる）。
  # 「機械可読な出力に人間向けの行が混ざっていないこと」「赤のとき 1 行も出さないこと」を
  # 照合するために使う。PATH の扱いは fx_run_args と同じ（t_begin から継承する）。
  OUT=''
  RC=0
  fx_guard_name="$1"
  shift
  OUT="$(cd "$FX" && bash "scripts/${fx_guard_name}.sh" "$@" 2>/dev/null)" || RC=$?
}

expect_green() {
  assert_count=$((assert_count + 1))
  # 成否ではなく「そのファイルが緑期待を 1 件でも持つか」を数える（カバレッジの形の話）。
  file_green=$((file_green + 1))
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
  file_red=$((file_red + 1))
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

expect_output_empty() {
  # 出力が完全に空であること。「検証が赤なら機械可読な stdout へ 1 行も出さない」のように、
  # *出さないこと* が契約になっている経路を照合するために使う。
  assert_count=$((assert_count + 1))
  if [ -n "$OUT" ]; then
    _t_fail "出力が空であることを期待しましたが、内容があります。"
  fi
}

expect_output_matches() {
  # $1 = 期待する ERE。件数表示など「緑の中身」を照合するために使う。
  #
  # **`grep -q` を使ってはならない。** `grep -q` は最初の一致で即終了するため、`$OUT` が
  # pipe buffer を超えると上流の `printf` が SIGPIPE で 141 を返し、`set -o pipefail` により
  # **マッチしているのにパイプライン全体が失敗**する（偽 FAIL）。`grep -c` は入力を最後まで
  # 読むので SIGPIPE が起きない。
  #
  # **ただし `|| true` で握り潰してもいけない。** `grep` は評価できない ERE に対し exit 2 を
  # 返し、そのとき標準出力は空になる。`|| true` だと `matched` が空文字のまま
  # `[ "$matched" -eq 0 ]` へ渡り、test 自身が「整数ではない」で status 2 を返す。`if` は偽に
  # なるため `_t_fail` へ到達せず、**壊れたパターンのアサーションが PASS として素通りする**
  # （PR #101 のレビューで実測。健全な実行と件数まで一致し、痕跡は stderr の 1 行だけだった）。
  # したがって終了コードを捕捉し、無一致（exit 1）と評価不能（exit 2 以上）を分けて扱う。
  assert_count=$((assert_count + 1))
  grep_rc=0
  matched="$(printf '%s\n' "$OUT" | grep -cE "$1")" || grep_rc=$?
  if [ "$grep_rc" -gt 1 ]; then
    _t_fail "パターンを評価できません（grep exit=${grep_rc}）: $1"
    return
  fi
  if [ "${matched:-0}" -eq 0 ]; then
    _t_fail "出力が期待パターンに一致しません: $1"
  fi
}

# --- 実行 -------------------------------------------------------------------

# ガードとケースファイルの 1:1 対応を、ケースを 1 件も走らせる前に強制する（Issue #90 追補）。
# 下の空振り防止は「アサーション 0 件」でしか発火せず、ケースファイルが 1 つ消えても残りが
# 緑なら OK を返してしまう（PR #93 のレビューで実測: 50-*.sh を外すと 20 ケース緑 exit 0）。
# 照合ロジックは独立したガードへ切り出してある。そうすることで、この harness 自身が
# その照合ガードを（合成ツリー上で）自己テストできる。
COVERAGE_GUARD="${ROOT}/scripts/check-guard-selftest-coverage.sh"
if [ ! -f "$COVERAGE_GUARD" ]; then
  # 照合ガードごと消えたときに、検証が黙って飛ぶことを防ぐ。
  echo "ERROR: 対応検証ガードがありません: scripts/check-guard-selftest-coverage.sh" >&2
  exit 1
fi
bash "$COVERAGE_GUARD" || exit 1

# ハーネス自身の自己テスト（PR #101 レビュー追補）。ケースを 1 件も走らせる前に、
# 「壊れたケースファイルを緑にしない」ことを合成ツリー上で確認する。ガードの自己テストを
# 集計している装置が黙って緑を返しては、下の全ケースの結果が信用できない。
# `GUARD_HARNESS_INNER=1` は合成ツリー側の run.sh へ自己テストを再帰起動させないための印で、
# harness-selftest.sh からのみ設定する（CI では設定しない）。
if [ "${GUARD_HARNESS_INNER:-0}" != '1' ]; then
  HARNESS_SELFTEST="${SCRIPT_DIR}/harness-selftest.sh"
  if [ ! -f "$HARNESS_SELFTEST" ]; then
    # 自己テストごと消えたときに、検証が黙って飛ぶことを防ぐ。
    echo "ERROR: ハーネス自己テストがありません: scripts/test/harness-selftest.sh" >&2
    exit 1
  fi
  bash "$HARNESS_SELFTEST" || exit 1
fi

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

# **CI 配線の空振り防止。** tier を引数で選ぶ設計にしたことで、「全 tier が走る」という保証が
# 装置の外側（ワークフローの引数 2 つ）へ移った。片方のステップの `--tier=b` が `--tier=a` へ
# 書き換われば Tier B は 1 件も走らないが、残った Tier A が緑を返すため CI は通る。ステップを
# 消した場合も同じである。#33（tf のサービスが push 対象に無い）・#51（typecheck が定義されて
# いるのに CI から呼ばれない）と同型で、しかも一段上（ガードを守る装置）で起きる。
# 照合するのは run.sh を実行している行だけで、ステップ名や順序には依存させない。
check_ci_tier_wiring() {
  ctw_yaml="$1"
  if [ ! -f "$ctw_yaml" ]; then
    echo "ERROR: CI ワークフローがありません: ${ctw_yaml#$ROOT/}。" >&2
    echo "       → ガード自己テストの配線を検証できません。" >&2
    return 1
  fi
  # 説明文中の `--tier=b` を配線として数えないよう、コメント行は落とす。
  ctw_lines="$(grep -F 'scripts/test/run.sh' "$ctw_yaml" | grep -vE '^[[:space:]]*#' || true)"
  if [ -z "$ctw_lines" ]; then
    echo "ERROR: ${ctw_yaml#$ROOT/} が scripts/test/run.sh を一度も実行していません。" >&2
    echo "       → ガード自己テストが CI から外れています。" >&2
    return 1
  fi
  ctw_a=0
  ctw_b=0
  while IFS= read -r ctw_line; do
    [ -n "$ctw_line" ] || continue
    # **`--tier=all` は `--tier=a` を部分文字列として含む。all を先に判定すること。**
    # 逆順にすると `--tier=all` の 1 行が「Tier A だけの配線」に化け、Tier B の欠落を見逃す。
    case "$ctw_line" in
      *--tier=all*) ctw_a=1; ctw_b=1 ;;
      *--tier=a*) ctw_a=1 ;;
      *--tier=b*) ctw_b=1 ;;
      *) ctw_a=1; ctw_b=1 ;;
    esac
  done <<EOF
$ctw_lines
EOF
  if [ "$ctw_a" -eq 1 ] && [ "$ctw_b" -eq 1 ]; then
    return 0
  fi
  if [ "$ctw_a" -eq 0 ]; then
    ctw_missing='A'
  else
    ctw_missing='B'
  fi
  echo "ERROR: ${ctw_yaml#$ROOT/} が Tier ${ctw_missing} を実行していません。" >&2
  echo "       → その層が CI から消えても、残った層の緑だけで通ってしまいます。" >&2
  echo "         run.sh の実行行へ --tier=a と --tier=b の両方（または tier 指定なし）を置いてください。" >&2
  return 1
}

check_ci_tier_wiring "${ROOT}/.github/workflows/ts-ci.yml" || exit 1

echo "ガード自己テスト（Issue #90）  tier=${TIER_SELECT}"
while IFS=' ' read -r file_tier case_file; do
  [ -n "$case_file" ] || continue
  CURRENT_TIER="$file_tier"
  echo "--- ${case_file#$CASES_DIR/}  [Tier $(printf '%s' "$file_tier" | tr 'ab' 'AB')] ---"
  file_green=0
  file_red=0
  file_ran=0
  file_cases=0
  source_rc=0
  # shellcheck source=/dev/null
  . "$case_file" || source_rc=$?
  # ファイル単位の健全性を、原因の近い順に 1 つだけ報告する（同じ 1 つの原因で 2 行出さない）。
  # 上 3 つは「そのファイルの検証が丸ごと消えていないか」、最後が Issue #90 の受入条件
  # 「各ガードへ緑ケース 1 件 + 赤ケース 1 件以上」の機械強制。
  file_problem=''
  if [ -n "$CURRENT_CASE" ]; then
    # t_end へ到達しないままファイルが終わった。構文エラーでの打ち切りはここへ落ちる
    # （`t_begin` は実行済みなのでケース数は 1 以上になり、件数だけでは検出できない）。
    file_problem="ケース「${CURRENT_CASE}」が閉じていません（t_end へ到達する前にファイルが終わりました）。"
    fx_cleanup
    CURRENT_CASE=''
  elif [ "$source_rc" -ne 0 ]; then
    # 全ケースが閉じた後で打ち切られた場合。以降に書かれていた検証は黙って消えている。
    file_problem="ケースファイルの読み込みが exit=${source_rc} で終わりました（末尾が失われています）。"
  elif [ "$file_cases" -eq 0 ]; then
    # ファイル名は残るためガード側の 1:1 照合では検出できない（PR #101 レビュー指摘 2）。
    file_problem='ケースを 1 件も定義していません（中身が消えています）。'
  elif [ "$file_ran" -gt 0 ] && { [ "$file_green" -eq 0 ] || [ "$file_red" -eq 0 ]; }; then
    # 片方だけのファイルは「検出できること」か「誤検知しないこと」のどちらかを検証していない。
    file_problem="緑ケースと赤ケースが両方必要です（expect_green=${file_green} / expect_red=${file_red}）。"
  fi
  if [ -n "$file_problem" ]; then
    fail_count=$((fail_count + 1))
    echo "  FAIL  ${case_file#$CASES_DIR/}" >&2
    echo "        ${file_problem}" >&2
  fi
done <<EOF
$case_files
EOF

echo
# ハーネス自身の空振り防止。ガードの空振りを検出する装置が空振りしては元の木阿弥である。
if [ "$assert_count" -eq 0 ]; then
  if [ "$dep_skip_count" -ne 0 ]; then
    # 「依存が無いので飛ばした」と「1 件も検証していない」は別のことである。前者を理由に
    # 後者を緑で返してはならない。CI では --require-full が skip 自体を失敗にする。
    # 判定に使うのは skip_count ではなく dep_skip_count である（--require-full では skip が
    # 失敗へ変わり skip_count が 0 になるため。理由は t_skip の注記を参照）。
    echo "ERROR: ${dep_skip_count} ケースが依存不足で飛ばされ、1 件も検証できていません（tier=${TIER_SELECT}）。" >&2
    echo "       → 依存が足りていません。Tier B は 'pnpm -C ts install' が要ります。" >&2
  else
    echo "ERROR: アサーションを 1 件も実行できませんでした。ハーネスが空振りしています。" >&2
  fi
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
