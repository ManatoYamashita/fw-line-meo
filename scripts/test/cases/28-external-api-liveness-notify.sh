# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/external-api-liveness-notify.sh の自己テスト（Issue #139）。
#
# report-ci-issue.sh は本文を加工せずそのまま送る。したがって緑（復旧）でも赤用の断定と
# 「## 対処」を組んでいると、復旧コメントが見出し付きの障害指示として描画され、不要な障害対応を
# 誘発する（Issue #102 のコメントで実測）。
#
# 本ワークフローには warn（UNOBSERVED）がある。**UNOBSERVED を「生きている」と書かないこと**が
# 本文側の中心の契約である。対象 0 件を緑に見せる文面は、Issue #139 の完了条件 2 を本文で破る。

eln_report() {
  fx_write report.txt <<'EOF'
件数（places は直近 30 時間・line-messaging は直近 3 時間）:
  places_fetch_ok_runs	0
OK places: ALIVE — 検証結果の素通しを確かめる行
OK: 外部 API の恒常観測に赤はありません（places=alive / line-messaging=alive）。
EOF
}

eln_compose() {
  # $1 = state。stdout だけを OUT へ入れる（stderr の診断を本文として照合しない）。
  fx_run_stdout external-api-liveness-notify \
    --state "$1" \
    --report report.txt \
    --run-url https://github.com/owner/repo/actions/runs/1
}

t_begin 'external-api-liveness 通知: 緑の本文に異常の断定と対処手順を出さない'
fx_guard external-api-liveness-notify
eln_report
eln_compose green
expect_green
expect_output_matches '## 検証結果'
expect_output_matches '検証結果の素通しを確かめる行'
expect_absent '異常を検出しました'
expect_absent '## 対処'
expect_absent 'UNOBSERVED は'
t_end

t_begin 'external-api-liveness 通知: 赤の本文は DEAD と NOT_RUN の対処を分けて出す'
fx_guard external-api-liveness-notify
eln_report
eln_compose red
expect_green
expect_output_matches '異常を検出しました'
expect_output_matches '## 対処'
expect_output_matches 'run-external-api-smoke\.sh'
expect_output_matches 'NOT_RUN.*ジョブが走っていない'
expect_absent '成功を観測しています'
t_end

t_begin 'external-api-liveness 通知: warn は「生きている」と書かず #125 の手動実疎通を指す'
fx_guard external-api-liveness-notify
eln_report
eln_compose warn
expect_green
expect_output_matches '判定できていません'
expect_output_matches 'UNOBSERVED は「生きている」ではない'
expect_output_matches '`#125` の手動実疎通'
expect_absent '成功を観測しています'
expect_absent '## 対処'
t_end

# 本文の文字列にバッククォートを生で書くと、ダブルクォートの中でコマンド置換として実行されて
# 消える（初版で Issue 番号がこの形で空になった）。番号が本文に残っていることを固定する。
t_begin 'external-api-liveness 通知: Issue 番号がコマンド置換で消えていない'
fx_guard external-api-liveness-notify
eln_report
eln_compose green
expect_output_matches 'Issue `#139`'
t_end

t_begin 'external-api-liveness 通知: 未知の state は緑として扱わず落ちる'
fx_guard external-api-liveness-notify
eln_report
eln_compose grean
expect_output_empty
# stdout は空、stderr に理由が出ることを照合する（原因まで固定する）。
fx_run_args external-api-liveness-notify --state grean --report report.txt \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '--state は green / warn / red のいずれかでなければなりません'
t_end

t_begin 'external-api-liveness 通知: report が無ければ落ちる'
fx_guard external-api-liveness-notify
eln_compose red
expect_output_empty
fx_run_args external-api-liveness-notify --state red --report report.txt \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '--report の検証結果ファイルがありません'
t_end
