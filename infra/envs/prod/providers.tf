# Provider 固定（gcp-infra-foundation / design: Technology Stack）
#
# google / google-beta を同一メジャー ~> 7.0 に固定する。Cloud Run は v2 リソース
# のみを使用する方針（v1 は legacy）。google-beta は Identity Platform 等の beta
# リソースで使用する。
terraform {
  required_version = ">= 1.11"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.0"
    }
  }
}

# user_project_override + billing_project: 請求先アカウントスコープの API
# （billingbudgets 等）が「quota project」を要求するため、当プロジェクトを
# quota/billing プロジェクトとして送る（ADC 利用時の SERVICE_DISABLED 回避）。
provider "google" {
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}

provider "google-beta" {
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}
