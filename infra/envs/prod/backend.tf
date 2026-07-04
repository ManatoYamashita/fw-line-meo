# GCS remote state backend（gcp-infra-foundation / Req 1.4）
#
# state バケットはブートストラップ手順（infra/README.md）で手動作成する
# IaC 例外リソースであり、Terraform 管理外。versioning を有効化しておくこと。
# ローカル検証は `terraform init -backend=false` で backend を回避するため、
# 下記 bucket が実在しなくても validate は成立する。実 init 時に -backend-config で
# 実バケット名を与えるか、本ファイルの bucket を確定値へ置き換える。
terraform {
  backend "gcs" {
    bucket = "fwlm-tfstate" # ブートストラップで作成する実バケット名に一致させる
    prefix = "terraform/state"
  }
}
