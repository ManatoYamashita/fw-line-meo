# scripts/deploy-notify.sh の自己テスト（PR #104 のレビュー指摘）。
#
# 背景: report-ci-issue.sh は緑（復旧）経路で本文を加工せずそのまま送る。したがって
# 「緑と赤で文面を出し分ける」責務は呼び出し側にあり、それが守られているかを検証する器も
# 呼び出し側ごとに要る。PR #104 は prod-image-drift.yml についてこれを入れたが、deploy.yml は
# 1 行目だけを組み分け、後半（失敗の範囲を遡れという指示と復旧後の再実行コマンド）を緑でも
# 出していた。フェンスが外れる前は崩れたコードブロックとして描画されていたものが、
# 外れた瞬間にデプロイ成功の復旧コメント上で指示文へ昇格した（GitHub /markdown API で実測）。
#
# したがって本ケースの本命は「緑に赤用の文面が出ないこと」であり、対照として
# 「赤では出ること」を必ず置く。緑の是正で赤まで削ると、障害通知が無内容になる。

PDN_RUN_URL=https://github.com/owner/repo/actions/runs/1
PDN_SHA=5e9308e

pdn_compose() {
  # $1 = state。組み立てを実走し、**stdout だけ**を OUT へ入れる。
  # stderr まで混ぜると、要約行（`OK: …`）を本文の一部として照合してしまう。
  fx_run_stdout deploy-notify \
    --state "$1" \
    --run-url "$PDN_RUN_URL" \
    --deployed-sha "$PDN_SHA"
}

# **本命**: 緑（復旧）の本文に、失敗調査の指示と再実行コマンドを出さないこと。
t_begin 'deploy 通知: 緑の本文に失敗調査の指示と再実行コマンドを出さない'
fx_guard deploy-notify
pdn_compose green
expect_output_matches '^deploy-prod が成功しました。$'
expect_output_matches '反映対象 commit'
expect_absent '本番は旧イメージのままです'
expect_absent '失敗の範囲は'
expect_absent '復旧後の再実行'
expect_absent 'gh run list --workflow deploy.yml'
t_end

# 対照: 赤では断定も調査手順も再実行コマンドも出す。緑の是正で赤まで削ってしまうと、
# 「本番が旧イメージのまま」という最も伝えるべき事実が通知から消える。
t_begin 'deploy 通知: 赤の本文には失敗の断定と調査手順を出す（対照）'
fx_guard deploy-notify
pdn_compose red
expect_output_matches '^deploy-prod が失敗しました。'
expect_output_matches '本番は旧イメージのままです'
expect_output_matches '失敗の範囲は'
expect_output_matches '復旧後の再実行'
t_end

# コマンド例を裸で置くと、行中の #123 が他 Issue への参照通知を、@name が誤メンションを飛ばす。
# report-ci-issue.sh は本文を加工しない契約なので、フェンスはこの呼び出し側にしか無い。
# 緑にはコマンド例そのものが無いためフェンスは 0 本になる（件数まで見ないと「崩れていない」と言えない）。
t_begin 'deploy 通知: 赤のコマンド例はフェンス内に置き、緑にはフェンスを出さない'
fx_guard deploy-notify
pdn_compose red
OUT="FENCES: $(count_output_matches '^```$')"
expect_output_matches '^FENCES: 2$'
pdn_compose green
OUT="FENCES: $(count_output_matches '^```$')"
expect_output_matches '^FENCES: 0$'
t_end

# 緑の正常終了。要約行は stderr へ出すので、ここだけ stderr を混ぜて受ける。
# 本文が 1 行も出ないまま exit 0 する経路（最悪の空振り）と区別するため、要約行と本文の両方を見る。
t_begin 'deploy 通知: 緑は要約行を stderr へ出して正常終了する'
fx_guard deploy-notify
fx_run_args deploy-notify \
  --state green \
  --run-url "$PDN_RUN_URL" \
  --deployed-sha "$PDN_SHA"
expect_green
expect_output_matches 'state=green'
expect_output_matches '^deploy-prod が成功しました。$'
t_end

# ---------------------------------------------------------------------------
# fail-closed（Issue #109 で prod-image-drift-notify.sh へ入れた判定と同じ理由）。
#
# `= "red"` の else で red 以外をすべて緑扱いにすると、state の綴りを間違えた瞬間に、
# デプロイが失敗している最中に「成功しました」という復旧通知が飛ぶ。

t_begin 'deploy 通知: 未知の state を緑として扱わない'
fx_guard deploy-notify
fx_run_args deploy-notify \
  --state gren \
  --run-url "$PDN_RUN_URL" \
  --deployed-sha "$PDN_SHA"
expect_red '--state は green か red でなければなりません'
# 綴り誤りが緑の本文として通ると、失敗中に復旧通知が飛ぶ。本文を 1 行も出していないこと。
# **照合は本文にしか現れない語へ当てる。** 診断文の言い回しを変えただけでケースが転ぶのを避ける。
expect_absent 'deploy-prod が成功しました'
t_end

t_begin 'deploy 通知: 反映対象 commit が空なら無内容の本文を返さない'
fx_guard deploy-notify
fx_run_args deploy-notify \
  --state green \
  --run-url "$PDN_RUN_URL"
expect_red '--deployed-sha が空です'
expect_absent 'deploy-prod が成功しました'
t_end
