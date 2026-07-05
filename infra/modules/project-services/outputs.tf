output "enabled_services" {
  description = "有効化した API サービス名の一覧（下流モジュールの依存表明に使用）。"
  value       = [for s in google_project_service.enabled : s.service]
}
