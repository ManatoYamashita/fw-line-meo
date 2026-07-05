# Secret Manager シークレット「枠」（gcp-infra-foundation / Req 5.1, 5.2）
#
# 本モジュールが所有するのは枠と secret id の output のみ。
# - 値（version）は一切持たない → `gcloud secrets versions add` で out-of-band 投入（Req 5.2）
# - accessor IAM も持たない → SA を作る consumer 側（run-services / batch-job）が
#   secret 単位で co-locate（循環回避・Req 5.4）
locals {
  secret_ids = [
    "line-channel-secret",       # Webhook 署名検証用
    "line-channel-access-token", # Push/Reply 送信用（機能1 配信・機能3 応答）
    "gemini-api-key",            # 口コミ下書き生成
    "places-api-key",            # 競合データ取得
    "db-admin-password",         # postgres 管理ユーザー（ランタイム SA には非付与）
  ]
}

resource "google_secret_manager_secret" "frames" {
  for_each = toset(local.secret_ids)

  project   = var.project_id
  secret_id = each.value

  replication {
    auto {}
  }
}
