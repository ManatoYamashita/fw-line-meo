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

variable "line_richmenu_completed_id" {
  description = <<-EOT
    完了後リッチメニューの richMenuId（env LINE_RICHMENU_COMPLETED_ID・line-on-demand-report の
    design.md「ReportMenuGate」）。line-webhook の同名 env と同じ値（root の line_richmenu_completed_id）を渡す。
    変化があった日の通知はリッチメニューからの確認を案内するため、送信の前に、このメニューがレポート導線を
    持つかと、オーナーにこのメニューが張られているかを照合するのに使う。
    CI はイメージだけを差し替え、env は Terraform が持つので、この env はそれを読むイメージより先に配線する
    （line-on-demand-report の design.md「Migration Strategy」の Step A）。呼出側の配線漏れを validate で
    止めるため、既定値を持たせない。
  EOT
  type        = string
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
