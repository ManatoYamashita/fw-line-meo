# scripts/check-deploy-image-coverage.sh の自己テスト（Issue #90）。
#
# 本ガードは Issue #33（tf は成功・サービスも存在するのに中身が placeholder のまま）という
# 無音の障害を防ぐ。検証辺は 3 本（IMAGE_NAMES / deploy.yml の update / ts-ci の matrix）あり、
# どれか 1 本だけ切れても症状が出ないため、辺ごとに赤ケースを置く。

dic_fixture() {
  fx_guard check-deploy-image-coverage
  fx_write infra/envs/prod/main.tf <<'EOF'
module "run-services" {
  services = {
    "survey-web" = {
      image = "cloudrun/container/hello"
    }
  }
}
EOF
  fx_write scripts/push-images.sh <<'EOF'
#!/usr/bin/env bash
IMAGE_NAMES=(survey-web)
EOF
  fx_write .github/workflows/deploy.yml <<'EOF'
jobs:
  deploy:
    steps:
      - run: gcloud run services update survey-web --image "$IMAGE"
EOF
  fx_write .github/workflows/ts-ci.yml <<'EOF'
jobs:
  docker-build:
    strategy:
      matrix:
        image: [survey-web]
EOF
}

t_begin 'check-deploy-image-coverage: tf / push / deploy / matrix が揃っていれば緑'
dic_fixture
fx_run check-deploy-image-coverage
expect_green
expect_output_matches '1 サービス検証'
t_end

t_begin 'check-deploy-image-coverage: IMAGE_NAMES への追加漏れを検出する（#33 と同型）'
dic_fixture
fx_write scripts/push-images.sh <<'EOF'
#!/usr/bin/env bash
IMAGE_NAMES=(other-service)
EOF
fx_run check-deploy-image-coverage
expect_red 'IMAGE_NAMES にありません'
t_end

t_begin 'check-deploy-image-coverage: deploy.yml の services update 漏れを検出する'
dic_fixture
fx_write .github/workflows/deploy.yml <<'EOF'
jobs:
  deploy:
    steps:
      - run: echo "no update step"
EOF
fx_run check-deploy-image-coverage
expect_red 'gcloud run services update survey-web'
t_end

t_begin 'check-deploy-image-coverage: docker-build matrix からの漏れを検出する'
dic_fixture
fx_write .github/workflows/ts-ci.yml <<'EOF'
jobs:
  docker-build:
    strategy:
      matrix:
        image: [other-service]
EOF
fx_run check-deploy-image-coverage
expect_red 'docker-build matrix にありません'
t_end

# 空振り防止の分岐そのものが到達可能かを検証する。修正前は grep 無一致 → pipefail × set -e で
# **出力ゼロのまま exit 1** になり、「1件も抽出できませんでした」が一度も出なかった。
# exit code だけを見るアサーションではこの欠陥を見逃す（赤ではあるため）。原因文字列まで
# 照合してはじめて検出できる。
t_begin 'check-deploy-image-coverage: tf からサービスを拾えないとき原因を告げて赤になる（空振り防止）'
dic_fixture
fx_write infra/envs/prod/main.tf <<'EOF'
module "run-services" {
  services = {}
}
EOF
fx_run check-deploy-image-coverage
expect_red '1件も抽出できませんでした'
t_end
