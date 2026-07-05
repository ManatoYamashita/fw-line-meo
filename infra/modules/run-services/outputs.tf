output "service_account_emails" {
  description = "サービスキー → ランタイム SA email。cicd-wif の serviceAccountUser 付与対象。"
  value       = { for k, sa in google_service_account.svc : k => sa.email }
}

output "service_names" {
  description = "サービスキー → Cloud Run サービス名。"
  value       = { for k, s in google_cloud_run_v2_service.svc : k => s.name }
}
