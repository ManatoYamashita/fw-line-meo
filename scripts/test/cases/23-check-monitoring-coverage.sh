# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-monitoring-coverage.sh の自己テスト（Issue #230）。
#
# 本ガードが防ぐのは 2 つの別々の失敗である。
#   (a) 5xx の述語にサービス名が入り、「サービスを足したとき忘れる」余地が生まれる（#151 と同型）
#   (b) 指標（tf）は生きているのにアプリ（ts）が事象を出さず、値が永久に 0 になる
# (b) は 2026-09-06〜09-09 の本番で実際に成立していた。指標もアラートも通知チャネルも
# 正しく存在したまま、署名検証が全件失敗しても誰にも届かない構成だった。
#
# **偽陽性を出さないことの検証を含める。** 本ガードの初版は group_by_fields の
# `resource.label.service_name`（サービスごとに率を出すための集約軸）を述語と読み違え、
# 正しい実ツリーを赤くした。誤検知するガードは、そのうち除外で黙らされて空振りへ退化する。

# --- 合成ツリー ---------------------------------------------------------------------------
# 上流の正典（check-deploy-image-coverage.sh --print-targets）も合成ツリーで緑にする必要が
# あるため、その 4 入力もここで書く（列挙を二重管理しない設計の帰結）。

mcov_root_tf() {
  # $1 = latency_watched_services の中身（例: '"survey-web"'）
  fx_write infra/envs/prod/main.tf <<EOF
module "run-services" {
  services = {
    "survey-web" = {
      image = "cloudrun/container/hello"
    }
    "line-webhook" = {
      image = "cloudrun/container/hello"
    }
  }
}

module "guardrails" {
  source                   = "../../modules/guardrails"
  survey_service_name      = module.run_services.service_names["survey-web"]
  webhook_service_name     = module.run_services.service_names["line-webhook"]
  latency_watched_services = [$1]
}
EOF
}

mcov_upstream() {
  fx_guard check-deploy-image-coverage
  fx_write scripts/push-images.sh <<'EOF'
#!/usr/bin/env bash
IMAGE_NAMES=(survey-web line-webhook daily-batch)
EOF
  fx_write .github/workflows/deploy.yml <<'EOF'
jobs:
  deploy:
    steps:
      - run: gcloud run jobs update daily-batch --image "$IMAGE"
      - run: gcloud run services update survey-web --image "$IMAGE"
      - run: gcloud run services update line-webhook --image "$IMAGE"
EOF
  fx_write .github/workflows/ts-ci.yml <<'EOF'
jobs:
  docker-build:
    strategy:
      matrix:
        image: [survey-web, line-webhook, daily-batch]
EOF
}

mcov_apps() {
  fx_write ts/apps/line-webhook/src/lib/structured-log.ts <<'EOF'
export function logSignatureVerificationFailed(): void {
  console.warn(JSON.stringify({ event: 'webhook_signature_verification_failed' }));
}
EOF
  fx_write ts/apps/survey-web/src/lib/structured-log.ts <<'EOF'
export function logFunnel(): void {
  console.info(JSON.stringify({ event: 'survey_page_viewed' }));
  console.info(JSON.stringify({ event: 'survey_response_submitted' }));
}
EOF
}

# 実ツリーと同じ形の guardrails。5xx は述語にサービス名を持たないが、集約軸には持つ
# （偽陽性の検証を兼ねる）。
mcov_guardrails() {
  fx_write infra/modules/guardrails/main.tf <<'EOF'
resource "google_monitoring_notification_channel" "email" {
  project = var.project_id
  type    = "email"
}

resource "google_monitoring_alert_policy" "service_5xx_rate" {
  project      = var.project_id
  display_name = "cloud run service 5xx rate"

  conditions {
    condition_threshold {
      filter             = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      denominator_filter = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_count\""

      aggregations {
        group_by_fields = ["resource.label.service_name"]
      }
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

resource "google_monitoring_alert_policy" "customer_latency" {
  for_each = toset(var.latency_watched_services)

  project      = var.project_id
  display_name = "cloud run ${each.key} p95 latency"

  conditions {
    condition_threshold {
      filter = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_latencies\" AND resource.labels.service_name = \"${each.key}\""
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

resource "google_logging_metric" "survey_funnel" {
  for_each = toset(["survey_page_viewed", "survey_response_submitted"])

  project = var.project_id
  name    = each.key
  filter  = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.survey_service_name}\" AND jsonPayload.event = \"${each.key}\""
}

resource "google_logging_metric" "webhook_signature_failures" {
  project = var.project_id
  name    = "webhook_signature_failures"
  filter  = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.webhook_service_name}\" AND jsonPayload.event = \"webhook_signature_verification_failed\""
}
EOF
}

mcov_fixture() {
  fx_guard check-monitoring-coverage
  mcov_upstream
  mcov_root_tf '"survey-web"'
  mcov_guardrails
  mcov_apps
}

# ---------------------------------------------------------------------------
t_begin 'check-monitoring-coverage: 宣言とアプリの実体が揃っていれば緑'
mcov_fixture
fx_run check-monitoring-coverage
expect_green
expect_output_matches '正典 2 サービス / alert policy 2 本 / logging metric 2 本 / 事象名 3 件'
t_end

# 偽陽性の検証。group_by_fields の service_name は「サービスごとに率を出す」集約軸であって
# 絞り込みではない。ここを叩くと実ツリーが赤くなる（初版が実際にそうだった）。
t_begin 'check-monitoring-coverage: 集約軸の service_name を述語と読み違えない'
mcov_fixture
fx_run check-monitoring-coverage
expect_green
expect_absent '述語に持っています'
t_end

t_begin 'check-monitoring-coverage: 5xx の述語にサービス名が入ったら赤（#151 と同型）'
mcov_fixture
fx_write infra/modules/guardrails/main.tf <<'EOF'
resource "google_monitoring_notification_channel" "email" {
  project = var.project_id
}

resource "google_monitoring_alert_policy" "service_5xx_rate" {
  project = var.project_id

  conditions {
    condition_threshold {
      filter = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"survey-web\" AND metric.labels.response_code_class = \"5xx\""
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

resource "google_logging_metric" "webhook_signature_failures" {
  project = var.project_id
  name    = "webhook_signature_failures"
  filter  = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.webhook_service_name}\" AND jsonPayload.event = \"webhook_signature_verification_failed\""
}
EOF
fx_run check-monitoring-coverage
expect_red 'service_5xx_rate が service_name を述語に持っています'
t_end

t_begin 'check-monitoring-coverage: 5xx のポリシーごと消えたら赤'
mcov_fixture
fx_write infra/modules/guardrails/main.tf <<'EOF'
resource "google_monitoring_notification_channel" "email" {
  project = var.project_id
}

resource "google_monitoring_alert_policy" "customer_latency" {
  for_each = toset(var.latency_watched_services)

  project = var.project_id

  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

resource "google_logging_metric" "webhook_signature_failures" {
  project = var.project_id
  name    = "webhook_signature_failures"
  filter  = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.webhook_service_name}\" AND jsonPayload.event = \"webhook_signature_verification_failed\""
}
EOF
fx_run check-monitoring-coverage
expect_red 'google_monitoring_alert_policy.service_5xx_rate が'
t_end

t_begin 'check-monitoring-coverage: 遅延監視の列挙が正典に無い名前なら赤'
mcov_fixture
mcov_root_tf '"survey-web", "ghost-service"'
fx_run check-monitoring-coverage
expect_red 'latency_watched_services の "ghost-service" はデプロイ正典に存在しません'
t_end

t_begin 'check-monitoring-coverage: 遅延監視の配線そのものが消えたら赤'
mcov_fixture
fx_write infra/envs/prod/main.tf <<'EOF'
module "run-services" {
  services = {
    "survey-web" = {
      image = "cloudrun/container/hello"
    }
    "line-webhook" = {
      image = "cloudrun/container/hello"
    }
  }
}

module "guardrails" {
  source               = "../../modules/guardrails"
  survey_service_name  = module.run_services.service_names["survey-web"]
  webhook_service_name = module.run_services.service_names["line-webhook"]
}
EOF
fx_run check-monitoring-coverage
expect_red 'latency_watched_services の配線がありません'
t_end

# **本ガードの中心。** 2026-09-06〜09-09 の本番がこの状態だった。
t_begin 'check-monitoring-coverage: 指標が数える事象をアプリが出していなければ赤'
mcov_fixture
fx_write ts/apps/line-webhook/src/lib/structured-log.ts <<'EOF'
export function nothing(): void {
  // 事象を出さない実装（本番で実際にこの形だった: 401 を返すだけで何も記録しない）。
}
EOF
fx_run check-monitoring-coverage
expect_red '指標 webhook_signature_failures が数える事象 "webhook_signature_verification_failed" を line-webhook が出力していません'
t_end

# 事象名が「どこかに在る」ではなく「その指標が指すサービスに在る」ことを見ているかの検証。
# 別サービスの src に置いただけで緑になるなら、この検査はサービスの対応を見ていない。
t_begin 'check-monitoring-coverage: 事象名が別サービスの側にあるだけでは緑にしない'
mcov_fixture
fx_write ts/apps/line-webhook/src/lib/structured-log.ts <<'EOF'
export function nothing(): void {
  return;
}
EOF
fx_write ts/apps/survey-web/src/lib/structured-log.ts <<'EOF'
export function logFunnel(): void {
  console.info(JSON.stringify({ event: 'survey_page_viewed' }));
  console.info(JSON.stringify({ event: 'survey_response_submitted' }));
  console.info(JSON.stringify({ event: 'webhook_signature_verification_failed' }));
}
EOF
fx_run check-monitoring-coverage
expect_red 'を line-webhook が出力していません'
t_end

t_begin 'check-monitoring-coverage: for_each の事象名も 1 件ずつ照合する'
mcov_fixture
fx_write ts/apps/survey-web/src/lib/structured-log.ts <<'EOF'
export function logFunnel(): void {
  console.info(JSON.stringify({ event: 'survey_page_viewed' }));
}
EOF
fx_run check-monitoring-coverage
expect_red '数える事象 "survey_response_submitted" を survey-web が出力していません'
t_end

t_begin 'check-monitoring-coverage: 指標が service_name をリテラル直書きしていたら赤'
mcov_fixture
fx_write infra/modules/guardrails/main.tf <<'EOF'
resource "google_monitoring_notification_channel" "email" {
  project = var.project_id
}

resource "google_monitoring_alert_policy" "service_5xx_rate" {
  project = var.project_id

  conditions {
    condition_threshold {
      filter = "resource.type = \"cloud_run_revision\" AND metric.labels.response_code_class = \"5xx\""
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

resource "google_logging_metric" "webhook_signature_failures" {
  project = var.project_id
  name    = "webhook_signature_failures"
  filter  = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"line-webhook\" AND jsonPayload.event = \"webhook_signature_verification_failed\""
}
EOF
fx_run check-monitoring-coverage
expect_red '対象サービスの変数名を解決できません'
t_end

t_begin 'check-monitoring-coverage: 通知チャネルへ接続されていないポリシーを検出する'
mcov_fixture
fx_write infra/modules/guardrails/main.tf <<'EOF'
resource "google_monitoring_notification_channel" "email" {
  project = var.project_id
}

resource "google_monitoring_alert_policy" "service_5xx_rate" {
  project = var.project_id

  conditions {
    condition_threshold {
      filter = "resource.type = \"cloud_run_revision\" AND metric.labels.response_code_class = \"5xx\""
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }
}

resource "google_logging_metric" "webhook_signature_failures" {
  project = var.project_id
  name    = "webhook_signature_failures"
  filter  = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.webhook_service_name}\" AND jsonPayload.event = \"webhook_signature_verification_failed\""
}
EOF
fx_run check-monitoring-coverage
expect_red '共用の通知チャネルへ接続されていません'
t_end

t_begin 'check-monitoring-coverage: auto_close を持たないポリシーを検出する'
mcov_fixture
fx_write infra/modules/guardrails/main.tf <<'EOF'
resource "google_monitoring_notification_channel" "email" {
  project = var.project_id
}

resource "google_monitoring_alert_policy" "service_5xx_rate" {
  project = var.project_id

  conditions {
    condition_threshold {
      filter = "resource.type = \"cloud_run_revision\" AND metric.labels.response_code_class = \"5xx\""
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

resource "google_logging_metric" "webhook_signature_failures" {
  project = var.project_id
  name    = "webhook_signature_failures"
  filter  = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.webhook_service_name}\" AND jsonPayload.event = \"webhook_signature_verification_failed\""
}
EOF
fx_run check-monitoring-coverage
expect_red 'alert_strategy.auto_close がありません'
t_end

# 空振り防止。0 件を「漏れなし」と読む退化が最も静かな失敗である。
t_begin 'check-monitoring-coverage: 指標が 1 本も無ければ赤（0 件を漏れなしと読まない）'
mcov_fixture
fx_write infra/modules/guardrails/main.tf <<'EOF'
resource "google_monitoring_notification_channel" "email" {
  project = var.project_id
}

resource "google_monitoring_alert_policy" "service_5xx_rate" {
  project = var.project_id

  conditions {
    condition_threshold {
      filter = "resource.type = \"cloud_run_revision\" AND metric.labels.response_code_class = \"5xx\""
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}
EOF
fx_run check-monitoring-coverage
expect_red 'google_logging_metric のブロックを1件も抽出できませんでした'
t_end

t_begin 'check-monitoring-coverage: alert policy が 1 本も無ければ赤'
mcov_fixture
fx_write infra/modules/guardrails/main.tf <<'EOF'
resource "google_monitoring_notification_channel" "email" {
  project = var.project_id
}

resource "google_logging_metric" "webhook_signature_failures" {
  project = var.project_id
  name    = "webhook_signature_failures"
  filter  = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.webhook_service_name}\" AND jsonPayload.event = \"webhook_signature_verification_failed\""
}
EOF
fx_run check-monitoring-coverage
expect_red 'google_monitoring_alert_policy のブロックを1件も抽出できませんでした'
t_end

# 上流の正典が壊れているときに、壊れた母数で緑にしないこと。
t_begin 'check-monitoring-coverage: 上流の正典が赤なら救済せず落ちる'
mcov_fixture
fx_write scripts/push-images.sh <<'EOF'
#!/usr/bin/env bash
IMAGE_NAMES=(other-service)
EOF
fx_run check-monitoring-coverage
expect_red 'デプロイ正典を取得できません'
t_end

# 分岐到達性。事象名の照合が「常に見つかった」へ定数化していないことを、判別子を潰す
# 最小改変で確かめる。変異が当たらなければハーネス側が失敗する。
t_begin 'check-monitoring-coverage: 事象名の照合が定数化していない（分岐到達性）'
mcov_fixture
fx_guard_mutate check-monitoring-coverage \
  -e 's/if \[ "\$hit_count" -eq 0 \]; then/if [ "$hit_count" -ge 0 ]; then/'
fx_run check-monitoring-coverage
expect_red 'が出力していません'
t_end
