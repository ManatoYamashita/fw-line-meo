variable "project_id" {
  description = "API を有効化する対象プロジェクト ID。"
  type        = string
}

variable "disable_on_destroy" {
  description = "destroy 時に API を無効化するか。既定 false（他リソースの巻き込み無効化を防ぐ安全側）。"
  type        = bool
  default     = false
}
