output "job_name" {
  description = "Cloud Run ジョブ名。Guardrails の失敗アラートポリシーがフィルタに使用。"
  value       = google_cloud_run_v2_job.batch.name
}

output "job_service_account_email" {
  description = "ジョブ実行 SA email。cicd-wif の serviceAccountUser 付与対象。"
  value       = google_service_account.job.email
}

output "scheduler_service_account_email" {
  description = "スケジューラ SA email。"
  value       = google_service_account.scheduler.email
}
