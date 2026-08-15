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
scan_targets=("$APPS_DIR")
[ -d "$UI_COMPONENTS_DIR" ] && scan_targets+=("$UI_COMPONENTS_DIR")

hits="$(grep -rnE "$HEX_PATTERN" "${scan_targets[@]}" "${GREP_FILTERS[@]}" 2>/dev/null || true)"

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
palette_targets=("$APPS_DIR")
[ -d "$UI_SRC_DIR" ] && palette_targets+=("$UI_SRC_DIR")

palette_hits="$(grep -rnE "$PALETTE_PATTERN" "${palette_targets[@]}" "${GREP_FILTERS[@]}" 2>/dev/null || true)"

if [ -n "$palette_hits" ]; then
  echo "ERROR: Tailwind 既定パレットの生色クラス（bg-red-500 等）が検出されました:" >&2
  printf '%s\n' "$palette_hits" | sed "s|^${ROOT}/||" >&2
  echo "       → 生パレット色は意味役割を持たないため、面ごとに配色が枝分かれします。" >&2
  echo "         theme.css 由来の意味論クラス（bg-primary / text-muted-foreground / border-border 等）を使い、" >&2
  echo "         必要な役割が無い場合は ts/packages/design-tokens へ役割ごと追加してください。" >&2
  fail=1
fi

# --- 検証2: theme.css の hex が design-tokens の値集合に含まれること ---
theme_hexes="$(grep -oE "$HEX_PATTERN" "$THEME_CSS" | tr '[:lower:]' '[:upper:]' | sort -u || true)"
token_hexes="$(grep -rhoE "$HEX_PATTERN" "$TOKENS_DIR" | tr '[:lower:]' '[:upper:]' | sort -u || true)"

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
