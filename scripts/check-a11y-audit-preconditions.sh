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
# **「前提」は 2 つある。** 1〜5 が守るのは「面が本体を描けているか」だが、それだけでは監査結果は
# 意味を持たない。もう 1 つは「規則が実際に走ったか」である。axe は include のセレクタが外れる・
# 注入が失敗するといった経路で、例外ではなく**空の結果**を返す。その 0 件を合格と読むと、
# 監査していないことが監査に合格したことと同義になる。steering tech.md の「違反 0 件と規則 0 件を
# 区別する」がこれで、`expectNoAxeViolations` の `passes + incomplete + violations > 0` が
# その実体である。以下も併せて機械検証する:
#   6. 監査ヘルパ（`@axe-core/playwright` を import する ts/packages/*/src の .ts）がちょうど
#      1 件あり、規則件数の区別を成り立たせている 3 項を保っている
#      （0 件 = ヘルパごと消えた・2 件以上 = 正典が割れた、のどちらも赤）
#   7. アプリ側（ts/apps/*/e2e/**）が axe を直接掴んでいない。**これが現実的な迂回路である。**
#      ヘルパの中身をいくら守っても、spec が `new AxeBuilder(...)` を直に書いて違反だけを
#      assert すれば、規則 0 件の区別は最初から存在しないことになる。
#
# **6・7 の照合は import 形（`from '@axe-core/playwright'`）でアンカーする。** 素のパッケージ名で
# 数えると散文が混じる。実際、本リポジトリの fixtures はコメントで版を記録しており、素の名前で
# 数えた時点で偽陽性になった（実測）。
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
# 監査ヘルパの同定に使う import 形。散文の偽陽性を避けるため、素のパッケージ名では数えない。
AXE_IMPORT="from '@axe-core/playwright'"
# axe を直に掴む形。import を経由しない書き方（再 export 越し等）もここで拾う。
AXE_CTOR='new AxeBuilder('
# 規則件数の区別を成り立たせている 3 項。1 つでも欠ければ「違反 0 件」と「規則 0 件」が同じ緑に
# 化ける。式そのもの（連結した 1 行）で照合しないのは、整形で折り返された瞬間に赤くなり、
# 踏んだ人がガードのほうを緩める圧力になるからである。項ごとに要求する。
RULE_TERM_PASSES='results.passes.length'
RULE_TERM_INCOMPLETE='results.incomplete.length'
RULE_TERM_ASSERT='toBeGreaterThan(0)'

if [ ! -d "$APPS_DIR" ]; then
  echo "ERROR: ${APPS_DIR#$ROOT/} がありません。走査の前提が崩れています。" >&2
  exit 1
fi

fail=0
audit_spec_count=0
fixture_module_count=0
helper_count=0
helper_files=''

# 指定ファイルに含まれる固定文字列の件数を返す。grep の「無一致（1）」と「評価不能（2 以上）」を
# 分けて扱う（後置 true で潰すと、評価不能が「違反 0 件」に化ける・Issue #120）。
# **この関数の中で fail を立ててはならない。** 呼び出しはコマンド置換（副シェル）なので、
# 代入した値は親へ戻らず、stderr のエラーだけが出て exit 0 という**偽の緑**になる
# （PR #192 レビュー指摘 1 の付帯。姉妹ガードで OK / exit 0 を実測した）。評価不能は
# 負値で返し、判定は下の count_checked が**親シェルで**行う。
count_fixed() {
  cf_rc=0
  cf_n="$(grep -cF "$1" "$2")" || cf_rc=$?
  if [ "$cf_rc" -gt 1 ]; then
    echo "ERROR: ${2#$ROOT/} の走査に失敗しました（grep exit ${cf_rc}）。判定不能を 0 件として扱いません。" >&2
    cf_n=-1
  fi
  printf '%s' "$cf_n"
}

# count_fixed の結果を CF_N へ入れる。**この関数は subshell ではないので fail が親へ残る。**
# 評価不能は fail-closed（赤）にしたうえで 0 として扱う。以降の判定は極性がまちまちだが、
# fail が立っている以上どの経路を通っても緑にはならない。
count_checked() {
  CF_N="$(count_fixed "$1" "$2")"
  if [ "$CF_N" -lt 0 ]; then
    echo "ERROR: ${2#$ROOT/} を走査できなかったため判定できません。" >&2
    echo "       → 判定不能を「違反なし」と読みません。" >&2
    fail=1
    CF_N=0
  fi
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
    count_checked "$AUDIT_MARK" "$spec"
    mark_n="$CF_N"
    [ "$mark_n" -gt 0 ] || continue
    audit_spec_count=$((audit_spec_count + 1))
    spec_rel="${spec#$ROOT/}"
    spec_dir="$(dirname "$spec")"

    # --- 2. 面を開く手順を spec へ直書きしていない ---------------------------------------
    count_checked "$GOTO_MARK" "$spec"
    goto_n="$CF_N"
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

      count_checked "$FIXTURE_GOTO" "$fixture_path"

      fg_n="$CF_N"
      count_checked "$FIXTURE_ASSERT" "$fixture_path"
      fa_n="$CF_N"
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

# --- 6. 監査ヘルパが規則件数の区別を保っている -------------------------------------------

for pkg_path in "$ROOT"/ts/packages/*/; do
  [ -d "${pkg_path}src" ] || continue
  pkg_files="$(find "${pkg_path}src" -type f -name '*.ts')"
  [ -n "$pkg_files" ] || continue
  for pkg_file in $pkg_files; do
    count_checked "$AXE_IMPORT" "$pkg_file"
    imp_n="$CF_N"
    [ "$imp_n" -gt 0 ] || continue
    helper_count=$((helper_count + 1))
    helper_files="${helper_files} ${pkg_file}"
  done
done

if [ "$helper_count" -eq 0 ]; then
  echo "ERROR: 監査ヘルパが ts/packages/*/src に 1 件もありません（axe の import が消えています）。" >&2
  echo "       → 規則 0 件の区別を担う実体が存在しません。監査ごと不要になったのなら、本ガードと" >&2
  echo "         CI のステップも併せて外してください。" >&2
  fail=1
elif [ "$helper_count" -gt 1 ]; then
  echo "ERROR: 監査ヘルパが ${helper_count} 件あります（正典が割れています）:" >&2
  for helper_file in $helper_files; do
    echo "       - ${helper_file#$ROOT/}" >&2
  done
  echo "       → 規律を 1 箇所で守れなくなります。片方だけ空振り防止を失っても誰も気づけません。" >&2
  fail=1
else
  for helper_file in $helper_files; do
    helper_rel="${helper_file#$ROOT/}"
    for term in "$RULE_TERM_PASSES" "$RULE_TERM_INCOMPLETE" "$RULE_TERM_ASSERT"; do
      count_checked "$term" "$helper_file"
      term_n="$CF_N"
      if [ "$term_n" -eq 0 ]; then
        echo "ERROR: ${helper_rel} に ${term} がありません（違反 0 件と規則 0 件を区別できません）。" >&2
        echo "       → axe は include が外れる・注入が失敗する経路で例外ではなく空の結果を返します。" >&2
        echo "         その 0 件を合格と読むと、監査していないことが監査に合格したことと同義になります。" >&2
        fail=1
      fi
    done
  done
fi

# --- 7. アプリ側が axe を直接掴んでいない -------------------------------------------------

for app_path in "$APPS_DIR"/*/; do
  [ -d "${app_path}e2e" ] || continue
  app_files="$(find "${app_path}e2e" -type f -name '*.ts')"
  [ -n "$app_files" ] || continue
  for app_file in $app_files; do
    app_rel="${app_file#$ROOT/}"
    count_checked "$AXE_IMPORT" "$app_file"
    di_n="$CF_N"
    count_checked "$AXE_CTOR" "$app_file"
    dc_n="$CF_N"
    if [ "$di_n" -gt 0 ] || [ "$dc_n" -gt 0 ]; then
      echo "ERROR: ${app_rel} が axe を直接掴んでいます（監査ヘルパを迂回しています）。" >&2
      echo "       → ヘルパの中身をいくら守っても、spec が直に axe を回して違反だけを assert すれば" >&2
      echo "         規則 0 件の区別は最初から存在しません。@fwlm/e2e-support の入口を使ってください。" >&2
      fail=1
    fi
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

echo "OK: a11y 監査の前提固定を検証しました（監査 spec ${audit_spec_count} 件 / fixtures モジュール ${fixture_module_count} 件 / 監査ヘルパ ${helper_count} 件）。"
