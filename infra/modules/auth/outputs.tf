output "identity_platform_config_id" {
  description = "Identity Platform 設定リソース ID（有効化の証跡）。"
  value       = google_identity_platform_config.default.id
}
