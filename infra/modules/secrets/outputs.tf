output "secret_ids" {
  description = "シークレット名 → Secret Manager リソース ID の対応。consumer が accessor binding / env mount で参照。"
  value       = { for name, s in google_secret_manager_secret.frames : name => s.id }
}
