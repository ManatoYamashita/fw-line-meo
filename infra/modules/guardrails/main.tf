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

# Places API クォータ上限（Req 7.2）。quota_id は実名確認後に設定（未設定なら作らない）。
resource "google_cloud_quotas_quota_preference" "places" {
  count = var.places_quota_id == "" ? 0 : 1

  parent   = "projects/${var.project_id}"
  name     = "places-requests-cap"
  service  = "places.googleapis.com"
  quota_id = var.places_quota_id

  quota_config {
    preferred_value = var.places_quota_limit
  }
}
