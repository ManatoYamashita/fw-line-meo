# scripts/check-deploy-image-coverage.sh の自己テスト（Issue #90）。
#
# 本ガードは Issue #33（tf は成功・サービスも存在するのに中身が placeholder のまま）という
# 無音の障害を防ぐ。検証辺は 4 本（IMAGE_NAMES / deploy.yml の services update / ts-ci の matrix /
# deploy.yml の jobs update）あり、どれか 1 本だけ切れても症状が出ないため、辺ごとに赤ケースを置く。
#
# Issue #91 でジョブ側（`gcloud run jobs update`）の検証と `--print-targets` が加わった。
# **ジョブは tf の run-services には現れない**（batch-job / delivery-job の別モジュール定義で、
# job 名はモジュール variables.tf の default にしか無い）。そのため対象集合は
# `IMAGE_NAMES − run-services` の差集合として導出する。合成ツリーもこの構造を再現する
# （tf にはサービスだけ・IMAGE_NAMES にはサービス＋ジョブ）。

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
  # daily-batch は tf の run-services に無い = ジョブとして導出される。
  fx_write scripts/push-images.sh <<'EOF'
#!/usr/bin/env bash
IMAGE_NAMES=(survey-web daily-batch)
EOF
  fx_write .github/workflows/deploy.yml <<'EOF'
jobs:
  deploy:
    steps:
      - run: gcloud run jobs update daily-batch --image "$IMAGE"
      - run: gcloud run services update survey-web --image "$IMAGE"
EOF
  fx_write .github/workflows/ts-ci.yml <<'EOF'
jobs:
  docker-build:
    strategy:
      matrix:
        image: [survey-web, daily-batch]
EOF
}

t_begin 'check-deploy-image-coverage: tf / push / deploy / matrix が揃っていれば緑'
dic_fixture
fx_run check-deploy-image-coverage
expect_green
expect_output_matches '1 サービス・1 ジョブ検証'
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

# --- Issue #91: ジョブ側の辺と、対象集合の供給 -------------------------------

# 検証2（services update）はサービスしか見ておらず、ジョブ 2 種は**無検証**だった。
# deploy.yml から jobs update を落としても緑のままになる穴が実際に開いていた。
t_begin 'check-deploy-image-coverage: deploy.yml の jobs update 漏れを検出する（#91 で塞いだ穴）'
dic_fixture
fx_write .github/workflows/deploy.yml <<'EOF'
jobs:
  deploy:
    steps:
      - run: gcloud run services update survey-web --image "$IMAGE"
EOF
fx_run check-deploy-image-coverage
expect_red 'gcloud run jobs update daily-batch'
t_end

# 対象集合の導出そのものが空振りしていないか。IMAGE_NAMES からジョブが消えると差集合が空になり、
# ジョブ側の検証が「対象 0 件で緑」になる（これも #33 と同型の無音化）。
t_begin 'check-deploy-image-coverage: ジョブを 1 件も導出できないとき緑を返さない（空振り防止）'
dic_fixture
fx_write scripts/push-images.sh <<'EOF'
#!/usr/bin/env bash
IMAGE_NAMES=(survey-web)
EOF
fx_write .github/workflows/ts-ci.yml <<'EOF'
jobs:
  docker-build:
    strategy:
      matrix:
        image: [survey-web]
EOF
fx_run check-deploy-image-coverage
expect_red 'ジョブを1件も導出できませんでした'
t_end

# --print-targets はドリフト検証（check-prod-image-drift.sh）へ対象集合を供給する唯一の口。
# stdout は機械可読な TSV 専用で、人間向けの OK 行は stderr へ退避する。
t_begin 'check-deploy-image-coverage: --print-targets が service / job を分類して TSV を出す'
dic_fixture
fx_run_args check-deploy-image-coverage --print-targets
expect_green
fx_run_stdout check-deploy-image-coverage --print-targets
expect_output_matches '^service	survey-web$'
expect_output_matches '^job	daily-batch$'
expect_absent 'OK:'
t_end

# 壊れた正典から導出した対象集合で下流を緑にするのが最悪の空振りであるため、
# 検証が赤なら stdout へ 1 行も出さずに落ちること。
t_begin 'check-deploy-image-coverage: 検証が赤のとき --print-targets は 1 行も出さない'
dic_fixture
fx_write .github/workflows/deploy.yml <<'EOF'
jobs:
  deploy:
    steps:
      - run: echo "no update step"
EOF
fx_run_args check-deploy-image-coverage --print-targets
expect_red 'gcloud run services update survey-web'
fx_run_stdout check-deploy-image-coverage --print-targets
expect_output_empty
t_end
