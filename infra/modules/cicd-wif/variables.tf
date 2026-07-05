variable "project_id" {
  description = "WIF リソースを配置するプロジェクト ID。"
  type        = string
}

variable "project_number" {
  description = "プロジェクト番号（principalSet の識別に必要・root の data.google_project から取得）。"
  type        = string
}

variable "github_repository" {
  description = "認証を許可する単一 GitHub リポジトリ（owner/repo 形式）。Req 6.3。"
  type        = string
}

variable "pool_id" {
  description = "Workload Identity Pool ID。"
  type        = string
  default     = "github-pool"
}

variable "provider_id" {
  description = "Workload Identity Pool Provider ID。"
  type        = string
  default     = "github-provider"
}

variable "runtime_service_account_emails" {
  description = "デプロイ時に principalSet が impersonate するランタイム SA email 群（run-services + batch-job の output）。"
  type        = list(string)
  default     = []
}
