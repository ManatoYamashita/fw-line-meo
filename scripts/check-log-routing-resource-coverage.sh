#!/usr/bin/env bash
# Issue #232 ガードレール（静的・GCP に触れない）: ログ振り分けの述語が、デプロイ正典に在る
# **実行面の種別をすべて覆っている**ことを検証する。
#
# ## 何が起きたか（2026-09-22 実測）
#
# PR #245 の 3 sink と `_Default` の除外は、述語が `resource.type = "cloud_run_revision"`
# だけだった。Cloud Run の**ジョブ**（daily-batch / summary-delivery）の記録は、どの
# カスタムバケットにも入らない。本番の構造化ログは直近 6 時間で 13 行、**うち 12 行が
# `cloud_run_job`** だった。90 日のエラー窓を用意した当の層が、その窓の外にあった。
#
# #227 が「この欠落はすでに二度実害を出している」として挙げる #151 は、まさにジョブの失敗が
# 無音だった事故である。**破れたときの症状は赤ではなく「新しいバケットが静かに空」** であり、
# 着弾を実測しない限り誰も気づかない。
#
# ## 検証すること
#
#   1. 振り分けの各フィルタ（sink の filter と `_Default` の exclusions）が、デプロイ正典の
#      種別に対応する resource.type をすべて含む
#      （service → `cloud_run_revision` / job → `cloud_run_job`）
#   2. 逆に、正典に無い種別を書いていない（両方向。正典が縮んだのに述語が残る形も赤）
#   3. 空振り防止: 正典 0 件・sink 0 件・振り分けフィルタ 0 件・述語 0 件はいずれも赤
#
# **種別の一覧をこのスクリプトへ列挙しない。** 正典は check-deploy-image-coverage.sh
# --print-targets であり、上流が赤ならここも即座に落ちる。
#
# `_Default` sink の**トップレベル** filter は対象外である。あれは Logging の既定除外を保つ
# ためのもので、振り分けの述語ではない（scripts/check-log-sink-default-filter.sh が所有する）。
#
# 使い方: bash scripts/check-log-routing-resource-coverage.sh
#   漏れがあれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INFRA_DIR="${ROOT}/infra"
CANON_SCRIPT="${SCRIPT_DIR}/check-deploy-image-coverage.sh"
MANAGED_SINK_NAME='_Default'

failed=0

fail() {
  echo "ERROR: $1" >&2
  failed=1
}

# 後置 `|| true` で grep の失敗を潰さない（無一致 exit 1 と評価不能 exit 2 を分ける）。
grep_count() {
  gc_rc=0
  gc_out="$(grep -c "$@")" || gc_rc=$?
  if [ "$gc_rc" -gt 1 ]; then
    return 2
  fi
  printf '%s' "$gc_out"
  return 0
}

if [ ! -d "$INFRA_DIR" ]; then
  echo "ERROR: infra ディレクトリがありません: ${INFRA_DIR#$ROOT/}。" >&2
  exit 1
fi
if [ ! -x "$CANON_SCRIPT" ] && [ ! -f "$CANON_SCRIPT" ]; then
  echo "ERROR: デプロイ正典のスクリプトがありません: ${CANON_SCRIPT#$ROOT/}。" >&2
  exit 1
fi

canon="$(bash "$CANON_SCRIPT" --print-targets 2>/dev/null | grep -E '^(service|job)	')" || {
  echo "ERROR: デプロイ正典を取得できません（${CANON_SCRIPT#$ROOT/} --print-targets）。" >&2
  exit 1
}
if [ -z "$canon" ]; then
  echo "ERROR: デプロイ正典が 0 件です。覆うべき種別を決められません。" >&2
  exit 1
fi

# 正典の種別 → Cloud Logging の resource.type。
required_types=''
while IFS='	' read -r kind _name; do
  [ -n "$kind" ] || continue
  case "$kind" in
    service) rtype='cloud_run_revision' ;;
    job) rtype='cloud_run_job' ;;
    *) continue ;;
  esac
  case " $required_types " in
    *" $rtype "*) ;;
    *) required_types="${required_types}${rtype} " ;;
  esac
done <<EOF
$canon
EOF
required_types="${required_types% }"
if [ -z "$required_types" ]; then
  echo "ERROR: 正典から resource.type を 1 つも導けませんでした。" >&2
  exit 1
fi

# resource / locals の代入を、括弧・角括弧・波括弧が閉じるまで読んで畳む。
flatten() {
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

# `local.<名前>` を同じディレクトリの定義で置き換える（最大 3 段）。
resolve_locals() {
  rl_text="$1"
  rl_dir="$2"
  rl_pass=0
  while [ "$rl_pass" -lt 3 ]; do
    rl_names="$(printf '%s\n' "$rl_text" | tr -c 'A-Za-z0-9_.' '\n' | sed -n 's/^local\.\([A-Za-z0-9_][A-Za-z0-9_]*\)$/\1/p' | sort -u)"
    [ -n "$rl_names" ] || break
    rl_changed=0
    while IFS= read -r rl_name; do
      [ -n "$rl_name" ] || continue
      rl_body=''
      for rl_sibling in "$rl_dir"/*.tf; do
        [ -f "$rl_sibling" ] || continue
        rl_body="$(flatten "$rl_sibling" local "$rl_name")"
        [ -n "$rl_body" ] && break
      done
      [ -n "$rl_body" ] || continue
      rl_text="$(printf '%s\n%s\n' "$rl_text" "$rl_body" | sed "s/local\.${rl_name}\$//")"
      rl_text="$(printf '%s' "$rl_text" | sed "s/local\.${rl_name}//g")"
      rl_changed=1
    done <<EOF
$rl_names
EOF
    [ "$rl_changed" -eq 1 ] || break
    rl_pass=$((rl_pass + 1))
  done
  printf '%s' "$rl_text"
}

tf_files="$(find "$INFRA_DIR" -type f -name '*.tf' | sort)"
if [ -z "$tf_files" ]; then
  echo "ERROR: infra 配下に .tf が 1 件もありません。走査対象がありません。" >&2
  exit 1
fi

sink_blocks=0
routing_filters=0

while IFS= read -r tf_file; do
  [ -n "$tf_file" ] || continue
  blocks="$(flatten "$tf_file" resource)"
  [ -n "$blocks" ] || continue
  while IFS= read -r -d "$(printf '\036')" block; do
    [ -n "$(printf '%s' "$block" | tr -d '[:space:]')" ] || continue
    sink_blocks=$((sink_blocks + 1))
    rel="${tf_file#$ROOT/}"
    sink_name="$(printf '%s\n' "$block" | sed -n 's/^  name[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' | sed -n '1,1p')"

    # 検査対象のフィルタを集める。`_Default` のトップレベル filter だけは対象外
    # （既定除外の保持であって振り分けの述語ではない）。
    if [ "$sink_name" = "$MANAGED_SINK_NAME" ]; then
      filters="$(printf '%s\n' "$block" | sed -n 's/^    filter[[:space:]]*=[[:space:]]*\(.*\)$/\1/p')"
    else
      filters="$(printf '%s\n' "$block" | sed -n 's/^  filter[[:space:]]*=[[:space:]]*\(.*\)$/\1/p')"
    fi
    [ -n "$filters" ] || continue

    while IFS= read -r rhs; do
      [ -n "$rhs" ] || continue
      routing_filters=$((routing_filters + 1))
      resolved="$(resolve_locals "$rhs" "$(dirname "$tf_file")")"
      # **HCL の逃がし（`\"`）を外してから照合する。** 素のままだと `"cloud_run_job"` は
      # `\"cloud_run_job\"` の部分文字列にならず、覆っているのに 0 件と読む（実測）。
      resolved="$(printf '%s' "$resolved" | sed 's/\\"/"/g')"

      predicates="$(printf '%s\n' "$resolved" | grep_count -- 'resource\.type')" || {
        fail "${rel}: 述語の有無を評価できません（grep が異常終了）: ${rhs}"
        continue
      }
      if [ "${predicates:-0}" -eq 0 ]; then
        fail "${rel}: sink \"${sink_name}\" のフィルタに resource.type の述語がありません: ${rhs}"
        continue
      fi

      for rtype in $required_types; do
        hits="$(printf '%s\n' "$resolved" | grep_count -F -- "\"${rtype}\"")" || {
          fail "${rel}: resource.type の照合を評価できません（grep が異常終了）: ${rtype}"
          continue
        }
        if [ "$hits" -eq 0 ]; then
          fail "${rel}: sink \"${sink_name}\" のフィルタが ${rtype} を覆っていません（${rhs}）。"
          echo "       → デプロイ正典にその種別の実行面が在る以上、その記録は振り分けから漏れます。" >&2
        fi
      done

      # 両方向。正典に無い種別を述語へ書いていないこと。
      found_types="$(printf '%s\n' "$resolved" | sed -n 's/.*resource\.type[[:space:]]*=[[:space:]]*\\*"\([a-z_]*\)\\*".*/\1/p' | sort -u)"
      while IFS= read -r ftype; do
        [ -n "$ftype" ] || continue
        case " $required_types " in
          *" $ftype "*) ;;
          *) fail "${rel}: sink \"${sink_name}\" のフィルタが正典に無い種別を書いています: ${ftype}" ;;
        esac
      done <<EOF
$found_types
EOF
    done <<EOF
$filters
EOF
  done <<EOF
$blocks
EOF
done <<EOF
$tf_files
EOF

if [ "$sink_blocks" -eq 0 ]; then
  echo "ERROR: google_logging_project_sink の宣言が 1 件も見つかりません。走査が空振りしています。" >&2
  exit 1
fi
if [ "$routing_filters" -eq 0 ]; then
  echo "ERROR: 振り分けのフィルタを 1 件も抽出できませんでした。検査が空振りしています。" >&2
  exit 1
fi
if [ "$failed" -ne 0 ]; then
  exit 1
fi

echo "OK: 振り分けフィルタ ${routing_filters} 件が正典の種別（${required_types}）を覆っています。"
