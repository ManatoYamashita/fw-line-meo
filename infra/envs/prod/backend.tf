# GCS remote state backend（gcp-infra-foundation / Req 1.4）
#
# バケット名はプロジェクト固有のため **partial backend** とし、init 時に
# `-backend-config="bucket=<GCS_BUCKET>"` で与える（`make tf-init TF_STATE_BUCKET=...`）。
# これでリポジトリに特定プロジェクトのバケット名をハードコードしない。
# state バケットはブートストラップ手順（infra/README.md §1-2）で手動作成する
# IaC 例外リソース（versioning 有効）。ローカル検証は `terraform init -backend=false`。
terraform {
  backend "gcs" {
    prefix = "terraform/state"
  }
}
