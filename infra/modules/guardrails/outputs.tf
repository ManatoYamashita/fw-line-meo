output "notification_channel_id" {
  description = "共用の通知チャネル ID。"
  value       = google_monitoring_notification_channel.email.id
}

output "budget_name" {
  description = "月次予算リソース名。"
  value       = google_billing_budget.monthly.name
}

output "survey_funnel_metric_names" {
  description = "アンケートのファネル指標名（Issue #137 段階3・logging.googleapis.com/user/<name> として読む）。"
  value       = { for k, m in google_logging_metric.survey_funnel : k => m.name }
}

output "service_alert_policy_names" {
  description = "Cloud Run サービス監視の alert policy 名（Issue #230）: display_name → policy のリソース名。運用照会と monitoring-drift の照合先の正典。"
  value = merge(
    {
      (google_monitoring_alert_policy.service_5xx_rate.display_name)          = google_monitoring_alert_policy.service_5xx_rate.name
      (google_monitoring_alert_policy.webhook_signature_failure.display_name) = google_monitoring_alert_policy.webhook_signature_failure.name
    },
    { for k, p in google_monitoring_alert_policy.customer_latency : p.display_name => p.name },
  )
}

output "logging_bucket_names" {
  description = "用途別 Cloud Logging バケット名（Issue #232）。"
  value = {
    audit     = google_logging_project_bucket_config.audit.bucket_id
    app_error = google_logging_project_bucket_config.app_error.bucket_id
    app_info  = google_logging_project_bucket_config.app_info.bucket_id
  }
}

output "webhook_signature_metric_name" {
  description = "署名検証失敗の指標名（Issue #230・logging.googleapis.com/user/<name> として読む）。"
  value       = google_logging_metric.webhook_signature_failures.name
}
