#!/usr/bin/env bash
# 本番の E2E のうち、読み取りだけで確かめられる部分を 1 本で流す実行装置（Issue #257）。
# 手順書は docs/testing/e2e.md。実機でしか確かめられない部分（LINE・カメラ・LIFF）は手順書の側にある。
#
# 本番の状態は一切変えない。行うのは次の照会だけである。
#   1. 稼働イメージと origin/main の一致   scripts/check-prod-image-drift.sh
#   2. シークレットの version 構成          scripts/check-secret-version-drift.sh（値は読まない）
#   3. 外部 API 実疎通の記録の鮮度          scripts/check-external-api-smoke-freshness.sh（GCP へ繋がない）
#   4. 本番のコミットに対する ts-ci の結果   gh（e2e / e2e-surfaces / lighthouse / cross-runtime が success）
#   5. 日次ジョブの直近の実行               gcloud run jobs executions list（daily-batch・summary-delivery）
#   6. 直近の配信の件数                     gcloud logging read（delivery-job.run の件数の項目だけを表示）
#
# 4 を置く理由: ローカルで流した自動層（run-e2e-local.sh）は、本番のコミットの証拠にならないことがある。
# 2026-09-13 の実施では、ローカルで検査したのが 9ab90f5、本番は 16 コミット先の 1ce6986 だった。
# 本番のコミットの自動層は、そのコミットに対する CI の結果で確かめる。
#
# 6 は運用者の資格情報で読む（roles/logging.viewer 相当）。CI からは呼ばない。CI にログ本文を
# 読む権限を付けない設計だからである（infra/README.md §5・§11）。表示するのは件数の項目だけで、
# ログの本文は出さない。
#
# 使い方:
#   PROJECT_ID=gen-fw-line-meo bash scripts/run-e2e-prod-checks.sh
#   PROJECT_ID=gen-fw-line-meo make e2e-prod-checks
#
# env:
#   PROJECT_ID  GCP プロジェクト ID。必須（既定値を置かない。check-prod-image-drift.sh と同じ理由）
#   REGION      既定 asia-northeast1
#
# 前提: gcloud（本番プロジェクトの閲覧権限）・gh（リポジトリの閲覧権限）・git・node。
# 最初の失敗で止めず、全項目を流してから集約する。1 項目でも赤なら exit 1。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-asia-northeast1}"

# 4. で success を要求する ts-ci のジョブ。E2E の自動層に当たるものだけを並べる。
REQUIRED_CI_JOBS=(e2e e2e-surfaces lighthouse cross-runtime)
# 5. の鮮度の上限（時間）。daily-batch は毎朝 1 回、summary-delivery は毎時。
DAILY_BATCH_MAX_AGE_H=26
SUMMARY_DELIVERY_MAX_AGE_H=2

if [ -z "$PROJECT_ID" ]; then
    echo "ERROR: PROJECT_ID が未設定です（例: PROJECT_ID=gen-fw-line-meo bash scripts/run-e2e-prod-checks.sh）" >&2
    exit 2
fi
for cmd in gcloud gh git node; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: '${cmd}' が見つかりません" >&2
        exit 2
    fi
done

results=()
fail=0
record() {
    # $1=項目 $2=PASS|FAIL|WARN $3=補足
    results+=("$1|$2|$3")
    [ "$2" != 'FAIL' ] || fail=1
}

banner() {
    echo
    echo '=================================================================='
    echo ">> $1"
    echo '=================================================================='
}

# ISO 8601 の時刻から経過時間（時間・小数 1 桁）を出す。解釈できなければ exit 2。
age_hours() {
    node -e '
const t = Date.parse(process.argv[1]);
if (Number.isNaN(t)) process.exit(2);
console.log(((Date.now() - t) / 3600e3).toFixed(1));
' "$1"
}

# $1（時間・小数）が $2 以下なら 0。
within_hours() {
    node -e 'process.exit(Number(process.argv[1]) <= Number(process.argv[2]) ? 0 : 1)' "$1" "$2"
}

git -C "$ROOT" fetch --quiet origin main || echo "WARN: origin/main を fetch できませんでした。手元の参照で比較します" >&2

# --- 1. 稼働イメージ ---------------------------------------------------------------------
banner '1. 本番の稼働イメージと origin/main の一致'
if drift_out="$(bash "${SCRIPT_DIR}/check-prod-image-drift.sh" 2>&1)"; then
    drift_rc=0
else
    drift_rc=$?
fi
printf '%s\n' "$drift_out"
# 署名行（prod-image-drift-notify.sh が重複判定に使う行）から、稼働中のコミットを読む。
# デプロイの途中は、サービスごとに別のコミットが動いている（2026-09-13 に実測: 7 件のうち 4 件が新、3 件が旧）。
# そのときは 1 つに決め打ちせず、動いているコミットをすべて 4. で確かめる。
signature="$(printf '%s\n' "$drift_out" | sed -n 's/^DRIFT-SIGNATURE: //p')"
prod_shas="$(printf '%s\n' "$signature" | tr ';' '\n' | sed -n -E 's/.*@([0-9a-f]{7,40})$/\1/p' | sort -u)"
prod_sha_count="$(printf '%s\n' "$prod_shas" | sed '/^$/d' | wc -l)"
prod_sha_count=$((prod_sha_count + 0))
prod_sha_list="$(printf '%s\n' "$prod_shas" | tr '\n' ' ' | sed 's/ *$//')"
if [ "$drift_rc" -eq 0 ]; then
    record '稼働イメージ' PASS "本番のコミット ${prod_sha_list:-不明}"
else
    record '稼働イメージ' FAIL "check-prod-image-drift.sh が exit ${drift_rc}"
fi
if [ "$prod_sha_count" -gt 1 ]; then
    echo "WARN: 本番で ${prod_sha_count} つのコミットが動いています（デプロイの途中）。実機の確認はデプロイの完了を待ってください" >&2
    record '稼働イメージ' WARN "コミットが混在（${prod_sha_list}）。デプロイの完了後に実機を確認する"
fi

# --- 2. シークレット ---------------------------------------------------------------------
banner '2. 本番シークレットの version 構成'
if bash "${SCRIPT_DIR}/check-secret-version-drift.sh"; then
    record 'シークレット' PASS ''
else
    record 'シークレット' FAIL 'check-secret-version-drift.sh が非ゼロ終了'
fi

# --- 3. 実疎通の鮮度 ---------------------------------------------------------------------
banner '3. 外部 API 実疎通の記録の鮮度'
if bash "${SCRIPT_DIR}/check-external-api-smoke-freshness.sh"; then
    record '実疎通の鮮度' PASS ''
else
    record '実疎通の鮮度' FAIL 'check-external-api-smoke-freshness.sh が非ゼロ終了（手順は infra/README.md §8）'
fi

# --- 4. 本番のコミットの CI --------------------------------------------------------------
banner '4. 本番のコミットに対する ts-ci の結果'
# 本番で動いているコミットの完全な SHA（5. 以降と集約の比較に使う）。
prod_full_shas=()
check_ci_for_sha() {
    local sha="$1" item full run_line run_id run_status run_conclusion jobs_tsv missing job conclusion name concl
    item="本番コミットの CI ${sha}"
    if ! full="$(git -C "$ROOT" rev-parse --verify --quiet "${sha}^{commit}")"; then
        echo "ERROR: ${sha} をこのリポジトリで解決できません（fetch が必要です）" >&2
        record "$item" FAIL 'コミットを解決できない'
        return
    fi
    prod_full_shas+=("$full")
    if ! run_line="$(gh run list --workflow ts-ci.yml --commit "$full" --limit 1 \
        --json databaseId,status,conclusion --jq '.[] | [.databaseId, .status, .conclusion] | @tsv')"; then
        echo "ERROR: gh run list が失敗しました（gh auth status を確かめてください）" >&2
        record "$item" FAIL 'gh run list が失敗'
        return
    fi
    if [ -z "$run_line" ]; then
        echo "ERROR: ${sha} に対する ts-ci の実行が見つかりません" >&2
        record "$item" FAIL 'ts-ci の実行が無い'
        return
    fi
    IFS=$'\t' read -r run_id run_status run_conclusion <<< "$run_line"
    echo "-- ${sha}: ts-ci run ${run_id}（${run_status} / ${run_conclusion:-未完了}）"
    jobs_tsv="$(gh run view "$run_id" --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv')" || jobs_tsv=''
    missing=0
    for job in "${REQUIRED_CI_JOBS[@]}"; do
        conclusion=''
        while IFS=$'\t' read -r name concl; do
            if [ "$name" = "$job" ]; then
                conclusion="$concl"
            fi
        done <<< "$jobs_tsv"
        echo "   ${job}: ${conclusion:-（見つからない）}"
        [ "$conclusion" = 'success' ] || missing=1
    done
    if [ "$run_conclusion" = 'success' ] && [ "$missing" -eq 0 ]; then
        record "$item" PASS "run ${run_id}（E2E の 4 ジョブが success）"
    else
        record "$item" FAIL "run ${run_id} の結論 ${run_conclusion:-未完了}・E2E ジョブの不足あり"
    fi
}
if [ "$prod_sha_count" -eq 0 ]; then
    echo "ERROR: 稼働イメージの確認から、本番のコミットを読めませんでした" >&2
    record '本番コミットの CI' FAIL '本番のコミットを読めない'
else
    for sha in $prod_shas; do
        check_ci_for_sha "$sha"
    done
fi

# --- 5. 日次ジョブ -----------------------------------------------------------------------
banner '5. 日次ジョブの直近の実行'
check_job() {
    local job="$1" max_age="$2" line name created succeeded failed age
    if ! line="$(gcloud run jobs executions list --job="$job" --region="$REGION" --project="$PROJECT_ID" \
        --limit=1 --format='value(metadata.name,metadata.creationTimestamp,status.succeededCount,status.failedCount)' --quiet)"; then
        echo "ERROR: ${job} の実行一覧を取得できません（gcloud の認証と権限を確かめてください）" >&2
        record "ジョブ ${job}" FAIL '実行一覧を取得できない'
        return
    fi
    if [ -z "$line" ]; then
        echo "ERROR: ${job} の実行が 1 件もありません" >&2
        record "ジョブ ${job}" FAIL '実行が無い'
        return
    fi
    IFS=$'\t' read -r name created succeeded failed <<< "$line"
    if ! age="$(age_hours "$created")"; then
        echo "ERROR: ${job} の作成時刻を解釈できません: ${created}" >&2
        record "ジョブ ${job}" FAIL '作成時刻を解釈できない'
        return
    fi
    echo "-- ${job}: ${name}・${created}（${age} 時間前）・成功 ${succeeded:-0}・失敗 ${failed:-0}"
    if [ "${succeeded:-0}" = '1' ] && within_hours "$age" "$max_age"; then
        record "ジョブ ${job}" PASS "${age} 時間前に成功"
    else
        record "ジョブ ${job}" FAIL "直近の実行が成功でないか、${max_age} 時間より古い（${age} 時間前）"
    fi
}
check_job daily-batch "$DAILY_BATCH_MAX_AGE_H"
check_job summary-delivery "$SUMMARY_DELIVERY_MAX_AGE_H"

# --- 6. 配信の件数 -----------------------------------------------------------------------
banner '6. 直近の配信の件数（配信対象があった実行・件数の項目だけ）'
# logName で絞らないと、同じ条件でも数分かかる（2026-09-13 実測: 無しで 2 分超・有りで 2 秒）。
log_filter="resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"summary-delivery\""
log_filter="${log_filter} AND logName=\"projects/${PROJECT_ID}/logs/run.googleapis.com%2Fstdout\""
log_filter="${log_filter} AND jsonPayload.event=\"delivery-job.run\" AND jsonPayload.targetsTotal>0"
if ! log_line="$(gcloud logging read "$log_filter" --project="$PROJECT_ID" --freshness=1d --limit=1 --quiet \
    --format='value(timestamp,jsonPayload.currentJstHour,jsonPayload.targetsTotal,jsonPayload.delivered,jsonPayload.failed,jsonPayload.skipped,jsonPayload.quotaExceeded)')"; then
    echo "ERROR: 配信のログを読めません（roles/logging.viewer 相当の権限が要ります）" >&2
    record '配信の件数' FAIL 'ログを読めない'
elif [ -z "$log_line" ]; then
    echo "ERROR: 直近 24 時間に、配信対象のある summary-delivery の実行がありません" >&2
    record '配信の件数' FAIL '直近 24 時間に配信対象のある実行が無い'
else
    IFS=$'\t' read -r l_ts l_hour l_targets l_delivered l_failed l_skipped l_quota <<< "$log_line"
    echo "-- ${l_ts}（${l_hour} 時の実行）: 対象 ${l_targets}・送信 ${l_delivered}・失敗 ${l_failed}・スキップ ${l_skipped}・上限超過 ${l_quota}"
    if [ "$l_delivered" = "$l_targets" ] && [ "${l_failed:-0}" = '0' ] && [ "${l_skipped:-0}" = '0' ] && [ "${l_quota:-0}" = '0' ]; then
        record '配信の件数' PASS "対象 ${l_targets} 件をすべて送信"
    else
        record '配信の件数' FAIL "対象 ${l_targets}・送信 ${l_delivered}・失敗 ${l_failed}・スキップ ${l_skipped}・上限超過 ${l_quota}"
    fi
fi

# --- 集約 -------------------------------------------------------------------------------
head_full_sha="$(git -C "$ROOT" rev-parse HEAD)"
banner "本番の読み取り確認の結果（本番のコミット: ${prod_sha_list:-不明}・このツリー: ${head_full_sha:0:7}）"
# 状態を先頭に置く。printf の幅指定はバイト数で数えるので、日本語の項目名を左に置くと列がずれる。
for entry in ${results[@]+"${results[@]}"}; do
    IFS='|' read -r r_item r_status r_note <<< "$entry"
    printf '  %-4s  %s  %s\n' "$r_status" "$r_item" "$r_note"
done
for full in ${prod_full_shas[@]+"${prod_full_shas[@]}"}; do
    if [ "$full" != "$head_full_sha" ]; then
        echo "  WARN: このツリー（${head_full_sha:0:7}）は本番のコミット（${full:0:7}）と違います。"
        echo "        ローカルの run-e2e-local.sh の結果は本番の証拠になりません（本番のコミットは 4. の CI 結果で確かめています）"
    fi
done
echo
echo "次は実機の確認です: docs/testing/e2e.md の「4. 本番の実機確認」"
if [ "$fail" -ne 0 ]; then
    echo "NG: 赤の項目があります（各項目の出力は上にあります）" >&2
    exit 1
fi
echo "OK: 読み取りで確かめられる項目はすべて緑です"
