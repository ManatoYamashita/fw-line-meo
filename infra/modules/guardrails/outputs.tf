output "notification_channel_id" {
  description = "共用の通知チャネル ID。"
  value       = google_monitoring_notification_channel.email.id
}

output "budget_name" {
  description = "月次予算リソース名。"
  value       = google_billing_budget.monthly.name
}
