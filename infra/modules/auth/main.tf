# Identity Platform / Firebase Auth（gcp-infra-foundation / Req 4.x）
#
# ダッシュボードの Google ログイン基盤を有効化する。TF が管理するのは
# 「有効化」まで。Google IdP プロバイダの有効化と OAuth クライアント設定は
# client secret を TF state に持ち込まないため手動 Console 手順（runbook・Req 5.2）。
# パスワード認証プロバイダは有効化しない（Req 4.2）。
#
# 注意: identity_platform_config は一度作成すると削除不可。既に有効化済みの
# プロジェクトでは terraform import で取り込む（runbook）。prevent_destroy で
# 誤 destroy を防ぐ。
resource "google_firebase_project" "default" {
  provider = google-beta
  project  = var.project_id
}

resource "google_identity_platform_config" "default" {
  provider = google-beta
  project  = var.project_id

  # 匿名ユーザーの自動削除等はデフォルトのまま。IdP の具体設定は手動（runbook）。
  depends_on = [google_firebase_project.default]

  lifecycle {
    prevent_destroy = true
  }
}
