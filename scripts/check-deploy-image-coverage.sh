#!/usr/bin/env bash
# Issue #33 再発防止ガードレール: infra/envs/prod/main.tf の run-services に定義された
# Cloud Run サービスは、tf 初回作成時は placeholder イメージ（cloudrun/container/hello）で
# 起動し、CI（scripts/push-images.sh → .github/workflows/deploy.yml）が実イメージを反映して
# はじめて機能する。そのためデプロイパイプラインへの追加漏れがあると「tf は成功・サービスも
# 存在するのに中身が placeholder のまま」という無音の障害になる（Issue #33 = survey-web で実発生）。
#
# 本スクリプトは以下を機械検証する（read-only の grep 検証・副作用なし・bash 3.2 でも走る）:
#   1. main.tf の run-services 各キーが push-images.sh の IMAGE_NAMES に含まれること
#   2. 同キーが deploy.yml の `gcloud run services update` 対象に含まれること
#   3. 意図的除外はこのファイル内の WHITELIST に Issue 番号付きで明記されていること
#      （ホワイトリスト項目が実はカバー済みになったら警告し、削除を促す）
#
# 使い方: bash scripts/check-deploy-image-coverage.sh
#   漏れがあれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TF_FILE="${ROOT}/infra/envs/prod/main.tf"
PUSH_SCRIPT="${ROOT}/scripts/push-images.sh"
DEPLOY_YML="${ROOT}/.github/workflows/deploy.yml"

# 意図的にデプロイパイプラインへ含めないサービス（必ず理由と Issue を明記すること）。
# 現在は空（Issue #35 で line-webhook を組込済み）。追加時は `WHITELIST=(name1 name2)` 形式。
WHITELIST=()

for f in "$TF_FILE" "$PUSH_SCRIPT" "$DEPLOY_YML"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: 検証対象ファイルが見つかりません: ${f#$ROOT/}" >&2
    exit 1
  fi
done

# main.tf の run-services サービスキー（`"name" = {` 形式のマップキーは services マップのみ）。
tf_services="$(grep -E '^[[:space:]]*"[a-z0-9-]+"[[:space:]]*=[[:space:]]*\{' "$TF_FILE" \
  | sed -E 's/^[[:space:]]*"([a-z0-9-]+)".*/\1/' | sort -u)"

if [ -z "$tf_services" ]; then
  echo "ERROR: ${TF_FILE#$ROOT/} から run-services のサービスキーを1件も抽出できませんでした（抽出パターンの前提が崩れています）。" >&2
  exit 1
fi

# push-images.sh の IMAGE_NAMES 配列（1行定義が前提。崩れたら fail して前提を守らせる）。
image_names_line="$(grep -E '^IMAGE_NAMES=\(' "$PUSH_SCRIPT" || true)"
if [ -z "$image_names_line" ]; then
  echo "ERROR: ${PUSH_SCRIPT#$ROOT/} に 'IMAGE_NAMES=(...)' の1行定義が見つかりません。" >&2
  exit 1
fi
image_names="$(printf '%s\n' "$image_names_line" | sed -E 's/^IMAGE_NAMES=\(([^)]*)\).*/\1/')"

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
checked=0
for svc in $tf_services; do
  # ${arr[@]+...} は空配列でも set -u（bash 3.2 含む）で unbound エラーにしない安全な展開。
  if in_list "$svc" ${WHITELIST[@]+"${WHITELIST[@]}"}; then
    # ホワイトリスト項目が実はカバー済みなら、無意味な除外を残さないよう警告する。
    # shellcheck disable=SC2086 # image_names は意図的に単語分割する
    if in_list "$svc" $image_names; then
      echo "WARNING: ${svc} は WHITELIST に載っていますが既に IMAGE_NAMES にあります。WHITELIST から削除してください。" >&2
    else
      echo "SKIP: ${svc}（WHITELIST・理由はスクリプト内コメント参照）"
    fi
    continue
  fi
  checked=$((checked + 1))

  # shellcheck disable=SC2086 # image_names は意図的に単語分割する
  if ! in_list "$svc" $image_names; then
    echo "ERROR: ${TF_FILE#$ROOT/} の run-services '${svc}' が ${PUSH_SCRIPT#$ROOT/} の IMAGE_NAMES にありません。" >&2
    echo "       → tf は placeholder で作成するため、push 対象に無いと本番が hello イメージのまま放置されます（Issue #33 と同型）。" >&2
    fail=1
  fi
  if ! grep -qE "gcloud run services update[[:space:]]+${svc}([[:space:]]|\\\\|\$)" "$DEPLOY_YML"; then
    echo "ERROR: ${DEPLOY_YML#$ROOT/} に 'gcloud run services update ${svc}' がありません（push しても Cloud Run へ反映されません）。" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "NG: デプロイパイプラインのカバレッジに漏れがあります（上記参照）。" >&2
  exit 1
fi

echo "OK: run-services デプロイカバレッジ緑（${checked} サービス検証・WHITELIST ${#WHITELIST[@]} 件）。"
exit 0
