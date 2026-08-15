#!/usr/bin/env bash
# Issue #117 ガードレール: `set -euo pipefail` の下で、入力を読み切らない consumer を
# パイプの下流へ置くと、上流が EPIPE を受けて 141 で死に、`pipefail` がそれをパイプライン全体の
# 失敗として伝播する。`.kiro/steering/tech.md`「シェルガードの実装規律」の規律 2 を機械強制する。
#
# **この退行は入力サイズ依存であり、コードを読んでも出ない。** 実測（PR #117 の計画時）:
# 上流 `printf`・下流 `grep` の quiet 判定で、多行入力 20,000 行（約 160KB）では 3/3 で 141、
# 2,000 行（約 16KB）では 3/3 で 0。閾値の下では何度走らせても緑なので、書いた本人は踏まない。
#
# 転ぶ向きは呼び出し側の極性で決まる。`if` の条件として使うと `set -e` は中断せず、141 が
# **「無一致」と同義に読まれる**。無一致が ERROR 側なら偽の赤、スキップ側なら偽の緑になる。
# 後者は「ガードが黙って対象を飛ばす」形であり、壊れたことを誰も検出できない。
#
# **単一行の入力では発火しない。** grep は行単位で判定するため、入力が 1 行なら行末まで
# 読まざるを得ず早期終了できない（200KB の 1 行で 3/3 が 0 だった）。したがって「今は転ばない」
# は入力の形という外部条件に依存しており、コードの性質ではない。振る舞いテストで守れるのは
# 多行入力の箇所だけなので、**構文そのものを静的に禁じる**のが本ガードの役割である。
#
# 本スクリプトは以下を機械検証する（read-only の grep 検証・副作用なし・bash 3.2 でも走る）:
#   1. 追跡下の `scripts/**/*.sh` で、パイプの下流に早期終了 consumer を置く行を検出
#      （`head` / `grep` の quiet・max-count 系 / `q` コマンドを持つ `sed`）
#   2. 行頭が `#` の行は対象外。規律そのものを説明する注記がこの構文を含むため、
#      除外しないと本ガードは永久に緑にならない（素朴な走査は 4 件ではなく 5 件を返す）
#   3. 空振り防止: 走査ファイル 0 件・パイプを含む行 0 件はいずれも赤
#      （列挙や走査パターンの前提が崩れたまま「違反 0 件だから緑」を返さない）
#   4. WHITELIST の項目が 1 件も当たらなくなったら WARNING を出す（無意味な除外を残さない）
#
# **`core.quotePath=false` を外してはならない。** 既定（true）の git ls-files は非 ASCII を
# 含むパスを引用符 + 8 進エスケープで返す。行末が `"` になるため拡張子の `$` アンカーに
# 一致せず、そのファイルが列挙から丸ごと消える（規律 1・PR #99 実測）。
#
# 既知の限界:
#   - 対象は `scripts/` のみである（規律 2 のスコープに合わせている）。`Makefile` 等は見ない。
#   - `sed` の検出は `Nq` と `;q` の 2 形に絞ってある。`q` の混入を網羅しようとすると
#     置換文字列の中の `q` まで拾って誤検出が増え、ガードへの信頼が先に壊れるためである。
#   - 変数越しの間接呼び出し（`$CMD | $CONSUMER`）は検出できない。
# 誤検出だと判断した場合は WHITELIST へ `<リポジトリ相対パス>|<行の内容>` 形式で、理由と
# Issue 番号をコメントに添えて登録すること。**行番号で同定してはならない**（PR #113 指摘2）。
# 行番号は上に 1 行挿入されただけでずれ、意図しない別の行の違反を無言で抑止する。
#
# 使い方: bash scripts/check-shell-pipe-consumers.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 意図的に許容する行（必ず理由と Issue を明記すること）。
# 形式: `WHITELIST=('scripts/foo.sh|cmd | head -n 1  # 理由')`。値は前後の空白を除いた行そのもの。
# 現在は空。
WHITELIST=()

# 検出パターン。**リテラルの「パイプ + 早期終了 consumer」を含めない形で組んである。**
# 本ガード自身も走査対象に入るため、素朴に書くと自分を違反として報告して永久に赤くなる。
# いずれも `|` の直後（空白を挟んでよい）に consumer が来ることだけを見る。パイプの終端に
# 限らず途中でも上流は EPIPE を受けるため、位置ではなく「下流にあること」で判定する。
PIPE_LINE_RE='\|'
HEAD_RE='\|[[:space:]]*head([[:space:]]|$)'
GREP_RE='\|[[:space:]]*grep[[:space:]]+(-[[:alpha:]]*[qm][[:alpha:]]*|--quiet|--silent|--max-count)'
SED_RE='\|[[:space:]]*sed[^|]*([0-9]q|;[[:space:]]*q)'

HEAD_MSG='は head をパイプの下流へ置いています。head は入力を読み切らずに抜けるため、上流が EPIPE で 141 になります。'
GREP_MSG='は grep の quiet / max-count 系をパイプの下流へ置いています。最初の一致で抜けるため、上流が EPIPE で 141 になります。'
SED_MSG='は q コマンドを持つ sed をパイプの下流へ置いています。q は入力を読み切らずに抜けるため、上流が EPIPE で 141 になります。'

if ! (cd "$ROOT" && git rev-parse --is-inside-work-tree >/dev/null 2>&1); then
  echo "ERROR: ${ROOT} は git work tree ではありません。" >&2
  echo "       → 本ガードは走査対象を git 管理下から列挙します（規律 1）。" >&2
  echo "         列挙できないまま進むと 0 件のまま緑になるため、ここで打ち切ります。" >&2
  exit 1
fi

in_list() {
  # $1=needle, 残り=list
  needle="$1"
  shift
  for x in "$@"; do
    [ "$x" = "$needle" ] && return 0
  done
  return 1
}

fail=0
file_count=0
pipe_line_count=0
bad_count=0

# 実際に当たった WHITELIST 項目。改行区切りで貯め、最後に「当たらなかった項目」を割り出す。
NL='
'
used_whitelist="$NL"

scan() {
  # $1=リポジトリ相対パス $2=絶対パス $3=検出正規表現 $4=エラー本文
  #
  # **関数だが subshell ではないため** fail / bad_count / used_whitelist は呼び出し側へ残る。
  # ここをパイプへ変えると集計が失われるので注意すること。
  scan_rel="$1"
  scan_path="$2"

  # 違反行を行番号つきで取り出す。無一致の exit 1 と評価不能（exit 2 以上）を分けて扱う。
  # 後置 `|| true` で潰すと、壊れた正規表現が「違反 0 件」に化けて緑で素通りする（規律 2）。
  scan_rc=0
  scan_bad="$(grep -nE "$3" "$scan_path")" || scan_rc=$?
  if [ "$scan_rc" -gt 1 ]; then
    echo "ERROR: 検出パターンを評価できません（grep exit=${scan_rc}）: $3" >&2
    fail=1
    return 0
  fi
  [ -n "$scan_bad" ] || return 0

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    lineno="${line%%:*}"
    content="${line#*:}"

    # 前後の空白を除いた行そのものを WHITELIST のキーにする（行番号は使わない）。
    trimmed="${content#"${content%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"

    # 行頭が `#` のコメント行は対象外。規律や過去の失敗を説明する注記が、まさにこの構文を
    # 引用するため（例: 「この形は SIGPIPE で偽陽性を生む」と書いた注記そのもの）。
    case "$trimmed" in
      '#'*) continue ;;
      # WHITELIST 宣言の行はコマンドではなくデータである。違反行を WHITELIST へ載せると
      # **その行の内容がガード本体のソースへ現れる**ため、除外しないと本ガードは
      # 「除外した違反」を自分の中に見つけて永久に赤くなる（自己テストで実測）。
      # 配列要素が行ごとに並ぶ書き方に備えて、引用符で始まる行も同様に扱う。
      'WHITELIST=('*) continue ;;
      "'"*) continue ;;
    esac

    key="${scan_rel}|${trimmed}"

    # ${arr[@]+...} は空配列でも set -u（bash 3.2 含む）で unbound エラーにしない安全な展開。
    if in_list "$key" ${WHITELIST[@]+"${WHITELIST[@]}"}; then
      echo "SKIP: ${scan_rel}:${lineno}（WHITELIST・理由はスクリプト内コメント参照）"
      used_whitelist="${used_whitelist}${key}${NL}"
      continue
    fi

    bad_count=$((bad_count + 1))
    echo "ERROR: ${scan_rel}:${lineno} $4" >&2
    echo "       | ${content}" >&2
    fail=1
  done <<EOF
$scan_bad
EOF
  return 0
}

# 走査対象の列挙。追跡下の `scripts/` 配下の .sh をすべて見る（pathspec の `*` は `/` も跨ぐ）。
# 自己テスト（scripts/test/）も対象に含める。ガードを検証する側が同じ罠を踏んでよい理由は無い。
targets="$( (cd "$ROOT" && git -c core.quotePath=false ls-files --cached -- 'scripts/*.sh') 2>/dev/null || true)"

while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  path="${ROOT}/${rel}"
  [ -f "$path" ] || continue
  file_count=$((file_count + 1))

  # 空振り防止の母数: コメント行を除いた「パイプを含む行」の数。
  # `grep -c` は入力を最後まで読むので SIGPIPE が起きない。無一致（exit 1）と
  # 評価不能（exit 2 以上）を分ける（本ガードが禁じている形を本ガード自身が踏まないため）。
  pipe_rc=0
  hits="$(grep -vE '^[[:space:]]*#' "$path" | grep -cE "$PIPE_LINE_RE")" || pipe_rc=$?
  if [ "$pipe_rc" -gt 1 ]; then
    echo "ERROR: ${rel} のパイプ行を数えられません（grep exit=${pipe_rc}）。" >&2
    fail=1
  else
    pipe_line_count=$((pipe_line_count + ${hits:-0}))
  fi

  scan "$rel" "$path" "$HEAD_RE" "$HEAD_MSG"
  scan "$rel" "$path" "$GREP_RE" "$GREP_MSG"
  scan "$rel" "$path" "$SED_RE" "$SED_MSG"
done <<EOF
$targets
EOF

# 空振り防止: 対象が 0 件なら「違反 0 件」は「検証していない」と同義である。
if [ "$file_count" -eq 0 ]; then
  echo "ERROR: 追跡下の scripts/**/*.sh が 1 件もありません（列挙の前提が崩れています）。" >&2
  exit 1
fi
if [ "$pipe_line_count" -eq 0 ]; then
  echo "ERROR: パイプを含む行を 1 件も検出できませんでした（走査パターンの前提が崩れています）。" >&2
  exit 1
fi

# 当たらなくなった除外を残さない（check-workflow-step-names.sh と同形）。
# 是正済みの行を除外したままにすると、次に同じ行が壊れたとき無言で見逃す。
for wl in ${WHITELIST[@]+"${WHITELIST[@]}"}; do
  case "$used_whitelist" in
    *"${NL}${wl}${NL}"*) continue ;;
  esac
  echo "WARNING: ${wl} は WHITELIST に載っていますが違反として検出されませんでした。WHITELIST から削除してください。" >&2
done

if [ "$fail" -ne 0 ]; then
  echo "NG: パイプの下流に早期終了 consumer を置く行が ${bad_count} 件あります。" >&2
  echo "    件数判定は grep の count（-c）へ、先頭数件の抽出は q を持たない sed -n '1,Np' へ置き換えてください。" >&2
  echo "    count は無一致で exit 1、評価不能な正規表現で exit 2 を返します。後置 true で潰さず、" >&2
  echo "    scripts/test/run.sh の expect_output_matches と同じく終了コードを捕捉して両者を分けること。" >&2
  exit 1
fi

echo "OK: シェルパイプ consumer ガード緑（${file_count} ファイル / ${pipe_line_count} パイプ行を検証・WHITELIST ${#WHITELIST[@]} 件）。"
exit 0
