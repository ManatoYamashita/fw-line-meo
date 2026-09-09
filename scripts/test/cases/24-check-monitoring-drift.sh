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
