output "provider_name" {
  description = "WIF provider のフルリソース名。GitHub Actions の workload_identity_provider（vars.WIF_PROVIDER）に設定する。"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "pool_name" {
  description = "Workload Identity Pool のフルリソース名。"
  value       = google_iam_workload_identity_pool.github.name
}
