#!/usr/bin/env bash
# Issue #51 ガードレール: ts-ci が typecheck を呼ばず、Next 3面には typecheck スクリプト自体が
# 無かったため、`@fwlm/ui` の .tsx の型エラーが CI 全緑のまま main に入り得た。`pnpm -r typecheck`
# はスクリプト未定義の workspace を黙ってスキップするため、「スクリプトの定義漏れ」と
# 「CI からの呼出漏れ」のどちらか一方でも起きると型検査は静かに消える。本スクリプトはその
# 両方を機械検出する（read-only の grep 検証・副作用なし・連想配列を使わず bash 3.2 でも走る）。
#
# 検証内容:
#   1. ts/pnpm-workspace.yaml の glob が指す全 workspace の package.json に "typecheck" がある
#   2. ts/package.json（root）に "typecheck" 定義がある
#   3. .github/workflows/ts-ci.yml が `pnpm -C ts run typecheck` を実際に呼んでいる
#
# 使い方: bash scripts/check-typecheck-coverage.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TS_DIR="${ROOT}/ts"
WORKSPACE_YAML="${TS_DIR}/pnpm-workspace.yaml"
ROOT_PKG="${TS_DIR}/package.json"
CI_YAML="${ROOT}/.github/workflows/ts-ci.yml"

for f in "$WORKSPACE_YAML" "$ROOT_PKG" "$CI_YAML"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: 検証対象が見つかりません: ${f#$ROOT/}" >&2
    exit 1
  fi
done

fail=0
checked=0

# (1) pnpm-workspace.yaml の glob から全 workspace を列挙し、各 package.json に
#     "typecheck" スクリプトがあることを検証（pnpm -r の暗黙スキップ対策）。
globs="$(sed -nE "s/^[[:space:]]*-[[:space:]]*'([^']+)'.*/\1/p" "$WORKSPACE_YAML")"
if [ -z "$globs" ]; then
  echo "ERROR: ${WORKSPACE_YAML#$ROOT/} から workspace glob を1件も抽出できません。抽出前提が崩れています。" >&2
  exit 1
fi

while IFS= read -r glob; do
  [ -n "$glob" ] || continue
  for pkg_dir in "$TS_DIR"/$glob/; do
    pkg_json="${pkg_dir}package.json"
    [ -f "$pkg_json" ] || continue
    checked=$((checked + 1))
    if ! grep -qE '"typecheck"[[:space:]]*:' "$pkg_json"; then
      echo "ERROR: ${pkg_json#$ROOT/} に \"typecheck\" スクリプトがありません。" >&2
      echo "       → pnpm -r typecheck はこの workspace を黙ってスキップし、型エラーが CI を素通りします。" >&2
      echo "         'tsc -p tsconfig.json --noEmit'（Next アプリは 'next typegen && tsc -p tsconfig.json --noEmit'）を追加してください。" >&2
      fail=1
    fi
  done
done <<EOF
$globs
EOF

# 空振り防止: workspace を1件も検証できていなければ、この検証自体が壊れている。
if [ "$checked" -eq 0 ]; then
  echo "ERROR: workspace の package.json を1件も検証できませんでした。抽出前提が崩れています。" >&2
  exit 1
fi

# (2) root の ts/package.json に typecheck 定義があること。
if ! grep -qE '"typecheck"[[:space:]]*:' "$ROOT_PKG"; then
  echo "ERROR: ${ROOT_PKG#$ROOT/} に \"typecheck\" スクリプトがありません。" >&2
  echo "       → CI の 'pnpm -C ts run typecheck' が動きません。\"typecheck\": \"pnpm -r typecheck\" を定義してください。" >&2
  fail=1
fi

# (3) ts-ci.yml が typecheck を実際に呼んでいること
#     （「定義されているのに呼ばれない」= Issue #51 の穴そのものの再発防止）。
if ! grep -qE 'pnpm -C ts run typecheck' "$CI_YAML"; then
  echo "ERROR: ${CI_YAML#$ROOT/} に 'pnpm -C ts run typecheck' の呼出がありません。" >&2
  echo "       → typecheck スクリプトが定義されていても CI では一度も実行されません（Issue #51 の穴の再来）。" >&2
  echo "         build ステップの直後に '- run: pnpm -C ts run typecheck' を追加してください" >&2
  echo "         （@fwlm/db 等が dist/ から型を export するため build 前では TS2307 で解決不能）。" >&2
  fail=1
fi

# (4) root の typecheck が packages の先行ビルドを含むこと（Issue #66）。
#     ts/packages/* は package.json の types が dist/ を指し、dist/ は .gitignore 対象である。
#     クリーン checkout で build 前に typecheck を走らせると TS2307 で解決不能になる（実測済み）。
#     CI は lint → build → typecheck の順序でこれを回避しているが、その順序は ts-ci.yml という
#     「外部の約束」にしか書かれていないため、手元だけ赤くなる非対称が残る。この非対称自体が
#     事故の温床（新規 worktree でテストが環境要因で全滅し赤化判定を誤る）なので、依存関係を
#     script 自身に持たせ、外れたら機械検出する。
if ! grep -qE '"build:packages"[[:space:]]*:' "$ROOT_PKG"; then
  echo "ERROR: ${ROOT_PKG#$ROOT/} に \"build:packages\" スクリプトがありません。" >&2
  echo "       → クリーン checkout では packages の dist/ が無く typecheck が TS2307 で落ちます。" >&2
  echo "         \"build:packages\": \"pnpm --filter \\\"./packages/**\\\" run build\" を定義してください。" >&2
  fail=1
fi

# typecheck の値そのものに build:packages が現れること（定義したのに呼ばれない、を防ぐ）。
# 終了コードを捕捉し、無一致（exit 1）と評価不能・読めない（exit 2 以上）を分ける（Issue #120）。
# 後置 true で潰すと、ファイルを読めない状態が「typecheck が未定義」と同じ結果に化け、
# 原因と逆向きの「build:packages を呼んでください」という指示が出る。
typecheck_line_rc=0
typecheck_line="$(grep -E '"typecheck"[[:space:]]*:' "$ROOT_PKG")" || typecheck_line_rc=$?
if [ "$typecheck_line_rc" -gt 1 ]; then
  echo "ERROR: ${ROOT_PKG#$ROOT/} を走査できません（grep exit=${typecheck_line_rc}）。" >&2
  exit 1
fi
case "$typecheck_line" in
  *build:packages*) ;;
  *)
    echo "ERROR: ${ROOT_PKG#$ROOT/} の \"typecheck\" が build:packages を呼んでいません。" >&2
    echo "       → CI のステップ順序に依存したままで、クリーンな手元では TS2307 で落ちます。" >&2
    echo "         \"typecheck\": \"pnpm run build:packages && pnpm -r typecheck\" にしてください。" >&2
    fail=1
    ;;
esac

if [ "$fail" -ne 0 ]; then
  echo "NG: typecheck カバレッジガードに違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: typecheck カバレッジガード緑（${checked} workspace + root 定義 + CI 呼出 + packages 先行ビルドを検証）。"
exit 0
