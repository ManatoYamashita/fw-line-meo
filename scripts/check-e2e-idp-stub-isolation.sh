#!/usr/bin/env bash
# Issue #53 ガードレール: 管理ダッシュボードと店舗詳細を実ブラウザで測るために、外部 IdP の
# SDK（`firebase/auth` / `@line/liff`）を **ビルド時にスタブへ差し替える**口を入れた。
# 差し替えは各面の `next.config.ts` の `turbopack.resolveAlias` が担い、サーバー側 env
# `E2E_STUB_IDP=1` が立っているときだけ有効になる（面のソースは 1 行も変えていない）。
#
# **この口が出荷経路へ漏れると、認証を一切しないイメージが本番へ出る。** 漏れ方は 3 通りあり、
# どれも通常のテストでは緑のまま通る:
#   1. Dockerfile / push-images.sh / deploy.yml が `E2E_STUB_IDP` を渡してしまう
#   2. `resolveAlias` の条件が env との等値比較でなくなり、常時 on に化ける（fail-open）
#   3. スタブ自体を本番ソース（src/ · app/）が import してしまい、env と無関係に束ねられる
#
# 1 と 3 は「動くので気づかない」形の事故である。ログインを求められないダッシュボードは
# 一見しただけでは壊れて見えず、LIFF 面は LINE 外でも開けてしまうため**むしろ便利に見える**。
#
# 本スクリプトは以下を機械検証する（read-only の走査・副作用なし・bash 3.2 でも走る）:
#   1. 出荷経路（各アプリの Dockerfile・scripts/push-images.sh・.github/workflows/deploy.yml）に
#      `E2E_STUB_IDP` が 1 件も現れない
#   2. スタブを持つアプリと、`resolveAlias` を持つアプリが**双方向で一致する**
#      （片方だけ足す／片方だけ消す、のどちらも赤にする）
#   3. `resolveAlias` を持つ next.config.ts が、env との**等値比較**を伴う
#   4. `e2e/stubs/` 配下のモジュールが src/ · app/ から import されていない
#   5. 空振り防止: スタブを持つアプリが 0 件なら赤（走査の前提が崩れたまま緑を返さない）
#
# 使い方: bash scripts/check-e2e-idp-stub-isolation.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APPS_DIR="${ROOT}/ts/apps"

# 差し替えを起動する env 名。出荷経路に現れてはならない文字列でもある。
STUB_ENV='E2E_STUB_IDP'
# fail-closed の形。この等値比較が無いと差し替えが常時 on に化けうる。
GUARD_EXPR="process.env.${STUB_ENV} === '1'"

if [ ! -d "$APPS_DIR" ]; then
  echo "ERROR: ${APPS_DIR#$ROOT/} がありません。走査の前提が崩れています。" >&2
  exit 1
fi

fail=0
stub_app_count=0
alias_app_count=0
shipping_file_count=0

# 指定ファイルに含まれる固定文字列の件数を返す。grep の「無一致（1）」と「評価不能（2 以上）」を
# 分けて扱う（後置 true で潰すと、評価不能が「違反 0 件」に化ける・Issue #120）。
count_fixed() {
  cf_rc=0
  cf_n="$(grep -cF "$1" "$2")" || cf_rc=$?
  if [ "$cf_rc" -gt 1 ]; then
    echo "ERROR: ${2#$ROOT/} の走査に失敗しました（grep exit ${cf_rc}）。判定不能を 0 件として扱いません。" >&2
    fail=1
    cf_n=-1
  fi
  printf '%s' "$cf_n"
}

# --- 1. 出荷経路に env が漏れていない ---------------------------------------------------

check_shipping_file() {
  csf_path="$1"
  [ -f "$csf_path" ] || return 0
  shipping_file_count=$((shipping_file_count + 1))
  csf_n="$(count_fixed "$STUB_ENV" "$csf_path")"
  if [ "$csf_n" -gt 0 ]; then
    echo "ERROR: ${csf_path#$ROOT/} に ${STUB_ENV} が ${csf_n} 件現れます（出荷経路への漏れ）。" >&2
    echo "       → 差し替えは E2E 専用です。この env が出荷ビルドへ届くと、認証を一切しない" >&2
    echo "         イメージが本番へ出ます。渡してよいのは CI の E2E ジョブだけです。" >&2
    fail=1
  fi
}

for app_path in "$APPS_DIR"/*/; do
  [ -d "$app_path" ] || continue
  check_shipping_file "${app_path}Dockerfile"
done
check_shipping_file "${ROOT}/scripts/push-images.sh"
check_shipping_file "${ROOT}/.github/workflows/deploy.yml"

if [ "$shipping_file_count" -eq 0 ]; then
  echo "ERROR: 出荷経路のファイルを 1 件も走査できませんでした。ガードが空振りしています。" >&2
  echo "       → Dockerfile / push-images.sh / deploy.yml の所在の前提が崩れています。" >&2
  exit 1
fi

# --- 2〜4. アプリごとの整合 -------------------------------------------------------------

for app_path in "$APPS_DIR"/*/; do
  [ -d "$app_path" ] || continue
  app="$(basename "$app_path")"
  stubs_dir="${app_path}e2e/stubs"
  next_config="${app_path}next.config.ts"

  has_stubs=0
  if [ -d "$stubs_dir" ]; then
    stub_files="$(find "$stubs_dir" -type f -name '*.ts')"
    if [ -n "$stub_files" ]; then
      has_stubs=1
      stub_app_count=$((stub_app_count + 1))
    fi
  fi

  has_alias=0
  if [ -f "$next_config" ]; then
    alias_n="$(count_fixed 'resolveAlias' "$next_config")"
    if [ "$alias_n" -gt 0 ]; then
      has_alias=1
      alias_app_count=$((alias_app_count + 1))
    fi
  fi

  # 2. 双方向の一致。片方だけ足す／消すのどちらも赤にする。
  if [ "$has_stubs" -eq 1 ] && [ "$has_alias" -eq 0 ]; then
    echo "ERROR: ${app} は e2e/stubs/ を持ちますが next.config.ts に resolveAlias がありません。" >&2
    echo "       → スタブが束ねられる経路が無く、E2E は本物の SDK を掴んで認証の壁で赤くなります。" >&2
    fail=1
  fi
  if [ "$has_stubs" -eq 0 ] && [ "$has_alias" -eq 1 ]; then
    echo "ERROR: ${app} は next.config.ts に resolveAlias を持ちますが e2e/stubs/ がありません。" >&2
    echo "       → 差し替え先が存在しません。ビルドが壊れるか、意図しない解決へ倒れます。" >&2
    fail=1
  fi

  [ "$has_alias" -eq 1 ] || continue

  # 3. fail-closed の形。等値比較が無ければ常時 on に化けうる。
  guard_n="$(count_fixed "$GUARD_EXPR" "$next_config")"
  if [ "$guard_n" -eq 0 ]; then
    echo "ERROR: ${app} の next.config.ts の resolveAlias が ${STUB_ENV} との等値比較で囲われていません。" >&2
    echo "       → 期待する形: ${GUARD_EXPR}" >&2
    echo "         真偽値評価（env の存在だけを見る形）にすると、空文字や 0 でも差し替えが有効になります。" >&2
    fail=1
  fi

  # 4. スタブが本番ソースから参照されていない。
  for src_dir in "${app_path}src" "${app_path}app" "${app_path}lib"; do
    [ -d "$src_dir" ] || continue
    ref_rc=0
    ref_files="$(grep -rlF 'e2e/stubs' "$src_dir" --include='*.ts' --include='*.tsx')" || ref_rc=$?
    if [ "$ref_rc" -gt 1 ]; then
      echo "ERROR: ${src_dir#$ROOT/} の走査に失敗しました（grep exit ${ref_rc}）。" >&2
      fail=1
      continue
    fi
    if [ -n "$ref_files" ]; then
      echo "ERROR: ${app} の本番ソースが e2e/stubs/ を参照しています:" >&2
      echo "$ref_files" | sed -e "s|^${ROOT}/|       - |" >&2
      echo "       → env と無関係にスタブが束ねられます。参照は e2e/ の内側に閉じてください。" >&2
      fail=1
    fi
  done
done

# --- 5. 空振り防止 ---------------------------------------------------------------------

if [ "$stub_app_count" -eq 0 ]; then
  echo "ERROR: e2e/stubs/ を持つアプリが 1 件もありません。ガードが空振りしています。" >&2
  echo "       → 差し替えの口ごと不要になったのなら、本ガードと CI のステップも併せて外してください" >&2
  echo "         （「対象 0 件だから緑」を恒久の状態にしないこと）。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: E2E スタブの隔離に違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: E2E スタブの隔離を検証しました（出荷経路 ${shipping_file_count} ファイル / スタブを持つアプリ ${stub_app_count} 件 / resolveAlias ${alias_app_count} 件）。"
