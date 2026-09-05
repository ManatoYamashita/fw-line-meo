#!/usr/bin/env bash
# Issue #53 ガードレール: **E2E spec は面を自分で開かない。** 面を開く手順（`page.goto`）と
# 「本体が描けていること」の前提 assert は `e2e/fixtures/` が単一の所有者になる。
#
# `check-a11y-audit-preconditions.sh` は同じ禁止を **a11y 監査 spec に対してだけ** 課している。
# 本スクリプトはそれを **e2e/ 配下の全ファイル（fixtures を除く）** へ広げる。両者の重なりは
# 無駄ではなく保護である —— 片方が消えても監査 spec の側は守られたままになる。
#
# なぜ全 spec へ広げるのか: 面を開く手順が spec 側にあると、同じ前提が複数箇所へ複写される。
# 実際 PR #191 の是正では、ui-foundation.spec.ts の 26 箇所のうち **10 箇所が fixtures と同じ
# 前提 assert を重複して書いていた**。複写された前提は片側だけが古び、しかもその劣化は
# 「テストが通り続ける」形で進むため、差分にも CI にも痕跡が出ない。
#
# 本スクリプトは以下を機械検証する（read-only の走査・副作用なし・bash 3.2 でも走る）:
#   1. `ts/apps/*/e2e/` 配下の `.ts` のうち、`fixtures/` の内側に無いものが `page.goto(` を
#      1 件も持たない（spec だけでなく helper・stub も対象。所有者を 1 種類に絞るため）
#   2. 例外は WHITELIST へ理由と Issue 番号つきで明記する（下記）。載っているのに違反が
#      無くなったものは警告して削除を促す
#   3. 空振り防止: 走査対象が 0 件、または `fixtures/` 側に `page.goto(` が 1 件も無いなら赤
#      （**後者が重要である。** 「誰も面を開かなくなった」状態は、禁止が守られている状態と
#        区別が付かないまま緑を返す）
#
# 使い方: bash scripts/check-e2e-goto-ownership.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APPS_DIR="${ROOT}/ts/apps"

GOTO_MARK='page.goto('

# 意図的な例外。形式は `'<リポジトリ相対パス>|<理由と Issue 番号>'`。
# **必ず理由と Issue を書くこと。** 一度きりの URL へ直接行く正当な場面はありうるが、
# 理由の無い例外は「面倒だから外した」と区別が付かない。
# 現在は空。
WHITELIST=()

if [ ! -d "$APPS_DIR" ]; then
  echo "ERROR: ${APPS_DIR#$ROOT/} がありません。走査の前提が崩れています。" >&2
  exit 1
fi

fail=0
scanned_count=0
fixture_goto_count=0
violation_count=0
# 違反として検出したパス（WHITELIST の不活性検出に使う）。
detected_paths=''

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

# WHITELIST に載っているパスか。
is_whitelisted() {
  iw_path="$1"
  # bash 3.2 は空配列の "${a[@]}" で落ちる。展開そのものを条件にする。
  for entry in ${WHITELIST[@]+"${WHITELIST[@]}"}; do
    iw_head="${entry%%|*}"
    [ "$iw_head" = "$iw_path" ] && return 0
  done
  return 1
}

for app_path in "$APPS_DIR"/*/; do
  [ -d "$app_path" ] || continue
  e2e_dir="${app_path}e2e"
  [ -d "$e2e_dir" ] || continue

  # `-mindepth` は使わない（深さ N 未満の述語評価ごと飛ばすため、深さの制限と除外を同時に
  # 書くと除外が発火しない・Issue #131 の教訓）。fixtures の除外はパスの形で判定する。
  e2e_files="$(find "$e2e_dir" -type f -name '*.ts')"
  [ -n "$e2e_files" ] || continue

  for f in $e2e_files; do
    rel="${f#$ROOT/}"
    n="$(count_fixed "$GOTO_MARK" "$f")"
    case "$f" in
      */fixtures/*)
        # 所有者側。ここに goto があることが「誰かが面を開いている」ことの証拠になる。
        fixture_goto_count=$((fixture_goto_count + n))
        continue
        ;;
    esac

    scanned_count=$((scanned_count + 1))
    [ "$n" -gt 0 ] || continue

    detected_paths="${detected_paths} ${rel}"
    if is_whitelisted "$rel"; then
      continue
    fi
    violation_count=$((violation_count + 1))
    echo "ERROR: ${rel} が ${GOTO_MARK} を ${n} 件持っています（面を spec 側で開いています）。" >&2
    echo "       → 開く手順と「本体が描けている」前提 assert は e2e/fixtures/ が単一の所有者です。" >&2
    echo "         spec 側へ書くと同じ前提が複数箇所へ複写され、片側だけが古びます（PR #191 では" >&2
    echo "         26 箇所のうち 10 箇所が fixtures と同じ assert を重複して持っていました）。" >&2
    fail=1
  done
done

# --- WHITELIST の不活性検出 ------------------------------------------------------------
# 載っているのに違反が無くなった項目は、一覧を実態から乖離させ続ける。

for entry in ${WHITELIST[@]+"${WHITELIST[@]}"}; do
  wl_path="${entry%%|*}"
  case " ${detected_paths} " in
    *" ${wl_path} "*) ;;
    *)
      echo "WARNING: ${wl_path} は WHITELIST に載っていますが違反として検出されませんでした。WHITELIST から削除してください。" >&2
      ;;
  esac
done

# --- 空振り防止 -------------------------------------------------------------------------

if [ "$scanned_count" -eq 0 ]; then
  echo "ERROR: ts/apps/*/e2e/ に走査対象の .ts が 1 件もありません。ガードが空振りしています。" >&2
  exit 1
fi

if [ "$fixture_goto_count" -eq 0 ]; then
  echo "ERROR: e2e/fixtures/ に ${GOTO_MARK} が 1 件もありません。" >&2
  echo "       → 「誰も面を開かなくなった」状態は、禁止が守られている状態と区別が付きません。" >&2
  echo "         所有者が実在することまで要求しないと、この検査は空振りしたまま緑を返します。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: 面を spec 側で開いているファイルが ${violation_count} 件あります（上記参照）。" >&2
  exit 1
fi

echo "OK: 面を開く手順の所有権を検証しました（走査 ${scanned_count} ファイル / fixtures 側の goto ${fixture_goto_count} 件・WHITELIST ${#WHITELIST[@]} 件）。"
