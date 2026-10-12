# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-external-api-liveness.sh の自己テスト（Issue #139）。
#
# 本ガードの中心は **4 状態を取り違えないこと** である（Issue #139 の完了条件 2）。
#   - 対象 0 件を緑にしない（UNOBSERVED）
#   - 実行していないことを「API が死んだ」と読まない（NOT_RUN と DEAD を分ける）
#   - 指標の作成直後（系列がまだ無い）を DEAD と読まない
# 加えて、収集経路（生の API 応答 → 件数）を RAW_DIR と PATH のスタブで実走させる。SNAPSHOT だけを
# 持つと、その区間は CI でも自己テストでも一度も走らない（#230 の偽緑が潜んでいた区間）。
# 実際、初版は定義の無い指標の timeSeries を取りに行って 404 で落ちた（2026-09-27 に本番で実測）。

# --- 合成ツリー: デプロイ正典（ジョブ名の照合に使う）---------------------------------------
eal_upstream() {
  fx_guard check-deploy-image-coverage
  fx_write infra/envs/prod/main.tf <<'EOF'
module "run-services" {
  services = {
    "line-webhook" = {
      image = "cloudrun/container/hello"
    }
  }
}
EOF
  fx_write scripts/push-images.sh <<'EOF'
#!/usr/bin/env bash
IMAGE_NAMES=(line-webhook daily-batch summary-delivery)
EOF
  fx_write .github/workflows/deploy.yml <<'EOF'
jobs:
  deploy:
    steps:
      - run: gcloud run jobs update daily-batch --image "$IMAGE"
      - run: gcloud run jobs update summary-delivery --image "$IMAGE"
      - run: gcloud run services update line-webhook --image "$IMAGE"
EOF
  fx_write .github/workflows/ts-ci.yml <<'EOF'
jobs:
  docker-build:
    strategy:
      matrix:
        image: [line-webhook, daily-batch, summary-delivery]
EOF
}

eal_fixture() {
  fx_guard check-external-api-liveness
  eal_upstream
}

eal_snapshot() {
  # 引数 6 つ: places ok / eligible / executions / line issued / failures / executions
  printf '# 自己テストの件数 fixture（Issue #139）\nplaces_fetch_ok_runs\t%s\nplaces_fetch_eligible_runs\t%s\nplaces_executions\t%s\nline_token_issued_runs\t%s\nline_token_issue_failures\t%s\nline_executions\t%s\n' \
    "$@" > "${FX}/snapshot.tsv"
}

eal_run() {
  # 注入用の環境変数はこの関数の中で閉じる（ケース間に漏らさない）。
  OUT=''
  RC=0
  # shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
  OUT="$(cd "$FX" && EXTERNAL_API_LIVENESS_SNAPSHOT="${FX}/snapshot.tsv" \
    bash scripts/check-external-api-liveness.sh 2>&1)" || RC=$?
}

# ---------------------------------------------------------------------------
t_begin 'check-external-api-liveness: 両方とも成功があれば緑'
eal_fixture
eal_snapshot 1 1 1 3 0 3
eal_run
expect_green
expect_output_matches 'EXTERNAL-API-LIVENESS-SIGNATURE: places=alive;line-messaging=alive;'
t_end

t_begin 'check-external-api-liveness: 対象はあるのに成功 0 なら DEAD（実行して全部失敗した）'
eal_fixture
eal_snapshot 0 1 1 3 0 3
eal_run
expect_red 'NG places: DEAD'
expect_output_matches 'places=dead;'
t_end

# **完了条件 2 の中心。** 対象店舗 0 件の日は Places を 1 回も叩かないので、キーが死んでいても
# exit 0 になる。これを緑にすると #63 と同じ無音障害を一段上で再生産する。
t_begin 'check-external-api-liveness: 対象 0 件は緑にせず UNOBSERVED（署名で知らせる）'
eal_fixture
eal_snapshot 0 0 1 3 0 3
eal_run
expect_green
expect_output_matches 'WARN places: UNOBSERVED'
expect_output_matches 'places=unobserved;'
expect_absent 'places: ALIVE'
t_end

t_begin 'check-external-api-liveness: 実行 0 件は NOT_RUN（DEAD と取り違えない）'
eal_fixture
eal_snapshot 0 0 0 3 0 3
eal_run
expect_red 'NG places: NOT_RUN'
expect_absent 'places: DEAD'
t_end

t_begin 'check-external-api-liveness: トークン発行の失敗だけなら line-messaging は DEAD'
eal_fixture
eal_snapshot 1 1 1 0 2 3
eal_run
expect_red 'NG line-messaging: DEAD'
expect_output_matches 'line-messaging=dead;'
t_end

# 指標の作成直後は、作成前の実行が窓に残る一方で系列はまだ 1 点も無い。これを DEAD と読むと
# apply の直後に誤報が出る（#118「偽の障害通知は通知そのものの信頼を壊す」）。
t_begin 'check-external-api-liveness: 実行はあるが成功も失敗も 0（作成直後）は DEAD にしない'
eal_fixture
eal_snapshot 1 1 1 0 0 3
eal_run
expect_green
expect_output_matches 'WARN line-messaging: UNOBSERVED'
expect_absent 'line-messaging: DEAD'
t_end

t_begin 'check-external-api-liveness: 指標が本番に無ければ UNOBSERVED（apply 前）'
eal_fixture
eal_snapshot absent absent 1 absent absent 3
eal_run
expect_green
expect_output_matches 'places=unobserved;line-messaging=unobserved;'
t_end

t_begin 'check-external-api-liveness: 実行件数に absent は使えない'
eal_fixture
eal_snapshot 1 1 absent 3 0 3
eal_run
expect_red '組込み指標 places_executions に absent は使えません'
expect_output_matches 'EXTERNAL-API-LIVENESS-SIGNATURE: config-error;'
t_end

t_begin 'check-external-api-liveness: 系列が欠けていたら赤（0 件を「漏れなし」と読まない）'
eal_fixture
printf 'places_fetch_ok_runs\t1\n' > "${FX}/snapshot.tsv"
eal_run
expect_red '系列 places_fetch_eligible_runs の行が 0 件です'
t_end

t_begin 'check-external-api-liveness: 件数でも absent でもない値は赤'
eal_fixture
eal_snapshot 1 1 1 three 0 3
eal_run
expect_red "系列 line_token_issued_runs の値が件数でも absent でもありません"
t_end

# 空文字の注入は「未設定」ではない。`:-` で判定すると実 API（gcloud）へ落ちる（#108）。
t_begin 'check-external-api-liveness: 空文字の注入は実 API へ落ちずに赤'
eal_fixture
OUT=''
RC=0
OUT="$(cd "$FX" && EXTERNAL_API_LIVENESS_SNAPSHOT='' PROJECT_ID='' \
  bash scripts/check-external-api-liveness.sh 2>&1)" || RC=$?
expect_red 'EXTERNAL_API_LIVENESS_SNAPSHOT が見つかりません'
expect_absent 'PROJECT_ID が未設定'
t_end

t_begin 'check-external-api-liveness: ジョブ名がデプロイ正典に無ければ赤（永久に NOT_RUN を防ぐ）'
eal_fixture
fx_write scripts/push-images.sh <<'EOF'
#!/usr/bin/env bash
IMAGE_NAMES=(line-webhook batch-renamed summary-delivery)
EOF
fx_write .github/workflows/deploy.yml <<'EOF'
jobs:
  deploy:
    steps:
      - run: gcloud run jobs update batch-renamed --image "$IMAGE"
      - run: gcloud run jobs update summary-delivery --image "$IMAGE"
      - run: gcloud run services update line-webhook --image "$IMAGE"
EOF
fx_write .github/workflows/ts-ci.yml <<'EOF'
jobs:
  docker-build:
    strategy:
      matrix:
        image: [line-webhook, batch-renamed, summary-delivery]
EOF
eal_snapshot 1 1 1 3 0 3
eal_run
expect_red 'ジョブ "daily-batch" がデプロイ正典の job にありません'
t_end

# 分岐到達性。DEAD の判別子を潰すと対象ありの成功 0 が UNOBSERVED へ落ちること（＝判定が
# 定数化していないこと）を確かめる。
t_begin 'check-external-api-liveness: DEAD の判定が定数化していない（分岐到達性）'
fx_guard_mutate check-external-api-liveness \
  -e 's/if \[ "\$j_basis" -gt 0 \]; then/if [ "$j_basis" -lt 0 ]; then/'
eal_upstream
eal_snapshot 0 1 1 3 0 3
eal_run
expect_green
expect_output_matches 'places=unobserved;'
t_end

# ---------------------------------------------------------------------------
# 収集経路: 生の API 応答から件数を組み立てる区間

eal_raw() {
  # $1 = descriptors に載せる指標名（空白区切り）。系列の JSON は eal_raw_series で書く。
  mkdir -p "${FX}/raw"
  {
    printf '{"metricDescriptors":['
    eal_first=1
    for eal_m in $1; do
      [ "$eal_first" -eq 1 ] || printf ','
      eal_first=0
      printf '{"type":"logging.googleapis.com/user/%s"}' "$eal_m"
    done
    printf ']}\n'
  } > "${FX}/raw/metric-descriptors.json"
}

eal_raw_series() {
  # $1 = 系列名, 残り = 各点の int64Value（0 個なら timeSeries が空の応答）
  eal_s="$1"
  shift
  if [ "$#" -eq 0 ]; then
    printf '{}\n' > "${FX}/raw/${eal_s}.json"
    return 0
  fi
  {
    printf '{"timeSeries":[{"points":['
    eal_first=1
    for eal_v in "$@"; do
      [ "$eal_first" -eq 1 ] || printf ','
      eal_first=0
      printf '{"value":{"int64Value":"%s"}}' "$eal_v"
    done
    printf ']}]}\n'
  } > "${FX}/raw/${eal_s}.json"
}

eal_run_raw() {
  OUT=''
  RC=0
  # shellcheck disable=SC2034
  OUT="$(cd "$FX" && EXTERNAL_API_LIVENESS_RAW_DIR="${FX}/raw" \
    bash scripts/check-external-api-liveness.sh 2>&1)" || RC=$?
}

t_begin 'check-external-api-liveness: 生の応答の点を合計し、空の応答を 0 件と読む'
eal_fixture
eal_raw 'places_fetch_ok_runs places_fetch_eligible_runs line_token_issued_runs line_token_issue_failures'
eal_raw_series places_fetch_ok_runs 1
eal_raw_series places_fetch_eligible_runs 1
eal_raw_series places_executions 1
eal_raw_series line_token_issued_runs 1 1 1
eal_raw_series line_token_issue_failures
eal_raw_series line_executions 1 2
eal_run_raw
expect_green
expect_output_matches 'line_token_issued_runs	3'
expect_output_matches 'line_token_issue_failures	0'
expect_output_matches 'line_executions	3'
expect_output_matches 'places=alive;line-messaging=alive;'
t_end

t_begin 'check-external-api-liveness: 定義に無い指標は absent と読む（系列ファイルを要求しない）'
eal_fixture
eal_raw 'places_fetch_ok_runs places_fetch_eligible_runs'
eal_raw_series places_fetch_ok_runs 1
eal_raw_series places_fetch_eligible_runs 1
eal_raw_series places_executions 1
eal_raw_series line_executions 1 1 1
eal_run_raw
expect_green
expect_output_matches 'line_token_issued_runs	absent'
expect_output_matches 'places=alive;line-messaging=unobserved;'
t_end

t_begin 'check-external-api-liveness: 件数へ畳めない応答は赤'
eal_fixture
eal_raw 'places_fetch_ok_runs places_fetch_eligible_runs line_token_issued_runs line_token_issue_failures'
eal_raw_series places_fetch_ok_runs 1
eal_raw_series places_fetch_eligible_runs 1
eal_raw_series places_executions 1
eal_raw_series line_token_issued_runs 1
eal_raw_series line_token_issue_failures
printf 'not json\n' > "${FX}/raw/line_executions.json"
eal_run_raw
expect_red 'line_executions の timeSeries 応答を件数へ畳めません'
t_end

# 本番の取得（gcloud / curl）を PATH のスタブで差し替えて走らせる。スタブの curl は、
# 定義の無い指標の timeSeries を本番と同じく 404（curl -f の exit 22）で返す。
eal_stub_live() {
  mkdir -p "${FX}/stub"
  cat > "${FX}/stub/gcloud" <<'EOF'
#!/usr/bin/env bash
echo 'stub-token'
EOF
  cat > "${FX}/stub/curl" <<'EOF'
#!/usr/bin/env bash
url=''
for a in "$@"; do
  case "$a" in
    https://*) url="$a" ;;
  esac
done
case "$url" in
  *metricDescriptors*) cat "${EAL_RAW}/metric-descriptors.json"; exit 0 ;;
esac
for s in places_fetch_ok_runs places_fetch_eligible_runs line_token_issued_runs line_token_issue_failures; do
  case "$url" in
    *"user%2F${s}"*)
      if [ -f "${EAL_RAW}/${s}.json" ]; then cat "${EAL_RAW}/${s}.json"; exit 0; fi
      echo 'curl: (22) The requested URL returned error: 404' >&2
      exit 22
      ;;
  esac
done
case "$url" in
  *daily-batch*) cat "${EAL_RAW}/places_executions.json"; exit 0 ;;
  *summary-delivery*) cat "${EAL_RAW}/line_executions.json"; exit 0 ;;
esac
echo "stub curl: unexpected url ${url}" >&2
exit 3
EOF
  chmod +x "${FX}/stub/gcloud" "${FX}/stub/curl"
}

eal_run_live() {
  OUT=''
  RC=0
  # shellcheck disable=SC2034
  OUT="$(cd "$FX" && PATH="${FX}/stub:$PATH" EAL_RAW="${FX}/raw" PROJECT_ID=proj \
    bash scripts/check-external-api-liveness.sh 2>&1)" || RC=$?
}

t_begin 'check-external-api-liveness: 本番収集は定義の無い指標を取りに行かない（404 で落ちない）'
eal_fixture
eal_raw ''
eal_raw_series places_executions 1
eal_raw_series line_executions 1 1 1
eal_stub_live
eal_run_live
expect_green
expect_output_matches 'places=unobserved;line-messaging=unobserved;'
expect_absent '404'
t_end

t_begin 'check-external-api-liveness: 本番収集で指標があれば件数を読む'
eal_fixture
eal_raw 'places_fetch_ok_runs places_fetch_eligible_runs line_token_issued_runs line_token_issue_failures'
eal_raw_series places_fetch_ok_runs
eal_raw_series places_fetch_eligible_runs 1
eal_raw_series places_executions 1
eal_raw_series line_token_issued_runs 1 1
eal_raw_series line_token_issue_failures
eal_raw_series line_executions 1 1
eal_stub_live
eal_run_live
expect_red 'NG places: DEAD'
expect_output_matches 'places=dead;line-messaging=alive;'
t_end

t_begin 'check-external-api-liveness: PROJECT_ID 未設定なら既定値へ落ちず赤'
eal_fixture
OUT=''
RC=0
OUT="$(cd "$FX" && PROJECT_ID='' bash scripts/check-external-api-liveness.sh 2>&1)" || RC=$?
expect_red 'PROJECT_ID が未設定です'
expect_output_matches 'EXTERNAL-API-LIVENESS-SIGNATURE: config-error;'
t_end
