# コストガードレール・失敗検知（gcp-infra-foundation / Req 2.5,7.1,7.2,7.3）
#
# 通知系（channel + alert policy）と課金系（budget + quota）を集約。
# 失敗アラートポリシーはここが所有する（run-services/batch-job → guardrails の一方向）。
#
# ジョブ名で対象を絞らない（Issue #151）。以前は job_name 変数で daily-batch だけを
# 見ていたため、後から追加された summary-delivery の失敗を見る監視が 1 つも無く、
# 60 execution 以上（毎時 2 回 × 600 秒のタイムアウト）が誰にも通知されないまま続いた。
# ジョブを足すたびに配線を思い出す設計は、思い出さなかったときに無音になる。
# 述語そのものを持たなければ、その忘れ方は起き得ない。

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

# Cloud Run Job 失敗アラート（Req 2.5 後半・検知）。プロジェクト内の全 Job の実行失敗を監視。
resource "google_monitoring_alert_policy" "job_failure" {
  project      = var.project_id
  display_name = "cloud run job failure"
  combiner     = "OR"

  conditions {
    display_name = "failed job executions"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_job\" AND metric.type = \"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result = \"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }

  # 既定の自動クローズは 7 日で、復旧を短時間で観測できない（直したのに閉じないので、
  # 開いているインシデントが「今も壊れている」ことを意味しなくなる）。
  # daily-batch は日次・summary-delivery は毎時なので、1 時間なら失敗が続く間は
  # インシデントが 1 本に畳まれ、直ってから 1 時間強で閉じる。
  alert_strategy {
    auto_close = "3600s"
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
