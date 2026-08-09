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

# 空振り防止（Issue #90）: 参照を 1 件も抽出できていなければ、この検証自体が壊れている。
# 上の grep は --include / --exclude-dir と `process\.env\.` 接頭に依存しており、拡張子構成の
# 変更や除外条件の綻びで **全ファイルを取りこぼしても 0 件＝緑** になる。本ガードが防ぐのは
# 「空値が焼き込まれて本番で必ず失敗する」障害であり、取りこぼしを緑と報告してはならない。
# 他の 4 本のガードは同種の防止を持っていたが、本ガードだけ欠けていた。
#
# なお ts/apps 自体が存在しない場合は上部で意図的に exit 0 している（アプリ層の導入前を
# 許容するため）。ここで防ぐのは「apps はあるのに 1 件も拾えない」状態である。
if [ "$var_count" -eq 0 ]; then
  echo "ERROR: NEXT_PUBLIC_* の参照を 1 件も検証できませんでした。ガードが空振りしています。" >&2
  echo "       → 走査の --include / --exclude-dir か 'process.env.' 接頭の前提が崩れています。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: NEXT_PUBLIC_* の build-arg ガードに違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: NEXT_PUBLIC_* build-arg ガード緑（${app_count} app / ${var_count} var 検証）。"
exit 0
