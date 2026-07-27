#!/usr/bin/env bash
# ui-design-foundation ガードレール（Requirements 1.4 / 4.4）: 色は必ずデザイントークン
# （ts/packages/design-tokens）を単一情報源とする。アプリ層や UI コンポーネントに hex を
# 直書きすると、Web と LINE で同じ意味役割の色が枝分かれし、トークン変更が全面に届かなくなる
# （本 spec 以前の実態: messages.ts / flex.ts に 15 箇所の直書き色が散在していた）。
# 本スクリプトはその再混入を CI で機械検出する（read-only の grep 検証・副作用なし・bash 3.2 互換）。
#
# 検証内容:
#   1. 直書き色の検出: ts/apps/** と ts/packages/ui/src/components/** に hex 色リテラルが無いこと
#      （許可箇所は下記 ALLOWED のみ = トークン定義と theme.css）
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
UI_COMPONENTS_DIR="${ROOT}/ts/packages/ui/src/components"

# hex 色リテラル（3〜8 桁。8 桁は shadow のアルファ付き #0000000D 等）。
HEX_PATTERN='#[0-9a-fA-F]{3,8}'

for f in "$TOKENS_DIR" "$THEME_CSS"; do
  if [ ! -e "$f" ]; then
    echo "ERROR: 検証対象が見つかりません: ${f#$ROOT/}" >&2
    exit 1
  fi
done

fail=0

# --- 検証1: アプリ層・UI コンポーネント層への直書き色の混入検出 ---
# テスト・E2E・生成物は対象外（スナップショットは現行描画の記録であり定義ではない）。
scan_targets=("$APPS_DIR")
[ -d "$UI_COMPONENTS_DIR" ] && scan_targets+=("$UI_COMPONENTS_DIR")

hits="$(grep -rnE "$HEX_PATTERN" "${scan_targets[@]}" \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.css' \
    --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist \
    --exclude-dir=test --exclude-dir=e2e --exclude-dir=__snapshots__ \
    --exclude='*.test.*' 2>/dev/null || true)"

if [ -n "$hits" ]; then
  echo "ERROR: デザイントークンを経由しない直書きの色指定が検出されました:" >&2
  printf '%s\n' "$hits" | sed "s|^${ROOT}/||" >&2
  echo "       → 色は ts/packages/design-tokens に意味役割で定義し、そこから参照してください。" >&2
  echo "         Web は theme.css 由来の意味論クラス（bg-primary 等）、LINE Flex は lineColors.* を使います。" >&2
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
  if ! printf '%s\n' "$token_hexes" | grep -qx "$hex"; then
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

echo "OK: デザイントークンガード緑（直書き色ゼロ・theme.css ${theme_count} 色が design-tokens と同値）。"
exit 0
