# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
#
# scripts/deploy-rollback-guard.sh の自己テスト（Issue #512）。
#
# 合成ツリーを、A → B → C の 1 本の幹と、A から分かれた枝 D を持つ git リポジトリにする。本番の実測は
# DEPLOY_ROLLBACK_RUNNING で注入する（gcloud を呼ばない）。判定の主眼は 2 つある。
#   1. 本番が候補より新しいコミットを指していれば止める（2026-11-03 の巻き戻りそのもの）
#   2. 同じコミットの出し直し・古いコミットからの更新・別の枝への切り替えは止めない
#      （止めすぎると、正当なデプロイが黙って出なくなる。止める側だけを試すと、この劣化を見逃す）

drg_tree() {
  fx_guard deploy-rollback-guard
  (
    cd "$FX" &&
      git init -q &&
      git -c user.email=selftest@example.com -c user.name=selftest commit -q --allow-empty -m A &&
      git -c user.email=selftest@example.com -c user.name=selftest commit -q --allow-empty -m B &&
      git -c user.email=selftest@example.com -c user.name=selftest commit -q --allow-empty -m C &&
      git checkout -q -b side HEAD~2 &&
      git -c user.email=selftest@example.com -c user.name=selftest commit -q --allow-empty -m D &&
      git checkout -q -
  ) >/dev/null 2>&1
  DRG_A="$(cd "$FX" && git rev-parse --short HEAD~2)"
  DRG_B="$(cd "$FX" && git rev-parse --short HEAD~1)"
  DRG_C="$(cd "$FX" && git rev-parse --short HEAD)"
  DRG_D="$(cd "$FX" && git rev-parse --short side)"
  assert_count=$((assert_count + 1))
  if [ -z "$DRG_A" ] || [ -z "$DRG_D" ] || [ "$DRG_A" = "$DRG_C" ]; then
    _t_fail "合成ツリーの履歴を作れませんでした（A=${DRG_A} C=${DRG_C} D=${DRG_D}）。"
  fi
}

drg_running() {
  # 標準入力の `<kind>\t<name>\t<image>` を本番の実測として置く。
  cat > "${FX}/running.tsv"
}

drg_run() { # $1 = 候補のコミット
  : > "${FX}/github-output"
  OUT=''
  RC=0
  OUT="$(cd "$FX" && DEPLOY_ROLLBACK_RUNNING="${FX}/running.tsv" GITHUB_OUTPUT="${FX}/github-output" \
    bash scripts/deploy-rollback-guard.sh --candidate "$1" 2>&1)" || RC=$?
}

drg_expect_output_file() { # $1 = 期待する rollback= の値
  assert_count=$((assert_count + 1))
  if [ "$(grep -cx "rollback=$1" "${FX}/github-output")" -ne 1 ]; then
    _t_fail "GITHUB_OUTPUT に rollback=$1 が 1 行ありません（中身: $(tr '\n' ' ' < "${FX}/github-output")）。"
  fi
}

drg_expect_exit0() {
  # 止める判定も exit 0 で返す（後続のステップは GITHUB_OUTPUT で分岐する）。`OK:` 行は出ないので
  # expect_green ではなく終了コードだけを見る。
  assert_count=$((assert_count + 1))
  if [ "$RC" -ne 0 ]; then
    _t_fail "exit 0 を期待しましたが exit=${RC} でした。"
  fi
}

IMG='asia-northeast1-docker.pkg.dev/p/fwlm'

t_begin 'deploy-rollback-guard: 本番が候補より新しいコミットを指していれば止める（2026-11-03 の形）'
drg_tree
drg_running <<EOF
service	line-webhook	${IMG}/line-webhook:${DRG_C}
service	survey-web	${IMG}/survey-web:${DRG_B}
job	daily-batch	${IMG}/daily-batch:${DRG_B}
EOF
drg_run "$DRG_B"
drg_expect_exit0
expect_absent 'OK:'
expect_output_matches "^SKIP: ${DRG_B} を出すと本番が巻き戻ります（より新しいコミットが動いている対象: service/line-webhook@${DRG_C}）"
drg_expect_output_file true
t_end

t_begin 'deploy-rollback-guard: 古いコミットからの更新は進める'
drg_tree
drg_running <<EOF
service	line-webhook	${IMG}/line-webhook:${DRG_A}
job	daily-batch	${IMG}/daily-batch:${DRG_B}
EOF
drg_run "$DRG_C"
expect_green
expect_output_matches '^OK: .*2 対象を判定'
expect_absent 'SKIP:'
drg_expect_output_file false
t_end

t_begin 'deploy-rollback-guard: 同じコミットの出し直しは止めない（rerun・手動実行）'
drg_tree
drg_running <<EOF
service	line-webhook	${IMG}/line-webhook:${DRG_C}
EOF
drg_run "$DRG_C"
expect_green
expect_output_matches '候補と同じコミット'
drg_expect_output_file false
t_end

t_begin 'deploy-rollback-guard: 別の枝のコミットは巻き戻りとみなさない'
drg_tree
drg_running <<EOF
service	line-webhook	${IMG}/line-webhook:${DRG_C}
EOF
drg_run "$DRG_D"
expect_green
expect_absent 'SKIP:'
drg_expect_output_file false
t_end

t_begin 'deploy-rollback-guard: 解決できないタグの対象は判定から外し、WARN を出す'
drg_tree
drg_running <<EOF
service	line-webhook	us-docker.pkg.dev/cloudrun/container/hello
service	survey-web	${IMG}/survey-web@sha256:0123456789abcdef
service	store-detail	${IMG}/store-detail:${DRG_A}
EOF
drg_run "$DRG_C"
expect_green
expect_output_matches '^WARN: service line-webhook のイメージ'
expect_output_matches '^WARN: service survey-web のイメージ'
drg_expect_output_file false
t_end

t_begin 'deploy-rollback-guard: 本番のサービスとジョブが 0 件なら止まる（判定の材料が無い）'
drg_tree
: > "${FX}/running.tsv"
drg_run "$DRG_C"
expect_red '本番のサービスとジョブが 0 件です'
t_end

t_begin 'deploy-rollback-guard: 候補のコミットを解決できなければ止まる（浅い checkout）'
drg_tree
drg_running <<EOF
service	line-webhook	${IMG}/line-webhook:${DRG_C}
EOF
drg_run 'deadbeefdeadbeef'
expect_red '候補のコミット deadbeefdeadbeef を解決できません'
t_end
