# Artifact Registry（gcp-infra-foundation / Req 6.1 支援）
#
# Cloud Run の services / jobs のイメージ置き場。Docker Hub ではなく AR を使う
# 方針（イメージのキャッシュ問題回避・CI から push）。
resource "google_artifact_registry_repository" "docker" {
  project       = var.project_id
  location      = var.region
  repository_id = var.repository_id
  format        = "DOCKER"
  description   = "fw-line-meo container images (Cloud Run services and jobs)"
}
