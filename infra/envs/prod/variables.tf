# ルート入力変数（gcp-infra-foundation / design: TerraformCore）
#
# region 以外はデフォルトを持たせない（環境固有値の明示を強制）。
# 実値は terraform.tfvars（gitignore 対象）で与える。

variable "project_id" {
  description = "単一 GCP プロジェクト ID（例: fwlm）。dev/prod 分離なし。"
  type        = string
}

variable "region" {
  description = "全リソースの既定リージョン。"
  type        = string
  default     = "asia-northeast1"
}

variable "billing_account_id" {
  description = "請求先アカウント ID。budget 作成に使用（apply 実行者に billing.costsManager が必要）。"
  type        = string
}

variable "budget_amount_jpy" {
  description = "月次予算アラートの閾値（円）。Req 7.1。"
  type        = number
  default     = 10000
}

variable "alert_email" {
  description = "予算超過・バッチ失敗の通知先メールアドレス。"
  type        = string
}

variable "github_repository" {
  description = "WIF が許可する単一 GitHub リポジトリ（owner/repo 形式）。Req 6.3。"
  type        = string
}

variable "places_quota_caps" {
  description = "Places API クォータ上限マップ（Req 7.2）: quota_id => preferred_value。空 {} なら上限なし。"
  type        = map(number)
  default     = {}
}

# --- review-acquisition（機能3）が追加する env（gcp-infra への additive 拡張） ---

variable "gemini_model" {
  description = "口コミ下書き生成に使う Gemini モデル ID（survey-web の GEMINI_MODEL env）。差替可能。"
  type        = string
  default     = "gemini-3.1-flash-lite"
}

variable "survey_base_url" {
  description = <<-EOT
    客向けアンケート Web の公開ベース URL（dashboard-api の SURVEY_BASE_URL env・QR 生成に使用）。
    survey-web の初回デプロイ後にその Cloud Run URL（またはカスタムドメイン）を設定する。
  EOT
  type        = string
  default     = ""
}

# --- line-onboarding（LINE Webhook 基盤）が追加する env（gcp-infra への additive 拡張） ---

variable "line_channel_id" {
  description = "LINE チャネル ID（line-webhook の LINE_CHANNEL_ID env・非秘匿）。"
  type        = string
  default     = ""
}

variable "line_richmenu_completed_id" {
  description = <<-EOT
    完了後リッチメニューの richMenuId（line-webhook の LINE_RICHMENU_COMPLETED_ID env）。
    `setup-rich-menus.ts` を実チャネルに対して実行した後に得られる値を設定する。
  EOT
  type        = string
  default     = ""
}
