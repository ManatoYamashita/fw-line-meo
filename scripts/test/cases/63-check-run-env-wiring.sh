# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
#
# check-run-env-wiring（Issue #500）のケース。
#
# 合成ツリーは、実リポジトリの配線と出典をそのまま複製して作る（Terraform の 3 ファイル・照合する
# 3 対象のソース・共通の env を読む共有パッケージ）。手で書いた小さな fixture にすると、実物の
# 書き方（merge の条件つきの枝・required ヘルパ・MissingConfigError）からずれた日に、ガードが
# 実物を読めなくなっても自己テストは緑のまま残る。デプロイ対象の正典だけは、合成ツリーで
# check-deploy-image-coverage.sh を再現するのが重いので、RUN_ENV_WIRING_TARGETS_SNAPSHOT で注入する。
#
# 赤のケースはすべて「1 か所だけ壊す」形で、変異が当たったことを先に確かめる
# （空振りした変異は無改変のツリーを検査し、緑を「検出できなかった」と読み違える）。

rew_tree() {
  fx_guard check-run-env-wiring
  for f in infra/envs/prod/main.tf infra/modules/run-services/main.tf infra/modules/delivery-job/main.tf; do
    fx_copy "$f"
  done
  for d in ts/apps/line-webhook/src ts/apps/dashboard-api/src ts/apps/delivery-job/src \
    ts/packages/db/src ts/packages/observability/src; do
    mkdir -p "${FX}/$(dirname "$d")"
    cp -R "${ROOT}/${d}" "${FX}/${d}"
  done
  rew_targets <<'EOF'
service	dashboard-api
service	dashboard-web
service	line-webhook
service	store-detail
service	survey-web
job	daily-batch
job	summary-delivery
EOF
}

rew_targets() {
  # 標準入力の TSV をデプロイ対象の正典として注入する。
  cat > "${FX}/targets.tsv"
}

rew_mutate() {
  # 合成ツリーのファイル（$1）へ perl の置換（$2）を当て、当たったことを確かめる。
  rew_file="${FX}/$1"
  cp "$rew_file" "${rew_file}.orig"
  perl -0pi -e "$2" "$rew_file"
  assert_count=$((assert_count + 1))
  if cmp -s "${rew_file}.orig" "$rew_file"; then
    _t_fail "変異が当たりませんでした（${1}: ${2}）。無改変のツリーを検査するところでした。"
  fi
  rm -f "${rew_file}.orig"
}

rew_run() {
  RUN_ENV_WIRING_TARGETS_SNAPSHOT="${FX}/targets.tsv" fx_run check-run-env-wiring
}

# ---------------------------------------------------------------------------
# 1. 緑（実物の配線と出典がそのまま一致する）

t_begin 'check-run-env-wiring: 実物の配線と出典が一致していれば緑（照合 3 件）'
rew_tree
rew_run
expect_green
expect_output_matches 'デプロイ対象 7 件・照合 3 件・必須 env [1-9][0-9]* 件・配線 [1-9][0-9]* 件'
t_end

# ---------------------------------------------------------------------------
# 2. 方向 1（実装 → tf）: 起票理由そのもの。必須にした env の配線を忘れる

t_begin 'check-run-env-wiring: dashboard-api の LINE_CHANNEL_ID の配線を消すと赤（#487 の形）'
rew_tree
rew_mutate infra/envs/prod/main.tf 's/\n        LINE_CHANNEL_ID      = var.line_channel_id//'
rew_run
expect_red 'service dashboard-api: ts/apps/dashboard-api/src/config.ts は LINE_CHANNEL_ID を必須にしていますが、Terraform が配線していません'
t_end

t_begin 'check-run-env-wiring: line-webhook の loadConfig に必須 env を足し、配線しないと赤（required ヘルパの形）'
rew_tree
rew_mutate ts/apps/line-webhook/src/config.ts "s/(liffStoreDetailUrl: required\\(env, 'LIFF_STORE_DETAIL_URL'\\),)/\$1\\n    extra: required(env, 'REW_NEW_ENV'),/"
rew_run
expect_red 'service line-webhook: ts/apps/line-webhook/src/config.ts は REW_NEW_ENV を必須にしていますが'
t_end

t_begin 'check-run-env-wiring: delivery-job に必須 env を足し、ジョブのモジュールへ配線しないと赤（MissingConfigError の形）'
rew_tree
rew_mutate ts/apps/delivery-job/src/index.ts "s/(  if \\(!completedRichMenuId\\) \\{)/  if (!env.REW_JOB_ENV) {\\n    throw new MissingConfigError('REW_JOB_ENV');\\n  }\\n\$1/"
rew_run
expect_red 'job summary-delivery: ts/apps/delivery-job/src/index.ts は REW_JOB_ENV を必須にしていますが'
t_end

# ---------------------------------------------------------------------------
# 3. 方向 2（tf → 実装）: 配線名の打ち間違いは両方向で赤になる

t_begin 'check-run-env-wiring: 配線名を打ち間違えると、配線の側も取り残しとして赤'
rew_tree
rew_mutate infra/envs/prod/main.tf 's/LIFF_STORE_DETAIL_URL = var.liff_url/LIFF_STORE_DETAIL_URI = var.liff_url/'
rew_run
expect_red 'service line-webhook: Terraform が LIFF_STORE_DETAIL_URI を配線していますが、ts/apps/line-webhook/src のどこにも現れません'
expect_red 'ts/apps/line-webhook/src/config.ts は LIFF_STORE_DETAIL_URL を必須にしていますが'
t_end

# ---------------------------------------------------------------------------
# 4. デプロイ対象の正典と TARGETS 表の両方向照合

t_begin 'check-run-env-wiring: 正典に新しいサービスが増え、TARGETS 表に無いと赤'
rew_tree
printf 'service\trew-new-service\n' >> "${FX}/targets.tsv"
rew_run
expect_red 'デプロイ対象 service rew-new-service が TARGETS 表にありません'
t_end

t_begin 'check-run-env-wiring: TARGETS 表の行が正典から消えると赤（撤去の取り残し）'
rew_tree
grep -v 'daily-batch' "${FX}/targets.tsv" > "${FX}/targets.tmp"
mv "${FX}/targets.tmp" "${FX}/targets.tsv"
rew_run
expect_red 'TARGETS 表の job daily-batch がデプロイ対象の正典にありません'
t_end

# ---------------------------------------------------------------------------
# 5. 空振り防止

t_begin 'check-run-env-wiring: 正典が 0 件なら赤'
rew_tree
: > "${FX}/targets.tsv"
rew_run
expect_red 'デプロイ対象の正典が 0 件です'
t_end

t_begin 'check-run-env-wiring: 出典から必須 env を 1 件も抜き出せなければ赤（自己申告の形が変わった）'
rew_tree
rew_mutate ts/apps/dashboard-api/src/config.ts "s/ is required'\\)/ is missing')/g"
rew_run
expect_red 'service dashboard-api の出典 ts/apps/dashboard-api/src/config.ts から必須の env を 1 件も抜き出せません'
t_end

t_begin 'check-run-env-wiring: サービスのブロックが見つからなければ赤（読み取りの空振り）'
rew_tree
rew_mutate infra/envs/prod/main.tf 's/"dashboard-api" = \{/"dashboard-api-renamed" = {/'
rew_run
expect_red 'module "run_services" にサービス "dashboard-api" のブロックが見つかりません'
t_end

t_begin 'check-run-env-wiring: 共通の env を読む共有パッケージが消えたら赤'
rew_tree
rm -rf "${FX}/ts/packages/observability/src"
mkdir -p "${FX}/ts/packages/observability/src"
rew_run
expect_red '共通の env GOOGLE_CLOUD_PROJECT を読む共有パッケージ'
t_end
