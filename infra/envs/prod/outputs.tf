# ルート出力（gcp-infra-foundation / Task 4.3）

output "service_names" {
  description = "Cloud Run サービスキー → サービス名。"
  value       = module.run_services.service_names
}

output "sql_connection_name" {
  description = "Cloud SQL 接続名（Auth Proxy / Language Connector 用）。"
  value       = module.database.connection_name
}

output "wif_provider_name" {
  description = "WIF provider のフルリソース名。GitHub の vars.WIF_PROVIDER に設定する。"
  value       = module.cicd_wif.provider_name
}

output "registry_url" {
  description = "Artifact Registry のイメージ push/pull ベース URL。"
  value       = module.registry.repository_url
}

output "daily_batch_job_name" {
  description = "日次バッチジョブ名（手動発火・アラート参照用）。"
  value       = module.batch_job.job_name
}

output "summary_delivery_job_name" {
  description = "配信ジョブ名（手動発火・アラート参照用）。"
  value       = module.delivery_job.job_name
}
