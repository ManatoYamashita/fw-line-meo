# 単体 validate 用の provider 宣言（gcp-infra-foundation / project-services）
# root と同一メジャーに固定する。
terraform {
  required_version = ">= 1.11"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}
