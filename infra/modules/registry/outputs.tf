output "repository_id" {
  description = "Docker リポジトリ ID。"
  value       = google_artifact_registry_repository.docker.repository_id
}

output "repository_url" {
  description = "イメージ push/pull 先のベース URL（LOCATION-docker.pkg.dev/PROJECT/REPO）。"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.docker.repository_id}"
}
