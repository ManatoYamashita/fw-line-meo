output "connection_name" {
  description = "Cloud SQL 接続名（PROJECT:REGION:INSTANCE）。consumer が Language Connector / env で使用。"
  value       = google_sql_database_instance.main.connection_name
}

output "instance_name" {
  description = "インスタンス名。consumer の google_sql_user が instance 参照に使用（循環回避の一方向依存）。"
  value       = google_sql_database_instance.main.name
}

output "database_name" {
  description = "アプリ用論理データベース名。"
  value       = google_sql_database.app.name
}
