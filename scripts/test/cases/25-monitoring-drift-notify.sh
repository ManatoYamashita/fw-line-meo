# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/monitoring-drift-notify.sh の自己テスト（Issue #230）。
#
# report-ci-issue.sh は本文を加工せずそのまま送る。したがって緑（復旧）でも赤用の断定と
# 「## 対処」を組んでいると、復旧コメントが見出し付きの障害指示として描画され、不要な障害対応を
# 誘発する（Issue #102 のコメントで実測）。
#
# 本ワークフローの対処手順には **「先に make tf-plan を打て」** が要る。undeclared-in-prod は
# 「本番に在って宣言に無い」状態であり、そのまま apply すると監視が destroy される。この一文が
# 落ちると、通知を読んだ人が最短で監視を消す方向へ動きうる。

mdn_report() {
  fx_write report.txt <<'EOF'
OK: 本番の監視構成は宣言と一致（宣言 8 件 / 本番 8 件 / 8 件検証・WHITELIST 0 件）。
EOF
}

mdn_compose() {
  # $1 = state。組み立てを実走し、**stdout だけ**を OUT へ入れる。
  # stderr まで混ぜると、診断行を本文の一部として照合してしまう。
  fx_run_stdout monitoring-drift-notify \
    --state "$1" \
    --report report.txt \
    --run-url https://github.com/owner/repo/actions/runs/1
}

# **本命**: 緑（復旧）の本文に、赤用の断定と対処手順を出さないこと。
t_begin 'monitoring-drift 通知: 緑の本文に乖離の断定と対処手順を出さない'
fx_guard monitoring-drift-notify
mdn_report
mdn_compose green
# `8 件検証` は本スクリプト自身の要約ではなく、**検証結果ファイルの内容がそのまま本文へ
# 載っている**ことを示す。この 1 行で「exit 0」と「report を素通しで埋め込んだ」を両方固定できる。
expect_green
expect_output_matches '## 検証結果'
expect_output_matches '8 件検証'
expect_absent '乖離しています'
expect_absent '## 対処'
expect_absent 'tf-plan'
t_end

# 対照: 赤では断定も対処手順も出す。緑の是正で赤まで削ると障害通知が無内容になる。
t_begin 'monitoring-drift 通知: 赤の本文には断定と対処手順を出す（対照）'
fx_guard monitoring-drift-notify
mdn_report
mdn_compose red
expect_output_matches '乖離しています'
expect_output_matches '## 対処'
t_end

# **最も落としてはいけない一文。** これが無いと、通知を読んだ人が apply を先に打ち、
# 宣言に無い監視を自分で消す方向へ動きうる（#230 で state が保持していた 5 件がまさにそれ）。
t_begin 'monitoring-drift 通知: 赤の本文は apply より先に tf-plan を打つよう指示する'
fx_guard monitoring-drift-notify
mdn_report
mdn_compose red
expect_output_matches 'make tf-plan'
expect_output_matches 'destroy'
t_end

# 検出できない範囲を毎回明示する。「緑だから閾値も通知先も正しい」と読まれるのが最も危ない誤読。
t_begin 'monitoring-drift 通知: 赤の本文は検出範囲外を明示する'
fx_guard monitoring-drift-notify
mdn_report
mdn_compose red
expect_output_matches 'ポリシーの中身'
expect_output_matches '本ガードの範囲外'
t_end

t_begin 'monitoring-drift 通知: 検証結果は必ずフェンス内に置く（緑・赤とも）'
fx_guard monitoring-drift-notify
mdn_report
for mdn_state in green red; do
  mdn_compose "$mdn_state"
  # 裸で置くと出力中の #123 が他 Issue への参照通知を、@name が誤メンションを飛ばす。
  # **件数取得を後置 true で潰さない。** 潰すと評価不能（exit 2 以上）まで「0 件」へ化け、
  # フェンスが無いのに `FENCES: 0` として素通りする（Issue #120）。
  mdn_fences_rc=0
  mdn_fences="$(printf '%s\n' "$OUT" | grep -cE '^```$')" || mdn_fences_rc=$?
  if [ "$mdn_fences_rc" -gt 1 ]; then
    _t_fail "フェンス数の抽出パターンを評価できません（grep exit=${mdn_fences_rc}）"
  fi
  OUT="FENCES: ${mdn_fences:-0}"
  expect_output_matches '^FENCES: 2$'
done
t_end

t_begin 'monitoring-drift 通知: 未知の state を緑として扱わない'
fx_guard monitoring-drift-notify
mdn_report
fx_run_args monitoring-drift-notify \
  --state gren \
  --report report.txt \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '--state は green か red でなければなりません'
# 綴り誤りが緑の本文として通ると、乖離中に復旧通知が飛ぶ。本文を 1 行も出していないこと。
expect_absent '一致しています'
t_end

t_begin 'monitoring-drift 通知: 検証結果ファイルが無ければ無内容の本文を返さない'
fx_guard monitoring-drift-notify
fx_run_args monitoring-drift-notify \
  --state red \
  --report missing-report.txt \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '検証結果ファイルがありません'
# **照合は本文にしか現れない語へ当てる。** 見出し（`## 検証結果`）はエラーメッセージ自身が
# 説明のために含んでおり、診断文の言い回しを変えただけでケースが赤/緑へ転ぶ。
expect_absent '本番の監視構成が'
t_end

t_begin 'monitoring-drift 通知: run URL が空なら本文を返さない（通知から run へ辿れなくなる）'
fx_guard monitoring-drift-notify
mdn_report
fx_run_args monitoring-drift-notify \
  --state red \
  --report report.txt
expect_red '--run-url が空です'
expect_absent '本番の監視構成が'
t_end
