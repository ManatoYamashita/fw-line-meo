#!/usr/bin/env bash
# Issue #252 ガードレール: 確定店舗を選ぶ読み出し・判定に「停止中でない」の述語が付いていることを
# ファイル単位の件数照合で機械強制する（store-suspension spec・Requirement 4.5）。
#
# 背景: 店舗の利用停止（`stores.suspended_at`）は、確定店舗を選ぶ既存の 11 箇所
# （Go の日次取得・配信ジョブ・LINE の店舗一覧・客向けアンケート・QR 発行・店舗一覧画面）の
# **すべて**に「停止中でない」を足して初めて効く。どれか 1 つを足し忘れると、取得は止まったのに
# 通知は届く、アンケートは閉じたのに QR は発行できる、という片方だけ停止した状態になる。
# 足し忘れを知らせる網は他に無く、新しい読み出しを足したときも同じ穴が開く。
#
# 本スクリプトは以下を機械検証する（read-only の走査・副作用なし・bash 3.2 でも走る）:
#   1. 走査対象は追跡下の `go/**/*.go` と `ts/**/*.{ts,tsx}`。テスト（`_test.go`・`*.test.ts(x)`・
#      `/test/`・`/e2e/`）と生成物（`*.d.ts`・`dist/`・`.next/`・`node_modules/`）を除く
#   2. コメント行（行頭の空白の後に `//`・`/*`・`*`・`--` で始まる行）の判定は数えない。
#      文書コメントが `place_status='confirmed'` を引用しているため（liff-auth.ts の JSDoc 等）
#   3. 確定の判定 A = `place_status = 'confirmed'`・`placeStatus ===/!== 'confirmed'`、
#      停止の判定 B = `suspended_at IS NULL`・`suspendedAt ===/!== null` を行ごとに数え、
#      印の無い A を持つファイルごとに B ≥ 印の無い A を要求する
#   4. 表示だけの判定（利用可否を決めない A）は、同じ行か直前の行の
#      `serviceable-predicate: display-only（理由）` の印で 1 件だけ数えから外せる。
#      理由の無い印・どの A も指さない印・宣言外のファイルの印・宣言数と食い違う印はいずれも赤
#   5. 空振り防止: 走査ファイル 0 件・A の総数（印つきを含む）0 件・走査の評価不能はいずれも赤
#
# **印の宣言をガード本体へ直書きするのは意図的である。** 理由を書けば誰でも印を増やせる形にすると、
# 印が「検査を黙らせる手段」になる。印を増やすには下の 2 つの宣言を書き換える必要があり、
# その差分がレビューに必ず現れる。表現を書き換えて件数を避けることもしてはならない。
#
# 既知の限界:
#   - どのクエリに B が付いたかまでは見ない。ファイル内で件数が足りていれば、B が別の読み出しに
#     付いていても緑になる（research.md で受容した限界。言語間の契約試験が振る舞いで補う）
#   - `place_status <> 'confirmed'` や `IN ('confirmed')` のような別表記の A は数えない。
#     現行ツリーに実在しない。現れたら A の正規表現を広げること
#   - ダブルクォートの `"confirmed"`（TS の `=== "confirmed"`・Go の `== "confirmed"`）と、
#     行をまたいで書いた `place_status\n= 'confirmed'` も A として数えない。現行ツリーは
#     単一引用符・1 行の形だけである
#   - 除外するのは行頭のコメント行だけで、コード行の末尾コメントにある B は数えてしまう
#     （`... 'confirmed'`; // suspended_at IS NULL` は緑になる）
#
# 使い方: bash scripts/check-store-serviceable-predicate.sh
#   食い違いがあれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- 表示だけの判定の除外印の宣言（書き換えるとレビューに差分が出る） -----------------
# 印の総数。店舗一覧の「確定済み／未確定」の表示だけが該当する（design.md PredicateGuard）。
EXPECTED_DISPLAY_ONLY_MARKERS=1
# 印を置いてよいファイル（リポジトリ相対パス）。
DISPLAY_ONLY_MARKER_FILES=('ts/apps/dashboard-web/src/app/stores/page.tsx')

if ! (cd "$ROOT" && git rev-parse --is-inside-work-tree >/dev/null 2>&1); then
  echo "ERROR: ${ROOT} は git work tree ではありません。" >&2
  echo "       → 本ガードは走査対象を git 管理下から列挙します。列挙できないまま進むと 0 件のまま" >&2
  echo "         緑になるため、ここで打ち切ります。" >&2
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

# --- 走査対象の列挙 ----------------------------------------------------------------
# pathspec は引用符で囲み、シェルに glob を先食いさせない。git の pathspec の `*` は `/` も
# またぐので、`go/*.go` で go/ 配下の全階層が対象になる。
ls_rc=0
listing="$(cd "$ROOT" && git -c core.quotePath=false ls-files -- 'go/*.go' 'ts/*.ts' 'ts/*.tsx')" || ls_rc=$?
if [ "$ls_rc" -ne 0 ]; then
  echo "ERROR: 走査対象を列挙できません（git ls-files exit=${ls_rc}）。" >&2
  exit 1
fi

files=()
empty_count=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    # テスト
    *_test.go | *.test.ts | *.test.tsx | */test/* | */e2e/*) continue ;;
    # 生成物
    *.d.ts | */dist/* | */.next/* | */node_modules/*) continue ;;
  esac
  if [ ! -f "${ROOT}/${f}" ]; then
    # 追跡下なのに読めないファイルを黙って飛ばすと、射程が静かに痩せる。
    echo "ERROR: 走査を評価できません（追跡下のファイルが読めません: ${f}）。" >&2
    exit 1
  fi
  if [ ! -s "${ROOT}/${f}" ]; then
    # 空のファイルは判定を持ち得ない。awk は 0 行のファイルで FNR==1 を通らず、下の
    # ファイル数の照合を食い違わせるため、ここで数えるだけにする。
    empty_count=$((empty_count + 1))
    continue
  fi
  files+=("$f")
done <<EOF
${listing}
EOF

if [ "${#files[@]}" -eq 0 ]; then
  echo "ERROR: 走査対象のファイルが 1 件もありません（go/ と ts/ の本番コードを列挙できていません）。" >&2
  exit 1
fi

# --- 件数の抽出 --------------------------------------------------------------------
# 1 回の awk で全ファイルを読む。出力は次の 2 種類の TSV 行である（列はいずれも空にならない）:
#   FILE    <path> <A の総数> <印で外した A の数> <B の数>
#   MARKER  <path> <行番号> <valid | noreason | orphan>
# 印の対応づけ: 印はまず同じ行の A を 1 件指し、同じ行に A が無ければ次の行の A を指す。
# 次の行にも A が無ければ orphan（どの判定も指していない）として報告する。
# LC_ALL=C で読むのは、全角の括弧をバイト列として index() で探すためである（ロケールで
# 文字の区切りが変わると macOS と CI で結果が割れる）。
AWK_PROG="$(cat <<'AWK'
function count(s, re,    t) { t = s; return gsub(re, "", t) }
function flush(    k) {
  if (cur == "") return
  for (k = 0; k < pending; k++) print "MARKER\t" cur "\t" pendline "\torphan"
  print "FILE\t" cur "\t" a "\t" am "\t" b
}
BEGIN {
  reA1 = "place_status[[:space:]]*=[[:space:]]*" q "confirmed" q
  reA2 = "placeStatus[[:space:]]*[!=]==[[:space:]]*" q "confirmed" q
  reB1 = "suspended_at[[:space:]]+[Ii][Ss][[:space:]]+[Nn][Uu][Ll][Ll]"
  reB2 = "suspendedAt[[:space:]]*[!=]==[[:space:]]*null"
  reM = "serviceable-predicate:[[:space:]]*display-only"
  reComment = "^[[:space:]]*(//|/[*]|[*]|--)"
  cur = ""
}
FNR == 1 { flush(); cur = FILENAME; a = 0; am = 0; b = 0; pending = 0; pendline = 0 }
{
  line = $0
  ac = 0; bc = 0
  if (line !~ reComment) {
    ac = count(line, reA1) + count(line, reA2)
    bc = count(line, reB1) + count(line, reB2)
  }
  a += ac; b += bc

  # 印の抽出（コメントの中に書くのが普通なので、コメント行も見る）。
  valid = 0
  rest = line
  while (match(rest, reM)) {
    rest = substr(rest, RSTART + RLENGTH)
    tail = rest
    sub(/^[[:space:]]+/, "", tail)
    closer = ""
    if (index(tail, "（") == 1) { closer = "）"; inner = substr(tail, length("（") + 1) }
    else if (substr(tail, 1, 1) == "(") { closer = ")"; inner = substr(tail, 2) }
    reason = ""
    if (closer != "") {
      ci = index(inner, closer)
      if (ci > 0) reason = substr(inner, 1, ci - 1)
    }
    gsub(/[[:space:]]/, "", reason)
    if (reason == "") { print "MARKER\t" cur "\t" FNR "\tnoreason" }
    else { print "MARKER\t" cur "\t" FNR "\tvalid"; valid++ }
  }

  # 直前の行の印が先にこの行の A を指し、残りを同じ行の印が指す。
  use = (pending < ac) ? pending : ac
  am += use
  left = ac - use
  for (k = use; k < pending; k++) print "MARKER\t" cur "\t" pendline "\torphan"
  use2 = (valid < left) ? valid : left
  am += use2
  pending = valid - use2
  pendline = FNR
}
END { flush() }
AWK
)"

awk_rc=0
awk_out="$(cd "$ROOT" && LC_ALL=C awk -v q="'" "$AWK_PROG" "${files[@]}")" || awk_rc=$?
if [ "$awk_rc" -ne 0 ]; then
  echo "ERROR: 走査を評価できません（awk exit=${awk_rc}）。読めないファイルがあるか、抽出が壊れています。" >&2
  exit 1
fi

# --- 判定 --------------------------------------------------------------------------
fail=0
file_count=0
total_a=0
total_marked=0
total_b=0
checked_files=0
marker_total=0
short_report=''
noreason_report=''
orphan_report=''
undeclared_report=''
summary=''

NL='
'

while IFS="$(printf '\t')" read -r kind p c1 c2 c3; do
  [ -n "$kind" ] || continue
  case "$kind" in
    FILE)
      file_count=$((file_count + 1))
      total_a=$((total_a + c1))
      total_marked=$((total_marked + c2))
      total_b=$((total_b + c3))
      unmarked=$((c1 - c2))
      if [ "$c1" -gt 0 ] || [ "$c3" -gt 0 ]; then
        summary="${summary}  ${p}: 確定の判定 ${c1}（印 ${c2}）/ 停止の判定 ${c3}${NL}"
      fi
      if [ "$unmarked" -gt 0 ]; then
        checked_files=$((checked_files + 1))
        if [ "$c3" -lt "$unmarked" ]; then
          short_report="${short_report}  ${p}: 印の無い確定の判定 ${unmarked} 件に対し、停止の判定 ${c3} 件${NL}"
        fi
      fi
      ;;
    MARKER)
      case "$c2" in
        orphan)
          orphan_report="${orphan_report}  ${p}:${c1}${NL}"
          continue
          ;;
        noreason)
          noreason_report="${noreason_report}  ${p}:${c1}${NL}"
          ;;
      esac
      marker_total=$((marker_total + 1))
      if ! in_list "$p" "${DISPLAY_ONLY_MARKER_FILES[@]}"; then
        undeclared_report="${undeclared_report}  ${p}:${c1}${NL}"
      fi
      ;;
    *)
      echo "ERROR: 走査の出力を解釈できません: ${kind}" >&2
      exit 1
      ;;
  esac
done <<EOF
${awk_out}
EOF

# 列挙したファイル数と、抽出が返したファイル数の照合。食い違えば抽出が一部を読み落としている。
if [ "$file_count" -ne "${#files[@]}" ]; then
  echo "ERROR: 走査を評価できません（列挙 ${#files[@]} ファイルに対し、抽出の結果は ${file_count} ファイル）。" >&2
  exit 1
fi

echo "ファイルごとの件数（確定の判定・停止の判定のどちらかを持つファイル）:"
printf '%s' "$summary"

if [ "$total_a" -eq 0 ]; then
  echo "ERROR: 確定の判定が 1 件も見つかりません（走査 ${file_count} ファイル）。" >&2
  echo "  → 走査の射程か抽出の正規表現が壊れています。確定の判定を表記ごと変えたなら、" >&2
  echo "    このガードの正規表現も合わせて変えてください。" >&2
  fail=1
fi

if [ -n "$short_report" ]; then
  echo "ERROR: 停止の判定が足りないファイルがあります（確定の判定に「停止中でない」が付いていません）:" >&2
  printf '%s' "$short_report" >&2
  echo "  → 確定店舗を選ぶ読み出し・判定には \`suspended_at IS NULL\`（SQL）か" >&2
  echo "    \`suspendedAt === null\` / \`!== null\`（TS）を必ず添えてください（Requirement 4.5）。" >&2
  echo "    利用可否を決めない表示だけの判定なら、宣言済みの除外印の対象かを確かめてください。" >&2
  fail=1
fi

if [ -n "$noreason_report" ]; then
  echo "ERROR: 理由の無い display-only の印があります:" >&2
  printf '%s' "$noreason_report" >&2
  echo "  → \`serviceable-predicate: display-only（理由）\` の形で、利用可否を決めない理由を書いてください。" >&2
  fail=1
fi

if [ -n "$orphan_report" ]; then
  echo "ERROR: 確定の判定を指していない display-only の印があります（同じ行にも次の行にも判定がありません）:" >&2
  printf '%s' "$orphan_report" >&2
  fail=1
fi

if [ -n "$undeclared_report" ]; then
  echo "ERROR: 宣言外のファイルに display-only の印があります:" >&2
  printf '%s' "$undeclared_report" >&2
  echo "  → 印を置いてよいファイルは DISPLAY_ONLY_MARKER_FILES の宣言だけです。" >&2
  fail=1
fi

if [ "$marker_total" -ne "$EXPECTED_DISPLAY_ONLY_MARKERS" ]; then
  echo "ERROR: display-only の印の数が宣言と食い違っています（宣言 ${EXPECTED_DISPLAY_ONLY_MARKERS} 件・実際 ${marker_total} 件）。" >&2
  echo "  → 印を増減するなら、ガード本体の EXPECTED_DISPLAY_ONLY_MARKERS を書き換えてレビューを通してください。" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "OK: 確定の判定 ${total_a} 件（うち display-only の印 ${total_marked} 件）/ 停止の判定 ${total_b} 件 / 走査 ${file_count} ファイル（空のファイル ${empty_count} 件を除く）— 印の無い確定の判定を持つ ${checked_files} ファイルすべてで停止の判定が足りています。"
