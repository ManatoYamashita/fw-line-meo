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

variable "places_quota_caps" {
  description = <<-EOT
    Places API のクォータ上限マップ（Req 7.2）: quota_id => preferred_value。
    quota_id は Cloud Quotas の実名（例: SearchTextRequestPerDayPerProject）。
    空マップ {} なら上限を作らない。バッチが使う日次エンドポイントをまとめて絞る。
  EOT
  type        = map(number)
  default     = {}
}
