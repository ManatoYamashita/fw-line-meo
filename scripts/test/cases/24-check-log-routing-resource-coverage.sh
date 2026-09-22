# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-log-routing-resource-coverage.sh の自己テスト（Issue #232）。
#
# 本ガードが守るのは「ログ振り分けの述語が、デプロイ正典に在る実行面の種別をすべて覆う」である。
# **破れたときの症状は赤ではなく「新しいバケットが静かに空」** で、着弾を実測しない限り
# 誰も気づかない。PR #245 の述語は `cloud_run_revision` だけで、本番の構造化ログ 13 行のうち
# 12 行（Cloud Run ジョブの記録）がどのカスタムバケットにも入らない状態だった。
#
# **HCL の逃がしを外してから照合することの検証を含める。** 初版は `"cloud_run_job"` を素の
# まま探し、実ツリーの `\"cloud_run_job\"` に一致せず「覆っていない」と誤って赤にした。
# 誤検知するガードは、そのうち除外で黙らされて空振りへ退化する。

# 上流の正典（check-deploy-image-coverage.sh --print-targets）も合成ツリーで緑にする必要が
# あるため、その 4 入力もここで書く（列挙を二重管理しない設計の帰結）。
lrrc_upstream() {
  fx_guard check-deploy-image-coverage
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
EOF
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

# $1 = local.log_resource_types の値（HCL の逃がし込み）。
lrrc_guardrails() {
  mkdir -p "${FX}/infra/modules/guardrails"
  cat > "${FX}/infra/modules/guardrails/main.tf" <<EOF
locals {
  log_resource_types = $1

  audit_log_filter = <<-EOT
    \${local.log_resource_types} AND jsonPayload.event =~ "^audit\\\\."
  EOT
}

resource "google_logging_project_sink" "audit" {
  project                = var.project_id
  name                   = "fwlm-audit"
  destination            = "logging.googleapis.com/projects/p/locations/global/buckets/fwlm-audit"
  filter                 = local.audit_log_filter
  unique_writer_identity = true
}

resource "google_logging_project_sink" "default" {
  project     = var.project_id
  name        = "_Default"
  destination = "logging.googleapis.com/projects/p/locations/global/buckets/_Default"

  filter = local.default_sink_required_exclusions

  exclusions {
    name   = "fwlm-audit-routed"
    filter = local.audit_log_filter
  }
}

# 振り分けではない監視の述語。**対象外でなければならない**（サービスだけを見るのが正しく、
# ここまで巻き込むと、正しいツリーを赤くする誤検知になる）。
resource "google_monitoring_alert_policy" "latency" {
  conditions {
    condition_threshold {
      filter = "resource.type = \\"cloud_run_revision\\" AND metric.type = \\"run.googleapis.com/request_latencies\\""
    }
  }
}
EOF
}

lrrc_both='"(resource.type = \"cloud_run_revision\" OR resource.type = \"cloud_run_job\")"'

t_begin 'check-log-routing-resource-coverage: 正典の種別をすべて覆っていれば緑'
fx_guard check-log-routing-resource-coverage
lrrc_upstream
lrrc_guardrails "$lrrc_both"
fx_run check-log-routing-resource-coverage
expect_green
t_end

t_begin 'check-log-routing-resource-coverage: ジョブの種別が抜けていれば赤（PR #245 の状態）'
fx_guard check-log-routing-resource-coverage
lrrc_upstream
lrrc_guardrails '"resource.type = \"cloud_run_revision\""'
fx_run check-log-routing-resource-coverage
expect_red 'cloud_run_job を覆っていません'
t_end

t_begin 'check-log-routing-resource-coverage: サービスの種別が抜けていれば赤'
fx_guard check-log-routing-resource-coverage
lrrc_upstream
lrrc_guardrails '"resource.type = \"cloud_run_job\""'
fx_run check-log-routing-resource-coverage
expect_red 'cloud_run_revision を覆っていません'
t_end

t_begin 'check-log-routing-resource-coverage: 正典に無い種別を書いていれば赤（両方向）'
fx_guard check-log-routing-resource-coverage
lrrc_upstream
lrrc_guardrails '"(resource.type = \"cloud_run_revision\" OR resource.type = \"cloud_run_job\" OR resource.type = \"gce_instance\")"'
fx_run check-log-routing-resource-coverage
expect_red '正典に無い種別を書いています: gce_instance'
t_end

t_begin 'check-log-routing-resource-coverage: 述語そのものが無ければ赤'
fx_guard check-log-routing-resource-coverage
lrrc_upstream
lrrc_guardrails '"jsonPayload.event:*"'
fx_run check-log-routing-resource-coverage
expect_red 'resource.type の述語がありません'
t_end

t_begin 'check-log-routing-resource-coverage: sink の宣言が 0 件なら赤（走査の空振り防止）'
fx_guard check-log-routing-resource-coverage
lrrc_upstream
mkdir -p "${FX}/infra/modules/guardrails"
fx_write infra/modules/guardrails/main.tf <<'EOF'
resource "google_logging_project_bucket_config" "audit" {
  bucket_id      = "fwlm-audit"
  retention_days = 30
}
EOF
fx_run check-log-routing-resource-coverage
expect_red '走査が空振りしています'
t_end

# **正典が空なら、覆うべき種別を決められない。** 空のまま緑を返すと、上流が壊れた瞬間に
# この検査ごと無力化する。
t_begin 'check-log-routing-resource-coverage: 正典が 0 件なら赤（上流の空振りを引き継がない）'
fx_guard check-log-routing-resource-coverage
fx_write scripts/check-deploy-image-coverage.sh <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
lrrc_guardrails "$lrrc_both"
fx_run check-log-routing-resource-coverage
expect_red 'デプロイ正典を取得できません'
t_end
