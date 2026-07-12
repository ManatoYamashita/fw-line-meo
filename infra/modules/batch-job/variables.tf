variable "project_id" {
  description = "日次バッチジョブを配置するプロジェクト ID。"
  type        = string
}

variable "region" {
  description = "ジョブ・スケジューラのリージョン。"
  type        = string
  default     = "asia-northeast1"
}

variable "job_name" {
  description = "Cloud Run ジョブ名。"
  type        = string
  default     = "daily-batch"
}

variable "db_instance_name" {
  description = "Cloud SQL インスタンス名（IAM DB ユーザーの instance 参照用・database output）。"
  type        = string
}

variable "db_connection_name" {
  description = "Cloud SQL 接続名（env CLOUDSQL_CONNECTION_NAME 用・database output）。"
  type        = string
}

variable "db_name" {
  description = <<-EOT
    アプリ用論理データベース名（env DB_NAME 用・database output）。
    task 3.6/6.3 レビューで発見: config.Load() が DBModeCloudSQLIAM で必須とする DB_IAM_USER・DB_NAME が
    未配線のまま残っており Go バイナリが起動時に fail-fast していた。delivery-job モジュールと同じ3値
    （CLOUDSQL_CONNECTION_NAME・DB_NAME・DB_IAM_USER）を揃える。
  EOT
  type        = string
}

variable "places_secret_id" {
  description = "Places API キーの Secret Manager secret id（secrets output）。"
  type        = string
}

variable "image" {
  description = "初期プレースホルダイメージ。実イメージは CI が更新（TF は ignore_changes）。"
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "schedule" {
  description = "起動スケジュール（cron）。既定は毎朝 06:00。"
  type        = string
  default     = "0 6 * * *"
}

variable "timezone" {
  description = "スケジュールのタイムゾーン。"
  type        = string
  default     = "Asia/Tokyo"
}
