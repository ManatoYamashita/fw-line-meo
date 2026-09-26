# 客向けアンケート Web（survey-web）の独自ドメイン（Issue #338）
#
# QR を読んだ来店客のアドレスバーに run.app ではなく review.firstweb-works.com を出す。
# QR の中身は {SURVEY_BASE_URL}/s/{storeId} で、印刷した QR の URL は後から変えられないため、
# QR を大量に配る前にこのドメインへ切り替える。
#
# custom-domain.tf のドメインマッピングを使わない理由: ドメインマッピングは Preview で、公式は
# 遅延の問題を理由に本番向けではないとする。api. と dashboard. は人の操作が 1 回通るだけなので
# 許容したが、survey-web は来店客が下書きの生成を待つ画面で、応答時間が効く（infra/README.md §9-2-b）。
# そこで公式推奨の外部 HTTPS ロードバランサ + サーバーレス NEG を使う。
#
# 費用: 転送ルールは 5 本まで $0.025/時（HTTPS と HTTP→HTTPS 転送の 2 本で同額）。
#
# run.app は閉じない（ingress は INGRESS_TRAFFIC_ALL のまま）。切り替え前に発行した QR が
# run.app を指しているため、ここを絞ると発行済みの QR が開けなくなる。
#
# X-Forwarded-For の形がロードバランサ経由と run.app 直とで変わる。流量制限の鍵を読む位置は
# 実測してから決める（Issue #338・#344）。
#
# 前提: DNS は Cloudflare で `review` の A レコードを下の survey_web_lb_ip へ向ける。証明書の
# 発行が終わるまでプロキシは OFF にする（ON だと Google が証明書を発行できない）。手順は
# infra/README.md §9-2-d。

locals {
  survey_web_domain = "review.firstweb-works.com"
}

resource "google_compute_global_address" "survey_web" {
  name = "survey-web-lb"

  depends_on = [module.project_services]
}

resource "google_compute_region_network_endpoint_group" "survey_web" {
  name                  = "survey-web-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = module.run_services.service_names["survey-web"]
  }

  depends_on = [module.project_services]
}

resource "google_compute_backend_service" "survey_web" {
  name                  = "survey-web-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"

  backend {
    group = google_compute_region_network_endpoint_group.survey_web.id
  }

  # 要求のログは Cloud Run 側が既に持つ。ロードバランサ側でも取ると来店客の IP を二重に残すので取らない。
  log_config {
    enable = false
  }
}

resource "google_compute_managed_ssl_certificate" "survey_web" {
  name = "survey-web-cert"

  managed {
    domains = [local.survey_web_domain]
  }

  depends_on = [module.project_services]
}

# ロードバランサの既定は TLS 1.0 から受け付ける。1.2 未満を拒む。
resource "google_compute_ssl_policy" "survey_web" {
  name            = "survey-web-tls"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"

  depends_on = [module.project_services]
}

# ホスト名で振り分ける（Issue #368）。どのホストにも当たらない要求（IP 直打ち・run.app の Host を
# 付けた要求など）は、これまでどおり survey-web へ送る。
resource "google_compute_url_map" "survey_web" {
  name            = "survey-web-https"
  default_service = google_compute_backend_service.survey_web.id

  dynamic "host_rule" {
    for_each = local.lb_extra_hosts
    content {
      hosts        = [host_rule.value]
      path_matcher = host_rule.key
    }
  }

  dynamic "path_matcher" {
    for_each = local.lb_extra_hosts
    content {
      name            = path_matcher.key
      default_service = google_compute_backend_service.extra[path_matcher.key].id
    }
  }
}

resource "google_compute_target_https_proxy" "survey_web" {
  name             = "survey-web-https"
  url_map          = google_compute_url_map.survey_web.id
  ssl_certificates = [google_compute_managed_ssl_certificate.survey_web.id]
  ssl_policy       = google_compute_ssl_policy.survey_web.id
}

resource "google_compute_global_forwarding_rule" "survey_web_https" {
  name                  = "survey-web-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.survey_web.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.survey_web.id
}

# http:// で打ち込まれた場合に https:// へ送る。
resource "google_compute_url_map" "survey_web_redirect" {
  name = "survey-web-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "survey_web_redirect" {
  name    = "survey-web-http-redirect"
  url_map = google_compute_url_map.survey_web_redirect.id
}

resource "google_compute_global_forwarding_rule" "survey_web_http" {
  name                  = "survey-web-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.survey_web.id
  port_range            = "80"
  target                = google_compute_target_http_proxy.survey_web_redirect.id
}

# ---------------------------------------------------------------------------------------------
# api. と dashboard. の載せ替え（Issue #368）
#
# Cloud Run のドメインマッピング（custom-domain.tf）は Preview で、公式は遅延の問題を理由に本番向け
# ではないとする。ロードバランサは上で既に持っていて、転送ルールは 5 本まで同額なので、載せ替えても
# 費用は増えない。キーは run-services のサービスキーで、値はそのサービスへ割り当てるホスト名。
#
# 証明書は Certificate Manager の DNS 認証で発行する。上の google_compute_managed_ssl_certificate は
# DNS がロードバランサを向いてからしか発行されないので、そのまま DNS を切り替えると、証明書が
# できるまで TLS で繋がらない時間が生まれる。DNS 認証なら、DNS を向ける前に発行できる。
# review. もこの方式へ揃える（HTTPS プロキシは証明書の一覧と証明書マップのどちらか一方しか持てない）。
#
# この段では足すだけで、HTTPS プロキシはまだ上の証明書を使う。切り替えの順は infra/README.md §9-2-e。
# ---------------------------------------------------------------------------------------------

locals {
  lb_extra_hosts = {
    "line-webhook"  = "api.firstweb-works.com"
    "dashboard-web" = "dashboard.firstweb-works.com"
  }
  # 証明書マップに載せるホスト名の全部。キーは Certificate Manager のリソース名に使う。
  lb_cert_hosts = {
    "review"    = local.survey_web_domain
    "api"       = "api.firstweb-works.com"
    "dashboard" = "dashboard.firstweb-works.com"
  }
}

resource "google_compute_region_network_endpoint_group" "extra" {
  for_each = local.lb_extra_hosts

  name                  = "${each.key}-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = module.run_services.service_names[each.key]
  }

  depends_on = [module.project_services]
}

resource "google_compute_backend_service" "extra" {
  for_each = local.lb_extra_hosts

  name                  = "${each.key}-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"

  backend {
    group = google_compute_region_network_endpoint_group.extra[each.key].id
  }

  # survey-web と同じく、要求のログは Cloud Run 側に任せる。
  log_config {
    enable = false
  }
}

resource "google_certificate_manager_dns_authorization" "lb" {
  for_each = local.lb_cert_hosts

  name   = "${each.key}-dns-auth"
  domain = each.value

  depends_on = [module.project_services]
}

resource "google_certificate_manager_certificate" "lb" {
  for_each = local.lb_cert_hosts

  name = "${each.key}-cert"

  managed {
    domains            = [each.value]
    dns_authorizations = [google_certificate_manager_dns_authorization.lb[each.key].id]
  }
}

resource "google_certificate_manager_certificate_map" "lb" {
  name = "firstweb-works-lb"

  depends_on = [module.project_services]
}

resource "google_certificate_manager_certificate_map_entry" "lb" {
  for_each = local.lb_cert_hosts

  name         = "${each.key}-entry"
  map          = google_certificate_manager_certificate_map.lb.name
  hostname     = each.value
  certificates = [google_certificate_manager_certificate.lb[each.key].id]
}
