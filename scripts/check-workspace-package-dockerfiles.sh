#!/usr/bin/env bash
# Issue #234 ガードレール: pnpm workspace の共有パッケージは、それを使う各アプリのコンテナ定義へ
# **名前で列挙**して取り込まれており、依存宣言の追加に自動追従しない。段を足し忘れても CI は何も
# 言わず、しかも**失敗する時点が段によって違う**。
#   - 依存解決の段の漏れ  → `pnpm install --frozen-lockfile` が落ちる（早期に気づける）
#   - ビルド／実行時配置の段の漏れ → **イメージが作れてしまう**（実行時まで露見しない）
#
# 本スクリプトは依存宣言とコンテナ定義を両方向で照合する
# （read-only の走査・副作用なし・連想配列を使わず bash 3.2 でも走る）。
#
# ## 依存は推移的に閉じる（直接依存だけを見ると誤検知する）
#
# `pnpm install --frozen-lockfile` は lockfile 全体を解決するため、**間接的に到達する workspace
# パッケージの package.json も依存解決の段に要る**。実測では `ui → design-tokens`（dev 経由）と
# `store-identification → db`（prod 経由）の 2 本があり、前者のせいで dashboard-web と store-detail
# は自分が宣言していない design-tokens を取り込んでいる。直接依存だけで逆方向を照合すると、
# **この正しい取り込みを違反として叩く**（本ガードの初版が実際にそうなった）。
#
# したがって閉包を 2 通り計算する。
#   - 全経路の閉包:   prod / dev の区別なく辿る。**依存解決の段**の判定に使う
#   - prod 経路の閉包: prod 依存のみを辿る。**ビルド・実行時配置の段**の判定に使う
#     （dev を 1 度でも経由したものは実行時に要らない）
#
# ## 段の要否は面の形から導く（宣言表を持たない）
#
# 実測（2026-09-07・6 アプリ）で例外なく成り立つ規則:
#   - 依存解決の段:   全経路の閉包に含まれるすべてに必要
#   - ビルドの段:     prod 経路の閉包のうち**ビルド成果物を持つ**ものに必要
#   - 実行時配置の段: **成果物を内包しない形式**の面で、prod 経路の閉包すべてに必要
#
# 3 つ目が要点である。standalone 形式で出力する面（`.next/standalone` を写す 3 面）は依存を内包した
# 成果物を配置するため、packages を個別に写さない。ここへ機械的に「3 段そろえろ」と要求すると、
# **存在しないパスの複写でイメージビルドが落ちる**（各 Dockerfile 自身がその注意を残している）。
#
# 面の形は Dockerfile 自身が持っているので、別途の宣言表を用意しない。宣言表を持てば、それを
# 更新し忘れるという新しい壊れ方を作ることになる（#151 の「述語を持たなければ、その忘れ方は
# 起き得ない」と同じ判断）。
#
# 本スクリプトが検証すること:
#   1. 全経路の閉包すべてに依存解決の段がある（順方向）
#   2. prod 経路の閉包のうちビルド成果物を持つものにビルドの段がある（順方向）
#   3. 成果物を内包しない形式の面で、prod 経路の閉包すべてに実行時配置の段がある（順方向）
#   4. コンテナ定義が参照する packages が、すべて全経路の閉包に含まれる（逆方向）
#   5. 走査対象が 0 件のときは赤にする（空振り防止）
#
# 使い方: bash scripts/check-workspace-package-dockerfiles.sh
#   欠落があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APPS_DIR="${ROOT}/ts/apps"
PACKAGES_DIR="${ROOT}/ts/packages"

if [ ! -d "$APPS_DIR" ] || [ ! -d "$PACKAGES_DIR" ]; then
  echo "ERROR: ${APPS_DIR} または ${PACKAGES_DIR} が存在しません。走査前提が崩れています。" >&2
  exit 1
fi

# package.json の指定セクションから @fwlm/* の workspace 依存を短縮名で取り出す。
# 整形（2 スペースインデント）を前提とする。崩れて 0 件になった場合は末尾の空振り防止が拾う。
extract_workspace_deps() {
  # $1: package.json のパス / $2: セクション名（dependencies | devDependencies）
  # 無一致（該当セクションに workspace 依存が無い）は正常。評価不能とは区別して扱う。
  local out rc
  out="$(sed -n "/^  \"$2\": {/,/^  }/p" "$1" 2>/dev/null \
    | grep -oE '"@fwlm/[a-z0-9-]+": "workspace:' \
    | sed -E 's|^"@fwlm/||; s|": "workspace:$||' \
    | sort -u)" && rc=0 || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "ERROR: $1 の $2 から workspace 依存を抽出できませんでした（exit ${rc}）。" >&2
    exit 1
  fi
  printf '%s\n' "$out"
}

# 依存を推移的に閉じる。
# $1: 開始集合（改行区切りの短縮名） / $2: all=prod と dev を辿る、prod=prod のみを辿る
resolve_closure() {
  local pending="$1"
  local mode="$2"
  local seen=""
  local round=0
  local p sub next pkg
  while [ -n "$pending" ] && [ "$round" -lt 20 ]; do
    round=$((round + 1))
    next=""
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      case "$seen" in
        *"|${p}|"*) continue ;;
      esac
      seen="${seen}|${p}|"
      pkg="${PACKAGES_DIR}/${p}/package.json"
      [ -f "$pkg" ] || continue
      sub="$(extract_workspace_deps "$pkg" dependencies)"
      if [ "$mode" = "all" ]; then
        sub="$(printf '%s\n%s\n' "$sub" "$(extract_workspace_deps "$pkg" devDependencies)")"
      fi
      next="$(printf '%s\n%s\n' "$next" "$sub")"
    done <<EOF
$pending
EOF
    pending="$(printf '%s\n' "$next" | sed '/^$/d' | sort -u)"
  done
  printf '%s\n' "$seen" | tr '|' '\n' | sed '/^$/d' | sort -u
}

# ビルド成果物を持つパッケージか（build スクリプトの有無で判定する）。
has_build_output() {
  # $1: パッケージ短縮名
  local pkg="${PACKAGES_DIR}/$1/package.json"
  [ -f "$pkg" ] || return 1
  grep -qE '^[[:space:]]*"build":' "$pkg"
}

# 成果物を内包する形式か（standalone 出力を配置する面は packages を個別に写さない）。
bundles_dependencies() {
  # $1: Dockerfile のパス
  grep -qE '\.next/standalone' "$1"
}

# 集合に含まれるか（改行区切りの集合を第 1 引数、探す値を第 2 引数で受ける）。
# quiet 系（-q）はパイプの下流に置くと最初の一致で抜け、上流の printf が EPIPE で 141 になる。
# 件数で判定し、評価不能（exit 2 以上）は無一致と区別して即座に落とす。
set_contains() {
  local n rc
  n="$(printf '%s\n' "$1" | grep -cFx -- "$2")" && rc=0 || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "ERROR: 集合照合が評価不能でした（grep exit ${rc}）。走査前提が崩れています。" >&2
    exit 1
  fi
  [ "$n" -gt 0 ]
}

fail=0
app_count=0
dep_count=0
checked_stages=0

for app_path in "$APPS_DIR"/*/; do
  [ -d "$app_path" ] || continue
  app="$(basename "$app_path")"
  pkg_json="${app_path}package.json"
  dockerfile="${app_path}Dockerfile"

  [ -f "$pkg_json" ] || continue

  direct_prod="$(extract_workspace_deps "$pkg_json" dependencies)"
  direct_dev="$(extract_workspace_deps "$pkg_json" devDependencies)"
  direct_all="$(printf '%s\n%s\n' "$direct_prod" "$direct_dev" | sed '/^$/d' | sort -u)"

  [ -n "$direct_all" ] || continue
  app_count=$((app_count + 1))

  # デプロイ対象でないアプリはコンテナ定義を持たない。照合対象から外す。
  [ -f "$dockerfile" ] || continue

  closure_all="$(resolve_closure "$direct_all" all)"
  closure_prod="$(resolve_closure "$direct_prod" prod)"

  if bundles_dependencies "$dockerfile"; then
    needs_runtime_stage=0
  else
    needs_runtime_stage=1
  fi

  # --- 順方向: 閉包に対して必要な段がそろっているか ---
  while IFS= read -r dep; do
    [ -n "$dep" ] || continue
    dep_count=$((dep_count + 1))

    # (1) 依存解決の段: 全経路の閉包すべてに必要
    checked_stages=$((checked_stages + 1))
    if ! grep -qE "^COPY packages/${dep}/package\.json" "$dockerfile"; then
      echo "ERROR: ${app} は @fwlm/${dep} へ（間接を含め）依存しますが、依存解決の段に取り込みがありません。" >&2
      echo "       → ${dockerfile#$ROOT/} の deps ステージへ 'COPY packages/${dep}/package.json packages/${dep}/' を足してください。" >&2
      fail=1
    fi

    if set_contains "$closure_prod" "$dep"; then
      # (2) ビルドの段: prod 経路かつビルド成果物を持つものに必要
      if has_build_output "$dep"; then
        checked_stages=$((checked_stages + 1))
        if ! grep -qE "^RUN pnpm -C packages/${dep} run build" "$dockerfile"; then
          echo "ERROR: ${app} は @fwlm/${dep}（ビルド成果物を持つ）を実行時に使いますが、ビルドの段がありません。" >&2
          echo "       → ${dockerfile#$ROOT/} の build ステージへ 'RUN pnpm -C packages/${dep} run build' を足してください。" >&2
          echo "         この漏れはイメージが作れてしまうため、実行時まで露見しません。" >&2
          fail=1
        fi
      fi

      # (3) 実行時配置の段: 成果物を内包しない形式の面でのみ必要
      if [ "$needs_runtime_stage" -eq 1 ]; then
        checked_stages=$((checked_stages + 1))
        if ! grep -qE "^COPY --from=build /repo/packages/${dep}( |\$)" "$dockerfile"; then
          echo "ERROR: ${app} は @fwlm/${dep} を実行時に使いますが、実行時配置の段に取り込みがありません。" >&2
          echo "       → ${dockerfile#$ROOT/} の runner ステージへ 'COPY --from=build /repo/packages/${dep} ./packages/${dep}' を足してください。" >&2
          fail=1
        fi
      fi
    fi
  done <<EOF
$closure_all
EOF

  # --- 逆方向: コンテナ定義が参照する packages が閉包に含まれるか ---
  referenced="$(grep -oE 'packages/[a-z0-9][a-z0-9-]*' "$dockerfile" | sed 's|^packages/||' | sort -u)" && ref_rc=0 || ref_rc=$?
  if [ "$ref_rc" -gt 1 ]; then
    echo "ERROR: ${dockerfile#$ROOT/} からの packages 参照の抽出が評価不能でした（exit ${ref_rc}）。" >&2
    exit 1
  fi
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    if ! set_contains "$closure_all" "$ref"; then
      echo "ERROR: ${app} のコンテナ定義は packages/${ref} を参照しますが、依存として（間接的にも）到達しません。" >&2
      echo "       → ${app_path#$ROOT/}package.json へ依存を宣言するか、不要な取り込みを削ってください。" >&2
      fail=1
    fi
  done <<EOF
$referenced
EOF
done

# 空振り防止: 抽出が 0 件なら、この検証自体が壊れている。
# 上の抽出は package.json の整形（2 スペースインデント）と "workspace:" 接頭に依存しており、
# 整形の変更や依存記法の綻びで **全件を取りこぼしても 0 件＝緑** になる。
# 本ガードが防ぐのは「イメージが作れてしまい実行時まで露見しない」障害であり、
# 取りこぼしを緑と報告してはならない。
if [ "$app_count" -eq 0 ]; then
  echo "ERROR: workspace 依存を持つアプリを 1 件も抽出できませんでした。ガードが空振りしています。" >&2
  echo "       → package.json の整形か 'workspace:' 記法の前提が崩れています。" >&2
  exit 1
fi
if [ "$dep_count" -eq 0 ]; then
  echo "ERROR: workspace 依存を 1 件も抽出できませんでした。ガードが空振りしています。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: 共有パッケージとコンテナ定義の照合に違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: 共有パッケージのコンテナ定義ガード緑（${app_count} app / ${dep_count} 依存 / ${checked_stages} 段を両方向検証）。"
exit 0
