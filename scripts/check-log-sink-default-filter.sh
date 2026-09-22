#!/usr/bin/env bash
# Issue #232 ガードレール（静的・GCP に触れない）: Logging が作成した `_Default` sink を
# Terraform の管理下へ置くとき、**既定の必須ログ除外を落としていない**ことを検証する。
#
# ## 何が起きたか（2026-09-22 実測）
#
# PR #245 は `_Default` sink を import して exclusions を 3 つ足した。ところが resource 側が
# `filter` を 1 行も宣言していなかったため、`terraform plan` は既存の filter を
# **`-> null`（= 全件受け入れ）** へ落とそうとしていた。`_Required` が 400 日無料で保持している
# 監査ログ（`cloudaudit.*` / `externalaudit.*` の 6 種）が、`_Default`（30 日・課金）へも
# 二重に入る状態である。本番の該当ログは 7 日で 882 件あった。
#
# **コメントは規律にならない。** 同 PR のモジュール冒頭には「既存の必須ログ除外を保ったまま
# exclusions を追加する」と書かれていたが、それを実装した行も、確かめる検査も無かった。
# 宣言と意図が食い違ったまま緑で通り、apply の直前に plan の属性を読んで初めて見つかった。
#
# ## 検証すること
#
#   1. `google_logging_project_sink` のうち `name = "_Default"` のものが `filter` を宣言している
#   2. その filter（`local.<名前>` の 1 段は解決する）が必須ログ ID 6 種すべてを除外している
#   3. 空振り防止: 走査対象 0 件・`_Default` sink 0 件・必須 ID の表が空 はいずれも赤
#
# 使い方: bash scripts/check-log-sink-default-filter.sh
#   逸脱があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INFRA_DIR="${ROOT}/infra"

# Logging が `_Default` sink の既定 filter で除外している必須ログ。ここが空なら検査は空振りする。
REQUIRED_LOG_IDS='cloudaudit.googleapis.com/activity
externalaudit.googleapis.com/activity
cloudaudit.googleapis.com/system_event
externalaudit.googleapis.com/system_event
cloudaudit.googleapis.com/access_transparency
externalaudit.googleapis.com/access_transparency'

# 管理下へ置く対象の sink 名（Logging が作成する既定のバケット sink）。
MANAGED_SINK_NAME='_Default'

failed=0

# **後置 `|| true` で grep の失敗を潰さない。** 無一致（exit 1）と評価不能（exit 2 以上）が
# 同じ 0 件に化け、パターンが壊れた瞬間に検査が素通りする（`scripts/check-grep-exit-codes.sh`
# が機械強制しており、本スクリプトの初版が実際に捕まった）。
# 呼出元で判定するため、**副シェルの中で fail を立てない**（親へ戻らない）。
grep_count() {
  gc_rc=0
  gc_out="$(grep -c "$@")" || gc_rc=$?
  if [ "$gc_rc" -gt 1 ]; then
    return 2
  fi
  printf '%s' "$gc_out"
  return 0
}

fail() {
  echo "ERROR: $1" >&2
  failed=1
}

if [ ! -d "$INFRA_DIR" ]; then
  echo "ERROR: infra ディレクトリがありません: ${INFRA_DIR#$ROOT/}。" >&2
  exit 1
fi

required_count="$(printf '%s\n' "$REQUIRED_LOG_IDS" | grep_count '[^[:space:]]')" || {
  echo "ERROR: 必須ログ ID の表を評価できません（grep が異常終了）。" >&2
  exit 1
}
if [ "$required_count" -eq 0 ]; then
  echo "ERROR: 必須ログ ID の表が空です。除外の欠落を検出できません。" >&2
  exit 1
fi

tf_files="$(find "$INFRA_DIR" -type f -name '*.tf' | sort)"
if [ -z "$tf_files" ]; then
  echo "ERROR: infra 配下に .tf が 1 件もありません。走査対象がありません。" >&2
  exit 1
fi

# resource / locals の代入を、括弧・角括弧・波括弧・heredoc が閉じるまで読んで 1 行へ畳む。
# **1 行 grep で読んではならない。** terraform fmt は複数行のままの代入を許すので、
# `filter = local.x` は拾えても `filter = <<-EOT ... EOT` は 1 行では見えない。
flatten() {
  # $1 = ファイル / $2 = 'resource' なら sink ブロック抽出、'local' なら $3 の local を抽出
  awk -v mode="$2" -v want="${3:-}" '
    function netdepth(s,   t, n) {
      n = 0
      t = s; n += gsub(/[[({]/, "", t)
      t = s; n -= gsub(/[])}]/, "", t)
      return n
    }
    mode == "resource" {
      if (inres == 0 && $0 ~ /^resource[[:space:]]+"google_logging_project_sink"/) {
        inres = 1; depth = 0; body = ""
      }
      if (inres) {
        body = body $0 "\n"
        depth += netdepth($0)
        if (depth <= 0) { printf "%s\036", body; inres = 0 }
      }
      next
    }
    mode == "local" {
      if (inloc == 0 && $0 ~ "^[[:space:]]*" want "[[:space:]]*=") {
        inloc = 1; depth = 0; body = ""
        if ($0 ~ /<<-?[A-Z]+[[:space:]]*$/) { heredoc = 1 }
      }
      if (inloc) {
        body = body $0 "\n"
        if (heredoc) {
          if (body != $0 "\n" && $0 ~ /^[[:space:]]*[A-Z]+[[:space:]]*$/) { print body; exit }
          next
        }
        depth += netdepth($0)
        if (depth <= 0) { print body; exit }
      }
    }
  ' "$1"
}

managed_found=0
scanned_blocks=0

while IFS= read -r tf_file; do
  [ -n "$tf_file" ] || continue
  blocks="$(flatten "$tf_file" resource)"
  [ -n "$blocks" ] || continue
  while IFS= read -r -d "$(printf '\036')" block; do
    [ -n "$(printf '%s' "$block" | tr -d '[:space:]')" ] || continue
    scanned_blocks=$((scanned_blocks + 1))
    # **属性はブロック直下（terraform fmt が保証する 2 スペース）だけを読む。** 深い位置まで
    # 拾うと、`exclusions { filter = ... }` の中身を sink 自身の filter と取り違え、
    # filter を消した状態を「宣言はあるが中身が足りない」と誤って報告する（実測）。
    sink_name="$(printf '%s\n' "$block" | sed -n 's/^  name[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' | sed -n '1,1p')"
    [ "$sink_name" = "$MANAGED_SINK_NAME" ] || continue
    managed_found=$((managed_found + 1))
    rel="${tf_file#$ROOT/}"

    filter_rhs="$(printf '%s\n' "$block" | sed -n 's/^  filter[[:space:]]*=[[:space:]]*\(.*\)$/\1/p' | sed -n '1,1p')"
    if [ -z "$filter_rhs" ]; then
      fail "${rel}: sink \"${MANAGED_SINK_NAME}\" が filter を宣言していません。"
      echo "       → filter を書かないと Terraform は空（全件）を送り、Logging が既定で持つ" >&2
      echo "         必須ログの除外が消えます。_Required と二重に保存され課金対象になります。" >&2
      continue
    fi

    # `local.<名前>` の 1 段だけ解決する（同じディレクトリの .tf を見る）。
    resolved="$filter_rhs"
    local_name="$(printf '%s' "$filter_rhs" | sed -n 's/^local\.\([A-Za-z0-9_]*\).*/\1/p')"
    if [ -n "$local_name" ]; then
      resolved=''
      for sibling in "$(dirname "$tf_file")"/*.tf; do
        [ -f "$sibling" ] || continue
        found="$(flatten "$sibling" local "$local_name")"
        if [ -n "$found" ]; then resolved="$found"; break; fi
      done
      if [ -z "$resolved" ]; then
        fail "${rel}: filter が参照する local.${local_name} の定義を解決できません。"
        continue
      fi
    fi

    missing=''
    while IFS= read -r log_id; do
      [ -n "$log_id" ] || continue
      hits="$(printf '%s\n' "$resolved" | grep_count -F -- "$log_id")" || {
        fail "${rel}: 必須ログ ID の照合を評価できません（grep が異常終了）: ${log_id}"
        continue
      }
      if [ "$hits" -eq 0 ]; then
        missing="${missing}${log_id} "
      fi
    done <<EOF
$REQUIRED_LOG_IDS
EOF
    if [ -n "$missing" ]; then
      fail "${rel}: sink \"${MANAGED_SINK_NAME}\" の filter が必須ログを除外していません: ${missing% }"
      echo "       → 除外が欠けたログは _Required と _Default の両方へ入り、二重に課金されます。" >&2
    fi
  done <<EOF
$blocks
EOF
done <<EOF
$tf_files
EOF

if [ "$scanned_blocks" -eq 0 ]; then
  echo "ERROR: google_logging_project_sink の宣言が 1 件も見つかりません。走査が空振りしています。" >&2
  exit 1
fi

if [ "$managed_found" -eq 0 ]; then
  echo "ERROR: name = \"${MANAGED_SINK_NAME}\" の sink 宣言が 1 件もありません。" >&2
  echo "       → 既定 sink を管理下へ置いたまま検査対象から外れた状態です（空振り）。" >&2
  exit 1
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "OK: _Default sink の必須ログ除外 ${required_count} 件を宣言で保持しています（対象 ${managed_found} 件）。"
