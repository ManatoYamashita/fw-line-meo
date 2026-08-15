#!/usr/bin/env bash
# Issue #105 ガードレール: YAML の plain scalar は **空白に続く `#` 以降をコメントとして捨てる**。
# 引用符で囲んでいない `name:` に ` #` が含まれると、GitHub Actions の UI とステップ一覧 API に
# 出る表示名がそこで切れる。本リポジトリはステップ名へ Issue 番号を書く規約なので、
# `- name: デザイントークンガード（Issue #41 …）` は `デザイントークンガード（Issue` になる。
#
# 動作には影響しない。だが **赤くなったステップを名前で特定できない** ため、CI 失敗時の
# 切り分けコストが上がる。YAML として妥当なので構文チェックでは検出されず、実際に本リポジトリで
# 3 度再発した（#89 のレビュー残件 → #100 で ts-ci.yml の 6 件 → #106 で deploy.yml の 1 件）。
# 人手の規律では 4 度目が来るため機械で弾く。
#
# 壊れ方は 2 形ある。値の **途中** の ` #` は表示名を途中で切り、値の **先頭** の `#` は値ごと
# 捨てて name を null にする（表示名が丸ごと消え、Actions は代わりに run の内容を出す）。
# 後者は PR #113 のレビューで検出漏れが実測された形である。
#
# 本スクリプトは以下を機械検証する（read-only の grep 検証・副作用なし・bash 3.2 でも走る）:
#   1. `.github/workflows/*.yml` および `*.yaml` の `name:` 行のうち、
#      値が引用符で始まらず ` #` を含むもの（表示名が切れる）を検出
#   2. 同じく `name:` の値が `#` で始まるもの（name が null になる）を検出
#   3. 空振り防止: workflow ファイル 0 件・`name:` 行 0 件はいずれも赤
#      （走査の前提が崩れたまま「違反 0 件だから緑」を返さない）
#   4. WHITELIST の項目が 1 件も当たらなくなったら WARNING を出す（無意味な除外を残さない）
#
# 既知の限界: `run:` ブロックの中に `name: …` で始まる行を書くと、それも `name:` 行として
# 扱われる。誤検出だと判断した場合は WHITELIST へ `<ファイル名>|<行の内容>` 形式で、理由と
# Issue 番号をコメントに添えて登録すること。**行番号で同定してはならない**（PR #113 レビュー
# 指摘2）。行番号は上に 1 行挿入されただけでずれ、意図しない別の行の違反を無言で抑止する。
#
# 使い方: bash scripts/check-workflow-step-names.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW_DIR="${ROOT}/.github/workflows"

# 意図的に許容する行（必ず理由と Issue を明記すること）。
# 形式: `WHITELIST=('ts-ci.yml|- name: 除外したい行 # 補足')`。値は前後の空白を除いた行そのもの。
# 現在は空。
WHITELIST=()

# `name:` 行そのもの（違反かどうかに関わらず）。空振り防止の母数に使う。
NAME_LINE_RE='^[[:space:]]*(-[[:space:]]+)?name:[[:space:]]'
# 違反1: 値が引用符・空白・`#` のいずれでもない文字で始まり、そのあとに「空白 + #」が現れる。
# 先頭の `#` を除外しておくことで、下の違反2 と排他になり同じ行を二重報告しない。
TRUNC_LINE_RE="^[[:space:]]*(-[[:space:]]+)?name:[[:space:]]+[^'\"#[:space:]].*[[:space:]]#"
# 違反2: 値そのものが `#` で始まる。YAML は値ごとコメントとして捨てるため name は null になる。
NULL_LINE_RE='^[[:space:]]*(-[[:space:]]+)?name:[[:space:]]+#'

TRUNC_MSG="の name: が引用符で囲まれておらず ' #' を含みます。表示名がそこで切れます。"
NULL_MSG='の name: の値が # で始まります。YAML が値ごとコメントとして捨てるため表示名が消えます。'

if [ ! -d "$WORKFLOW_DIR" ]; then
  echo "ERROR: ワークフローディレクトリがありません: .github/workflows（走査の前提が崩れています）。" >&2
  exit 1
fi

in_list() {
  # $1=needle, 残り=list
  needle="$1"
  shift
  for x in "$@"; do
    [ "$x" = "$needle" ] && return 0
  done
  return 1
}

fail=0
file_count=0
name_line_count=0
bad_count=0

# 実際に当たった WHITELIST 項目。改行区切りで貯め、最後に「当たらなかった項目」を割り出す。
# 区切りに改行を使うのは、キーへ含まれ得ない唯一の文字だからである。
NL='
'
used_whitelist="$NL"

scan() {
  # $1=ファイル名 $2=ファイルパス $3=検出正規表現 $4=エラー本文
  #
  # **関数だが subshell ではないため** fail / bad_count / used_whitelist は呼び出し側へ残る。
  # ここをパイプへ変えると集計が失われるので注意すること。
  scan_wf="$1"
  scan_path="$2"

  # 違反行を行番号つきで取り出す。無一致の exit 1 は後置 true で受ける。
  scan_bad="$(grep -nE "$3" "$scan_path" || true)"
  [ -n "$scan_bad" ] || return 0

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    lineno="${line%%:*}"
    content="${line#*:}"

    # 前後の空白を除いた行そのものを WHITELIST のキーにする（行番号は使わない）。
    trimmed="${content#"${content%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    key="${scan_wf}|${trimmed}"

    # ${arr[@]+...} は空配列でも set -u（bash 3.2 含む）で unbound エラーにしない安全な展開。
    if in_list "$key" ${WHITELIST[@]+"${WHITELIST[@]}"}; then
      echo "SKIP: ${scan_wf}:${lineno}（WHITELIST・理由はスクリプト内コメント参照）"
      used_whitelist="${used_whitelist}${key}${NL}"
      continue
    fi

    bad_count=$((bad_count + 1))
    echo "ERROR: ${scan_wf}:${lineno} $4" >&2
    echo "       | ${content}" >&2
    fail=1
  done <<EOF
$scan_bad
EOF
  return 0
}

for wf_path in "$WORKFLOW_DIR"/*.yml "$WORKFLOW_DIR"/*.yaml; do
  [ -f "$wf_path" ] || continue
  wf="$(basename "$wf_path")"
  file_count=$((file_count + 1))

  # 件数で数える。`grep -q` は最初の一致で終了するため、上流が SIGPIPE で死んで
  # pipefail が入力サイズ依存の偽陽性を生む（#78 で実際に踏んだ）。
  hits="$(grep -cE "$NAME_LINE_RE" "$wf_path" || true)"
  name_line_count=$((name_line_count + hits))

  scan "$wf" "$wf_path" "$TRUNC_LINE_RE" "$TRUNC_MSG"
  scan "$wf" "$wf_path" "$NULL_LINE_RE" "$NULL_MSG"
done

# 空振り防止: 対象が 0 件なら「違反 0 件」は「検証していない」と同義である。
if [ "$file_count" -eq 0 ]; then
  echo "ERROR: .github/workflows にワークフローファイルが 1 件もありません。" >&2
  exit 1
fi
if [ "$name_line_count" -eq 0 ]; then
  echo "ERROR: name: 行を 1 件も検出できませんでした（走査パターンの前提が崩れています）。" >&2
  exit 1
fi

# 当たらなくなった除外を残さない（check-deploy-image-coverage.sh / check-guard-selftest-coverage.sh と同形）。
# 是正済みの行を除外したままにすると、次に同じ行が壊れたとき無言で見逃す。
for wl in ${WHITELIST[@]+"${WHITELIST[@]}"}; do
  case "$used_whitelist" in
    *"${NL}${wl}${NL}"*) continue ;;
  esac
  echo "WARNING: ${wl} は WHITELIST に載っていますが違反として検出されませんでした。WHITELIST から削除してください。" >&2
done

if [ "$fail" -ne 0 ]; then
  echo "NG: 表示名が壊れる name: が ${bad_count} 件あります。値を引用符で囲んでください（例: - name: 'ガード（Issue #105）'）。" >&2
  exit 1
fi

echo "OK: ワークフロー表示名ガード緑（${file_count} ファイル / ${name_line_count} 件の name: を検証・WHITELIST ${#WHITELIST[@]} 件）。"
exit 0
