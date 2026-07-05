variable "project_id" {
  description = "Artifact Registry を配置するプロジェクト ID。"
  type        = string
}

variable "region" {
  description = "リポジトリのロケーション。"
  type        = string
  default     = "asia-northeast1"
}

variable "repository_id" {
  description = "Docker リポジトリ ID。"
  type        = string
  default     = "fwlm"
}
