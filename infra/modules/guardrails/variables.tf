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

variable "places_quota_caps" {
  description = <<-EOT
    Places API のクォータ上限マップ（Req 7.2）: quota_id => preferred_value。
    quota_id は Cloud Quotas の実名（例: SearchTextRequestPerDayPerProject）。
    空マップ {} なら上限を作らない。バッチが使う日次エンドポイントをまとめて絞る。
  EOT
  type        = map(number)
  default     = {}
}

variable "survey_service_name" {
  description = "ファネル指標（Issue #137 段階3）の対象となる survey-web の Cloud Run サービス名（run-services output）。"
  type        = string
}

variable "webhook_service_name" {
  description = "署名検証失敗の指標（Issue #230）の対象となる line-webhook の Cloud Run サービス名（run-services output）。"
  type        = string
}

variable "latency_watched_services" {
  description = <<-EOT
    p95 遅延を監視する Cloud Run サービス名の一覧（Issue #230）。**客向け面のみ**を入れる。
    5xx 率はサービス名を列挙せず全サービスを覆うため、ここへ足し忘れても無音にはならない。

    **run-services の output（computed）を渡さないこと。** for_each の集合要素にすると、
    サービスを 1 件でも新規に足した PR では apply 前に値が確定せず `Invalid for_each
    argument` で prod env の plan ごと落ちる（cicd-wif が values() ではなく keys() を渡す
    理由と同じ罠）。run-services は name = each.key なので、サービス名は services マップの
    鍵そのもの＝リテラルで確定する。
  EOT
  type        = list(string)
}
