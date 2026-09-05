#!/usr/bin/env bash
# Issue #53 ガードレール: 自動 a11y 監査は、**面が本体を描けていることを先に固定してから**
# 当てなければ意味を持たない。空の画面・エラー画面には違反が出ようがないため、前提を置かない
# 監査は面が壊れたときにこそ最も静かに緑を返す。
#
# これは机上の懸念ではない。PR #191 のレビューで実測した:
#   `/s/{storeId}` の unavailable 分岐（店舗不在・place 未確定）が返す 1 段落だけの DOM へ
#   WCAG A/AA タグで axe を当てると **violations 0 / passes 5**（aria-hidden-body・
#   color-contrast・document-title・html-has-lang・html-lang-valid）になる。`<html lang>` と
#   `<title>` があるだけで `expectNoAxeViolations` の「規則が 1 件も走っていない」検出
#   （passes + incomplete + violations > 0）まで満たすため、**回答画面を一度も監査せずに
#   2 件とも緑を返していた**（是正前の spec をスタブへ当てて 2 passed を確認済み）。
#
# steering `tech.md` はこれを規律として明文化したが、**文章の規律は現に破られた**。同じ PR が
# 9 経路のうち 2 経路で自ら破っており、しかも CI は全緑だった。だからここで機械強制する。
#
# 本スクリプトは以下を機械検証する（read-only の走査・副作用なし・bash 3.2 でも走る）:
#   1. 監査 spec を **ファイル名ではなく `expectNoAxeViolations` の呼び出し**で同定する
#      （`a11y-audit.spec.ts` という名前に依存すると、改名した瞬間に走査対象が消えて空振りする）
#   2. 監査 spec に `page.goto(` が 1 件も現れない（面を開く手順を spec へ直書きしない）
#   3. 監査 spec が `./fixtures/` 配下のモジュールを 1 件以上 import している
#   4. その fixtures モジュールが `page.goto(` と `expect(` の**両方**を持つ
#      （3 だけでは「goto を移しただけで前提 assert が無い」形を通してしまう。移設ではなく
#        「開く手順と前提 assert が同居していること」が守りたい性質である）
#   5. 空振り防止: 監査 spec が 0 件なら赤（走査の前提が崩れたまま緑を返さない）
#
# 使い方: bash scripts/check-a11y-audit-preconditions.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APPS_DIR="${ROOT}/ts/apps"

# 監査 spec の同定に使う呼び出し。@fwlm/e2e-support/a11y が公開する唯一の入口であり、
# 「axe を当てている spec」の実体そのものである。表やファイル名へ書き写すと、実物が動いた
# ときに一覧だけが古びて走査対象から外れる。
AUDIT_MARK='expectNoAxeViolations'
# 面を開く手順を spec へ直書きしている形。
GOTO_MARK='page.goto('
# fixtures 側が「開く手順」と「前提 assert」を同居させていることの形。
FIXTURE_GOTO="$GOTO_MARK"
FIXTURE_ASSERT='expect('

if [ ! -d "$APPS_DIR" ]; then
  echo "ERROR: ${APPS_DIR#$ROOT/} がありません。走査の前提が崩れています。" >&2
  exit 1
fi

fail=0
audit_spec_count=0
fixture_module_count=0

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

for app_path in "$APPS_DIR"/*/; do
  [ -d "$app_path" ] || continue
  e2e_dir="${app_path}e2e"
  [ -d "$e2e_dir" ] || continue

  # `-mindepth` は使わない（深さ N 未満の述語評価ごと飛ばすため、深さの制限と除外を同時に
  # 書くと除外が発火しない・Issue #131 の教訓）。深さの都合はシェル側で扱う。
  spec_files="$(find "$e2e_dir" -type f -name '*.spec.ts')"
  [ -n "$spec_files" ] || continue

  for spec in $spec_files; do
    mark_n="$(count_fixed "$AUDIT_MARK" "$spec")"
    [ "$mark_n" -gt 0 ] || continue
    audit_spec_count=$((audit_spec_count + 1))
    spec_rel="${spec#$ROOT/}"
    spec_dir="$(dirname "$spec")"

    # --- 2. 面を開く手順を spec へ直書きしていない ---------------------------------------
    goto_n="$(count_fixed "$GOTO_MARK" "$spec")"
    if [ "$goto_n" -gt 0 ]; then
      echo "ERROR: ${spec_rel} が ${GOTO_MARK} を ${goto_n} 件直書きしています。" >&2
      echo "       → 監査 spec は面を自分で開いてはいけません。開く手順と「本体が描けている」" >&2
      echo "         前提 assert を e2e/fixtures/ の 1 箇所へ置き、そこを経由してください。" >&2
      echo "         前提を欠いた監査は、面が壊れたときに最も静かに緑を返します。" >&2
      fail=1
    fi

    # --- 3. fixtures を経由している -------------------------------------------------------
    # BRE で書く（BSD / GNU の双方で同じに読ませるため。ERE の \+ 等は移植性が無い）。
    fixture_rels="$(sed -n "s/.*from '\.\/\(fixtures\/[A-Za-z0-9_.-]*\)'.*/\1/p" "$spec")"
    if [ -z "$fixture_rels" ]; then
      echo "ERROR: ${spec_rel} が ./fixtures/ のモジュールを 1 件も import していません。" >&2
      echo "       → 面を開く手順が spec の内側にあるか、そもそも前提を固定していません。" >&2
      fail=1
      continue
    fi

    # --- 4. fixtures 側が「開く手順」と「前提 assert」を同居させている ---------------------
    for rel in $fixture_rels; do
      fixture_path="${spec_dir}/${rel}"
      case "$rel" in
        *.ts) ;;
        *) fixture_path="${fixture_path}.ts" ;;
      esac
      fixture_rel="${fixture_path#$ROOT/}"
      if [ ! -f "$fixture_path" ]; then
        echo "ERROR: ${spec_rel} が import する ${fixture_rel} が存在しません。" >&2
        fail=1
        continue
      fi
      fixture_module_count=$((fixture_module_count + 1))

      fg_n="$(count_fixed "$FIXTURE_GOTO" "$fixture_path")"
      fa_n="$(count_fixed "$FIXTURE_ASSERT" "$fixture_path")"
      if [ "$fg_n" -eq 0 ]; then
        echo "ERROR: ${fixture_rel} に ${FIXTURE_GOTO} がありません（面を開く手順を持っていません）。" >&2
        echo "       → 監査 spec が経由しているのに面を開かないのであれば、開く手順は" >&2
        echo "         どこか別の場所（おそらく spec の内側）に残っています。" >&2
        fail=1
      fi
      if [ "$fa_n" -eq 0 ]; then
        echo "ERROR: ${fixture_rel} に ${FIXTURE_ASSERT} がありません（前提 assert を持っていません）。" >&2
        echo "       → 開く手順だけを移しても守りたい性質は満たされません。「本体が描けている」" >&2
        echo "         ことをここで先に固定しないと、空の画面が監査に合格します。" >&2
        fail=1
      fi
    done
  done
done

# --- 5. 空振り防止 ---------------------------------------------------------------------

if [ "$audit_spec_count" -eq 0 ]; then
  echo "ERROR: ${AUDIT_MARK} を呼ぶ spec が 1 件もありません。ガードが空振りしています。" >&2
  echo "       → 自動 a11y 監査ごと不要になったのなら、本ガードと CI のステップも併せて" >&2
  echo "         外してください（「対象 0 件だから緑」を恒久の状態にしないこと）。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: a11y 監査の前提固定に違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: a11y 監査の前提固定を検証しました（監査 spec ${audit_spec_count} 件 / fixtures モジュール ${fixture_module_count} 件）。"
