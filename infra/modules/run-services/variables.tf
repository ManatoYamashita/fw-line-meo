variable "project_id" {
  description = "Cloud Run サービスを配置するプロジェクト ID。"
  type        = string
}

variable "region" {
  description = "サービスのリージョン。"
  type        = string
  default     = "asia-northeast1"
}

variable "db_instance_name" {
  description = "Cloud SQL インスタンス名（IAM DB ユーザーの instance 参照用・database output）。"
  type        = string
}

variable "db_connection_name" {
  description = "Cloud SQL 接続名（env CLOUDSQL_CONNECTION_NAME 用・database output）。"
  type        = string
}

variable "image" {
  description = "初期プレースホルダイメージ。実イメージは CI が更新（TF は ignore_changes で追従しない）。"
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "services" {
  description = <<-EOT
    サービス定義マップ（設計のモジュール入力インターフェース）。
    - public: invoker を allUsers にするか
    - secret_env: 環境変数名 → Secret Manager secret id（accessor と env mount を導出）
    - needs_cloudsql: cloudsql ロール + IAM DB ユーザーを付与するか
    実体マップは Task 4.3 の root 配線で渡す。
  EOT
  type = map(object({
    public         = bool
    secret_env     = map(string)
    needs_cloudsql = bool
  }))
  default = {}
}
