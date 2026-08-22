# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/external-api-smoke-notify.sh の自己テスト（Issue #125）。
#
# report-ci-issue.sh は本文を加工せずそのまま送る。したがって緑（復旧）でも赤用の断定と
# 「## 対処」を組んでいると、復旧コメントが見出し付きの障害指示として描画され、不要な障害対応を
# 誘発する（Issue #102 のコメントで実測。prod-image-drift-notify.sh で同じ欠陥を踏んでいる）。
#
# **本文の組み立てをワークフローの run ブロックへ戻さないこと。** yml へ埋め込むと検証が
# 「見出しコメントを sed で抜いて実走する」形へ逆戻りし、Issue #109 では抽出対象のスクリプトが
# 存在しないことで孤児ケース検出に掛かって main の ts-ci が 3 日赤いままになった。

easn_report() {
  # 検証結果ファイル。本文へフェンス付きで埋め込まれる。
  fx_write report.txt <<'EOF'
OK: 外部 API の実疎通記録はすべて有効期間内（3 件検証・有効期間 14 日）。
EXTERNAL-API-SMOKE-SIGNATURE: gemini=ok;line-messaging=ok;places=ok;
EOF
}

easn_compose() {
  # $1 = state。組み立てを実走し、**stdout だけ**を OUT へ入れる。
  # stderr まで混ぜると、診断行を本文の一部として照合してしまう。
  fx_run_stdout external-api-smoke-notify \
    --state "$1" \
    --report report.txt \
    --run-url https://github.com/owner/repo/actions/runs/1
}

# **本命**: 緑（復旧）の本文に、赤用の断定と対処手順を出さないこと。
t_begin 'external-api-smoke 通知: 緑の本文に未実施の断定と対処手順を出さない'
fx_guard external-api-smoke-notify
easn_report
easn_compose green
# `OK:` は本スクリプト自身の要約行ではなく、**検証結果ファイルの内容がそのまま本文へ載っている**
# ことを示す。この 1 行で「exit 0」と「report を素通しで埋め込んだ」の両方を固定できる。
expect_green
expect_output_matches '## 検証結果'
expect_output_matches '3 件検証'
expect_absent '未実施または期限切れです'
expect_absent '## 対処'
expect_absent 'run-external-api-smoke.sh'
t_end

# 対照: 赤では断定も対処手順も出す。緑の是正で赤まで削ると障害通知が無内容になる。
t_begin 'external-api-smoke 通知: 赤の本文には断定と対処手順を出す（対照）'
fx_guard external-api-smoke-notify
easn_report
easn_compose red
expect_output_matches '未実施または期限切れです'
expect_output_matches '## 対処'
expect_output_matches 'run-external-api-smoke.sh'
# 最も危ない誤読は「日付だけ更新すれば緑になる」である。赤の本文で必ず釘を刺す。
expect_output_matches '日付だけを更新して実疎通を省略しないでください'
# 鍵を CI へ渡さない設計であることを毎回明示する（「CI で自動化すればいい」への回答）。
expect_output_matches 'Req 5.4'
t_end

t_begin 'external-api-smoke 通知: 検証結果は必ずフェンス内に置く（緑・赤とも）'
fx_guard external-api-smoke-notify
easn_report
for easn_state in green red; do
  easn_compose "$easn_state"
  # 裸で置くと出力中の #123 が他 Issue への参照通知を、@name が誤メンションを飛ばす。
  # **件数取得を後置 true で潰さない。** 潰すと評価不能（exit 2 以上）まで「0 件」へ化け、
  # フェンスが無いのに `FENCES: 0` として素通りする（Issue #120）。無一致（1）と評価不能（2 以上）
  # を分ける。`grep -c` は入力を読み切るので上流へ SIGPIPE を送らない（Issue #78）。
  easn_fences_rc=0
  easn_fences="$(printf '%s\n' "$OUT" | grep -cE '^```$')" || easn_fences_rc=$?
  if [ "$easn_fences_rc" -gt 1 ]; then
    _t_fail "フェンス数の抽出パターンを評価できません（grep exit=${easn_fences_rc}）"
  fi
  OUT="FENCES: ${easn_fences:-0}"
  expect_output_matches '^FENCES: 2$'
done
t_end

t_begin 'external-api-smoke 通知: 未知の state を緑として扱わない'
fx_guard external-api-smoke-notify
easn_report
fx_run_args external-api-smoke-notify \
  --state gren \
  --report report.txt \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '--state は green か red でなければなりません'
# 綴り誤りが緑の本文として通ると、未実施のまま復旧通知が飛ぶ。本文を 1 行も出していないこと。
expect_absent 'すべて有効期間内です'
t_end

t_begin 'external-api-smoke 通知: 検証結果ファイルが無ければ無内容の本文を返さない'
fx_guard external-api-smoke-notify
fx_run_args external-api-smoke-notify \
  --state red \
  --report missing-report.txt \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '検証結果ファイルがありません'
# **照合は本文にしか現れない語へ当てる。** 見出し（`## 検証結果`）はエラーメッセージ自身が
# 説明のために含んでおり、診断文の言い回しを変えただけでケースが赤/緑へ転ぶ。
expect_absent '外部 API への実疎通が'
t_end

t_begin 'external-api-smoke 通知: run URL が空なら本文を返さない（通知から run へ辿れなくなる）'
fx_guard external-api-smoke-notify
easn_report
fx_run_args external-api-smoke-notify \
  --state red \
  --report report.txt
expect_red '--run-url が空です'
expect_absent '外部 API への実疎通が'
t_end
