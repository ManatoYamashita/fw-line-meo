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
#   4. IMAGE_NAMES の各イメージが ts-ci.yml の docker-build matrix（`image: [...]` 1行定義）に
#      含まれること（PR 段階の実ビルド検証から漏れたイメージを作らせない）
#   5. ジョブ（= IMAGE_NAMES − run-services。現状 daily-batch / summary-delivery）が deploy.yml の
#      `gcloud run jobs update` 対象に含まれること（Issue #91。検証2はサービスしか見ておらず、
#      ジョブが deploy.yml から消えても誰も気づかない穴が開いていた）
#
# 対象集合の正典（Issue #91）: サービスは main.tf の run-services マップキー、ジョブはその差集合
# （IMAGE_NAMES − run-services）で導出する。ジョブは main.tf 上 module "batch_job" /
# module "delivery_job" の別モジュール定義で、job 名はモジュール variables.tf の default にしか
# 無いため、run-services の抽出には構造上乗らない。差集合で導出すれば列挙の二重管理を作らずに
# service / job の分類まで得られる。この分類は --print-targets で外部（ドリフト検証）へ供給する。
#
# 使い方:
#   bash scripts/check-deploy-image-coverage.sh
#     漏れがあれば該当を stderr に出して exit 1、無ければ exit 0。
#   bash scripts/check-deploy-image-coverage.sh --print-targets
#     上記の検証を完走させた上で、デプロイ対象を `<kind>\t<name>` の TSV で stdout へ出す
#     （kind = service | job）。検証が赤なら stdout へ 1 行も出さず exit 1 する。壊れた正典から
#     導出した対象集合で下流を緑にするのが最悪の空振りであるため、print だけの近道は用意しない。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

print_targets=0
while [ $# -gt 0 ]; do
  case "$1" in
    --print-targets)
      print_targets=1
      shift
      ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: 未知の引数です: $1" >&2
      echo "       → 使い方は bash scripts/check-deploy-image-coverage.sh --help を参照してください。" >&2
      exit 2
      ;;
  esac
done

# 人間向けの進捗出力（OK / SKIP）の出し先。--print-targets 時は stdout を TSV 専用にするため
# stderr へ退避する。ERROR / WARNING は従来どおり常に stderr。引数なし実行の出力は不変。
if [ "$print_targets" -eq 1 ]; then
  exec 3>&2
else
  exec 3>&1
fi

TF_FILE="${ROOT}/infra/envs/prod/main.tf"
PUSH_SCRIPT="${ROOT}/scripts/push-images.sh"
DEPLOY_YML="${ROOT}/.github/workflows/deploy.yml"
TS_CI_YML="${ROOT}/.github/workflows/ts-ci.yml"

# 意図的にデプロイパイプラインへ含めないサービス（必ず理由と Issue を明記すること）。
# 現在は空（Issue #35 で line-webhook を組込済み）。追加時は `WHITELIST=(name1 name2)` 形式。
WHITELIST=()

for f in "$TF_FILE" "$PUSH_SCRIPT" "$DEPLOY_YML" "$TS_CI_YML"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: 検証対象ファイルが見つかりません: ${f#$ROOT/}" >&2
    exit 1
  fi
done

# main.tf の run-services サービスキー（`"name" = {` 形式のマップキーは services マップのみ）。
# **末尾の `|| true` は必須である（Issue #90）。** grep は無一致で exit 1 を返し、
# `set -o pipefail` によりパイプライン全体が失敗扱いになる。`set -e` と組み合わさると、
# 直下の「1件も抽出できませんでした」という空振り検出へ到達する前にスクリプトが死に、
# **出力ゼロのまま exit 1** になる。fail-closed ではあるが、原因を一切告げない赤は
# 誤診断より始末が悪い。抽出結果の空判定は必ず下の分岐で行う。
tf_services="$(grep -E '^[[:space:]]*"[a-z0-9-]+"[[:space:]]*=[[:space:]]*\{' "$TF_FILE" \
  | sed -E 's/^[[:space:]]*"([a-z0-9-]+)".*/\1/' | sort -u || true)"

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
# --print-targets で出す対象集合。WHITELIST で意図的に除外したサービスは含めない
# （CI がデプロイしない以上、ドリフト検証の対象にもならない）。
target_services=""
for svc in $tf_services; do
  # ${arr[@]+...} は空配列でも set -u（bash 3.2 含む）で unbound エラーにしない安全な展開。
  if in_list "$svc" ${WHITELIST[@]+"${WHITELIST[@]}"}; then
    # ホワイトリスト項目が実はカバー済みなら、無意味な除外を残さないよう警告する。
    # shellcheck disable=SC2086 # image_names は意図的に単語分割する
    if in_list "$svc" $image_names; then
      echo "WARNING: ${svc} は WHITELIST に載っていますが既に IMAGE_NAMES にあります。WHITELIST から削除してください。" >&2
    else
      echo "SKIP: ${svc}（WHITELIST・理由はスクリプト内コメント参照）" >&3
    fi
    continue
  fi
  checked=$((checked + 1))
  target_services="${target_services}${svc}"$'\n'

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

# 検証4: push-images.sh の全イメージが ts-ci の docker-build matrix に含まれること。
# matrix は「image: [a, b, c]」の1行定義が前提（崩れたら fail して前提を守らせる）。
matrix_line="$(grep -E '^[[:space:]]*image: \[' "$TS_CI_YML" || true)"
matrix_checked=0
if [ -z "$matrix_line" ]; then
  echo "ERROR: ${TS_CI_YML#$ROOT/} に docker-build の 'image: [...]' 1行 matrix 定義が見つかりません。" >&2
  fail=1
else
  # shellcheck disable=SC2086 # image_names は意図的に単語分割する
  for name in $image_names; do
    matrix_checked=$((matrix_checked + 1))
    # [ ] , のいずれかを境界として名前の完全一致を検証（部分一致の誤検出を防ぐ）。
    # 件数で判定する（Issue #117）。`$matrix_line` は現状 1 行なので早期終了は起きないが、
    # 「今は転ばない」は入力の形という外部条件に依存しており、コードの性質ではない。
    # 無一致（exit 1）と評価不能（exit 2 以上）を分ける。`${name}` を ERE へ埋めているため、
    # 名前に正規表現メタ文字が混じると exit 2 になりうる。後置 true で潰すと、それが
    # 「matrix に無い」と同じ扱いになり **原因と逆向きの診断**を出す。
    matrix_rc=0
    matrix_hits="$(printf '%s\n' "$matrix_line" | grep -cE "[][, ]${name}[],]")" || matrix_rc=$?
    if [ "$matrix_rc" -gt 1 ]; then
      echo "ERROR: '${name}' の matrix 照合パターンを評価できません（grep exit=${matrix_rc}）。" >&2
      echo "       → イメージ名に正規表現メタ文字が含まれていないか確認してください。" >&2
      fail=1
    elif [ "${matrix_hits:-0}" -eq 0 ]; then
      echo "ERROR: ${PUSH_SCRIPT#$ROOT/} の '${name}' が ${TS_CI_YML#$ROOT/} の docker-build matrix にありません。" >&2
      echo "       → PR 段階の実ビルド検証（Issue #33/#35 型の Dockerfile 腐敗の検出）から漏れます。" >&2
      fail=1
    fi
  done
fi

# 検証5（Issue #91）: ジョブ（= IMAGE_NAMES − run-services）が deploy.yml の
# `gcloud run jobs update` 対象に含まれること。検証2は `gcloud run services update` しか見ておらず、
# ジョブ2件は無検証だった（deploy.yml から消しても緑のままになる穴を実測で確認済み）。
target_jobs=""
job_checked=0
# shellcheck disable=SC2086 # image_names は意図的に単語分割する
for name in $image_names; do
  # shellcheck disable=SC2086 # tf_services は意図的に単語分割する
  if in_list "$name" $tf_services; then
    continue
  fi
  job_checked=$((job_checked + 1))
  target_jobs="${target_jobs}${name}"$'\n'

  if ! grep -qE "gcloud run jobs update[[:space:]]+${name}([[:space:]]|\\\\|\$)" "$DEPLOY_YML"; then
    echo "ERROR: ${DEPLOY_YML#$ROOT/} に 'gcloud run jobs update ${name}' がありません（push しても Cloud Run へ反映されません）。" >&2
    echo "       → '${name}' は IMAGE_NAMES にあり ${TF_FILE#$ROOT/} の run-services に無いため、ジョブとみなしています。" >&2
    echo "         サービスのつもりなら run-services の services マップへ追加してください。" >&2
    fail=1
  fi
done

if [ "$job_checked" -eq 0 ]; then
  echo "ERROR: IMAGE_NAMES と run-services の差集合からジョブを1件も導出できませんでした（対象集合の導出前提が崩れています）。" >&2
  echo "       → 現状は daily-batch / summary-delivery の2件が導出される想定です。両者が run-services へ移されたか、IMAGE_NAMES の抽出が壊れています。" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: デプロイパイプラインのカバレッジに漏れがあります（上記参照）。" >&2
  exit 1
fi

echo "OK: run-services デプロイカバレッジ緑（${checked} サービス・${job_checked} ジョブ検証・WHITELIST ${#WHITELIST[@]} 件・matrix ${matrix_checked} イメージ照合）。" >&3

if [ "$print_targets" -eq 1 ]; then
  # shellcheck disable=SC2086 # target_services / target_jobs は改行区切りで意図的に単語分割する
  for svc in $target_services; do
    printf 'service\t%s\n' "$svc"
  done
  # shellcheck disable=SC2086 # 同上
  for job in $target_jobs; do
    printf 'job\t%s\n' "$job"
  done
fi
exit 0
