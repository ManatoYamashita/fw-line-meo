#!/usr/bin/env bash
# ui-design-foundation ガードレール（Requirements 1.4 / 4.4）: 色は必ずデザイントークン
# （ts/packages/design-tokens）を単一情報源とする。アプリ層や UI コンポーネントに hex を
# 直書きすると、Web と LINE で同じ意味役割の色が枝分かれし、トークン変更が全面に届かなくなる
# （本 spec 以前の実態: messages.ts / flex.ts に 15 箇所の直書き色が散在していた）。
# 本スクリプトはその再混入を CI で機械検出する（read-only の grep 検証・副作用なし・bash 3.2 互換）。
#
# 検証内容:
#   1a. 直書き hex の検出: ts/apps/** と ts/packages/ui/src/components/** に hex 色リテラルが
#       無いこと（許可箇所は下記 ALLOWED のみ = トークン定義と theme.css）
#   1b. 生パレット色クラスの検出: ts/apps/** と ts/packages/ui/src/** に Tailwind 既定パレットの
#       色クラス（bg-red-500 / text-blue-700 等）が無いこと。これらは hex を含まないため 1a を
#       すり抜けるが、Tailwind が実色へコンパイルするため直書き色と等価にトークン運用を壊す
#       （design.md「@fwlm/ui — components」が明示的に禁止している対象）
#   2. theme.css の同値照合: theme.css の全 hex が design-tokens の値集合に含まれること
#      （手動同期を機械検証で固める設計・codegen は持たない）
#
# 使い方: bash scripts/check-design-tokens.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TOKENS_DIR="${ROOT}/ts/packages/design-tokens/src"
THEME_CSS="${ROOT}/ts/packages/ui/src/theme.css"
APPS_DIR="${ROOT}/ts/apps"
UI_SRC_DIR="${ROOT}/ts/packages/ui/src"
UI_COMPONENTS_DIR="${UI_SRC_DIR}/components"

# hex 色リテラル（3〜8 桁。8 桁は shadow のアルファ付き #0000000D 等）。
HEX_PATTERN='#[0-9a-fA-F]{3,8}'

# Issue / PR 参照は色ではない。Issue 番号が 3 桁に達した時点で hex の 3 桁短縮形（#RGB）と
# 表記が完全に衝突する（`#132` は #112233 と同形）。実際、Issue 132 の作業で追加した
# `（Issue 132）` 形式のコメントが「直書き色」として検出され CI が赤になった。
#
# 除外するのは **種別を前置した参照だけ** に限る。裸の `#132` まで除外すると `#000` のような
# 数字のみのグレー階調と原理的に区別がつかず、本物の直書き色を見逃す側に倒れるため。
# つまりこの除外は「Issue 参照は Issue / PR を前置して書く」という規約とセットで成立している。
# 前置なしで書きたい場合は色と紛れない表記（`Issue 132` など）を使うこと。
ISSUE_REF_PATTERN='(Issue|PR|issue|pr) #[0-9]+'

# Tailwind 既定パレットの色クラス（bg-red-500 / text-blue-700 / border-gray-200 等）。
# @theme でトークンを定義しても Tailwind の既定パレットは無効化されないため、これらのクラスは
# そのまま実色へコンパイルされる（＝トークンを迂回した色指定になる）。
# 単語境界に \b を使わないのは BSD grep（macOS の既定 grep）が \b を解釈しないため。
# 代わりにクラス名に現れない文字（英数字・ハイフン・アンダースコア以外）で前後を挟んで判定する。
PALETTE_PATTERN='(^|[^a-zA-Z0-9_-])(bg|text|border|ring|outline|fill|stroke)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}([^0-9]|$)'

# 走査対象の拡張子と、除外する生成物・テスト資産
# （スナップショットは現行描画の記録であり定義ではないため対象外）。
GREP_FILTERS=(
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.css'
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist
  --exclude-dir=test --exclude-dir=e2e --exclude-dir=__snapshots__
  --exclude='*.test.*'
)

for f in "$TOKENS_DIR" "$THEME_CSS"; do
  if [ ! -e "$f" ]; then
    echo "ERROR: 検証対象が見つかりません: ${f#$ROOT/}" >&2
    exit 1
  fi
done

fail=0

# --- 検証1a: アプリ層・UI コンポーネント層への直書き hex の混入検出 ---
# theme.css は hex の許可箇所（design-tokens と同値であることは検証2 が保証する）のため対象外。
scan_targets=()
[ -d "$APPS_DIR" ] && scan_targets+=("$APPS_DIR")
[ -d "$UI_COMPONENTS_DIR" ] && scan_targets+=("$UI_COMPONENTS_DIR")

# 空振り防止: 走査対象が 1 つも無ければ「違反 0 件」は「検証していない」と同義である。
if [ "${#scan_targets[@]}" -eq 0 ]; then
  echo "ERROR: 直書き hex の走査対象がありません（ts/apps も ts/packages/ui/src/components も不在）。" >&2
  exit 1
fi

# **`2>/dev/null` を付けてはならない（Issue #120）。** 付けると評価できない ERE に対する
# grep のエラーごと捨てるため、痕跡が 1 行も残らないまま「違反 0 件」で緑になる。
# 実測: PALETTE_PATTERN を壊すと bg-red-500 の違反を置いたままガードが exit 0 を返した。
# 対象ディレクトリの不在は上で弾いてあるので、ここで出る stderr は本物の異常である。
hits_rc=0
raw_hits="$(grep -rnE "$HEX_PATTERN" "${scan_targets[@]}" "${GREP_FILTERS[@]}")" || hits_rc=$?
if [ "$hits_rc" -gt 1 ]; then
  echo "ERROR: 直書き hex の検出パターンを評価できません（grep exit=${hits_rc}）: ${HEX_PATTERN}" >&2
  exit 1
fi

# Issue / PR 参照を打ち消したうえで、なお hex が残る行だけを違反とする。
# 打ち消しは行内の該当箇所だけを潰すので、同じ行に本物の直書き色があればそれは残る。
#
# sed と grep を 1 本のパイプに繋いではならない。grep の exit 1（無一致＝違反なし）と
# sed の失敗（パターン評価不能）が pipefail 下で同じ 1 に潰れ、**壊れた ISSUE_REF_PATTERN が
# 「違反 0 件」に化ける**（Issue 120 と同型の偽緑）。段を分けてそれぞれの失敗を別に扱う。
hits=""
if [ -n "$raw_hits" ]; then
  strip_rc=0
  stripped="$(printf '%s\n' "$raw_hits" | sed -E "s/${ISSUE_REF_PATTERN}/\1 ref/g")" || strip_rc=$?
  if [ "$strip_rc" -ne 0 ]; then
    echo "ERROR: Issue 参照の打ち消しを評価できません（sed exit=${strip_rc}）: ${ISSUE_REF_PATTERN}" >&2
    exit 1
  fi

  filter_rc=0
  hits="$(printf '%s\n' "$stripped" | grep -E "$HEX_PATTERN")" || filter_rc=$?
  # exit 1 は「Issue 参照だけだった＝違反なし」で正常。2 以上はパターン評価の失敗である。
  if [ "$filter_rc" -gt 1 ]; then
    echo "ERROR: Issue 参照を除いた後の hex 判定を評価できません（grep exit=${filter_rc}）: ${HEX_PATTERN}" >&2
    exit 1
  fi
fi

if [ -n "$hits" ]; then
  echo "ERROR: デザイントークンを経由しない直書きの色指定が検出されました:" >&2
  printf '%s\n' "$hits" | sed "s|^${ROOT}/||" >&2
  echo "       → 色は ts/packages/design-tokens に意味役割で定義し、そこから参照してください。" >&2
  echo "         Web は theme.css 由来の意味論クラス（bg-primary 等）、LINE Flex は lineColors.* を使います。" >&2
  fail=1
fi

# --- 検証1b: 生パレット色クラス（bg-red-500 等）の混入検出 ---
# hex を含まないため検証1a では捕まらないが、Tailwind が実色へコンパイルするため
# トークンを迂回した色指定になる。theme.css を含む UI パッケージの src 全体を走査対象にする
# （パレット色クラスはトークン定義側にも現れてはならないため hex のような許可箇所を持たない）。
palette_targets=()
[ -d "$APPS_DIR" ] && palette_targets+=("$APPS_DIR")
[ -d "$UI_SRC_DIR" ] && palette_targets+=("$UI_SRC_DIR")

if [ "${#palette_targets[@]}" -eq 0 ]; then
  echo "ERROR: 生パレット色クラスの走査対象がありません（ts/apps も ts/packages/ui/src も不在）。" >&2
  exit 1
fi

# ここが実測で偽 PASS を出した箇所である（Issue #120）。`2>/dev/null` と後置 true の併用で、
# 壊れたパターンが痕跡ゼロのまま「生パレット色クラスゼロ」に化けていた。
palette_rc=0
palette_hits="$(grep -rnE "$PALETTE_PATTERN" "${palette_targets[@]}" "${GREP_FILTERS[@]}")" || palette_rc=$?
if [ "$palette_rc" -gt 1 ]; then
  echo "ERROR: 生パレット色クラスの検出パターンを評価できません（grep exit=${palette_rc}）: ${PALETTE_PATTERN}" >&2
  exit 1
fi

if [ -n "$palette_hits" ]; then
  echo "ERROR: Tailwind 既定パレットの生色クラス（bg-red-500 等）が検出されました:" >&2
  printf '%s\n' "$palette_hits" | sed "s|^${ROOT}/||" >&2
  echo "       → 生パレット色は意味役割を持たないため、面ごとに配色が枝分かれします。" >&2
  echo "         theme.css 由来の意味論クラス（bg-primary / text-muted-foreground / border-border 等）を使い、" >&2
  echo "         必要な役割が無い場合は ts/packages/design-tokens へ役割ごと追加してください。" >&2
  fail=1
fi

# --- 検証2: theme.css の hex が design-tokens の値集合に含まれること ---
# 終了コードを捕捉し、無一致（exit 1）と評価不能（exit 2 以上）を分ける（Issue #120）。
# 潰すと、抽出が壊れた状態が「色が 1 件も無い」と同義になる。theme 側は下の theme_count で、
# token 側は直後の空振り防止で赤へ倒れるが、それは偶然の後ろ盾であって設計ではない。
theme_hexes_rc=0
theme_hexes="$(grep -oE "$HEX_PATTERN" "$THEME_CSS" | tr '[:lower:]' '[:upper:]' | sort -u)" || theme_hexes_rc=$?
token_hexes_rc=0
token_hexes="$(grep -rhoE "$HEX_PATTERN" "$TOKENS_DIR" | tr '[:lower:]' '[:upper:]' | sort -u)" || token_hexes_rc=$?
if [ "$theme_hexes_rc" -gt 1 ] || [ "$token_hexes_rc" -gt 1 ]; then
  echo "ERROR: hex の抽出パターンを評価できません（grep exit=${theme_hexes_rc}/${token_hexes_rc}）: ${HEX_PATTERN}" >&2
  exit 1
fi

if [ -z "$token_hexes" ]; then
  echo "ERROR: ${TOKENS_DIR#$ROOT/} から色定義を 1 件も抽出できませんでした（抽出前提が崩れています）。" >&2
  exit 1
fi

theme_count=0
while IFS= read -r hex; do
  [ -n "$hex" ] || continue
  theme_count=$((theme_count + 1))
  # 件数で判定する（Issue #117）。`$token_hexes` は **多行**であり、quiet 判定にすると
  # トークンが増えた時点で最初の一致で打ち切られ、上流の printf が EPIPE で 141 を返す。
  # ここは `if !` の内側なので中断はせず、141 が「無一致」と読まれて **定義済みの色を
  # 未定義として報告する偽の赤**に化ける。実測の発火点は約 20,000 行（規律 2）。
  # 無一致（exit 1）と評価不能（exit 2 以上）は分ける。後置 true で潰すと、壊れた
  # パターンが「無一致」に化けて未定義色を素通りさせる。
  hex_rc=0
  hex_hits="$(printf '%s\n' "$token_hexes" | grep -cx "$hex")" || hex_rc=$?
  if [ "$hex_rc" -gt 1 ]; then
    echo "ERROR: ${THEME_CSS#$ROOT/} の ${hex} を照合できません（grep exit=${hex_rc}）。" >&2
    fail=1
  elif [ "${hex_hits:-0}" -eq 0 ]; then
    echo "ERROR: ${THEME_CSS#$ROOT/} の ${hex} は design-tokens に定義がありません。" >&2
    echo "       → theme.css の値は design-tokens と同値でなければなりません（単一情報源の維持）。" >&2
    fail=1
  fi
done <<EOF
$theme_hexes
EOF

if [ "$theme_count" -eq 0 ]; then
  echo "ERROR: ${THEME_CSS#$ROOT/} から色を 1 件も抽出できませんでした（空振り検証の防止）。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: デザイントークンのガードに違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: デザイントークンガード緑（直書き hex ゼロ・生パレット色クラスゼロ・theme.css ${theme_count} 色が design-tokens と同値）。"
exit 0
