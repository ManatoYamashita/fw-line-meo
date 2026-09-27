#!/usr/bin/env bash
# Issue #139（#125 の残件）: 外部 API（places / line-messaging）の生死を、本番の実トラフィックに
# 現れる成否の件数で判定する。
#
# **なぜ要るか。** #125 の層3（infra/external-api-smoke.tsv・有効期間 14 日）は、運用者が 14 日ごとに
# 思い出して叩く儀式に依存している。places と line-messaging は定期ジョブが毎日・毎時叩いているので、
# その成否を数えれば人の記憶に頼らず生死を知れる。本スクリプトはその判定を行う。
#
# **gemini は対象外。** 客がアンケートに答えたときにしか叩かれず「0 件＝正常」があり得るため、
# 「キーが死んでいる」と「誰も使っていない」を観測から区別できない。gemini については #125 の
# 手動実疎通が唯一の手段として存続する（steering tech.md の #125 / #139 の項）。
#
# **判定は 4 状態で、成功回数だけを閾値で見ない。** 成功回数が 0 のとき、それが「実行して全部
# 失敗した」のか「実行していない」のか「叩く対象が無かった」のかを分けないと、対象 0 件で緑になる
# （#125 で steering に書いた「execution 成否を証拠に採ってはならない」と同じ罠）か、実行していない
# だけの日を「API が死んだ」と誤報する。
#
#   ALIVE       成功が 1 件以上 → 緑
#   DEAD        判定材料はあるのに成功が 0（実行して全部失敗した）→ 赤
#   NOT_RUN     ジョブの完了した実行が 0（実行していない。API の死ではない）→ 赤
#   UNOBSERVED  実行はあるが判定材料が無い（places の対象 0 件・指標の作成直後・指標が未作成）
#               → **緑にしない。** exit 0 のまま署名へ <api>=unobserved; を載せ、ワークフローが
#               追跡 Issue で知らせる。このとき生死の証拠は #125 の手動実疎通だけである
#
#   API             成功の件数                    判定材料（これが 1 以上で成功 0 なら DEAD）  窓
#   places          places_fetch_ok_runs          places_fetch_eligible_runs（対象 1 件以上の実行） 30h
#   line-messaging  line_token_issued_runs        line_token_issue_failures（トークン発行の失敗） 3h
#
# 実行の有無は組込み指標 run.googleapis.com/job/completed_execution_count をジョブ名で絞って数える。
# 窓は daily-batch（毎日 06:00 JST）と summary-delivery（毎時）の周期に余裕を足したもの。
#
# **ログを 1 行も読まない。** 読むのは Monitoring の timeSeries（指標の値）と metricDescriptors
# （指標の定義）だけで、どちらも roles/monitoring.viewer（#230 で CI に付与済み）に含まれる。
# logging 系のロールを付けると CI がログ本文を読めるようになるので付けない（#230 と同じ線）。
# **新しい IAM 付与はゼロ**である。
#
# 使い方: PROJECT_ID=<id> bash scripts/check-external-api-liveness.sh
#   赤（DEAD / NOT_RUN / 構成の異常）があれば exit 1、無ければ exit 0。
#   最終行近くに `EXTERNAL-API-LIVENESS-SIGNATURE: places=<state>;line-messaging=<state>;` を出す。
#
# 環境変数（既定はすべて本番挙動）:
#   PROJECT_ID                       GCP プロジェクト ID。収集するときは**必須**（既定値を置かない）
#   EXTERNAL_API_LIVENESS_SNAPSHOT   正規化済みの件数（TSV 2 列）の注入。設定されていれば収集しない
#   EXTERNAL_API_LIVENESS_RAW_DIR    **収集経路そのもの**の注入。API 応答の生の形を置く:
#                                    metric-descriptors.json と <series>.json（timeSeries の応答）。
#                                    SNAPSHOT だけを持つと、応答から件数を組み立てる区間が CI でも
#                                    自己テストでも一度も走らない（#230 の偽緑が潜んでいた区間）
#   判定はいずれも `${VAR+x}`（設定されているか）で行う。空文字を渡したら「未設定」ではなく
#   「空の注入」として扱い、実 API へ落ちない（#108 の是正と同じ）。
#
# snapshot の形式（TSV 2 列・`#` 始まりと空行は読み飛ばす）:
#   <series>\t<件数 | absent>
#     series : places_fetch_ok_runs / places_fetch_eligible_runs / places_executions /
#              line_token_issued_runs / line_token_issue_failures / line_executions
#     absent : 指標の定義が本番に無い（apply 前）。*_executions には使えない
#
# 呼び出し（read-only）:
#   GET https://monitoring.googleapis.com/v3/projects/<P>/metricDescriptors
#       ?filter=metric.type = starts_with("logging.googleapis.com/user/")
#   GET https://monitoring.googleapis.com/v3/projects/<P>/timeSeries
#       ?filter=<指標>&interval.startTime=<now-窓>&interval.endTime=<now>
#       &aggregation.alignmentPeriod=3600s&aggregation.perSeriesAligner=ALIGN_SUM
#       &aggregation.crossSeriesReducer=REDUCE_SUM
#
#   read-only・連想配列を使わず bash 3.2 でも走る。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ $# -gt 0 ]; then
  case "$1" in
    -h|--help)
      sed -n '2,68p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: 未知の引数です: $1" >&2
      echo "       → 使い方は bash scripts/check-external-api-liveness.sh --help を参照してください。" >&2
      exit 2
      ;;
  esac
fi

# 窓（時間）。周期に余裕を足した値で、判定の意味を変えるので定数にする。
PLACES_WINDOW_HOURS=30
LINE_WINDOW_HOURS=3

# ジョブ名。tf（infra/modules/batch-job・delivery-job の job_name 既定値）と同じ値でなければならない。
# 下でデプロイ正典（check-deploy-image-coverage.sh --print-targets）の job 行に実在することを照合し、
# 綴り違いや改名の取り残しで「実行 0 件」を読み続ける状態（＝永久に NOT_RUN）を防ぐ。
PLACES_JOB="daily-batch"
LINE_JOB="summary-delivery"

# 判定が読む系列。ログベース指標の名前は infra/modules/guardrails/main.tf の
# `# monitoring-coverage: ci-read (#139)` 宣言と対であり、check-monitoring-coverage.sh が
# ここに名前が書かれていることを照合する。
USER_METRICS="places_fetch_ok_runs places_fetch_eligible_runs line_token_issued_runs line_token_issue_failures"
ALL_SERIES="places_fetch_ok_runs places_fetch_eligible_runs places_executions line_token_issued_runs line_token_issue_failures line_executions"

COVERAGE_GUARD="${SCRIPT_DIR}/check-deploy-image-coverage.sh"

TMPWORK="$(mktemp -d "${TMPDIR:-/tmp}/external-api-liveness.XXXXXX")"
trap 'rm -rf "$TMPWORK"' EXIT

# 署名は元の stdout（fd 3）へ出す。正規化の関数は出力を snapshot ファイルへ向けて呼ばれるので、
# 素の stdout へ書くと署名が snapshot に混ざって消える。
exec 3>&1

# 構成の異常で早期に止まるときも署名を出す（ワークフローが空の署名を扱わずに済むように）。
fail_early() {
  # $1 = 署名の値, 残り = stderr へ出す行
  sig_value="$1"
  shift
  for msg_line in "$@"; do
    echo "$msg_line" >&2
  done
  echo "EXTERNAL-API-LIVENESS-SIGNATURE: ${sig_value};" >&3
  exit 1
}

# --- 注入の排他 ---------------------------------------------------------------------------
if [ -n "${EXTERNAL_API_LIVENESS_SNAPSHOT+x}" ] && [ -n "${EXTERNAL_API_LIVENESS_RAW_DIR+x}" ]; then
  fail_early config-error \
    "ERROR: EXTERNAL_API_LIVENESS_SNAPSHOT と EXTERNAL_API_LIVENESS_RAW_DIR は同時に指定できません。"
fi

# --- ジョブ名がデプロイ正典に実在すること --------------------------------------------------
canon_rc=0
canon_tsv="$(bash "$COVERAGE_GUARD" --print-targets 2>/dev/null)" || canon_rc=$?
if [ "$canon_rc" -ne 0 ]; then
  fail_early config-error \
    "ERROR: デプロイ正典を取得できません（check-deploy-image-coverage.sh が exit=${canon_rc}）。"
fi
for job in "$PLACES_JOB" "$LINE_JOB"; do
  job_hits="$(printf '%s\n' "$canon_tsv" | awk -F'\t' -v j="$job" '$1 == "job" && $2 == j' | wc -l | tr -d '[:space:]')"
  if [ "$job_hits" -ne 1 ]; then
    fail_early config-error \
      "ERROR: ジョブ \"${job}\" がデプロイ正典の job にありません。" \
      "       → 改名・撤去の取り残しです。このまま読むと実行 0 件が続き、永久に NOT_RUN になります。"
  fi
done

# --- 収集: 生の応答を RAW_DIR へ集める ------------------------------------------------------
rfc3339() {
  # $1 = epoch 秒。jq の todate は GNU/BSD の date の差（-d / -r）に依存しない。
  jq -rn --argjson t "$1" '$t | todate'
}

urlenc() {
  jq -rn --arg v "$1" '$v | @uri'
}

series_filter() {
  case "$1" in
    places_executions) printf 'metric.type = "run.googleapis.com/job/completed_execution_count" AND resource.type = "cloud_run_job" AND resource.labels.job_name = "%s"' "$PLACES_JOB" ;;
    line_executions) printf 'metric.type = "run.googleapis.com/job/completed_execution_count" AND resource.type = "cloud_run_job" AND resource.labels.job_name = "%s"' "$LINE_JOB" ;;
    *) printf 'metric.type = "logging.googleapis.com/user/%s"' "$1" ;;
  esac
}

series_window_hours() {
  case "$1" in
    places_*) echo "$PLACES_WINDOW_HOURS" ;;
    line_*) echo "$LINE_WINDOW_HOURS" ;;
    *) return 1 ;;
  esac
}

collect_live() {
  # $1 = 出力先ディレクトリ
  if [ -z "${PROJECT_ID:-}" ]; then
    fail_early config-error "ERROR: PROJECT_ID が未設定です（既定値は置きません）。"
  fi
  cl_rc=0
  cl_token="$(gcloud auth print-access-token 2>/dev/null)" || cl_rc=$?
  if [ "$cl_rc" -ne 0 ] || [ -z "$cl_token" ]; then
    fail_early config-error "ERROR: アクセストークンを取得できません（gcloud auth print-access-token exit=${cl_rc}）。"
  fi
  # トークンをコマンドラインへ置かない（同一ホストの ps で読める）。ヘッダは 600 の一時ファイルで渡す。
  cl_hdr="${TMPWORK}/auth-header"
  (umask 077 && printf 'Authorization: Bearer %s\n' "$cl_token" > "$cl_hdr")
  cl_base="https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}"

  cl_desc_filter="$(urlenc 'metric.type = starts_with("logging.googleapis.com/user/")')"
  curl -sS -f -H "@${cl_hdr}" "${cl_base}/metricDescriptors?filter=${cl_desc_filter}&pageSize=1000" \
    > "$1/metric-descriptors.json" || {
    fail_early config-error "ERROR: metricDescriptors を照会できません（権限は roles/monitoring.viewer・infra/modules/cicd-wif）。"
  }

  # 定義の無い指標の timeSeries を照会すると 404 で落ちる（2026-09-27 に本番で実測）。
  # 定義が無いことは正規化が metric-descriptors.json から absent と読むので、ここでは取りに行かない。
  cl_names_rc=0
  cl_names="$(jq -r '(.metricDescriptors // [])[] | .type' "$1/metric-descriptors.json")" || cl_names_rc=$?
  if [ "$cl_names_rc" -ne 0 ]; then
    fail_early config-error "ERROR: metricDescriptors の応答を解釈できません（jq exit=${cl_names_rc}）。"
  fi

  cl_now="$(date -u +%s)"
  for s in $ALL_SERIES; do
    case " $USER_METRICS " in
      *" $s "*)
        cl_present="$(printf '%s\n' "$cl_names" | awk -v n="logging.googleapis.com/user/${s}" '$0 == n' | wc -l | tr -d '[:space:]')"
        if [ "$cl_present" -eq 0 ]; then
          continue
        fi
        ;;
    esac
    cl_hours="$(series_window_hours "$s")"
    cl_start="$(rfc3339 $((cl_now - cl_hours * 3600)))"
    cl_end="$(rfc3339 "$cl_now")"
    cl_q="filter=$(urlenc "$(series_filter "$s")")"
    cl_q="${cl_q}&interval.startTime=$(urlenc "$cl_start")&interval.endTime=$(urlenc "$cl_end")"
    cl_q="${cl_q}&aggregation.alignmentPeriod=3600s&aggregation.perSeriesAligner=ALIGN_SUM&aggregation.crossSeriesReducer=REDUCE_SUM"
    curl -sS -f -H "@${cl_hdr}" "${cl_base}/timeSeries?${cl_q}" > "$1/${s}.json" || {
      fail_early config-error "ERROR: timeSeries（${s}）を照会できません。"
    }
  done
}

# --- 正規化: 生の応答 → `<series>\t<件数|absent>` ------------------------------------------
normalize_raw() {
  # $1 = RAW_DIR
  nr_desc="$1/metric-descriptors.json"
  if [ ! -f "$nr_desc" ]; then
    fail_early config-error "ERROR: ${nr_desc} がありません。"
  fi
  nr_names_rc=0
  nr_names="$(jq -r '(.metricDescriptors // [])[] | .type' "$nr_desc" | sed -n 's#^logging\.googleapis\.com/user/##p')" || nr_names_rc=$?
  if [ "$nr_names_rc" -ne 0 ]; then
    fail_early config-error "ERROR: metricDescriptors の応答を解釈できません（jq/sed exit=${nr_names_rc}）。"
  fi
  for s in $ALL_SERIES; do
    case " $USER_METRICS " in
      *" $s "*)
        nr_present="$(printf '%s\n' "$nr_names" | awk -v n="$s" '$0 == n' | wc -l | tr -d '[:space:]')"
        if [ "$nr_present" -eq 0 ]; then
          printf '%s\tabsent\n' "$s"
          continue
        fi
        ;;
    esac
    nr_file="$1/${s}.json"
    if [ ! -f "$nr_file" ]; then
      fail_early config-error "ERROR: ${nr_file} がありません。"
    fi
    # 値が無い（timeSeries が空）のは 0 件である。ログベースのカウンタは 0 を書かないので、
    # 「系列が無い」をここで 0 と読む。int64Value は文字列で返る。
    nr_sum_rc=0
    nr_sum="$(jq -r '[(.timeSeries // [])[] | (.points // [])[] | (.value.int64Value // .value.doubleValue // 0 | tonumber)] | add // 0 | floor' "$nr_file")" || nr_sum_rc=$?
    nr_sum_bad=0
    case "$nr_sum" in
      '' | *[!0-9]*) nr_sum_bad=1 ;;
    esac
    if [ "$nr_sum_rc" -ne 0 ] || [ "$nr_sum_bad" -ne 0 ]; then
      fail_early config-error "ERROR: ${s} の timeSeries 応答を件数へ畳めません（jq exit=${nr_sum_rc}・値='${nr_sum}'）。"
    fi
    printf '%s\t%s\n' "$s" "$nr_sum"
  done
}

SNAPSHOT_FILE="${TMPWORK}/snapshot.tsv"
injected_note=""
if [ -n "${EXTERNAL_API_LIVENESS_SNAPSHOT+x}" ]; then
  if [ ! -f "$EXTERNAL_API_LIVENESS_SNAPSHOT" ]; then
    fail_early config-error "ERROR: EXTERNAL_API_LIVENESS_SNAPSHOT が見つかりません: '${EXTERNAL_API_LIVENESS_SNAPSHOT}'"
  fi
  # 無一致（1）は「行が無い」で、下の行数検査が赤にする。評価不能（2 以上）は握り潰さない。
  snap_rc=0
  grep -Ev '^[[:space:]]*(#|$)' "$EXTERNAL_API_LIVENESS_SNAPSHOT" > "$SNAPSHOT_FILE" || snap_rc=$?
  if [ "$snap_rc" -gt 1 ]; then
    fail_early config-error "ERROR: EXTERNAL_API_LIVENESS_SNAPSHOT を読めません（grep exit=${snap_rc}）。"
  fi
  injected_note="（注入: EXTERNAL_API_LIVENESS_SNAPSHOT）"
elif [ -n "${EXTERNAL_API_LIVENESS_RAW_DIR+x}" ]; then
  if [ ! -d "$EXTERNAL_API_LIVENESS_RAW_DIR" ]; then
    fail_early config-error "ERROR: EXTERNAL_API_LIVENESS_RAW_DIR が見つかりません: '${EXTERNAL_API_LIVENESS_RAW_DIR}'"
  fi
  normalize_raw "$EXTERNAL_API_LIVENESS_RAW_DIR" > "$SNAPSHOT_FILE"
  injected_note="（注入: EXTERNAL_API_LIVENESS_RAW_DIR）"
else
  RAW="${TMPWORK}/raw"
  mkdir -p "$RAW"
  collect_live "$RAW"
  normalize_raw "$RAW" > "$SNAPSHOT_FILE"
fi

# --- snapshot の検証: 各系列がちょうど 1 行 ------------------------------------------------
value_of() {
  awk -F'\t' -v s="$1" '$1 == s { print $2 }' "$SNAPSHOT_FILE"
}

for s in $ALL_SERIES; do
  rows="$(awk -F'\t' -v s="$s" '$1 == s' "$SNAPSHOT_FILE" | wc -l | tr -d '[:space:]')"
  if [ "$rows" -ne 1 ]; then
    fail_early config-error "ERROR: 系列 ${s} の行が ${rows} 件です（ちょうど 1 件が必要です）。"
  fi
  v="$(value_of "$s")"
  case "$v" in
    absent)
      case "$s" in
        *_executions) fail_early config-error "ERROR: 組込み指標 ${s} に absent は使えません。" ;;
      esac
      ;;
    *)
      case "$v" in
        '' | *[!0-9]*) fail_early config-error "ERROR: 系列 ${s} の値が件数でも absent でもありません: '${v}'" ;;
      esac
      ;;
  esac
done
unknown_rows="$(awk -F'\t' -v all=" $ALL_SERIES " 'index(all, " " $1 " ") == 0' "$SNAPSHOT_FILE" | wc -l | tr -d '[:space:]')"
if [ "$unknown_rows" -ne 0 ]; then
  fail_early config-error "ERROR: 未知の系列が ${unknown_rows} 行あります（綴り違いの可能性）。"
fi

# 判定の根拠を残す。追跡 Issue の本文から、どの件数でその状態になったかを読めるようにする。
echo "件数（places は直近 ${PLACES_WINDOW_HOURS} 時間・line-messaging は直近 ${LINE_WINDOW_HOURS} 時間）:"
for s in $ALL_SERIES; do
  printf '  %s\t%s\n' "$s" "$(value_of "$s")"
done

# --- 判定 -----------------------------------------------------------------------------------
# $1 = API 名, $2 = 成功, $3 = 判定材料, $4 = 実行, $5 = 窓（時間）, $6 = 判定材料の説明
# 結果は STATE へ入れ、行を stdout / stderr へ出す。
judge() {
  j_api="$1"; j_ok="$2"; j_basis="$3"; j_exec="$4"; j_hours="$5"; j_basis_label="$6"
  if [ "$j_ok" = "absent" ] || [ "$j_basis" = "absent" ]; then
    STATE=unobserved
    echo "WARN ${j_api}: UNOBSERVED — 判定に使う指標が本番にありません（terraform apply 前の可能性）。生死の証拠は #125 の手動実疎通だけです。"
    return 0
  fi
  if [ "$j_exec" -eq 0 ]; then
    STATE=not_run
    echo "NG ${j_api}: NOT_RUN — 直近 ${j_hours} 時間にジョブの完了した実行が 0 件です。API の死ではなく、ジョブが走っていません（Cloud Scheduler・ジョブの状態を確認）。" >&2
    return 0
  fi
  if [ "$j_ok" -gt 0 ]; then
    STATE=alive
    echo "OK ${j_api}: ALIVE — 直近 ${j_hours} 時間に成功 ${j_ok} 件（実行 ${j_exec} 件・${j_basis_label} ${j_basis} 件）。"
    return 0
  fi
  if [ "$j_basis" -gt 0 ]; then
    STATE=dead
    echo "NG ${j_api}: DEAD — 直近 ${j_hours} 時間に実行 ${j_exec} 件・${j_basis_label} ${j_basis} 件で、成功が 0 件です（実行して全部失敗した）。資格情報・課金・API の有効化を確認し、bash scripts/run-external-api-smoke.sh で確かめてください。" >&2
    return 0
  fi
  STATE=unobserved
  echo "WARN ${j_api}: UNOBSERVED — 直近 ${j_hours} 時間に実行 ${j_exec} 件はありますが、${j_basis_label}も成功も 0 件で判定できません。生死の証拠は #125 の手動実疎通だけです。"
  return 0
}

STATE=""
judge places "$(value_of places_fetch_ok_runs)" "$(value_of places_fetch_eligible_runs)" \
  "$(value_of places_executions)" "$PLACES_WINDOW_HOURS" "対象店舗のある実行"
places_state="$STATE"

STATE=""
judge line-messaging "$(value_of line_token_issued_runs)" "$(value_of line_token_issue_failures)" \
  "$(value_of line_executions)" "$LINE_WINDOW_HOURS" "トークン発行の失敗"
line_state="$STATE"

if [ -z "$places_state" ] || [ -z "$line_state" ]; then
  fail_early config-error "ERROR: 判定が状態を返しませんでした（内部の不整合）。"
fi

echo "EXTERNAL-API-LIVENESS-SIGNATURE: places=${places_state};line-messaging=${line_state};"

case "${places_state} ${line_state}" in
  *dead* | *not_run*)
    echo "NG: 外部 API の恒常観測で赤があります（上記参照）。${injected_note}" >&2
    exit 1
    ;;
esac
echo "OK: 外部 API の恒常観測に赤はありません（places=${places_state} / line-messaging=${line_state}）。${injected_note}"
