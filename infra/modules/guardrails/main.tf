# コストガードレール・失敗検知（gcp-infra-foundation / Req 2.5,7.1,7.2,7.3）
#
# 通知系（channel + alert policy）と課金系（budget + quota）を集約。
# 失敗アラートポリシーはここが所有する（run-services/batch-job → guardrails の一方向）。
#
# ジョブ名で対象を絞らない（Issue #151）。以前は job_name 変数で daily-batch だけを
# 見ていたため、後から追加された summary-delivery の失敗を見る監視が 1 つも無く、
# 60 execution 以上（毎時 2 回 × 600 秒のタイムアウト）が誰にも通知されないまま続いた。
# ジョブを足すたびに配線を思い出す設計は、思い出さなかったときに無音になる。
# 述語そのものを持たなければ、その忘れ方は起き得ない。

# 通知チャネル（budget 通知とバッチ失敗アラートで共用）
resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "fw-line-meo ops email"
  type         = "email"

  labels = {
    email_address = var.alert_email
  }
}

# 月次予算アラート（Req 7.1）。billing account レベル権限が必要（runbook）。
resource "google_billing_budget" "monthly" {
  billing_account = var.billing_account_id
  display_name    = "fwlm monthly budget"

  budget_filter {
    projects = ["projects/${var.project_number}"]
  }

  amount {
    specified_amount {
      currency_code = "JPY"
      units         = tostring(var.budget_amount_jpy)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }

  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.email.id]
    disable_default_iam_recipients   = false
  }
}

# Cloud Run Job 失敗アラート（Req 2.5 後半・検知）。プロジェクト内の全 Job の実行失敗を監視。
resource "google_monitoring_alert_policy" "job_failure" {
  project      = var.project_id
  display_name = "cloud run job failure"
  combiner     = "OR"

  conditions {
    display_name = "failed job executions"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_job\" AND metric.type = \"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result = \"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_COUNT"
      }
    }
  }

  # 既定の自動クローズは 7 日で、復旧を短時間で観測できない（直したのに閉じないので、
  # 開いているインシデントが「今も壊れている」ことを意味しなくなる）。
  # daily-batch は日次・summary-delivery は毎時なので、1 時間なら失敗が続く間は
  # インシデントが 1 本に畳まれ、直ってから 1 時間強で閉じる。
  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

# Places API クォータ上限（Req 7.2）。バッチが使う日次エンドポイントを quota_id 単位で
# 上限設定（空マップなら作らない）。既定からの減量で安全チェックに掛かる場合に備え
# ignore_safety_checks を付与。
resource "google_cloud_quotas_quota_preference" "places" {
  for_each = var.places_quota_caps

  parent   = "projects/${var.project_id}"
  name     = each.key
  service  = "places.googleapis.com"
  quota_id = each.key

  quota_config {
    preferred_value = each.value
  }

  ignore_safety_checks = "QUOTA_DECREASE_PERCENTAGE_TOO_HIGH"
}

# ------------------------------------------------------------------------------
# アンケートのファネル指標（review-acquisition / Issue #137 段階3・Req 5.7）
#
# 表示件数（survey_page_viewed）は DB のどの表にも存在しない。survey_material_tallies が
# 数えるのは **送信された回答** だけで、「開いたが送らなかった」は原理的に出せないため、
# 唯一の記録がアプリの構造化ログになる。ところが Cloud Run の stdout は _Default バケットへ
# 入り、既定の保持は 30 日である（本番実測: buckets list → _Default 30 日・_Required 400 日は
# 監査ログ専用。ログベース指標もシンクも未設定）。段階4（導線変更）の判断は「施策前後の比較」
# なので、施策前の窓が消えた時点で本 spec の計測基盤そのものが目的を果たさなくなる。
#
# ログベース指標へ写すと時系列は 24 か月残る（6 週までは 1 分粒度、以降は 10 分粒度へ集約）。
# _Default バケットの保持延長を採らないのは、survey 以外の全ログまで課金対象になるため。
#
# **本指標は event 名だけで絞る。** 記録の粒度としてそれで足りるためであり、以前ここに
# 書かれていた「severity では絞れない」という理由は **Issue #228 のデプロイをもって解消する**。
# ソース側は是正済みだが、**本番が新しいイメージで動き始めるまでは旧挙動のままである**。
# 解消前に新しい指標へ severity 条件を足すと、下記の「静かな 0」をそのまま踏む。
#
# 解消前は、アプリが `level` フィールドを出しており Cloud Run がこれを LogEntry.severity へ
# 写さないため、`severity = "INFO"` を条件に足すと 1 件も一致しなかった（本番実測:
# {"event":"generation_failed","level":"error"} の severity は null）。現在は全実行面が
# `severity` を集約基盤の綴りで出すため、重大度による絞り込みは**可能**である
# （正典 docs/observability/log-field-canon.md）。新しい指標を作る際はこの前提で設計してよい。
#
# **指標は作成時点から数え始める。** 段階4 の直前に作ってもベースラインは取れないので、
# 本 spec のデプロイと同じタイミングで apply すること。
# ------------------------------------------------------------------------------
resource "google_logging_metric" "survey_funnel" {
  # monitoring-coverage: analytics-only (#137)
  # この 2 指標はアラートを持たない。段階4（導線変更）の効果を施策前後で比較するための計測で
  # あり、閾値を割ったら人を起こす類のものではないため。scripts/check-monitoring-coverage.sh は
  # この宣言が無い指標に「読むアラートが無い」と赤を出す（指標だけが生き残る #230 の鏡像を
  # 防ぐため）。**通知が要るのに面倒だからここへ逃がしてはならない。**
  for_each = toset(["survey_page_viewed", "survey_response_submitted"])

  project     = var.project_id
  name        = each.key
  description = "review-acquisition のファネル（Issue #137 段階3・Req 5.7）: ${each.key} を店舗単位で数える。"
  filter      = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.survey_service_name}\" AND jsonPayload.event = \"${each.key}\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"

    # 店舗単位で読めることが Req 5.7 の要求。**来店客に紐づく値は載せない**（storeId は
    # 事業者側の識別子であって来店客の識別子ではない）。ログ側の sink が storeId 以外を
    # 出さない allowlist なので、ここで抽出しうる値も構造的に storeId に限られる。
    labels {
      key         = "store_id"
      value_type  = "STRING"
      description = "店舗 ID（jsonPayload.storeId）。"
    }
  }

  label_extractors = {
    store_id = "EXTRACT(jsonPayload.storeId)"
  }
}

# ------------------------------------------------------------------------------
# Cloud Run サービスの監視（Issue #230 / #227 の子）
#
# **このブロックは一度失われている。** 2026-09-06 に apply され本番で稼働していたが、
# 対応する .tf が commit されないまま作業ツリーから消えた（2026-09-09 実測: 本番に
# alert policy 4 本と logging metric 1 本が存在し、state serial 38 もそれを保持するのに、
# origin/main にも 49 本のリモートブランチのいずれにも対応するコードが無かった）。
# state にあって config に無いリソースは destroy 対象なので、**次の apply が監視を
# 消すところだった**。監視を入れた変更が監視の穴を作るのは #151 と同じ本末転倒である。
#
# 復元にあたってはリソースアドレスを state と厳密に一致させた（moved は不要）。
# destroy→create にすると、その隙間に起きた障害が誰にも通知されない。
#
# 同じ消え方が二度起きないよう、機械強制を 2 層で置いた:
#   - scripts/check-monitoring-coverage.sh（ts-ci・静的）
#   - .github/workflows/monitoring-drift.yml（6 時間ごと・本番と宣言の両方向照合）
# 後者だけが「コードが消えても本番は生きている」を検出できる。
# ------------------------------------------------------------------------------

# 5xx 率（Req 7.3・検知）。**サービス名を列挙しない。**
#
# job_failure（上）と同じ思想である。述語にサービス名を持つと、サービスを足すたびに
# ここへ足すことを思い出す必要が生まれ、思い出さなかったときに無音になる。
# resource.type だけで絞れば、その忘れ方は構造的に起き得ない。
# 現在の対象は 5 サービス（dashboard-api / dashboard-web / line-webhook / store-detail /
# survey-web）だが、この式は 6 本目が生えた翌日から自動的にそれも見る。
#
# 比率で見るのは、絶対数だと低トラフィックのサービス（dashboard-web 等）が常に静かで、
# 高トラフィックのサービスだけが鳴る非対称が生まれるためである。分母は同じ
# request_count（response_code_class で絞らない全リクエスト）を同じ集約で取る。
resource "google_monitoring_alert_policy" "service_5xx_rate" {
  project      = var.project_id
  display_name = "cloud run service 5xx rate"
  combiner     = "OR"

  conditions {
    display_name = "5xx rate above threshold"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.05
      duration        = "300s"

      # 系列が無い間（ゼロスケールで 1 件もリクエストが無い等）を「異常」と読まない。
      # 既定は欠測を評価対象にするため、静まり返っているサービスが鳴り続ける。
      evaluation_missing_data = "EVALUATION_MISSING_DATA_INACTIVE"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }

      denominator_filter = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_count\""

      denominator_aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

# 客向け面のリクエスト遅延（Issue #230）。
#
# 5xx が全サービスを覆うのに対し、こちらは意図的に絞る。遅延が「離脱」という形で
# 直接損失になるのは客の目の前で動く面だけで、代理店ダッシュボードが 2 秒遅いことと
# アンケートページが 2 秒遅いことは事業上まったく別の意味を持つ。全面へ同じ SLO を
# 敷くと、鳴っても誰も動かないアラートが増えて全体が信用されなくなる。
#
# **列挙してよいのはこの理由があるからで、忘れても無音にならないことは 5xx が担保する。**
# check-monitoring-coverage.sh が見るのは片方向だけである（ここに書いた名前がデプロイ正典に
# 実在すること。綴り違いと撤去済みサービスは赤くなる）。**逆方向は見ていない。** 客向けの面を
# 足してここへ足し忘れても CI は緑のままで、原理的にもガードには「どのサービスが客向けか」が
# 分からない。足し忘れの帰結は「その面の遅延だけが無監視になる」ことであり、5xx は
# サービス名を持たない述語で覆い続ける。
resource "google_monitoring_alert_policy" "customer_latency" {
  for_each = toset(var.latency_watched_services)

  project      = var.project_id
  display_name = "cloud run ${each.key} p95 latency"
  combiner     = "OR"

  conditions {
    display_name = "p95 request latency above threshold"

    condition_threshold {
      filter                  = "resource.type = \"cloud_run_revision\" AND metric.type = \"run.googleapis.com/request_latencies\" AND resource.labels.service_name = \"${each.key}\""
      comparison              = "COMPARISON_GT"
      threshold_value         = 2000
      duration                = "300s"
      evaluation_missing_data = "EVALUATION_MISSING_DATA_INACTIVE"

      # p95 を系列ごとに取り、リビジョン間は最大で畳む（新旧リビジョンが並走する
      # デプロイ中に、遅い方が平均で薄まって見えなくなるのを避ける）。
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MAX"
      }
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}

# Webhook 署名検証の失敗件数（Issue #230）。
#
# 急増は「攻撃」か「LINE 側の設定事故（チャネルシークレットの取り違え・再発行）」の
# いずれかで、後者はオンボーディングが全件無言で 401 になるため、どちらも即座に知る
# 必要がある。line-webhook は 401 を返すだけなので Cloud Run の 5xx 率には現れない。
#
# **severity では絞らないこと。** アプリは `level` フィールドを出しており、Cloud Run は
# これを LogEntry.severity へ写さない（survey_funnel と同じ本番実測）。severity を条件に
# 足すと 1 件も一致せず「指標は存在するのに常に 0」という静かな失敗になる。
#
# **この指標は実際に一度その状態になっている。** 2026-09-06 に実験イメージで実測した後、
# アプリ側の出力コードが失われ、以後 main のイメージ（何もログしない）が稼働していた。
# ゆえに「event 名がアプリから実際に出力されているか」を check-monitoring-coverage.sh が
# 静的に両方向照合する。指標の側だけが生きている状態を CI が緑にしてはならない。
resource "google_logging_metric" "webhook_signature_failures" {
  project     = var.project_id
  name        = "webhook_signature_failures"
  description = "line-webhook の署名検証失敗件数（Issue #230）。"
  filter      = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.webhook_service_name}\" AND jsonPayload.event = \"webhook_signature_verification_failed\""

  # ラベルを持たない。署名検証は本文を一切処理する前に落ちる境界であり、この時点で
  # 手元にある値（raw body・署名ヘッダ・送信元）はすべて **載せてはいけない側** である
  # （#227「越えてはならない線」）。件数だけで用は足りる。
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "webhook_signature_failure" {
  project      = var.project_id
  display_name = "line-webhook signature verification failures"
  combiner     = "OR"

  conditions {
    display_name = "signature failures above threshold"

    condition_threshold {
      filter          = "metric.type = \"logging.googleapis.com/user/${google_logging_metric.webhook_signature_failures.name}\" AND resource.type = \"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"

      # ここは evaluation_missing_data を設定しない。ログベース指標は「失敗が無い間は
      # 系列そのものが存在しない」が正常状態であり、欠測の扱いを明示すると
      # 「無い＝評価できる」側へ倒れて意味が変わる。
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [google_monitoring_notification_channel.email.id]
}
