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
# 本スクリプトは以下を機械検証する（read-only の grep 検証・副作用なし・bash 3.2 でも走る）:
#   1. `.github/workflows/*.yml` の `name:` 行のうち、値が引用符で始まらず ` #` を含むものを検出
#   2. 空振り防止: workflow ファイル 0 件・`name:` 行 0 件はいずれも赤
#      （走査の前提が崩れたまま「違反 0 件だから緑」を返さない）
#
# 既知の限界: `run:` ブロックの中に `name: …` で始まる行を書くと、それも `name:` 行として
# 扱われる。値を引用符で囲めば緑になるため実害は小さいが、誤検出だと判断した場合は
# WHITELIST へ `<ファイル名>:<行番号>` 形式で理由と Issue 番号を添えて登録すること。
#
# 使い方: bash scripts/check-workflow-step-names.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW_DIR="${ROOT}/.github/workflows"

# 意図的に許容する行（必ず理由と Issue を明記すること）。
# 形式: `WHITELIST=(ts-ci.yml:42)`。現在は空。
WHITELIST=()

# `name:` 行そのもの（違反かどうかに関わらず）。空振り防止の母数に使う。
NAME_LINE_RE='^[[:space:]]*(-[[:space:]]+)?name:[[:space:]]'
# 違反行: 値が引用符でも空白でもない文字で始まり、そのあとに「空白 + #」が現れる。
BAD_LINE_RE="^[[:space:]]*(-[[:space:]]+)?name:[[:space:]]+[^'\"[:space:]].*[[:space:]]#"

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

for wf_path in "$WORKFLOW_DIR"/*.yml "$WORKFLOW_DIR"/*.yaml; do
  [ -f "$wf_path" ] || continue
  wf="$(basename "$wf_path")"
  file_count=$((file_count + 1))

  # 件数で数える。`grep -q` は最初の一致で終了するため、上流が SIGPIPE で死んで
  # pipefail が入力サイズ依存の偽陽性を生む（#78 で実際に踏んだ）。
  hits="$(grep -cE "$NAME_LINE_RE" "$wf_path" || true)"
  name_line_count=$((name_line_count + hits))

  # 違反行を行番号つきで取り出す。無一致の exit 1 は `|| true` で受ける。
  bad="$(grep -nE "$BAD_LINE_RE" "$wf_path" || true)"
  [ -n "$bad" ] || continue

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    lineno="${line%%:*}"
    # ${arr[@]+...} は空配列でも set -u（bash 3.2 含む）で unbound エラーにしない安全な展開。
    if in_list "${wf}:${lineno}" ${WHITELIST[@]+"${WHITELIST[@]}"}; then
      echo "SKIP: ${wf}:${lineno}（WHITELIST・理由はスクリプト内コメント参照）"
      continue
    fi
    bad_count=$((bad_count + 1))
    echo "ERROR: ${wf}:${lineno} の name: が引用符で囲まれておらず ' #' を含みます。表示名がそこで切れます。" >&2
    echo "       | ${line#*:}" >&2
    fail=1
  done <<EOF
$bad
EOF
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

if [ "$fail" -ne 0 ]; then
  echo "NG: 表示名が切れる name: が ${bad_count} 件あります。値を引用符で囲んでください（例: - name: 'ガード（Issue #105）'）。" >&2
  exit 1
fi

echo "OK: ワークフロー表示名ガード緑（${file_count} ファイル / ${name_line_count} 件の name: を検証・WHITELIST ${#WHITELIST[@]} 件）。"
exit 0
