#!/usr/bin/env bash
# competitive-daily-summary（task 6.3）/ agency-dashboard（task 5.1）/ Issue #33: 6イメージ
# （daily-batch・summary-delivery・store-detail・dashboard-api・dashboard-web・survey-web）を
# ビルドし、Artifact Registry（infra/modules/registry・既定 repository_id=fwlm）へ push する。
#
# 前提（実 GCP 接続が必要な手順・ローカル検証環境には無い）:
#   - gcloud CLI がインストール済みで、push 対象プロジェクトに roles/artifactregistry.writer 相当の
#     権限を持つアカウントで `gcloud auth login`（または WIF）済みであること
#   - `gcloud auth configure-docker ${REGION}-docker.pkg.dev` を一度実行済みであること
#     （本スクリプトは --build-only 以外の実行時に自動でこれを試みる）
#   - docker（または CONTAINER_CMD で指定する互換 CLI）が利用可能であること
#
# 使い方:
#   scripts/push-images.sh                    # 6イメージを build + push（既定 TAG=gitの短SHA）
#   scripts/push-images.sh --build-only        # push せず build のみ（ローカル検証・CI の検証ジョブ向け）
#   scripts/push-images.sh --image daily-batch # 対象を1イメージに絞る
#     （daily-batch|summary-delivery|store-detail|dashboard-api|dashboard-web|survey-web）
#   PROJECT_ID=fwlm REGION=asia-northeast1 REPOSITORY=fwlm TAG=v0.1.0 scripts/push-images.sh
#
# 各イメージの Dockerfile とビルドコンテキストは go/Dockerfile・ts/apps/delivery-job/Dockerfile・
# ts/apps/store-detail/Dockerfile・ts/apps/dashboard-api/Dockerfile・ts/apps/dashboard-web/Dockerfile・
# ts/apps/survey-web/Dockerfile 冒頭コメントに記載の規約と一致させている。
#
# push 後の daily-batch Job 実体化手順（terraform apply の外・ignore_changes[image]）は
# infra/README.md 「7. コンテナイメージの push と既設 Job/Service の実体化」を参照。

set -euo pipefail

CONTAINER_CMD="${CONTAINER_CMD:-docker}"
PROJECT_ID="${PROJECT_ID:-fwlm}"
REGION="${REGION:-asia-northeast1}"
REPOSITORY="${REPOSITORY:-fwlm}"
TAG="${TAG:-}"

BUILD_ONLY=0
ONLY_IMAGE=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/push-images.sh [--build-only]
       [--image daily-batch|summary-delivery|store-detail|dashboard-api|dashboard-web|survey-web]

env vars: CONTAINER_CMD (既定 docker) / PROJECT_ID (既定 fwlm) / REGION (既定 asia-northeast1)
          REPOSITORY (既定 fwlm) / TAG (既定 git 短SHA。dirty working tree なら -dirty 付与)
          dashboard-web の build-arg: NEXT_PUBLIC_API_BASE_URL / NEXT_PUBLIC_FIREBASE_API_KEY /
          NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN / NEXT_PUBLIC_FIREBASE_PROJECT_ID（push 時は必須）
          store-detail の build-arg: NEXT_PUBLIC_LIFF_ID（push 時は必須）
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-only)
      BUILD_ONLY=1
      shift
      ;;
    --image)
      [ "$#" -ge 2 ] || { echo "ERROR: --image には値が必要です" >&2; usage; exit 2; }
      ONLY_IMAGE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: 未知の引数: $1" >&2
      usage
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -n "$ONLY_IMAGE" ]; then
  case "$ONLY_IMAGE" in
    daily-batch|summary-delivery|store-detail|dashboard-api|dashboard-web|survey-web) ;;
    *)
      echo "ERROR: 不明なイメージ名: ${ONLY_IMAGE}（daily-batch|summary-delivery|store-detail|dashboard-api|dashboard-web|survey-web）" >&2
      exit 2
      ;;
  esac
fi

if ! command -v "$CONTAINER_CMD" >/dev/null 2>&1; then
  echo "ERROR: コンテナランタイム '$CONTAINER_CMD' が見つかりません（CONTAINER_CMD で差替可）。" >&2
  exit 1
fi

if [ -z "$TAG" ]; then
  if git -C "$ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
    TAG="$(git -C "$ROOT" rev-parse --short HEAD)"
    if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
      TAG="${TAG}-dirty"
    fi
  else
    TAG="latest"
  fi
fi

REGISTRY_HOST="${REGION}-docker.pkg.dev"
IMAGE_BASE="${REGISTRY_HOST}/${PROJECT_ID}/${REPOSITORY}"

# name / Dockerfile / build context（Dockerfile 冒頭コメントの docker build 例と一致させる）
IMAGE_NAMES=(daily-batch summary-delivery store-detail dashboard-api dashboard-web survey-web)
declare -A DOCKERFILE=(
  [daily-batch]="go/Dockerfile"
  [summary-delivery]="ts/apps/delivery-job/Dockerfile"
  [store-detail]="ts/apps/store-detail/Dockerfile"
  [dashboard-api]="ts/apps/dashboard-api/Dockerfile"
  [dashboard-web]="ts/apps/dashboard-web/Dockerfile"
  [survey-web]="ts/apps/survey-web/Dockerfile"
)
declare -A CONTEXT=(
  [daily-batch]="go"
  [summary-delivery]="ts"
  [store-detail]="ts"
  [dashboard-api]="ts"
  [dashboard-web]="ts"
  [survey-web]="ts"
)

# ビルド時 build-arg（イメージ別）。store-detail は Next.js の NEXT_PUBLIC_LIFF_ID を、
# dashboard-web は NEXT_PUBLIC_API_BASE_URL / NEXT_PUBLIC_FIREBASE_* 一式を、いずれも
# クライアントバンドルへ next build 時にインライン化する必要がある（ランタイム env では効かない）。
# 値は同名の環境変数から取得（未設定なら空のまま=起動が失敗するため下で警告/hard-fail）。
declare -A BUILD_ARGS=(
  [store-detail]="--build-arg NEXT_PUBLIC_LIFF_ID=${NEXT_PUBLIC_LIFF_ID:-}"
  [dashboard-web]="--build-arg NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL:-} --build-arg NEXT_PUBLIC_FIREBASE_API_KEY=${NEXT_PUBLIC_FIREBASE_API_KEY:-} --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:-} --build-arg NEXT_PUBLIC_FIREBASE_PROJECT_ID=${NEXT_PUBLIC_FIREBASE_PROJECT_ID:-}"
)
if [ -z "${NEXT_PUBLIC_LIFF_ID:-}" ] && { [ -z "$ONLY_IMAGE" ] || [ "$ONLY_IMAGE" = "store-detail" ]; }; then
  # push 経路（--build-only 以外）では空の LIFF ID を焼き込んだ壊れイメージを出荷させない（hard-fail）。
  # --build-only（ローカル検証・CI 検証ジョブ）は LIFF 不要な確認もあり得るため警告に留めて続行する。
  if [ "$BUILD_ONLY" -eq 0 ]; then
    echo "ERROR: NEXT_PUBLIC_LIFF_ID 未設定のまま store-detail を push しようとしています。空の LIFF ID が焼き込まれ LIFF 起動が必ず失敗します（tfvars の liff_id と同値を指定してください）。ローカルビルド確認のみなら --build-only を指定。" >&2
    exit 1
  fi
  echo "WARNING: NEXT_PUBLIC_LIFF_ID 未設定。store-detail のクライアントバンドルに空の LIFF ID が焼き込まれます（--build-only のため続行。push 時は tfvars の liff_id と同値を渡すこと）。" >&2
fi
if { [ -z "${NEXT_PUBLIC_API_BASE_URL:-}" ] || [ -z "${NEXT_PUBLIC_FIREBASE_API_KEY:-}" ] || [ -z "${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN:-}" ] || [ -z "${NEXT_PUBLIC_FIREBASE_PROJECT_ID:-}" ]; } && { [ -z "$ONLY_IMAGE" ] || [ "$ONLY_IMAGE" = "dashboard-web" ]; }; then
  # push 経路（--build-only 以外）では空のクライアント設定を焼き込んだ壊れイメージを出荷させない（hard-fail）。
  # 4 変数のいずれかが空だと dashboard-web は Firebase 初期化 or dashboard-api 呼び出しが本番で必ず失敗する。
  # --build-only（ローカル検証・CI 検証ジョブ）はこれら不要な確認もあり得るため警告に留めて続行する。
  if [ "$BUILD_ONLY" -eq 0 ]; then
    echo "ERROR: NEXT_PUBLIC_API_BASE_URL / NEXT_PUBLIC_FIREBASE_API_KEY / NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN / NEXT_PUBLIC_FIREBASE_PROJECT_ID のいずれかが未設定のまま dashboard-web を push しようとしています。空のクライアント設定が焼き込まれ Firebase 初期化・dashboard-api 呼び出しが本番で必ず失敗します（4 変数すべてを指定してください）。ローカルビルド確認のみなら --build-only を指定。" >&2
    exit 1
  fi
  echo "WARNING: dashboard-web の NEXT_PUBLIC_* が未設定です。空のクライアント設定が焼き込まれます（--build-only のため続行。push 時は 4 変数すべてを渡すこと）。" >&2
fi

if [ -n "$ONLY_IMAGE" ]; then
  IMAGE_NAMES=("$ONLY_IMAGE")
fi

if [ "$BUILD_ONLY" -eq 0 ]; then
  echo "==> gcloud auth configure-docker ${REGISTRY_HOST}"
  if command -v gcloud >/dev/null 2>&1; then
    gcloud auth configure-docker "$REGISTRY_HOST" --quiet
  else
    echo "ERROR: gcloud が見つかりません。push には gcloud auth configure-docker が必要です。" >&2
    echo "       ローカルビルドのみ確認したい場合は --build-only を指定してください。" >&2
    exit 1
  fi
fi

for name in "${IMAGE_NAMES[@]}"; do
  dockerfile="${DOCKERFILE[$name]}"
  context="${CONTEXT[$name]}"
  image_ref="${IMAGE_BASE}/${name}:${TAG}"

  build_args="${BUILD_ARGS[$name]:-}"
  echo "==> build ${name}: ${CONTAINER_CMD} build ${build_args} -f ${dockerfile} -t ${image_ref} ${context}"
  # shellcheck disable=SC2086 # build_args は意図的に単語分割する（--build-arg K=V の並び）
  "$CONTAINER_CMD" build ${build_args} -f "${ROOT}/${dockerfile}" -t "${image_ref}" "${ROOT}/${context}"

  if [ "$BUILD_ONLY" -eq 1 ]; then
    echo "==> --build-only: push をスキップ（${image_ref}）"
    continue
  fi

  echo "==> push ${name}: ${CONTAINER_CMD} push ${image_ref}"
  "$CONTAINER_CMD" push "${image_ref}"
  echo "==> pushed: ${image_ref}"
done

if [ "$BUILD_ONLY" -eq 0 ]; then
  echo ""
  echo "全イメージの push が完了しました（TAG=${TAG}）。次は既設 Job/Service への反映が必要です:"
  echo "  gcloud run jobs update daily-batch --image=${IMAGE_BASE}/daily-batch:${TAG} --region=${REGION} --project=${PROJECT_ID}"
  echo "  gcloud run jobs update summary-delivery --image=${IMAGE_BASE}/summary-delivery:${TAG} --region=${REGION} --project=${PROJECT_ID}"
  echo "  gcloud run services update store-detail --image=${IMAGE_BASE}/store-detail:${TAG} --region=${REGION} --project=${PROJECT_ID}"
  echo "  gcloud run services update dashboard-api --image=${IMAGE_BASE}/dashboard-api:${TAG} --region=${REGION} --project=${PROJECT_ID}"
  echo "  gcloud run services update dashboard-web --image=${IMAGE_BASE}/dashboard-web:${TAG} --region=${REGION} --project=${PROJECT_ID}"
  echo "  gcloud run services update survey-web --image=${IMAGE_BASE}/survey-web:${TAG} --region=${REGION} --project=${PROJECT_ID}"
  echo "詳細手順は infra/README.md 「7. コンテナイメージの push と既設 Job/Service の実体化」を参照。"
fi
