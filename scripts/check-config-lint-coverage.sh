#!/usr/bin/env bash
# Issue #66 ガードレール: モノレポの設定ファイル（next.config.ts / postcss.config.mjs /
# vitest.config.ts / playwright.config.ts / eslint.config.js）が一度も lint されていなかった。
# 穴は 2 段構えで、片方だけ塞いでも 1 本も lint されない:
#   (1) ts/eslint.config.js の ignores に `**/*.config.*` があり、全 config を除外していた
#   (2) 各 workspace の lint スクリプトが `eslint src test` のようにディレクトリ限定で、
#       パッケージ直下のファイルへ到達しない
# Issue #70 のガード（check-test-code-coverage.sh）は test/ e2e/ の「ディレクトリ」を見るため
# パッケージ直下の config は守備範囲外であり、この穴は検出できない。
# 本スクリプトはその両方を機械検出する（read-only の grep 検証・副作用なし・連想配列を使わず
# bash 3.2 でも走る。pnpm install 前に走らせるため node を使わない）。
#
# 検証内容:
#   1. ts/eslint.config.js の ignores に config を丸ごと除外するパターンが無い
#   2. 実在する全 config ファイルが、所属 workspace の lint スクリプト引数に現れる
#      （ts 直下の eslint.config.js は root の ts/package.json の lint を対象とする）
#
# 使い方: bash scripts/check-config-lint-coverage.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TS_DIR="${ROOT}/ts"
ESLINT_CONFIG="${TS_DIR}/eslint.config.js"
ROOT_PKG="${TS_DIR}/package.json"

for f in "$ESLINT_CONFIG" "$ROOT_PKG"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: 検証対象が見つかりません: ${f#$ROOT/}" >&2
    exit 1
  fi
done

fail=0
checked=0

# (1) ignores に config を丸ごと消すパターンが無いこと。
#     ファイル全体を grep するとコメント中の記述（本件の経緯説明など）に誤ヒットするため、
#     `ignores:` の行だけを取り出して判定する（1 行定義が前提。崩れたら fail して前提を守らせる）。
#     BSD grep（macOS の既定）は \b を解釈しないため使わず、クォート込みの固定文字列で照合する。
#     クォート込みの厳密文字列一致では守れない（'**/*.config.*' を "**/*.config.*" と書き換える
#     だけで同じ穴が再発することを実測済み・PR #79 レビュー指摘）。そのため ignores の各要素を
#     個別に取り出し、ワイルドカード（*）と `.config` を同時に含む要素をクォート種別・綴りに
#     依らず検出する。
ignores_line="$(grep -E '^[[:space:]]*ignores:' "$ESLINT_CONFIG" || true)"
if [ -z "$ignores_line" ]; then
  echo "ERROR: ${ESLINT_CONFIG#$ROOT/} から 'ignores:' の行を抽出できませんでした。抽出前提が崩れています。" >&2
  echo "       → ignores は 1 行で定義してください（本ガードが除外パターンを機械検証します）。" >&2
  exit 1
fi

ignore_entries="$(printf '%s\n' "$ignores_line" | grep -oE "['\"][^'\"]*['\"]" || true)"
if [ -z "$ignore_entries" ]; then
  echo "ERROR: ${ESLINT_CONFIG#$ROOT/} の ignores から要素を1件も抽出できませんでした。抽出前提が崩れています。" >&2
  exit 1
fi

while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  case "$entry" in
    *\**.config*|*.config*\**)
      echo "ERROR: ${ESLINT_CONFIG#$ROOT/} の ignores に config を広く除外する疑わしい要素があります: ${entry}" >&2
      echo "       → next/postcss/vitest/playwright/eslint の設定がモノレポ全体で lint されなくなるおそれがあります。" >&2
      echo "         ignores は生成物のみ（dist / dist-scripts / node_modules / .next）へ絞ってください。" >&2
      fail=1
      ;;
  esac
done <<EOF
$ignore_entries
EOF

# (2) 実在する config が所属 workspace の lint 引数に現れること。
#     生成物・依存は除外する（.next 配下等の設定は検証対象ではない）。
configs="$(find "$TS_DIR" -type f -name '*.config.*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -path '*/dist-scripts/*' \
  -not -path '*/.next/*' \
  | sort)"

if [ -z "$configs" ]; then
  echo "ERROR: ${TS_DIR#$ROOT/} から config ファイルを1件も抽出できませんでした。抽出前提が崩れています。" >&2
  exit 1
fi

while IFS= read -r config; do
  [ -n "$config" ] || continue
  base="$(basename "$config")"
  dir="$(cd "$(dirname "$config")" && pwd)"

  # 所属 workspace の package.json を決める。ts 直下の config（eslint.config.js）は root 扱い。
  pkg_json="${dir}/package.json"
  if [ ! -f "$pkg_json" ]; then
    echo "ERROR: ${config#$ROOT/} と同じディレクトリに package.json がありません（想定外の配置）。" >&2
    echo "       → 本ガードは「config は workspace 直下にある」ことを前提に所属を決めています。" >&2
    echo "         配置を見直すか、本スクリプトの所属判定を拡張してください。" >&2
    fail=1
    continue
  fi

  checked=$((checked + 1))

  # lint スクリプトの行を取り出す（1 行定義が前提。崩れたら fail して前提を守らせる）。
  lint_line="$(grep -E '"lint"[[:space:]]*:' "$pkg_json" || true)"
  if [ -z "$lint_line" ]; then
    echo "ERROR: ${pkg_json#$ROOT/} に \"lint\" スクリプトがありません（${base} が lint されません）。" >&2
    echo "       → \"lint\": \"eslint <ディレクトリ...> ${base}\" を追加してください。" >&2
    fail=1
    continue
  fi

  # ファイル名の完全一致を、名前に現れない文字（空白・引用符）を境界にして判定する。
  # 部分一致だと next.config.ts が next.config.ts.bak 等に誤ヒットしうるため。
  if ! printf '%s\n' "$lint_line" | grep -qE "[[:space:]\"]${base}([[:space:]\"]|\$)"; then
    echo "ERROR: ${config#$ROOT/} が ${pkg_json#$ROOT/} の lint スクリプト引数にありません。" >&2
    echo "       → lint スクリプトはディレクトリ限定のためパッケージ直下のファイルへ到達しません。" >&2
    echo "         \"lint\" の引数末尾へ ${base} を追加してください（例: eslint src test ${base}）。" >&2
    fail=1
  fi
done <<EOF
$configs
EOF

# 空振り防止: config を1件も検証できていなければ、この検証自体が壊れている。
if [ "$checked" -eq 0 ]; then
  echo "ERROR: config ファイルを1件も検証できませんでした。抽出前提が崩れています。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: config lint カバレッジガードに違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: config lint カバレッジガード緑（${checked} 件の config が lint 対象に含まれることを検証）。"
exit 0
