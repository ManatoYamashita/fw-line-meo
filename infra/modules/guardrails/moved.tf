# 失敗アラートポリシーのリソース名リネーム対応（Issue #151）
#
# job_name 述語の撤去にあわせて batch_failure → job_failure へ改名した。Terraform は
# リソースアドレスの変更を「destroy(旧) → create(新)」と解釈するため、moved で
# 意味的に同一のリソースとして対応付ける。destroy/create になると、その隙間に
# 発生した失敗が通知されないまま流れる（監視を直す変更が監視の穴を作るのは本末転倒）。
#
# 対象は本番で稼働中の 1 本のみ（Monitoring API で実測: プロジェクト内の
# alertPolicies は "daily-batch job failure" だけ）。state に旧アドレスが存在しない
# 環境では no-op。

moved {
  from = google_monitoring_alert_policy.batch_failure
  to   = google_monitoring_alert_policy.job_failure
}
