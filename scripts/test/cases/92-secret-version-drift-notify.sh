# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/secret-version-drift-notify.sh の自己テスト（Issue #63）。
#
# report-ci-issue.sh は本文を加工せずそのまま送る。したがって緑（復旧）でも赤用の断定と
# 「## 対処」を組んでいると、復旧コメントが見出し付きの障害指示として描画され、不要な障害対応を
# 誘発する（Issue #102 のコメントで実測。prod-image-drift-notify.sh で同じ欠陥を踏んでいる）。
#
# **本文の組み立てをワークフローの run ブロックへ戻さないこと。** yml へ埋め込むと検証が
# 「見出しコメントを sed で抜いて実走する」形へ逆戻りし、Issue #109 では抽出対象のスクリプトが
# 存在しないことで孤児ケース検出に掛かって main の ts-ci が 3 日赤いままになった。

svn_report() {
  # 検証結果ファイル。本文へフェンス付きで埋め込まれる。
  fx_write report.txt <<'EOF'
OK: 本番シークレットの version 構成は宣言と一致（6 件検証・WHITELIST 0 件）。
EOF
}

svn_compose() {
  # $1 = state。組み立てを実走し、**stdout だけ**を OUT へ入れる。
  # stderr まで混ぜると、診断行を本文の一部として照合してしまう。
  fx_run_stdout secret-version-drift-notify \
    --state "$1" \
    --report report.txt \
    --run-url https://github.com/owner/repo/actions/runs/1
}

# **本命**: 緑（復旧）の本文に、赤用の断定と対処手順を出さないこと。
t_begin 'secret-version-drift 通知: 緑の本文に乖離の断定と対処手順を出さない'
fx_guard secret-version-drift-notify
svn_report
svn_compose green
# `OK:` は本スクリプト自身の要約行ではなく、**検証結果ファイルの内容がそのまま本文へ載っている**
# ことを示す。この 1 行で「exit 0」と「report を素通しで埋め込んだ」の両方を固定できる。
expect_green
expect_output_matches '## 検証結果'
expect_output_matches '6 件検証'
expect_absent '乖離しています'
expect_absent '## 対処'
expect_absent 'versions disable'
t_end

# 対照: 赤では断定も対処手順も出す。緑の是正で赤まで削ると障害通知が無内容になる。
t_begin 'secret-version-drift 通知: 赤の本文には断定と対処手順を出す（対照）'
fx_guard secret-version-drift-notify
svn_report
svn_compose red
expect_output_matches '乖離しています'
expect_output_matches '## 対処'
expect_output_matches 'versions disable'
# 検出できない範囲を毎回明示する。「緑だから値も正しい」と読まれるのが最も危ない誤読である。
expect_output_matches '値そのものの正当性は本ガードの範囲外'
t_end

t_begin 'secret-version-drift 通知: 検証結果は必ずフェンス内に置く（緑・赤とも）'
fx_guard secret-version-drift-notify
svn_report
for svn_state in green red; do
  svn_compose "$svn_state"
  # 裸で置くと出力中の #123 が他 Issue への参照通知を、@name が誤メンションを飛ばす。
  OUT="FENCES: $(printf '%s\n' "$OUT" | grep -cE '^```$' || true)"
  expect_output_matches '^FENCES: 2$'
done
t_end

t_begin 'secret-version-drift 通知: 未知の state を緑として扱わない'
fx_guard secret-version-drift-notify
svn_report
fx_run_args secret-version-drift-notify \
  --state gren \
  --report report.txt \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '--state は green か red でなければなりません'
# 綴り誤りが緑の本文として通ると、乖離中に復旧通知が飛ぶ。本文を 1 行も出していないこと。
expect_absent '一致しています'
t_end

t_begin 'secret-version-drift 通知: 検証結果ファイルが無ければ無内容の本文を返さない'
fx_guard secret-version-drift-notify
fx_run_args secret-version-drift-notify \
  --state red \
  --report missing-report.txt \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '検証結果ファイルがありません'
# **照合は本文にしか現れない語へ当てる。** 見出し（`## 検証結果`）はエラーメッセージ自身が
# 説明のために含んでおり、診断文の言い回しを変えただけでケースが赤/緑へ転ぶ。
expect_absent '本番 Secret Manager'
t_end

t_begin 'secret-version-drift 通知: run URL が空なら本文を返さない（通知から run へ辿れなくなる）'
fx_guard secret-version-drift-notify
svn_report
fx_run_args secret-version-drift-notify \
  --state red \
  --report report.txt
expect_red '--run-url が空です'
expect_absent '本番 Secret Manager'
t_end
