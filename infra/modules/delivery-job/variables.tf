variable "project_id" {
  description = "配信ジョブを配置するプロジェクト ID。"
  type        = string
}

variable "region" {
  description = "ジョブ・スケジューラのリージョン。"
  type        = string
  default     = "asia-northeast1"
}

variable "job_name" {
  description = "Cloud Run ジョブ名（design.md: Cloud Run Job `summary-delivery`）。"
  type        = string
  default     = "summary-delivery"
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
    task 3.6/6.3 レビューで発見された batch-job モジュールの配線漏れ（DB_IAM_USER・DB_NAME 未配線で
    Cloud SQL IAM 接続モードが起動時に fail-fast する）を本モジュールでは繰り返さないため、
    run-services モジュールと同じ3値（CLOUDSQL_CONNECTION_NAME・DB_NAME・DB_IAM_USER）を最初から揃える。
  EOT
  type        = string
}

variable "line_channel_secret_id" {
  description = <<-EOT
    LINE チャネルシークレットの Secret Manager secret id（secrets output の `line-channel-secret`）。
    delivery-job は Stateless channel access token を client_credentials（channel_id + channel_secret）で
    都度発行するため（ts/apps/delivery-job/src/line.ts）、本 secret の値が env LINE_CHANNEL_SECRET に
    直接マウントされる。
  EOT
  type        = string
}

variable "line_channel_access_token_secret_id" {
  description = <<-EOT
    LINE チャネルアクセストークンの Secret Manager secret id（secrets output の
    `line-channel-access-token`）。design.md「Modified Files」「Security Considerations」
    （`line-channel-access-token` の accessor を delivery-job SA へ追加付与・
    「delivery-job のみ LINE token accessor」）に基づき accessor のみを付与する。
    現行の delivery-job 実装（Stateless token 発行方式）は本 secret を env としては消費しないため、
    Job のコンテナ env へはマウントしない（IAM accessor 権限の付与のみ・CONCERNS 参照）。
  EOT
  type        = string
}

variable "line_channel_id" {
  description = <<-EOT
    LINE チャネル ID（Stateless token 発行の client_id・env LINE_CHANNEL_ID）。
    channel secret とは異なり単体では認証情報として機能しない識別子のため Secret Manager を経由せず
    平文 env として配線する（webhook アプリの LINE チャネル関連 env が未確立のため、本モジュール配線が
    リポジトリ初の LINE チャネル ID env）。デプロイ前に terraform.tfvars で実値を設定すること。
  EOT
  type        = string
  default     = ""
}

variable "liff_url" {
  description = <<-EOT
    「詳細を見る」ボタンの遷移先 LIFF URL（env LIFF_URL・design.md「LIFF URL 契約」）。
    LIFF チャネル自体の作成は task 6.2 / #6 LINE 基盤と共同の runbook 手順（design.md Open Questions）
    のため、既定は空文字列。store-detail の LIFF チャネル発行後に terraform.tfvars で設定する。
  EOT
  type        = string
  default     = ""
}

variable "image" {
  description = "初期プレースホルダイメージ。実イメージは CI が更新（TF は ignore_changes）。"
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "schedule" {
  description = "起動スケジュール（cron）。既定は毎時 HH:00（design.md「毎時配信」）。"
  type        = string
  default     = "0 * * * *"
}

variable "timezone" {
  description = "スケジュールのタイムゾーン。"
  type        = string
  default     = "Asia/Tokyo"
}
