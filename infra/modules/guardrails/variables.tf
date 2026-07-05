variable "project_id" {
  description = "ガードレール対象プロジェクト ID。"
  type        = string
}

variable "project_number" {
  description = "プロジェクト番号（budget_filter 用・root の data.google_project から取得）。"
  type        = string
}

variable "billing_account_id" {
  description = "請求先アカウント ID。budget 作成に使用（apply 実行者に billing.costsManager が必要）。"
  type        = string
}

variable "budget_amount_jpy" {
  description = "月次予算アラート閾値（円）。Req 7.1。"
  type        = number
  default     = 10000
}

variable "alert_email" {
  description = "予算超過・バッチ失敗の通知先メール。"
  type        = string
}

variable "job_name" {
  description = "失敗アラートの対象となる daily-batch ジョブ名（batch-job output）。"
  type        = string
}

variable "places_quota_id" {
  description = <<-EOT
    Places API のクォータ ID（Req 7.2）。**推測で書かない**: apply 前に
    `gcloud services quota list --service=places.googleapis.com --project=PROJECT`
    で実名を確認して設定する（runbook）。未設定（空文字）ならクォータ上限を作らない。
  EOT
  type        = string
  default     = ""
}

variable "places_quota_limit" {
  description = "Places API クォータ上限値（preferred_value）。places_quota_id 設定時に必須。"
  type        = number
  default     = 0
}
