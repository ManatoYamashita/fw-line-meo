# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-log-sink-default-filter.sh の自己テスト（Issue #232）。
#
# 本ガードが守るのは「Logging が作成した `_Default` sink を Terraform の管理下へ置くとき、
# 既定の必須ログ除外を落とさない」である。**破れたときの症状は赤ではなく、監査ログの
# 二重保存（`_Required` 400 日無料 ＋ `_Default` 30 日課金）** であり、CI にも apply の
# 実行ログにも何も出ない。plan の属性まで下りて読んだときにだけ `-> null` として見える。
#
# **偽陽性を出さないことの検証を含める。** 初版は属性を深さ無制限で拾い、
# `exclusions { filter = ... }` の中身を sink 自身の filter と取り違えていた。filter を
# まるごと消しても「宣言はあるが中身が足りない」と別の理由で赤くなるため、赤ケースを
# 文字列まで照合していなければ、取り違えたまま「検出できている」と読めてしまう。

# 正しい状態: local 経由で必須 6 件を除外し、exclusions を 3 つ持つ。
lsdf_required_local() {
  cat <<'EOF'
locals {
  default_sink_required_exclusions = join(" AND ", [
    for log_id in [
      "cloudaudit.googleapis.com/activity",
      "externalaudit.googleapis.com/activity",
      "cloudaudit.googleapis.com/system_event",
      "externalaudit.googleapis.com/system_event",
      "cloudaudit.googleapis.com/access_transparency",
      "externalaudit.googleapis.com/access_transparency",
    ] : "NOT LOG_ID(\"${log_id}\")"
  ])
}
EOF
}

lsdf_write() {
  # $1 = sink 直下へ置く filter 行（空なら宣言しない）
  mkdir -p "${FX}/infra/modules/guardrails"
  {
    lsdf_required_local
    cat <<'EOF'

resource "google_logging_project_sink" "audit" {
  project     = var.project_id
  name        = "fwlm-audit"
  destination = "logging.googleapis.com/projects/p/locations/global/buckets/fwlm-audit"

  filter = <<-EOT
    resource.type = "cloud_run_revision"
  EOT
}

resource "google_logging_project_sink" "default" {
  project     = var.project_id
  name        = "_Default"
  destination = "logging.googleapis.com/projects/p/locations/global/buckets/_Default"
EOF
    if [ -n "${1:-}" ]; then
      printf '\n  %s\n' "$1"
    fi
    cat <<'EOF'

  exclusions {
    name   = "fwlm-audit-routed"
    filter = <<-EOT
      resource.type = "cloud_run_revision" AND jsonPayload.event =~ "^audit\\."
    EOT
  }
}
EOF
  } > "${FX}/infra/modules/guardrails/main.tf"
}

t_begin 'check-log-sink-default-filter: 必須除外を local 経由で保持していれば緑'
fx_guard check-log-sink-default-filter
lsdf_write 'filter = local.default_sink_required_exclusions'
fx_run check-log-sink-default-filter
expect_green
t_end

t_begin 'check-log-sink-default-filter: filter の宣言が無ければ赤（PR #245 の形）'
fx_guard check-log-sink-default-filter
lsdf_write ''
fx_run check-log-sink-default-filter
# 入れ子の exclusions の filter を拾って別の理由で赤くするのではなく、
# 「宣言が無い」と言えていることまで固定する。
expect_red 'filter を宣言していません'
t_end

t_begin 'check-log-sink-default-filter: 必須ログ ID が 1 件欠けたら赤'
fx_guard check-log-sink-default-filter
lsdf_write 'filter = local.default_sink_required_exclusions'
sed '/externalaudit.googleapis.com\/access_transparency/d' \
  "${FX}/infra/modules/guardrails/main.tf" > "${FX}/infra/modules/guardrails/main.tf.new"
mv "${FX}/infra/modules/guardrails/main.tf.new" "${FX}/infra/modules/guardrails/main.tf"
fx_run check-log-sink-default-filter
expect_red '必須ログを除外していません'
t_end

t_begin 'check-log-sink-default-filter: 直書きの filter でも必須 6 件を満たせば緑（local 必須ではない）'
fx_guard check-log-sink-default-filter
lsdf_write 'filter = "NOT LOG_ID(\"cloudaudit.googleapis.com/activity\") AND NOT LOG_ID(\"externalaudit.googleapis.com/activity\") AND NOT LOG_ID(\"cloudaudit.googleapis.com/system_event\") AND NOT LOG_ID(\"externalaudit.googleapis.com/system_event\") AND NOT LOG_ID(\"cloudaudit.googleapis.com/access_transparency\") AND NOT LOG_ID(\"externalaudit.googleapis.com/access_transparency\")"'
fx_run check-log-sink-default-filter
expect_green
t_end

t_begin 'check-log-sink-default-filter: 参照先の local が無ければ赤（解決できないまま緑にしない）'
fx_guard check-log-sink-default-filter
lsdf_write 'filter = local.does_not_exist'
fx_run check-log-sink-default-filter
expect_red '定義を解決できません'
t_end

t_begin 'check-log-sink-default-filter: _Default の sink が 1 件も無ければ赤（空振り防止）'
fx_guard check-log-sink-default-filter
lsdf_write 'filter = local.default_sink_required_exclusions'
sed 's/name        = "_Default"/name        = "_Other"/' \
  "${FX}/infra/modules/guardrails/main.tf" > "${FX}/infra/modules/guardrails/main.tf.new"
mv "${FX}/infra/modules/guardrails/main.tf.new" "${FX}/infra/modules/guardrails/main.tf"
fx_run check-log-sink-default-filter
expect_red 'の sink 宣言が 1 件もありません'
t_end

t_begin 'check-log-sink-default-filter: sink の宣言自体が 0 件なら赤（走査の空振り防止）'
fx_guard check-log-sink-default-filter
mkdir -p "${FX}/infra/modules/guardrails"
fx_write infra/modules/guardrails/main.tf <<'EOF'
resource "google_logging_project_bucket_config" "audit" {
  project        = var.project_id
  bucket_id      = "fwlm-audit"
  retention_days = 30
}
EOF
fx_run check-log-sink-default-filter
expect_red '走査が空振りしています'
t_end

# **必須 ID の表が空になったら、検査は全件を素通りさせる。** 表を空にする改変で赤へ到達する
# ことまで assert しないと、空振りの分岐が生きているかどうかを誰も確かめていない状態になる。
t_begin 'check-log-sink-default-filter: 必須 ID の表が空になる改変で赤（自身の空振り検出）'
fx_guard_mutate check-log-sink-default-filter \
  -e "/^REQUIRED_LOG_IDS='cloudaudit/,/access_transparency'\$/c\\
REQUIRED_LOG_IDS=''"
lsdf_write 'filter = local.default_sink_required_exclusions'
fx_run check-log-sink-default-filter
expect_red '必須ログ ID の表が空です'
t_end
