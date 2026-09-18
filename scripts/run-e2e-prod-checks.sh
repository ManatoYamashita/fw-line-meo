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
#   6. 直近の配信                           gcloud logging read（delivery-job.run の件数と delivery-job.fatal の有無）
#
# 6 の合格の条件は「対象をすべて送信した」ではない。通知は**変化があった日にだけ**送るので、
# 1 通も送らない実行が正常でありうる。見るのは次の 3 つである（line-on-demand-report tasks 4.5）。
#   - 失敗（failed）と上限超過（quotaExceeded）が 0 件
#   - 完了後メニューの準備判定（reportMenuReady）が true
#   - すべての対象が、送信か理由つきの見送り（当日の集計なし・変化なし・比較不能・メニュー未準備）の
#     どちらかに数えられている
# 準備判定を条件に含めるのは、メニューの差し替え（spec の Step C）の後もメニュー未準備が続く状態を
# 緑にしないためである。Step B から C の間は意図どおり赤になる。
#
# 4 を置く理由: ローカルで流した自動層（run-e2e-local.sh）は、本番のコミットの証拠にならないことがある。
# 2026-09-13 の実施では、ローカルで検査したのが 9ab90f5、本番は 16 コミット先の 1ce6986 だった。
# 本番のコミットの自動層は、そのコミットに対する CI の結果で確かめる。
#
# 6 は運用者の資格情報で読む（roles/logging.viewer 相当）。CI からは呼ばない。CI にログ本文を
# 読む権限を付けない設計だからである（infra/README.md §5・§11）。表示するのは件数と時刻だけで、
# ログの本文は出さない。
#
# 使い方:
#   PROJECT_ID=gen-fw-line-meo bash scripts/run-e2e-prod-checks.sh
#   PROJECT_ID=gen-fw-line-meo make e2e-prod-checks
#
# env:
#   PROJECT_ID  GCP プロジェクト ID。必須（既定値を置かない。check-prod-image-drift.sh と同じ理由）
#   REGION      既定 asia-northeast1
#   PROD_DELIVERY_RUN_SNAPSHOT
#               6 の判定を外から試すための注入口。`gcloud logging read --format=json` と同じ形
#               （`[{ "timestamp": …, "jsonPayload": { … } }]`）の JSON を渡すと、配信のログを
#               読まずにその値で判定する。**設定されているかどうかで判定する**（空文字も注入と
#               みなす）。`${VAR:-}` で見ると、空文字を渡した試験が実 API へ落ちる
#
# 前提: gcloud（本番プロジェクトの閲覧権限）・gh（リポジトリの閲覧権限）・git・node。
# 最初の失敗で止めず、全項目を流してから集約する。1 項目でも FAIL なら exit 1。WARN は exit を変えない。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# gh はカレントディレクトリからリポジトリを決めるので、どこから呼ばれてもルートで動かす。
cd "$ROOT"

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

# 照会結果を列で読むときは JSON で受けて node で判定する。**タブ区切り（value() や @tsv）を
# IFS=$'\t' の read で読んではならない。** タブは IFS の空白文字なので連続すると 1 つに潰れ、
# 空の列があると後ろの列が前へずれる。実例: 失敗した実行では API が succeededCount を返さず
# （0 の項目は省かれる）、「成功 空・失敗 1」が「成功 1・失敗 空」と読まれて PASS になった
# （PR #262 のレビューで実測）。

git fetch --quiet origin main || echo "WARN: origin/main を fetch できませんでした。手元の参照で比較します" >&2

# --- 1. 稼働イメージ ---------------------------------------------------------------------
banner '1. 本番の稼働イメージと origin/main の一致'
if drift_out="$(bash "${SCRIPT_DIR}/check-prod-image-drift.sh" 2>&1)"; then
    drift_rc=0
else
    drift_rc=$?
fi
printf '%s\n' "$drift_out"
# 署名行（prod-image-drift-notify.sh が重複判定に使う行）から、稼働中のコミットを読む。
# 各項目は <kind>/<name>=<status>@<tag>。status が in-flight の項目は、main がまだ本番へ届いていない
# （デプロイ待ち、またはデプロイの途中）ことを表す。drift は猶予内なら exit 0 を返すので、ここで拾う。
signature="$(printf '%s\n' "$drift_out" | sed -n 's/^DRIFT-SIGNATURE: //p')"
entries="$(printf '%s\n' "$signature" | tr ';' '\n' | sed '/^$/d')"
in_flight="$(printf '%s\n' "$entries" | sed -n '/=in-flight@/p' | sed '/^$/d' | wc -l)"
in_flight=$((in_flight + 0))
short_tags="$(printf '%s\n' "$entries" | sed -n -E 's/.*@([0-9a-f]{7,40})$/\1/p' | sort -u)"
# 短い SHA は桁数がそろうとは限らない（core.abbrev=auto）。完全な SHA へ解決してから重複を除く。
prod_full_shas=()
unresolved_tags=()
for tag in $short_tags; do
    if full="$(git rev-parse --verify --quiet "${tag}^{commit}")"; then
        dup=0
        for seen in ${prod_full_shas[@]+"${prod_full_shas[@]}"}; do
            [ "$seen" = "$full" ] && dup=1
        done
        [ "$dup" -eq 1 ] || prod_full_shas+=("$full")
    else
        unresolved_tags+=("$tag")
    fi
done
prod_sha_list=''
for full in ${prod_full_shas[@]+"${prod_full_shas[@]}"}; do
    prod_sha_list="${prod_sha_list:+${prod_sha_list} }${full:0:7}"
done
if [ "$drift_rc" -eq 0 ]; then
    record '稼働イメージ' PASS "本番のコミット ${prod_sha_list:-不明}"
else
    record '稼働イメージ' FAIL "check-prod-image-drift.sh が exit ${drift_rc}"
fi
if [ "$in_flight" -gt 0 ] || [ "${#prod_full_shas[@]}" -gt 1 ]; then
    echo "WARN: main がまだ本番へ届いていません（in-flight ${in_flight} 件・稼働中のコミット ${#prod_full_shas[@]} 種類）。実機の確認はデプロイの完了を待ってください" >&2
    record '稼働イメージ' WARN "デプロイ待ち・デプロイ中（in-flight ${in_flight} 件）。完了後に実機を確認する"
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
check_ci_for_sha() {
    local full="$1" item run_line run_id run_status run_conclusion jobs_tsv missing job conclusion name concl
    item="本番コミットの CI ${full:0:7}"
    if ! run_line="$(gh run list --workflow ts-ci.yml --commit "$full" --limit 1 \
        --json databaseId,status,conclusion --jq '.[] | [.databaseId, .status, .conclusion] | @tsv')"; then
        echo "ERROR: gh run list が失敗しました（gh auth status を確かめてください）" >&2
        record "$item" FAIL 'gh run list が失敗'
        return
    fi
    if [ -z "$run_line" ]; then
        echo "ERROR: ${full:0:7} に対する ts-ci の実行が見つかりません" >&2
        record "$item" FAIL 'ts-ci の実行が無い'
        return
    fi
    # 空になりうるのは末尾の conclusion（実行中）だけなので、タブの潰れで列はずれない。
    IFS=$'\t' read -r run_id run_status run_conclusion <<< "$run_line"
    echo "-- ${full:0:7}: ts-ci run ${run_id}（${run_status} / ${run_conclusion:-未完了}）"
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
for tag in ${unresolved_tags[@]+"${unresolved_tags[@]}"}; do
    echo "ERROR: ${tag} をこのリポジトリで解決できません（fetch が必要です）" >&2
    record "本番コミットの CI ${tag}" FAIL 'コミットを解決できない'
done
if [ "${#prod_full_shas[@]}" -eq 0 ] && [ "${#unresolved_tags[@]}" -eq 0 ]; then
    echo "ERROR: 稼働イメージの確認から、本番のコミットを読めませんでした" >&2
    record '本番コミットの CI' FAIL '本番のコミットを読めない'
fi
for full in ${prod_full_shas[@]+"${prod_full_shas[@]}"}; do
    check_ci_for_sha "$full"
done

# --- 5. 日次ジョブ -----------------------------------------------------------------------
banner '5. 日次ジョブの直近の実行'
check_job() {
    local job="$1" max_age="$2" json verdict v_status v_info
    if ! json="$(gcloud run jobs executions list --job="$job" --region="$REGION" --project="$PROJECT_ID" --limit=3 \
        --format='json(metadata.name,metadata.creationTimestamp,status.completionTime,status.succeededCount,status.failedCount)' --quiet)"; then
        echo "ERROR: ${job} の実行一覧を取得できません（gcloud の認証と権限を確かめてください）" >&2
        record "ジョブ ${job}" FAIL '実行一覧を取得できない'
        return
    fi
    # 実行中（completionTime が無い）のものは飛ばし、最も新しい完了済みの実行で判定する。
    # 一覧は未開始・実行中が先頭、その後は開始時刻の降順に並ぶ。
    # shellcheck disable=SC2016  # node へ渡す JS をそのまま書くため、単一引用符の中で展開させない。
    if ! verdict="$(JOB_JSON="$json" MAX_AGE_H="$max_age" node -e '
const list = JSON.parse(process.env.JOB_JSON || "[]");
const idx = list.findIndex((e) => e.status && e.status.completionTime);
if (idx < 0) {
  console.log(`FAIL|完了した実行がありません（取得 ${list.length} 件）`);
  process.exit(0);
}
const e = list[idx];
const succeeded = Number(e.status.succeededCount ?? 0);
const failed = Number(e.status.failedCount ?? 0);
const created = e.metadata.creationTimestamp;
const age = (Date.now() - Date.parse(created)) / 3600e3;
if (Number.isNaN(age)) {
  console.log(`FAIL|作成時刻を解釈できません: ${created}`);
  process.exit(0);
}
const ok = succeeded >= 1 && failed === 0 && age <= Number(process.env.MAX_AGE_H);
const note = idx > 0 ? `・実行中 ${idx} 件を飛ばした` : "";
console.log(`${ok ? "PASS" : "FAIL"}|${e.metadata.name}・${created}（${age.toFixed(1)} 時間前）・成功 ${succeeded}・失敗 ${failed}${note}`);
')"; then
        echo "ERROR: ${job} の実行一覧を解釈できません" >&2
        record "ジョブ ${job}" FAIL '実行一覧を解釈できない'
        return
    fi
    IFS='|' read -r v_status v_info <<< "$verdict"
    echo "-- ${job}: ${v_info}"
    if [ "$v_status" = 'PASS' ]; then
        record "ジョブ ${job}" PASS "直近の完了済みの実行が成功（${max_age} 時間以内）"
    else
        record "ジョブ ${job}" FAIL "直近の完了済みの実行が失敗か、${max_age} 時間より古い"
    fi
}
check_job daily-batch "$DAILY_BATCH_MAX_AGE_H"
check_job summary-delivery "$SUMMARY_DELIVERY_MAX_AGE_H"

# --- 6. 直近の配信 -----------------------------------------------------------------------
banner '6. 直近の配信（失敗と上限超過が 0 件・準備判定が true・対象がすべて数えられている）'
# logName で絞らないと、同じ条件でも数分かかる（2026-09-13 実測: 無しで 2 分超・有りで 2 秒）。
# 件数の要約（delivery-job.run）は info なので stdout、致命的な失敗（delivery-job.fatal）は error なので
# stderr へ出る（@fwlm/observability の sink が console[level] で書く）。
log_base="resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"summary-delivery\""
run_filter="${log_base} AND logName=\"projects/${PROJECT_ID}/logs/run.googleapis.com%2Fstdout\""
run_filter="${run_filter} AND jsonPayload.event=\"delivery-job.run\" AND jsonPayload.targetsTotal>0"
fatal_filter="${log_base} AND logName=\"projects/${PROJECT_ID}/logs/run.googleapis.com%2Fstderr\""
fatal_filter="${fatal_filter} AND jsonPayload.event=\"delivery-job.fatal\""

# 判定を外から試せるよう、実行サマリーの JSON を注入できるようにする。**設定の有無で判定する**
# （`${VAR:-}` だと空文字が未設定と同義になり、空を渡した試験が実 API へ落ちる）。
run_read_ok=1
run_json=''
if [ -n "${PROD_DELIVERY_RUN_SNAPSHOT+x}" ]; then
    echo '-- 注入された実行サマリー（PROD_DELIVERY_RUN_SNAPSHOT）で判定します。配信のログは読みません'
    run_json="$PROD_DELIVERY_RUN_SNAPSHOT"
elif ! run_json="$(gcloud logging read "$run_filter" --project="$PROJECT_ID" --freshness=1d --limit=1 --quiet \
    --format='json(timestamp,jsonPayload.currentJstHour,jsonPayload.targetsTotal,jsonPayload.delivered,jsonPayload.failed,jsonPayload.skipped,jsonPayload.quotaExceeded,jsonPayload.skippedNoChange,jsonPayload.skippedNotComparable,jsonPayload.skippedMenuUnavailable,jsonPayload.reportMenuReady)')"; then
    run_read_ok=0
fi

# shellcheck disable=SC2016  # node へ渡す JS をそのまま書くため、単一引用符の中で展開させない。
if [ "$run_read_ok" -eq 0 ]; then
    echo "ERROR: 配信のログを読めません（roles/logging.viewer 相当の権限が要ります）" >&2
    record '配信の件数' FAIL 'ログを読めない'
elif ! run_verdict="$(RUN_JSON="$run_json" node -e '
const list = JSON.parse(process.env.RUN_JSON || "[]");
if (list.length === 0) {
  console.log("FAIL|直近 24 時間に、配信対象のある実行がありません");
  process.exit(0);
}
const p = list[0].jsonPayload || {};
// 通知は変化があった日にだけ送るので、送信数そのものは合格の条件にならない。見るのは
// 「失敗と上限超過が 0 件」「準備判定が true」「すべての対象が数えられている」の 3 つである。
const counts = ["targetsTotal", "delivered", "failed", "skipped", "quotaExceeded",
  "skippedNoChange", "skippedNotComparable", "skippedMenuUnavailable"];
const absent = counts.filter((k) => typeof p[k] !== "number");
if (typeof p.reportMenuReady !== "boolean") {
  absent.push("reportMenuReady");
}
if (absent.length > 0) {
  console.log(`FAIL|実行サマリーの項目が欠けています: ${absent.join(", ")}`);
  process.exit(0);
}
// **数え上げには失敗と上限超過も含める。** 含めないと「1 件でも失敗があれば合計が足りない」と
// なり、失敗 0 件の条件が数え上げに吸収されて**単独では一度も効かない**（条件を 1 つ壊しても
// 別の条件が赤にするので、壊れたことに気づけない）。ここでは「どのバケツにも数えられていない
// 対象が無いこと」だけを見て、失敗と上限超過は独立した条件として残す。
const accounted = p.delivered + p.failed + p.quotaExceeded + p.skipped
  + p.skippedNoChange + p.skippedNotComparable + p.skippedMenuUnavailable;
const ok = p.failed === 0 && p.quotaExceeded === 0 && p.reportMenuReady === true && accounted === p.targetsTotal;
const detail = `対象 ${p.targetsTotal}・送信 ${p.delivered}・失敗 ${p.failed}・上限超過 ${p.quotaExceeded}`
  + `・見送り（集計なし ${p.skipped}／変化なし ${p.skippedNoChange}／比較不能 ${p.skippedNotComparable}`
  + `／メニュー未準備 ${p.skippedMenuUnavailable}）・準備判定 ${p.reportMenuReady}`;
const why = [];
if (p.failed !== 0) why.push("失敗あり");
if (p.quotaExceeded !== 0) why.push("上限超過あり");
if (p.reportMenuReady !== true) why.push("完了後メニューが未準備");
if (accounted !== p.targetsTotal) why.push(`数えられていない対象が ${p.targetsTotal - accounted} 件`);
console.log(`${ok ? "PASS" : "FAIL"}|${list[0].timestamp}（${p.currentJstHour} 時の実行）: ${detail}`
  + `${ok ? "" : ` → ${why.join("・")}`}`);
')"; then
    echo "ERROR: 配信のログを解釈できません" >&2
    record '配信の件数' FAIL 'ログを解釈できない'
else
    IFS='|' read -r r_status r_info <<< "$run_verdict"
    echo "-- ${r_info}"
    record '配信の件数' "$r_status" "$r_info"
fi

# 件数の要約は成功した実行しか出さない。致命的に失敗した実行は delivery-job.fatal だけを出すので、
# 上の照会は 24 時間以内の古い成功を拾いうる。失敗は別に数える。
if ! fatal_ts="$(gcloud logging read "$fatal_filter" --project="$PROJECT_ID" --freshness=1d --limit=1 --quiet \
    --format='value(timestamp)')"; then
    echo "ERROR: 配信の失敗ログを読めません" >&2
    record '配信の致命的な失敗' FAIL 'ログを読めない'
elif [ -n "$fatal_ts" ]; then
    echo "-- 直近 24 時間に delivery-job.fatal があります: ${fatal_ts}（相関 ID からの追い方は infra/README.md §11-4）"
    record '配信の致命的な失敗' FAIL "直近 24 時間にあり（${fatal_ts}）"
else
    echo "-- 直近 24 時間に delivery-job.fatal はありません"
    record '配信の致命的な失敗' PASS '直近 24 時間になし'
fi

# --- 集約 -------------------------------------------------------------------------------
head_full_sha="$(git rev-parse HEAD)"
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
    echo "NG: FAIL の項目があります（各項目の出力は上にあります）" >&2
    exit 1
fi
echo "OK: 読み取りで確かめられる項目に FAIL はありません"
