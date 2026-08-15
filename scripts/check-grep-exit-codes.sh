#!/usr/bin/env bash
# Issue #120 ガードレール: `grep` の失敗を後置 `true` で潰すと、**無一致（exit 1）と
# 評価不能（exit 2 以上）が同じ結果に化ける**。`.kiro/steering/tech.md`「シェルガードの
# 実装規律」の規律 2 の後半を機械強制する。前半（早期終了 consumer）は
# `scripts/check-shell-pipe-consumers.sh` が見ている。
#
# **壊れ方は「違反 0 件」である。** grep は評価できない ERE に対し exit 2 を返し、そのとき
# 標準出力は空になる。後置 `true` はそれを飲み込むので:
#   - 検出結果を文字列で受ける形（`hits="$(grep ... )"`）では `[ -n "$hits" ]` が偽になり、
#     **「違反なし」と同義**になる。ガードは緑を返す。
#   - 件数で受ける形（`n="$(grep -c ... )"`）では空文字が `${n:-0}` で 0 と読まれ、
#     呼び出し側の極性しだいで偽の赤にも偽の緑にもなる。
#
# 実測（Issue #120 の起票時）:
#   - `check-design-tokens.sh` の `PALETTE_PATTERN` を壊すと、`bg-red-500` の違反を
#     ツリーに置いたまま「生パレット色クラスゼロ」と申告して exit 0。当該行は `2>/dev/null` を
#     伴うため **grep のエラーすら残らず、痕跡が 1 行も無い**。
#   - `check-workflow-step-names.sh` の `TRUNC_LINE_RE` を壊すと、違反を置いたまま
#     「5 ファイル / 42 件の name: を検証」と **件数まで健全な実行と一致**させて exit 0。
#     痕跡は stderr の 1 行だけで、CI ログでは他の出力に埋もれる。
#   - いずれもパターンを壊さなければ同じ違反で exit 1 になる（ガード自体は生きている）。
#
# 空振り防止の後ろ盾があるかどうかで結果が割れるのが厄介な点で、同じファイル内でも
# 守られている行と守られていない行が混在する。行ごとに見るしかないため機械で弾く。
#
# 正しい形は `scripts/test/run.sh` の `expect_output_matches` である。終了コードを捕捉し、
# 無一致（exit 1）と評価不能（exit 2 以上）を分ける:
#
#   rc=0
#   hits="$(printf '%s\n' "$list" | grep -cE "$pat")" || rc=$?
#   if [ "$rc" -gt 1 ]; then ... 評価不能として報告 ... fi
#
# 本スクリプトは以下を機械検証する（read-only の走査・副作用なし・bash 3.2 でも走る）:
#   1. 追跡下の `scripts/**/*.sh` で、`grep` を含む行が後置 `true` で失敗を潰していないこと
#   2. 行頭 `#` のコメント行と `WHITELIST` 宣言は対象外
#      （規律を説明する注記や、除外した違反行の内容そのものがソースへ現れるため）
#   3. 空振り防止: 走査ファイル 0 件・`grep` を含む行 0 件はいずれも赤
#   4. WHITELIST の項目が 1 件も当たらなくなったら WARNING を出す
#
# **`core.quotePath=false` を外してはならない**（規律 1・PR #99 実測）。
#
# 既知の限界:
#   - 対象は `scripts/` のみ（規律 2 のスコープに合わせている）。
#   - `grep` と後置 `true` が**別の行**に分かれた複数行パイプラインは検出できない。
#     現状の 43 箇所はすべて同一行である。
#   - `2>/dev/null` を併用して診断ごと捨てているかまでは見ない。これは棚卸しの対象であり、
#     機械判定にすると正当な用途（存在しないディレクトリの抑止など）と区別できない。
# 誤検出だと判断した場合は WHITELIST へ `<リポジトリ相対パス>|<行の内容>` 形式で、理由と
# Issue 番号をコメントに添えて登録すること。**行番号で同定してはならない**（PR #113 指摘2）。
#
# 使い方: bash scripts/check-grep-exit-codes.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# WHITELIST を宣言しているファイル（= 本スクリプト）のリポジトリ相対パス。
# データ行の除外をこのファイルへ限定するために使う（下の scan 内 case を参照）。
# check-shell-pipe-consumers.sh と同形である（PR #119 で同じ穴を塞いだ）。
SELF_REL="${SCRIPT_DIR}/$(basename "$0")"
SELF_REL="${SELF_REL#$ROOT/}"

# 意図的に許容する行（必ず理由と Issue を明記すること）。
# 形式: `WHITELIST=('scripts/foo.sh|cmd  # 理由')`。値は前後の空白を除いた行そのもの。
# 現在は空。
WHITELIST=()

# 走査に使うトークン。**このファイル自身も走査対象に入る**ため、`grep` を含む行へ
# 失敗を潰す形を書いてはならない。判定は下の case で行い、正規表現には含めない。
GREP_TOKEN_RE='grep'

MSG='は grep の失敗を後置 true で潰しています。無一致（exit 1）と評価不能（exit 2 以上）が同じ結果に化けます。'

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
grep_line_count=0
bad_count=0

NL='
'
used_whitelist="$NL"

scan() {
  # $1=リポジトリ相対パス $2=絶対パス
  #
  # **関数だが subshell ではないため** 集計は呼び出し側へ残る。パイプへ変えると失われる。
  #
  # `grep` を含む行だけを取り出し、後置 true の有無は case で見る。二段目を grep にすると、
  # 検出パターン側の `|` で `[^|]*` が切れて数え落とす（起票時の調査で 43 件を 25 件と
  # 数え違えた実測がある）。文字列一致で確実に拾う。
  scan_rel="$1"
  scan_rc=0
  scan_lines="$(grep -n "$GREP_TOKEN_RE" "$2")" || scan_rc=$?
  if [ "$scan_rc" -gt 1 ]; then
    echo "ERROR: ${scan_rel} を走査できません（grep exit=${scan_rc}）。" >&2
    fail=1
    return 0
  fi
  [ -n "$scan_lines" ] || return 0

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    lineno="${line%%:*}"
    content="${line#*:}"

    trimmed="${content#"${content%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"

    # 行頭が `#` のコメント行は全ファイルで対象外。規律を説明する注記がこの構文を引用するため。
    case "$trimmed" in
      '#'*) continue ;;
    esac

    # WHITELIST 宣言の行と配列要素の引用符行はコマンドではなくデータである。違反行を除外へ
    # 載せるとその内容がガード本体のソースへ現れるため、除外しないと永久に赤くなる。
    #
    # **この除外は WHITELIST を宣言する本ファイルへ限定すること。** 全ファイルへ広げると、
    # 複数行の `awk` / `sed` で残りのコマンドが続く閉じ引用符行に置かれた握り潰しが、
    # ERROR も SKIP も出さずに消える（check-shell-pipe-consumers.sh が PR #119 で踏んだ穴と
    # 同型。本ガードはその是正前のひな型から複製されていた）。対照は 86 番にある。
    if [ "$scan_rel" = "$SELF_REL" ]; then
      case "$trimmed" in
        'WHITELIST=('*) continue ;;
        "'"*) continue ;;
      esac
    fi

    grep_line_count=$((grep_line_count + 1))

    # 後置 true による握り潰しの検出。空白の有無だけを許容する。
    case "$trimmed" in
      *'|| true'*) ;;
      *'||true'*) ;;
      *) continue ;;
    esac

    key="${scan_rel}|${trimmed}"
    if in_list "$key" ${WHITELIST[@]+"${WHITELIST[@]}"}; then
      echo "SKIP: ${scan_rel}:${lineno}（WHITELIST・理由はスクリプト内コメント参照）"
      used_whitelist="${used_whitelist}${key}${NL}"
      continue
    fi

    bad_count=$((bad_count + 1))
    echo "ERROR: ${scan_rel}:${lineno} $MSG" >&2
    echo "       | ${content}" >&2
    fail=1
  done <<EOF
$scan_lines
EOF
  return 0
}

targets="$( (cd "$ROOT" && git -c core.quotePath=false ls-files --cached -- 'scripts/*.sh') 2>/dev/null )"

while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  path="${ROOT}/${rel}"
  [ -f "$path" ] || continue
  file_count=$((file_count + 1))
  scan "$rel" "$path"
done <<EOF
$targets
EOF

# 空振り防止: 対象が 0 件なら「違反 0 件」は「検証していない」と同義である。
if [ "$file_count" -eq 0 ]; then
  echo "ERROR: 追跡下の scripts/**/*.sh が 1 件もありません（列挙の前提が崩れています）。" >&2
  exit 1
fi
if [ "$grep_line_count" -eq 0 ]; then
  echo "ERROR: grep を含む行を 1 件も検出できませんでした（走査パターンの前提が崩れています）。" >&2
  exit 1
fi

for wl in ${WHITELIST[@]+"${WHITELIST[@]}"}; do
  case "$used_whitelist" in
    *"${NL}${wl}${NL}"*) continue ;;
  esac
  echo "WARNING: ${wl} は WHITELIST に載っていますが違反として検出されませんでした。WHITELIST から削除してください。" >&2
done

if [ "$fail" -ne 0 ]; then
  echo "NG: grep の失敗を後置 true で潰す行が ${bad_count} 件あります。" >&2
  echo "    終了コードを捕捉し、無一致（exit 1）と評価不能（exit 2 以上）を分けてください。" >&2
  echo "    正典は scripts/test/run.sh の expect_output_matches です。" >&2
  exit 1
fi

echo "OK: grep 終了コードガード緑（${file_count} ファイル / ${grep_line_count} 件の grep 行を検証・WHITELIST ${#WHITELIST[@]} 件）。"
exit 0
