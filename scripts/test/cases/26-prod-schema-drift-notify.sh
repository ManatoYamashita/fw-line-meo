# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/prod-schema-drift-notify.sh の自己テスト（Issue #251）。

t_begin 'prod-schema-drift 通知: 緑の本文に乖離・対処を出さない'
fx_guard prod-schema-drift-notify
fx_write report.txt <<'EOF'
OK: 本番スキーマは一致しています（対象 30 件）。
EOF
fx_run_stdout prod-schema-drift-notify \
  --state green --report report.txt --run-url https://github.com/owner/repo/actions/runs/1
expect_green
expect_output_matches '## 検証結果'
expect_output_matches '対象 30 件'
expect_absent '乖離しています'
expect_absent '## 対処'
t_end

t_begin 'prod-schema-drift 通知: 赤ではmigration適用漏れの対処と対象外を示す'
fx_guard prod-schema-drift-notify
fx_write report.txt <<'EOF'
ERROR: 本番に存在しない対象: relation audit_logs (-)
EOF
fx_run_stdout prod-schema-drift-notify \
  --state red --report report.txt --run-url https://github.com/owner/repo/actions/runs/1
if [ "$RC" -ne 0 ]; then
  _t_fail "赤通知の本文生成は exit=0 を期待しましたが exit=${RC} でした。"
fi
expect_output_matches '本番 Cloud SQL のスキーマが db/migrations 適用後の catalog と乖離しています'
expect_output_matches 'infra/README.md §3'
expect_output_matches '表の行データや定義内容の差は本検査の対象外'
t_end

t_begin 'prod-schema-drift 通知: 未知のstateは緑に倒さない'
fx_guard prod-schema-drift-notify
fx_write report.txt <<'EOF'
ERROR: fixture
EOF
fx_run_args prod-schema-drift-notify --state gren --report report.txt --run-url https://github.com/owner/repo/actions/runs/1
expect_red '--state は green か red'
expect_absent '一致しています'
t_end

t_begin 'prod-schema-drift 通知: report が無ければ本文を作らない'
fx_guard prod-schema-drift-notify
fx_run_args prod-schema-drift-notify --state red --report missing.txt --run-url https://github.com/owner/repo/actions/runs/1
expect_red '--report の検証結果ファイルがありません'
expect_absent '本番 Cloud SQL のスキーマが'
t_end
