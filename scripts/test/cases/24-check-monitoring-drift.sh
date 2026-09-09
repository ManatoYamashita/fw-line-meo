# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-monitoring-drift.sh の自己テスト（Issue #230）。
#
# 本ガードが捕まえる中心は **「本番に在って宣言に無い」** である。#230 の実態は「監視が無い」
# ではなく「apply されたがコードが失われた」で、2026-09-06〜09-09 の本番はまさにこの状態
# だった（alert policy 4 本と logging metric 1 本が稼働し state も保持していたのに、対応する
# .tf が origin/main にも 49 本のリモートブランチのいずれにも無かった）。逆方向の
# 「宣言に在って本番に無い」は apply 忘れ・誤削除で、こちらは 1 件も鳴らない監視になる。
#
# クラウド照会は PROD_MONITORING_SNAPSHOT で注入する。live 収集も同じ 2 列 TSV を組み立てて
# から比較へ渡す設計なので、fixture と本番実測が完全に同一経路を通る。

mdr_guardrails() {
  # 実ツリーと同じ 3 形を持たせる: for_each を持たない policy / for_each(var) の policy /
  # for_each(リテラル) の metric。宣言側の展開が 3 形とも効くことをここで固定する。
  fx_write infra/modules/guardrails/main.tf <<'EOF'
resource "google_monitoring_alert_policy" "job_failure" {
  project      = var.project_id
  display_name = "cloud run job failure"
}

resource "google_monitoring_alert_policy" "customer_latency" {
  for_each = toset(var.latency_watched_services)

  project      = var.project_id
  display_name = "cloud run ${each.key} p95 latency"
}

resource "google_logging_metric" "survey_funnel" {
  for_each = toset(["survey_page_viewed", "survey_response_submitted"])

  project = var.project_id
  name    = each.key
}

resource "google_logging_metric" "webhook_signature_failures" {
  project = var.project_id
  name    = "webhook_signature_failures"
}
EOF
}

mdr_root_tf() {
  fx_write infra/envs/prod/main.tf <<'EOF'
module "guardrails" {
  source                   = "../../modules/guardrails"
  latency_watched_services = ["store-detail", "survey-web"]
}
EOF
}

mdr_snapshot() {
  # $1 以降 = '<kind>|<name>'。`|` を実タブへ変換して書く。
  {
    printf '# 自己テストの本番 snapshot fixture（Issue #230）\n'
    for mdr_row in "$@"; do
      printf '%s\n' "$mdr_row" | tr '|' '\t'
    done
  } > "${FX}/snapshot.tsv"
}

mdr_full_snapshot() {
  mdr_snapshot \
    'policy|cloud run job failure' \
    'policy|cloud run store-detail p95 latency' \
    'policy|cloud run survey-web p95 latency' \
    'metric|survey_page_viewed' \
    'metric|survey_response_submitted' \
    'metric|webhook_signature_failures'
}

mdr_run() {
  # 注入用の環境変数はこの関数の中で閉じる（ケース間に漏らさない）。
  # PROJECT_ID は MDR_PROJECT_ID で上書きできる（`-` 展開なので空文字も渡せる＝未設定の検証用）。
  OUT=''
  RC=0
  # shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
  OUT="$(cd "$FX" && \
    PROJECT_ID="${MDR_PROJECT_ID-proj}" \
    PROD_MONITORING_SNAPSHOT="${FX}/snapshot.tsv" \
    bash scripts/check-monitoring-drift.sh 2>&1)" || RC=$?
}

mdr_whitelist() {
  # 合成ツリーへ複製したガードの `WHITELIST=()` へ項目を注入する（$1 = 括弧の中身をそのまま）。
  awk -v entry="$1" '
    /^WHITELIST=\(\)$/ { print "WHITELIST=(" entry ")"; next }
    { print }
  ' "${FX}/scripts/check-monitoring-drift.sh" > "${FX}/scripts/mdr-whitelist.tmp"
  mv "${FX}/scripts/mdr-whitelist.tmp" "${FX}/scripts/check-monitoring-drift.sh"

  # **注入が当たったことを先に確かめる。** 空振りしたまま走らせると、ガードが元のまま緑を
  # 返した結果を「WHITELIST が効いた証拠」と読み違える。
  if [ "$(grep -cF "$1" "${FX}/scripts/check-monitoring-drift.sh")" -eq 0 ]; then
    _t_fail "WHITELIST の注入が空振りしました: $1"
  fi
}

mdr_fixture() {
  fx_guard check-monitoring-drift
  mdr_guardrails
  mdr_root_tf
  mdr_full_snapshot
}

# ---------------------------------------------------------------------------
t_begin 'check-monitoring-drift: 宣言と本番が一致していれば緑（for_each の 3 形を展開する）'
mdr_fixture
mdr_run
expect_green
expect_output_matches '宣言 6 件 / 本番 6 件 / 6 件検証'
t_end

# **本ガードの中心。** 2026-09-06 に実際に起きた形。
t_begin 'check-monitoring-drift: 本番に在って宣言に無い policy を検出する（コードが失われた形）'
mdr_fixture
mdr_snapshot \
  'policy|cloud run job failure' \
  'policy|cloud run store-detail p95 latency' \
  'policy|cloud run survey-web p95 latency' \
  'policy|cloud run service 5xx rate' \
  'metric|survey_page_viewed' \
  'metric|survey_response_submitted' \
  'metric|webhook_signature_failures'
mdr_run
expect_red '本番に在る policy "cloud run service 5xx rate" が宣言にありません'
expect_output_matches 'terraform apply がこれを destroy します'
t_end

t_begin 'check-monitoring-drift: 本番に在って宣言に無い metric も検出する'
mdr_fixture
mdr_snapshot \
  'policy|cloud run job failure' \
  'policy|cloud run store-detail p95 latency' \
  'policy|cloud run survey-web p95 latency' \
  'metric|survey_page_viewed' \
  'metric|survey_response_submitted' \
  'metric|webhook_signature_failures' \
  'metric|ghost_metric'
mdr_run
expect_red '本番に在る metric "ghost_metric" が宣言にありません'
t_end

t_begin 'check-monitoring-drift: 宣言に在って本番に無い（apply 忘れ・誤削除）を検出する'
mdr_fixture
mdr_snapshot \
  'policy|cloud run job failure' \
  'policy|cloud run store-detail p95 latency' \
  'metric|survey_page_viewed' \
  'metric|survey_response_submitted' \
  'metric|webhook_signature_failures'
mdr_run
expect_red '宣言されている policy "cloud run survey-web p95 latency" が本番にありません'
t_end

# for_each の展開が効いているかを、片側だけ欠いて確かめる。展開が「1 件」で止まっていると
# store-detail 側の欠落を見逃す。
t_begin 'check-monitoring-drift: for_each(var) の展開が全要素に及んでいる'
mdr_fixture
mdr_snapshot \
  'policy|cloud run job failure' \
  'policy|cloud run survey-web p95 latency' \
  'metric|survey_page_viewed' \
  'metric|survey_response_submitted' \
  'metric|webhook_signature_failures'
mdr_run
expect_red '宣言されている policy "cloud run store-detail p95 latency" が本番にありません'
t_end

t_begin 'check-monitoring-drift: for_each(リテラル) の展開も全要素に及んでいる'
mdr_fixture
mdr_snapshot \
  'policy|cloud run job failure' \
  'policy|cloud run store-detail p95 latency' \
  'policy|cloud run survey-web p95 latency' \
  'metric|survey_page_viewed' \
  'metric|webhook_signature_failures'
mdr_run
expect_red '宣言されている metric "survey_response_submitted" が本番にありません'
t_end

t_begin 'check-monitoring-drift: for_each が参照する変数を解決できなければ赤'
mdr_fixture
fx_write infra/envs/prod/main.tf <<'EOF'
module "guardrails" {
  source = "../../modules/guardrails"
}
EOF
mdr_run
expect_red 'var.latency_watched_services を'
t_end

# 空振り防止。0 件を「乖離なし」と読む退化が最も静かな失敗である。
t_begin 'check-monitoring-drift: 宣言が 0 件なら赤（0 件を乖離なしと読まない）'
mdr_fixture
fx_write infra/modules/guardrails/main.tf <<'EOF'
# 監視の宣言が 1 件も無い状態。
EOF
mdr_run
expect_red 'resource ブロックを1件も切り出せませんでした'
t_end

t_begin 'check-monitoring-drift: 本番の実測が 0 行なら赤'
mdr_fixture
mdr_snapshot
mdr_run
expect_red '本番から監視資産を1行も読めませんでした'
t_end

t_begin 'check-monitoring-drift: PROJECT_ID 未設定なら既定値へ落ちず赤'
mdr_fixture
MDR_PROJECT_ID=''
mdr_run
unset MDR_PROJECT_ID
expect_red 'PROJECT_ID が未設定'
t_end

t_begin 'check-monitoring-drift: 注入モードであることを必ず明示する'
mdr_fixture
mdr_run
expect_green
expect_output_matches '注入モードで実行中です'
t_end

# 署名は本スクリプトの契約。早期異常の経路でも必ず出さないと、report-ci-issue.sh の
# 重複抑止が効かず、赤が続く限り 6 時間ごとに追跡 Issue へコメントが増える。
t_begin 'check-monitoring-drift: 早期異常でも署名を出してから落ちる'
mdr_fixture
MDR_PROJECT_ID=''
mdr_run
unset MDR_PROJECT_ID
expect_red 'PROJECT_ID が未設定'
expect_output_matches 'MONITORING-SIGNATURE: early-exit=config-error;'
t_end

t_begin 'check-monitoring-drift: 乖離の署名は判定つきで出る（状態変化を検出できる形）'
mdr_fixture
mdr_snapshot \
  'policy|cloud run job failure' \
  'policy|cloud run store-detail p95 latency' \
  'policy|cloud run survey-web p95 latency' \
  'policy|cloud run service 5xx rate' \
  'metric|survey_page_viewed' \
  'metric|survey_response_submitted' \
  'metric|webhook_signature_failures'
mdr_run
expect_red '宣言にありません'
expect_output_matches 'MONITORING-SIGNATURE:.*undeclared-in-prod;'
t_end

t_begin 'check-monitoring-drift: snapshot のパスが存在しなければ赤'
mdr_fixture
rm -f "${FX}/snapshot.tsv"
mdr_run
expect_red 'PROD_MONITORING_SNAPSHOT が見つかりません'
t_end

# ---------------------------------------------------------------------------
# WHITELIST の記帳（セルフレビューで検出した欠陥の回帰テスト）
#
# `used_whitelist` を空文字で初期化すると、最初に記帳された 1 件は前置改行を持たず
# `*"${NL}${wl}${NL}"*` に一致しない。その結果 **SKIP した直後に「検出されなかったので
# WHITELIST から削除してください」** という自己矛盾した WARNING が出て、正しく効いている
# 除外を消す方向へ誘導する。先例（check-secret-version-drift.sh）は $NL から始めている。
# 先例のケースは SKIP の存在しか見ておらず、この矛盾を検出できていなかったので、
# ここでは **WARNING の不在**まで assert する。

t_begin 'check-monitoring-drift: WHITELIST に載せた乖離は SKIP し、削除を促す WARNING を出さない'
mdr_fixture
mdr_snapshot \
  'policy|cloud run job failure' \
  'policy|cloud run store-detail p95 latency' \
  'policy|cloud run survey-web p95 latency' \
  'policy|cloud run service 5xx rate' \
  'metric|survey_page_viewed' \
  'metric|survey_response_submitted' \
  'metric|webhook_signature_failures'
mdr_whitelist "'policy|cloud run service 5xx rate|undeclared-in-prod'"
mdr_run
expect_green
expect_output_matches 'SKIP: policy cloud run service 5xx rate'
expect_absent 'WHITELIST から削除してください'
t_end

# 対照: 当たらなくなった除外は削除を促す。上の是正で WARNING を殺してしまうと、
# 是正済みの組を除外したまま残し、次に同じ乖離が起きたとき無言で見逃す。
t_begin 'check-monitoring-drift: 当たらなくなった WHITELIST は削除を促す（対照）'
mdr_fixture
mdr_whitelist "'policy|cloud run service 5xx rate|undeclared-in-prod'"
mdr_run
expect_green
expect_output_matches 'WHITELIST に載っていますが乖離として検出されませんでした'
t_end

# ---------------------------------------------------------------------------
# 複数行のリスト（セルフレビューで検出した欠陥の回帰テスト）
#
# terraform fmt は要素の多いリストを複数行のまま許す（実測で fmt -check を通ることを確認）。
# 1 行 grep で読んでいると、3 つ目の要素を足した瞬間に抽出が空になり、原因を名指ししない
# 赤が出る。しかも「そこへ足せ」と誘っているのはガード自身のコメントである。

t_begin 'check-monitoring-drift: for_each のリテラルを複数行で書いても解決できる'
mdr_fixture
fx_write infra/modules/guardrails/main.tf <<'EOF'
resource "google_monitoring_alert_policy" "job_failure" {
  project      = var.project_id
  display_name = "cloud run job failure"
}

resource "google_monitoring_alert_policy" "customer_latency" {
  for_each = toset(var.latency_watched_services)

  project      = var.project_id
  display_name = "cloud run ${each.key} p95 latency"
}

resource "google_logging_metric" "survey_funnel" {
  for_each = toset([
    "survey_page_viewed",
    # リストの中に注記が書かれても畳み込みから除く
    "survey_response_submitted",
  ])

  project = var.project_id
  name    = each.key
}

resource "google_logging_metric" "webhook_signature_failures" {
  project = var.project_id
  name    = "webhook_signature_failures"
}
EOF
mdr_run
expect_green
expect_output_matches '宣言 6 件 / 本番 6 件'
t_end

t_begin 'check-monitoring-drift: for_each が参照する変数を複数行で書いても解決できる'
mdr_fixture
fx_write infra/envs/prod/main.tf <<'EOF'
module "guardrails" {
  source = "../../modules/guardrails"

  latency_watched_services = [
    "store-detail",
    "survey-web",
  ]
}
EOF
mdr_run
expect_green
expect_output_matches '宣言 6 件 / 本番 6 件'
t_end

# ---------------------------------------------------------------------------
# 収集経路そのものの検査（独立レビューで検出した偽緑の回帰テスト）
#
# SNAPSHOT 注入は **正規化済みの 2 列 TSV** を渡すため、gcloud/API の応答から TSV を組み立てる
# 区間が CI でも自己テストでも一度も実行されない。#230 の偽緑（指標名の文字集合を
# `[A-Za-z0-9_]+` に絞ったせいで `store-qr-scans` のような名前が無言で live から落ち、
# 「本番に在って宣言に無い」判定に現れなくなる）は、まさにその未検査の区間に潜んでいた。
# RAW_DIR 注入は本番実行とまったく同じ正規化を通る。

mdr_raw() {
  # $1 = policies.txt の中身, $2 = metric-descriptors.json の中身
  mkdir -p "${FX}/raw"
  printf '%s\n' "$1" > "${FX}/raw/policies.txt"
  printf '%s\n' "$2" > "${FX}/raw/metric-descriptors.json"
}

mdr_run_raw() {
  OUT=''
  RC=0
  # shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
  OUT="$(cd "$FX" && \
    PROJECT_ID="${MDR_PROJECT_ID-proj}" \
    PROD_MONITORING_RAW_DIR="${FX}/raw" \
    bash scripts/check-monitoring-drift.sh 2>&1)" || RC=$?
}

t_begin 'check-monitoring-drift: 生の応答から正規化しても宣言と突き合わせられる'
mdr_fixture
rm -f "${FX}/snapshot.tsv"
mdr_raw 'cloud run job failure
cloud run store-detail p95 latency
cloud run survey-web p95 latency' \
  '{"metricDescriptors":[{"name":"projects/p/metricDescriptors/logging.googleapis.com/user/survey_page_viewed","type":"logging.googleapis.com/user/survey_page_viewed"},{"name":"projects/p/metricDescriptors/logging.googleapis.com/user/survey_response_submitted","type":"logging.googleapis.com/user/survey_response_submitted"},{"name":"projects/p/metricDescriptors/logging.googleapis.com/user/webhook_signature_failures","type":"logging.googleapis.com/user/webhook_signature_failures"}]}'
mdr_run_raw
expect_green
expect_output_matches '宣言 6 件 / 本番 6 件'
t_end

# **本命。** ハイフンを含む指標名を落とさないこと。落ちると「本番に在って宣言に無い」が
# 出なくなり、#230 と同じ状態を検出できない偽の緑になる。
t_begin 'check-monitoring-drift: ハイフンを含む指標名を live から落とさない'
mdr_fixture
rm -f "${FX}/snapshot.tsv"
mdr_raw 'cloud run job failure
cloud run store-detail p95 latency
cloud run survey-web p95 latency' \
  '{"metricDescriptors":[{"name":"projects/p/metricDescriptors/logging.googleapis.com/user/survey_page_viewed","type":"logging.googleapis.com/user/survey_page_viewed"},{"name":"projects/p/metricDescriptors/logging.googleapis.com/user/survey_response_submitted","type":"logging.googleapis.com/user/survey_response_submitted"},{"name":"projects/p/metricDescriptors/logging.googleapis.com/user/webhook_signature_failures","type":"logging.googleapis.com/user/webhook_signature_failures"},{"name":"projects/p/metricDescriptors/logging.googleapis.com/user/store-qr-scans","type":"logging.googleapis.com/user/store-qr-scans"}]}'
mdr_run_raw
expect_red '本番に在る metric "store-qr-scans" が宣言にありません'
t_end

# 抽出パターンが劣化して名前を取りこぼしたら、減った live で「乖離なし」を返さず赤にする。
t_begin 'check-monitoring-drift: 抽出が取りこぼしたら件数の対照で赤にする'
mdr_fixture
rm -f "${FX}/snapshot.tsv"
mdr_raw 'cloud run job failure
cloud run store-detail p95 latency
cloud run survey-web p95 latency' \
  '{"metricDescriptors":[{"name":"projects/p/metricDescriptors/logging.googleapis.com/user/survey_page_viewed","type":"logging.googleapis.com/user/survey_page_viewed"},{"name":"projects/p/metricDescriptors/logging.googleapis.com/user/survey_response_submitted","type":"logging.googleapis.com/user/survey_response_submitted"},{"name":"projects/p/metricDescriptors/logging.googleapis.com/user/webhook_signature_failures","type":"logging.googleapis.com/user/webhook_signature_failures"},{"name":"projects/p/metricDescriptors/logging.googleapis.com/user/store-qr-scans","type":"logging.googleapis.com/user/store-qr-scans"}]}'
# 抽出側の文字集合だけを絞る（対照は固定文字列で数えているので、こちらだけが減る）。
fx_guard_mutate check-monitoring-drift -e 's/\[^"\]+/[A-Za-z0-9_]+/'
mdr_run_raw
expect_red '件中'
expect_output_matches '偽の緑になります'
t_end

t_begin 'check-monitoring-drift: 2 つの注入を同時に渡したら曖昧にせず落とす'
mdr_fixture
mdr_raw 'cloud run job failure' '{"metricDescriptors":[]}'
OUT=''
RC=0
OUT="$(cd "$FX" && \
  PROJECT_ID=proj \
  PROD_MONITORING_SNAPSHOT="${FX}/snapshot.tsv" \
  PROD_MONITORING_RAW_DIR="${FX}/raw" \
  bash scripts/check-monitoring-drift.sh 2>&1)" || RC=$?
expect_red '同時に指定できません'
t_end

# 分岐到達性。赤の理由が **所属判定そのもの** から来ていることを、判別子を「常に一致」へ
# 潰す最小改変で確かめる。潰した瞬間に緑へ転じるなら、その赤は確かにこの分岐が作っている。
# 期待エラー文字列まで照合しても、判別子が定数化して片側が実質デッドコードになった状態は
# 別経路の赤で緑のまま残りうるので、到達性は別に取る。変異が当たらなければハーネスが落ちる。
t_begin 'check-monitoring-drift: 乖離の赤が所属判定から来ている（分岐到達性）'
mdr_fixture
mdr_snapshot \
  'policy|cloud run job failure' \
  'policy|cloud run store-detail p95 latency' \
  'policy|cloud run survey-web p95 latency' \
  'policy|cloud run service 5xx rate' \
  'metric|survey_page_viewed' \
  'metric|survey_response_submitted' \
  'metric|webhook_signature_failures'
fx_guard_mutate check-monitoring-drift \
  -e 's/if \[ "\$hr_rc" -eq 0 \]; then/if true; then/'
mdr_run
expect_green
expect_absent '宣言にありません'
t_end
