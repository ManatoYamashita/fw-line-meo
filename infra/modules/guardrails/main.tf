# コストガードレール・失敗検知（gcp-infra-foundation / Req 2.5,7.1,7.2,7.3）
#
# 通知系（channel + alert policy）と課金系（budget + quota）を集約。
# 循環回避のため batch 失敗アラートポリシーはここが所有し、BatchJob の Job を
# 名前で参照する（run-services/batch-job → guardrails の一方向）。

# 通知チャネル（budget 通知とバッチ失敗アラートで共用）
resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "fw-line-meo ops email"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }
}

# 月次予算アラート（Req 7.1）。billing account レベル権限が必要（runbook）。
resource "google_billing_budget" "monthly" {
  billing_account = var.billing_account_id
  display_name    = "fwlm monthly budget"

  budget_filter {
    projects = ["projects/${var.project_number}"]
  }

  amount {
    specified_amount {
      currency_code = "JPY"
      units         = tostring(var.budget_amount_jpy)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }

  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.email.id]
    disable_default_iam_recipients   = false
  }
}

# daily-batch 失敗アラート（Req 2.5 後半・検知）。Job 実行履歴の失敗数を監視。
resource "google_monitoring_alert_policy" "batch_failure" {
  project      = var.project_id
  display_name = "daily-batch job failure"
  combiner     = "OR"

  conditions {
    display_name = "daily-batch failed executions"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_job\" AND resource.labels.job_name = \"${var.job_name}\" AND metric.type = \"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result = \"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

# Places API クォータ上限（Req 7.2）。バッチが使う日次エンドポイントを quota_id 単位で
# 上限設定（空マップなら作らない）。既定からの減量で安全チェックに掛かる場合に備え
# ignore_safety_checks を付与。
resource "google_cloud_quotas_quota_preference" "places" {
  for_each = var.places_quota_caps

  parent   = "projects/${var.project_id}"
  name     = each.key
  service  = "places.googleapis.com"
  quota_id = each.key

  quota_config {
    preferred_value = each.value
  }

  ignore_safety_checks = "QUOTA_DECREASE_PERCENTAGE_TOO_HIGH"
}

# ------------------------------------------------------------------------------
# アンケートのファネル指標（review-acquisition / Issue #137 段階3・Req 5.7）
#
# 表示件数（survey_page_viewed）は DB のどの表にも存在しない。survey_material_tallies が
# 数えるのは **送信された回答** だけで、「開いたが送らなかった」は原理的に出せないため、
# 唯一の記録がアプリの構造化ログになる。ところが Cloud Run の stdout は _Default バケットへ
# 入り、既定の保持は 30 日である（本番実測: buckets list → _Default 30 日・_Required 400 日は
# 監査ログ専用。ログベース指標もシンクも未設定）。段階4（導線変更）の判断は「施策前後の比較」
# なので、施策前の窓が消えた時点で本 spec の計測基盤そのものが目的を果たさなくなる。
#
# ログベース指標へ写すと時系列は 24 か月残る（6 週までは 1 分粒度、以降は 10 分粒度へ集約）。
# _Default バケットの保持延長を採らないのは、survey 以外の全ログまで課金対象になるため。
#
# **severity では絞らないこと。** アプリは `level` フィールドを出しており、Cloud Run はこれを
# LogEntry.severity へ写さない（本番実測: {"event":"generation_failed","level":"error"} の
# severity は null）。`severity = "INFO"` を条件に足すと 1 件も一致せず、「指標は存在するのに
# 常に 0」という静かな失敗になる。event 名だけで絞る。
#
# **指標は作成時点から数え始める。** 段階4 の直前に作ってもベースラインは取れないので、
# 本 spec のデプロイと同じタイミングで apply すること。
# ------------------------------------------------------------------------------
resource "google_logging_metric" "survey_funnel" {
  for_each = toset(["survey_page_viewed", "survey_response_submitted"])

  project     = var.project_id
  name        = each.key
  description = "review-acquisition のファネル（Issue #137 段階3・Req 5.7）: ${each.key} を店舗単位で数える。"
  filter      = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.survey_service_name}\" AND jsonPayload.event = \"${each.key}\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"

    # 店舗単位で読めることが Req 5.7 の要求。**来店客に紐づく値は載せない**（storeId は
    # 事業者側の識別子であって来店客の識別子ではない）。ログ側の sink が storeId 以外を
    # 出さない allowlist なので、ここで抽出しうる値も構造的に storeId に限られる。
    labels {
      key         = "store_id"
      value_type  = "STRING"
      description = "店舗 ID（jsonPayload.storeId）。"
    }
  }

  label_extractors = {
    store_id = "EXTRACT(jsonPayload.storeId)"
  }
}
