# Cloud Run for_each キーのリネーム対応（line-onboarding PR #15 レビュー是正・High）
#
# main.tf の module.run_services.services は本 PR で "webhook" → "line-webhook" へ
# キーをリネームした。run-services モジュールは for_each = var.services のキーを
# そのままリソースアドレスに使うため、キー変更は Terraform 上「destroy(旧キー) →
# create(新キー)」を意味する。既に "webhook" キーで apply 済みの環境がある場合の
# サービスダウンタイム・invoker binding 消失・IAM DB ユーザー再作成を避けるため、
# 意味的に同一リソースのものだけ moved で対応付ける。
#
# 対象外（新規作成/削除のため moved 不要）:
#   google_secret_manager_secret_iam_member.accessor["webhook.LINE_CHANNEL_ACCESS_TOKEN"]
#     → stateless トークン発行方式への変更により本 PR で削除された secret アクセス。
#   google_secret_manager_secret_iam_member.accessor["line-webhook.PLACES_API_KEY"]
#     → 本 PR で新規追加された secret アクセス。
#
# state に旧アドレスが存在しない環境（未 apply）では no-op。

moved {
  from = module.run_services.google_service_account.svc["webhook"]
  to   = module.run_services.google_service_account.svc["line-webhook"]
}

moved {
  from = module.run_services.google_cloud_run_v2_service.svc["webhook"]
  to   = module.run_services.google_cloud_run_v2_service.svc["line-webhook"]
}

moved {
  from = module.run_services.google_cloud_run_v2_service_iam_member.invoker["webhook"]
  to   = module.run_services.google_cloud_run_v2_service_iam_member.invoker["line-webhook"]
}

moved {
  from = module.run_services.google_secret_manager_secret_iam_member.accessor["webhook.LINE_CHANNEL_SECRET"]
  to   = module.run_services.google_secret_manager_secret_iam_member.accessor["line-webhook.LINE_CHANNEL_SECRET"]
}

moved {
  from = module.run_services.google_sql_user.iam["webhook"]
  to   = module.run_services.google_sql_user.iam["line-webhook"]
}

moved {
  from = module.run_services.google_project_iam_member.cloudsql["webhook.roles/cloudsql.client"]
  to   = module.run_services.google_project_iam_member.cloudsql["line-webhook.roles/cloudsql.client"]
}

moved {
  from = module.run_services.google_project_iam_member.cloudsql["webhook.roles/cloudsql.instanceUser"]
  to   = module.run_services.google_project_iam_member.cloudsql["line-webhook.roles/cloudsql.instanceUser"]
}

# cicd_wif.act_as は SA の email 文字列そのものを for_each キーに使う
# （runtime_service_account_emails = concat(values(run_services.service_account_emails), ...)）。
# SA の account_id リネームで email 自体が変わるため、このキーも別物になる。
# moved ブロックのインデックスは静的リテラルのみ許可されるため（変数式・補間不可）、
# 本プロジェクトが単一 GCP プロジェクト運用（dev/prod 分離なし）であることを踏まえ、
# 実プロジェクト ID を直書きする。
moved {
  from = module.cicd_wif.google_service_account_iam_member.act_as["sa-webhook@gen-fw-line-meo.iam.gserviceaccount.com"]
  to   = module.cicd_wif.google_service_account_iam_member.act_as["sa-line-webhook@gen-fw-line-meo.iam.gserviceaccount.com"]
}
