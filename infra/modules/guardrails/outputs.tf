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
