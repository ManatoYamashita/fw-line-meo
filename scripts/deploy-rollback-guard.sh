#!/usr/bin/env bash
# Issue #512: deploy-prod が、本番で動いているコミットより古いコミットを後から出し、本番を巻き戻すのを止める。
#
# deploy-prod は ts-ci の完了ごとに workflow_run で起動し、その ts-ci が検証したコミット
# （workflow_run.head_sha）を出す。concurrency はデプロイを直列に並べるだけで、新旧を見ない。
# 2026-11-03 に PR を 2 つ続けてマージしたところ、後のコミット（dbc453e）の ts-ci が先に終わり、
# 先のコミット（eb910fa）のデプロイが後から走って本番を上書きした。run は 2 本とも success で、
# 一覧の headSha も 2 本とも新しい方を指すので、ジョブログの TAG 行を読まないと分からなかった。
# アプリのコードを変える PR が続いたときは、新しい変更が本番から黙って消える。
#
# 判定: 出そうとしているコミット（候補）について、本番の各対象（サービス・ジョブ）が指すイメージのタグ
# （git の短 SHA）を読み、**どれか 1 つでも候補の真の子孫を指していれば、候補を出すと巻き戻る**ので止める。
#   - 候補と同じコミットを指す対象は巻き戻りではない（同じコミットの再実行は許す。手動の出し直しに使う）
#   - 候補より古いコミット・別の枝のコミットを指す対象は、ふつうのデプロイとして進める
#   - タグを git で解決できない対象（履歴に無い・タグの形でない）は判定材料にならないので、WARN を出して
#     その対象を判定から外す（その対象だけを理由に、正当なデプロイを止めない）
#
# 出力: 止めるときは `SKIP:` 行を、進めるときは `OK:` 行を出す。どちらも exit 0。GITHUB_OUTPUT が
# あれば `rollback=true|false` を書く（deploy.yml の後続のステップがこれで分岐する）。
# 本番の状態を読めなかったときは exit 1（黙ってデプロイを進めると、巻き戻りを止める仕組みが空振りする）。
#
# 使い方: bash scripts/deploy-rollback-guard.sh --candidate <コミット>
#   PROJECT_ID   必須（DEPLOY_ROLLBACK_RUNNING を渡すときは不要）
#   REGION       既定 asia-northeast1
#   DEPLOY_ROLLBACK_RUNNING  本番の実測の注入（自己テスト用）。`<kind>\t<name>\t<image>` の TSV のパス。
#                            空文字も「注入した」とみなす（`+x` で判定する）。
#
# 対象はサービスとジョブの全件で、デプロイ対象の正典（check-deploy-image-coverage.sh）とは突き合わせない。
# 対象の網羅はその正典と check-prod-image-drift.sh の担当で、ここは「本番で動いているもの」の新旧だけを見る。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REGION="${REGION:-asia-northeast1}"

candidate=''
while [ $# -gt 0 ]; do
  case "$1" in
    --candidate)
      [ $# -ge 2 ] || { echo "ERROR: --candidate にはコミットが要ります" >&2; exit 2; }
      candidate="$2"
      shift 2
      ;;
    *)
      echo "ERROR: 不明な引数です: $1" >&2
      exit 2
      ;;
  esac
done
if [ -z "$candidate" ]; then
  echo "ERROR: --candidate が指定されていません" >&2
  exit 2
fi

candidate_full="$(git -C "$ROOT" rev-parse --verify --quiet "${candidate}^{commit}")" || {
  echo "ERROR: 候補のコミット ${candidate} を解決できません（checkout の履歴が浅い可能性があります）" >&2
  exit 1
}
candidate_short="$(git -C "$ROOT" rev-parse --short "$candidate_full")"

emit_output() { # $1 = true|false
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "rollback=$1" >> "$GITHUB_OUTPUT"
  fi
}

# --- 本番の実測（<kind>\t<name>\t<image>） ---
if [ -n "${DEPLOY_ROLLBACK_RUNNING+x}" ]; then
  if [ ! -f "$DEPLOY_ROLLBACK_RUNNING" ]; then
    echo "ERROR: DEPLOY_ROLLBACK_RUNNING のファイルが見つかりません: ${DEPLOY_ROLLBACK_RUNNING}" >&2
    exit 1
  fi
  running="$(cat "$DEPLOY_ROLLBACK_RUNNING")"
else
  : "${PROJECT_ID:?PROJECT_ID が必要です}"
  # 一覧の取得失敗を握り潰さない。$(...) の中で失敗すると空文字が返り、0 件を検査して進めてしまう。
  if ! svc="$(gcloud run services list --region="$REGION" --project="$PROJECT_ID" \
    --format='csv[no-heading](metadata.name,spec.template.spec.containers[0].image)')"; then
    echo "ERROR: gcloud run services list に失敗しました。本番の状態を読めないので、巻き戻りかどうかを判定できません。" >&2
    exit 1
  fi
  if ! job="$(gcloud run jobs list --region="$REGION" --project="$PROJECT_ID" \
    --format='csv[no-heading](metadata.name,spec.template.spec.template.spec.containers[0].image)')"; then
    echo "ERROR: gcloud run jobs list に失敗しました。本番の状態を読めないので、巻き戻りかどうかを判定できません。" >&2
    exit 1
  fi
  running="$(
    printf '%s\n' "$svc" | awk -F',' 'NF >= 2 { print "service\t" $1 "\t" $2 }'
    printf '%s\n' "$job" | awk -F',' 'NF >= 2 { print "job\t" $1 "\t" $2 }'
  )"
fi

checked=0
newer=''
while IFS=$'\t' read -r kind name image; do
  [ -n "$kind" ] || continue
  checked=$((checked + 1))
  # タグはイメージ参照の最後の `:` の後ろ。digest 指定（@sha256:）や、タグの無い参照は判定材料にならない。
  case "$image" in
    *@sha256:*) tag='' ;;
    *:*) tag="${image##*:}" ;;
    *) tag='' ;;
  esac
  running_full=''
  if [ -n "$tag" ]; then
    running_full="$(git -C "$ROOT" rev-parse --verify --quiet "${tag}^{commit}")" || running_full=''
  fi
  if [ -z "$running_full" ]; then
    echo "WARN: ${kind} ${name} のイメージ（${image}）のタグを、この履歴のコミットとして解決できません。この対象は判定から外します。"
    continue
  fi
  if [ "$running_full" = "$candidate_full" ]; then
    echo "-- ${kind} ${name}: 候補と同じコミット（${tag}）"
    continue
  fi
  if git -C "$ROOT" merge-base --is-ancestor "$candidate_full" "$running_full"; then
    echo "-- ${kind} ${name}: 候補より新しいコミット（${tag}）が動いています"
    newer="${newer} ${kind}/${name}@${tag}"
  else
    echo "-- ${kind} ${name}: ${tag} → ${candidate_short}"
  fi
done <<< "$running"

if [ "$checked" -eq 0 ]; then
  echo "ERROR: 本番のサービスとジョブが 0 件です。判定の材料が無いまま進めません。" >&2
  exit 1
fi

if [ -n "$newer" ]; then
  echo "SKIP: ${candidate_short} を出すと本番が巻き戻ります（より新しいコミットが動いている対象:${newer}）。このデプロイは行いません。"
  emit_output true
  exit 0
fi

echo "OK: ${candidate_short} は本番で動いているどのコミットより古くありません（${checked} 対象を判定）。デプロイを進めます。"
emit_output false
