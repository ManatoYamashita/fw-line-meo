# 独自ドメインの割り当て（Issue #282・#146 関門 B）
#
# GBP 連携の OAuth コールバックを run.app から独自ドメインへ移すための割り当て。
# OAuth ブランド検証は、Web アプリケーション型クライアントのリダイレクト URI のドメインを
# 承認済みドメインに含め、Search Console で所有権を確認することを求める。run.app は
# Google が管理する public suffix で所有権を確認できないため、独自ドメインが要る。
#
# Cloud Run のドメインマッピングは Preview（公式は遅延の問題を理由に本番向けではないとする）。
# ここを通るのはオーナー 1 人につき 1 回の OAuth コールバックだけなので遅延は問題にならず、
# 常時費用のかかるロードバランサではなくこちらを選んだ（Issue #282 の判断）。
# LINE の Webhook URL は OAuth と無関係なので run.app のまま変えない。
#
# 前提: apply するアカウントが Search Console で firstweb-works.com の所有者として
# 確認済みであること（ドメインマッピングは確認したアカウントにしか作れない）。
# DNS は Cloudflare で `api` の CNAME を ghs.googlehosted.com へ向ける（プロキシは OFF。
# ON だと Google が証明書を発行できない）。手順は infra/README.md §9-2-b。

resource "google_cloud_run_domain_mapping" "gbp_oauth_callback" {
  location = var.region
  name     = "api.firstweb-works.com"

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = module.run_services.service_names["line-webhook"]
  }
}

# ダッシュボード（Issue #146）。同意画面はダッシュボードの Google ログインと GBP 連携で共有され、
# ブランド検証は承認済みドメインのすべてについて所有権の確認を求める。run.app と firebaseapp.com は
# どちらも確認できないため、ダッシュボードも独自ドメインへ移す。Firebase Auth の authDomain も
# このドメインにし、/__/auth/ は dashboard-web が firebaseapp.com へ中継する（next.config.ts）。
# 通るのは人の操作だけなので、Preview の遅延は実害にならない（上の判断と同じ）。
resource "google_cloud_run_domain_mapping" "dashboard" {
  location = var.region
  name     = "dashboard.firstweb-works.com"

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = module.run_services.service_names["dashboard-web"]
  }
}
