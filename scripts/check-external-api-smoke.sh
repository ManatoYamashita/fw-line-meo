#!/usr/bin/env bash
# Issue #125 ガードレール（層1・構造）: Issue #63 の二層検証は「宣言どおりの version が入っている」
# までしか言えず、**値そのものの正当性は原理的に検出できない**。CI に付くのは secret 単位の
# `roles/secretmanager.viewer` だけで、このロールは `secretmanager.versions.access` を含まず、
# project 単位の付与は Req 5.4 で禁止だからである。したがってプレースホルダー文字列・失効キー・
# 別プロジェクトのキー・課金無効はいずれもメタデータからは見えない。2026-07-05〜08-02 の
# gemini-api-key はまさにこの穴に落ち、機能A は go-live 以降一度も成功していなかった。
#
# 到達手段は「実際に外部 API を叩いて成功を観測する」ことだけである。だが **その行為を CI へ
# 持ち込んではならない**（鍵を CI へ渡すことになり、#63 の再発防止のために #63 より広い
# ブラストラディウスを開く）。そこで #63 が secrets-provisioned.tsv で確立したのと同じ形を採る:
# out-of-band の人手作業を **リポジトリ内の宣言で正典化し、CI は宣言の構造だけを両方向照合する**。
#
# 本スクリプトは以下を機械検証する（read-only の grep 検証・副作用なし・bash 3.2 でも走る）:
#   1. secret 正典（check-secret-declaration-coverage.sh --print-secrets）↔ 宣言行を **両方向** 照合
#   2. 宣言ファイルの形式（6 列・api 語彙・PENDING と日付と証拠の整合・secret_id の重複なし）
#   3. api（'-' 以外）↔ infra/README.md §8 の手順セクション見出しを **両方向** 照合
#   4. 空振り防止: 正典 0 件・宣言 0 行・README 見出し 0 件・**実疎通対象 0 件** はいずれも赤
#
# **日付を一切参照しない（`date` を呼ばない）。** 鮮度の判定は
# scripts/check-external-api-smoke-freshness.sh（定期ワークフロー）が持つ。ts-ci が時間依存に
# なると、何も触っていない PR がある日突然赤くなり、規律は「日付だけ更新する」空洞化へ倒れる。
# これは設定ではなく **本スクリプトに date が 1 箇所も無いという構造** で担保する。
#
# **api の語彙をこのスクリプトへ列挙しない。** 語彙の正典は README §8 の見出しであり、
# 宣言と README が互いの正典になる（TSV 側の綴り間違いは「対応する節が無い」で、README 側の
# 綴り間違いは「対応する行が無い」で落ちる）。ここへ配列を置くと 3 箇所目の二重管理になる。
#
# **WHITELIST を持たない。** 実疎通の対象外は宣言の api 列 '-' で in-band に表現する。
# スクリプト内の除外を併設すると、同じ意味を 2 つの機構で書けてしまい、どちらが正かが決まらない。
#
# 使い方: bash scripts/check-external-api-smoke.sh
#   漏れがあれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ $# -gt 0 ]; then
  case "$1" in
    -h|--help)
      sed -n '2,33p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: 未知の引数です: $1" >&2
      echo "       → 使い方は bash scripts/check-external-api-smoke.sh --help を参照してください。" >&2
      exit 2
      ;;
  esac
fi

DECL_FILE="${ROOT}/infra/external-api-smoke.tsv"
README_FILE="${ROOT}/infra/README.md"
COVERAGE_GUARD="${SCRIPT_DIR}/check-secret-declaration-coverage.sh"

for f in "$DECL_FILE" "$README_FILE" "$COVERAGE_GUARD"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: 検証対象ファイルが見つかりません: ${f#"$ROOT"/}" >&2
    exit 1
  fi
done

in_list() {
  # $1=needle, 残り=list
  needle="$1"
  shift
  for x in "$@"; do
    [ "$x" = "$needle" ] && return 0
  done
  return 1
}

count_lines() {
  # $1=改行区切りの文字列。空なら 0。`wc -l` は入力を最後まで読むので SIGPIPE を起こさない
  # （`grep -c` を素で代入すると無一致の exit 1 で set -e に殺されるため、件数はこちらで数える）。
  if [ -z "$1" ]; then
    printf '0\n'
    return 0
  fi
  printf '%s\n' "$1" | wc -l | tr -d '[:space:]'
}

fail=0

# --- 検証1: secret 正典の取得（列挙を二重管理しない） ----------------------------------------
#
# 正典は check-secret-declaration-coverage.sh --print-secrets から導出する
# （check-deploy-image-coverage.sh --print-targets と同一の契約）。**上流が赤なら即座に落ちる。**
# 壊れた正典から導出した集合で下流を緑にするのが最悪の空振りであるため、ここでは救済しない。
# stderr は握り潰さず素通しする（上流の診断が消えると原因を告げない赤になる）。
canon_rc=0
canon_tsv="$(bash "$COVERAGE_GUARD" --print-secrets)" || canon_rc=$?
if [ "$canon_rc" -ne 0 ]; then
  echo "ERROR: secret 正典を取得できません（check-secret-declaration-coverage.sh が exit=${canon_rc}）。" >&2
  echo "       → 先にシークレット宣言カバレッジの赤を直してください。壊れた正典から導出した集合で" >&2
  echo "         本ガードを緑にすると、棚卸しの母数そのものが誤ったまま通ります。" >&2
  exit 1
fi

canon_ids_rc=0
canon_ids="$(printf '%s\n' "$canon_tsv" | sed -E 's/\t.*$//' | grep -E '^[a-z0-9-]+$' | sort -u)" || canon_ids_rc=$?
if [ "$canon_ids_rc" -gt 1 ]; then
  # 無一致（1）と評価不能（2 以上）を分ける。両方を「0 件」へ潰すと、原因の異なる 2 つが
  # 同じ診断へ落ちる（Issue #120）。
  echo "ERROR: secret 正典の抽出パターンを評価できません（grep exit=${canon_ids_rc}）。" >&2
  exit 1
fi
if [ -z "$canon_ids" ]; then
  echo "ERROR: secret 正典から secret_id を1件も抽出できませんでした（--print-secrets の書式が変わっています）。" >&2
  echo "       → 対象 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  exit 1
fi
canon_count="$(count_lines "$canon_ids")"

# --- 検証2: 宣言ファイルの読み込みと形式検査 -------------------------------------------------
decl_rows_rc=0
decl_rows="$(grep -vE '^[[:space:]]*(#|$)' "$DECL_FILE")" || decl_rows_rc=$?
if [ "$decl_rows_rc" -gt 1 ]; then
  # 潰すと「ファイルを読めない」が「データ行が 0 行」と同義に化け、原因の異なる 2 つが
  # 同じ診断へ落ちる（Issue #120）。
  echo "ERROR: ${DECL_FILE#"$ROOT"/} を読めません（grep exit=${decl_rows_rc}）。" >&2
  exit 1
fi
if [ -z "$decl_rows" ]; then
  echo "ERROR: ${DECL_FILE#"$ROOT"/} からデータ行を1行も読めませんでした（コメントと空行しかありません）。" >&2
  echo "       → 宣言 0 行のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  exit 1
fi

decl_ids=""
decl_apis=""
decl_count=0
target_count=0
pending_count=0
lineno=0
while IFS= read -r raw || [ -n "$raw" ]; do
  lineno=$((lineno + 1))
  trimmed="${raw#"${raw%%[![:space:]]*}"}"
  case "$trimmed" in
    ''|'#'*) continue ;;
  esac
  decl_count=$((decl_count + 1))

  d_id=''
  d_api=''
  d_last=''
  d_evid=''
  d_ref=''
  d_note=''
  d_extra=''
  IFS="$(printf '\t')" read -r d_id d_api d_last d_evid d_ref d_note d_extra <<TSVROW
$raw
TSVROW

  if [ -n "$d_extra" ]; then
    echo "ERROR: ${DECL_FILE#"$ROOT"/}:${lineno} の列が 6 列を超えています（列区切りはタブ 1 個です）。" >&2
    fail=1
    continue
  fi
  if [ -z "$d_id" ] || [ -z "$d_api" ] || [ -z "$d_last" ] || [ -z "$d_evid" ] || [ -z "$d_ref" ] || [ -z "$d_note" ]; then
    echo "ERROR: ${DECL_FILE#"$ROOT"/}:${lineno} は 6 列（secret_id / api / 最終確認日 / 証拠 / Issue-PR / 説明）が揃っていません。" >&2
    fail=1
    continue
  fi

  case "$d_id" in
    ''|*[!a-z0-9-]*)
      echo "ERROR: ${DECL_FILE#"$ROOT"/}:${lineno} の secret_id '${d_id}' が [a-z0-9-]+ の形ではありません。" >&2
      fail=1
      continue
      ;;
  esac

  # shellcheck disable=SC2086 # decl_ids は改行区切りで意図的に単語分割する
  if in_list "$d_id" $decl_ids; then
    echo "ERROR: ${DECL_FILE#"$ROOT"/}:${lineno} の secret_id '${d_id}' が宣言ファイルに重複しています（どちらが正か決まりません）。" >&2
    fail=1
    continue
  fi
  decl_ids="${decl_ids}${d_id}"$'\n'

  case "$d_ref" in
    '#'[0-9]*) ;;
    *)
      echo "ERROR: ${DECL_FILE#"$ROOT"/}:${lineno} の Issue-PR 列は '#<番号>' の形で書いてください（現在: '${d_ref}'）。" >&2
      fail=1
      ;;
  esac

  if [ "$d_api" = '-' ]; then
    # 実疎通の対象外。日付も証拠も持たないことを要求する（持てば「叩いたのに対象外」という
    # 読み手を惑わす行になる）。理由は説明列に必ず書かせる（上の 6 列非空検査が担保する）。
    if [ "$d_last" != '-' ] || [ "$d_evid" != '-' ]; then
      echo "ERROR: ${DECL_FILE#"$ROOT"/}:${lineno} は api が '-'（実疎通の対象外）なので最終確認日と証拠は '-' にしてください。" >&2
      fail=1
    fi
    continue
  fi

  case "$d_api" in
    [a-z]|[a-z]*[!a-z-]*)
      # 1 文字だけ、あるいは [a-z-] 以外を含む綴りを弾く。api の語彙そのものは README §8 の
      # 見出しが正典であり、ここでは形だけを見る。
      echo "ERROR: ${DECL_FILE#"$ROOT"/}:${lineno} の api '${d_api}' が [a-z][a-z-]+ の形ではありません（'-' は対象外の意味です）。" >&2
      fail=1
      continue
      ;;
  esac

  target_count=$((target_count + 1))
  decl_apis="${decl_apis}${d_api}"$'\n'

  if [ "$d_last" = 'PENDING' ]; then
    pending_count=$((pending_count + 1))
    if [ "$d_evid" != '-' ]; then
      echo "ERROR: ${DECL_FILE#"$ROOT"/}:${lineno} は PENDING（未実施）なので証拠は '-' にしてください（現在: '${d_evid}'）。" >&2
      fail=1
    fi
    continue
  fi

  case "$d_last" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *)
      echo "ERROR: ${DECL_FILE#"$ROOT"/}:${lineno} の最終確認日は YYYY-MM-DD か PENDING で書いてください（現在: '${d_last}'）。" >&2
      fail=1
      continue
      ;;
  esac

  if [ "$d_evid" = '-' ]; then
    echo "ERROR: ${DECL_FILE#"$ROOT"/}:${lineno} は実施日が入っているのに証拠が '-' です。" >&2
    echo "       → 証拠列は「本当に叩いたのか」を第三者が後から辿るための唯一の手掛かりです。" >&2
    echo "         実行日時・run URL・execution id など、辿れる識別子を書いてください（infra/README.md §8-4）。" >&2
    fail=1
  fi
done < "$DECL_FILE"

if [ "$target_count" -eq 0 ]; then
  echo "ERROR: ${DECL_FILE#"$ROOT"/} に実疎通の対象（api が '-' 以外）が1件もありません。" >&2
  echo "       → 全行を対象外へ倒すと、鮮度検証（層2）が何も見ないまま恒久的に緑になります。" >&2
  echo "         外部 API を叩く経路が本当に消えたのなら、本ガードとワークフローごと撤去してください。" >&2
  exit 1
fi

# --- 検証3: 正典 ↔ 宣言（両方向） ------------------------------------------------------------
# shellcheck disable=SC2086 # canon_ids は改行区切りで意図的に単語分割する
for s in $canon_ids; do
  # shellcheck disable=SC2086 # decl_ids は改行区切りで意図的に単語分割する
  if ! in_list "$s" $decl_ids; then
    echo "ERROR: secret 正典の '${s}' が ${DECL_FILE#"$ROOT"/} にありません。" >&2
    echo "       → 外部 API を叩く鍵なら api（gemini / places / line-messaging …）と PENDING を、" >&2
    echo "         叩かない鍵なら api '-' と対象外である理由を書いた行を足してください。" >&2
    echo "         分類そのものを宣言させるのは、棚卸しの漏れが「行が無い」という不可視の形に" >&2
    echo "         ならないようにするためです。" >&2
    fail=1
  fi
done

# shellcheck disable=SC2086 # decl_ids は改行区切りで意図的に単語分割する
for s in $decl_ids; do
  # shellcheck disable=SC2086 # canon_ids は改行区切りで意図的に単語分割する
  if ! in_list "$s" $canon_ids; then
    echo "ERROR: ${DECL_FILE#"$ROOT"/} の '${s}' が secret 正典にありません。" >&2
    echo "       → tf から枠を消したなら本宣言の行も消してください（残すと存在しない鍵の実疎通を" >&2
    echo "         永久に要求し続けます）。" >&2
    fail=1
  fi
done

# --- 検証4: api ↔ README §8 の手順セクション（両方向） ---------------------------------------
#
# 見出しの形は `### 8-<番号>. <api>: <説明>` に固定する。api を含まない節（8-0 一括実行・
# 8-4 記録の更新）は日本語で始まるためこのパターンに当たらない。
readme_rc=0
readme_apis="$(grep -oE '^### 8-[0-9]+\. [a-z][a-z-]+:' "$README_FILE" \
  | sed -E 's/^### 8-[0-9]+\. ([a-z][a-z-]+):$/\1/' | sort -u)" || readme_rc=$?
if [ "$readme_rc" -gt 1 ]; then
  echo "ERROR: §8 手順セクションの抽出パターンを評価できません（grep exit=${readme_rc}）: ${README_FILE#"$ROOT"/}" >&2
  exit 1
fi
if [ -z "$readme_apis" ]; then
  echo "ERROR: ${README_FILE#"$ROOT"/} から '### 8-<番号>. <api>: …' の見出しを1件も抽出できませんでした。" >&2
  echo "       → §8（外部 API 実疎通の手順）の見出し書式が変わっています。抽出 0 件のまま" >&2
  echo "         「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  exit 1
fi
readme_count="$(count_lines "$readme_apis")"

decl_apis_uniq="$(printf '%s' "$decl_apis" | sort -u)"
# shellcheck disable=SC2086 # decl_apis_uniq は改行区切りで意図的に単語分割する
for a in $decl_apis_uniq; do
  # shellcheck disable=SC2086 # readme_apis は改行区切りで意図的に単語分割する
  if ! in_list "$a" $readme_apis; then
    echo "ERROR: ${DECL_FILE#"$ROOT"/} の api '${a}' に対応する手順が ${README_FILE#"$ROOT"/} §8 にありません。" >&2
    echo "       → '### 8-<番号>. ${a}: <説明>' の節を足し、無害な最小呼び出しと成功の証拠を書いてください。" >&2
    echo "         手順の無い実疎通は「誰も同じことを再現できない」ため、記録が検証不能になります。" >&2
    fail=1
  fi
done

# shellcheck disable=SC2086 # readme_apis は改行区切りで意図的に単語分割する
for a in $readme_apis; do
  # shellcheck disable=SC2086 # decl_apis_uniq は改行区切りで意図的に単語分割する
  if ! in_list "$a" $decl_apis_uniq; then
    echo "ERROR: ${README_FILE#"$ROOT"/} §8 の手順にある api '${a}' が ${DECL_FILE#"$ROOT"/} にありません。" >&2
    echo "       → 手順だけがあり記録される先が無い状態です。宣言へ行を足すか、手順を削除してください。" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "NG: 外部 API 実疎通の宣言に漏れがあります（上記参照）。" >&2
  exit 1
fi

echo "OK: 外部 API 実疎通の宣言カバレッジ緑（secret 正典 ${canon_count} 件 / 宣言 ${decl_count} 行（実疎通対象 ${target_count}・うち PENDING ${pending_count}）/ README §8 手順 ${readme_count} 件を両方向照合）。"
exit 0
