variable "project_id" {
  description = "Cloud SQL インスタンスを配置するプロジェクト ID。"
  type        = string
}

variable "region" {
  description = "インスタンスのリージョン。"
  type        = string
  default     = "asia-northeast1"
}

variable "instance_name" {
  description = "Cloud SQL インスタンス名。"
  type        = string
  default     = "fwlm-pg"
}

variable "database_name" {
  description = "アプリ用論理データベース名（Req 3.2）。staging は runbook で別途追加。"
  type        = string
  default     = "fwlm"
}

variable "tier" {
  description = "マシンタイプ。MVP は shared-core db-f1-micro（唯一の常時課金・Req 7.3）。"
  type        = string
  default     = "db-f1-micro"
}

variable "disk_size_gb" {
  description = "データディスクサイズ（GB）。"
  type        = number
  default     = 10
}

variable "deletion_protection" {
  description = "誤削除防止。既定 true（Req 3.1 の 1 台保全）。"
  type        = bool
  default     = true
}
