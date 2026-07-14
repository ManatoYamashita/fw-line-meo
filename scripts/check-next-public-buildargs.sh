#!/usr/bin/env bash
# Issue #23 ガードレール: Next.js の NEXT_PUBLIC_* はクライアントバンドルへ next build 時に
# インライン化される値であり、Cloud Run のランタイム env 注入では反映されない。ソースが参照する
# NEXT_PUBLIC_X に対応する `ARG NEXT_PUBLIC_X` が同アプリの Dockerfile に無いと、空値が焼き込まれ
# 本番で必ず失敗する（PR #22 の store-detail LIFF 起動障害と同型）。本スクリプトはその欠落を
# CI で機械検出する（read-only の grep 検証・副作用なし・連想配列を使わず bash 3.2 でも走る）。
#
# 使い方: bash scripts/check-next-public-buildargs.sh
#   欠落があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APPS_DIR="${ROOT}/ts/apps"

if [ ! -d "$APPS_DIR" ]; then
  echo "OK: ${APPS_DIR} が存在しないため検証対象なし。" >&2
  exit 0
fi

fail=0
app_count=0
var_count=0

for app_path in "$APPS_DIR"/*/; do
  [ -d "$app_path" ] || continue
  app="$(basename "$app_path")"
  dockerfile="${app_path}Dockerfile"

  # ランタイムソースから `process.env.NEXT_PUBLIC_X` 参照を抽出。
  # テスト・ビルド生成物・依存は除外（テスト専用参照は build-arg 不要 → false positive を避ける）。
  # コメント/文字列中の裸の NEXT_PUBLIC_ を拾わないよう、process.env. 接頭を必須にする。
  vars="$(grep -rhoE 'process\.env\.NEXT_PUBLIC_[A-Z0-9_]+' "$app_path" \
      --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
      --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=test --exclude-dir=e2e \
      --exclude='*.test.*' 2>/dev/null \
    | sed -E 's/^process\.env\.//' | sort -u || true)"

  [ -n "$vars" ] || continue
  app_count=$((app_count + 1))

  while IFS= read -r var; do
    [ -n "$var" ] || continue
    var_count=$((var_count + 1))
    if [ ! -f "$dockerfile" ]; then
      echo "ERROR: ${app} はソースで ${var} を参照しますが Dockerfile がありません（build-arg で渡せません）。" >&2
      fail=1
      continue
    fi
    # `ARG NEXT_PUBLIC_X`（末尾に既定値やコメントが付く形も許容）を検出。
    if ! grep -qE "^[[:space:]]*ARG[[:space:]]+${var}([[:space:]]|=|\$)" "$dockerfile"; then
      echo "ERROR: ${app} はソースで ${var} を参照しますが ${dockerfile#$ROOT/} に 'ARG ${var}' がありません。" >&2
      echo "       → next build 時に空値が焼き込まれ本番で失敗します。build ステージの next build 前に" >&2
      echo "         'ARG ${var}' + 'ENV ${var}=\$${var}' を追加し、scripts/push-images.sh の BUILD_ARGS にも足してください。" >&2
      fail=1
    fi
  done <<EOF
$vars
EOF
done

if [ "$fail" -ne 0 ]; then
  echo "NG: NEXT_PUBLIC_* の build-arg ガードに違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: NEXT_PUBLIC_* build-arg ガード緑（${app_count} app / ${var_count} var 検証）。"
exit 0
