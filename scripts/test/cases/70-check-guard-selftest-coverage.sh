# scripts/check-guard-selftest-coverage.sh の自己テスト（Issue #90 追補）。
#
# 本ガードは「ガードは増えたがケースが追いつかない」を機械検出する。対応関係は順方向
# （ガード → ケース）と逆方向（ケース → ガード）で別々に切れるため、両方に赤ケースを置く。
#
# 合成ツリーにも本ガード自身が複製される（fx_guard）。本ガードは自分にもケースを要求するため、
# fixture には 70-check-guard-selftest-coverage.sh のダミーが必要になる。この自己参照が
# 成立していること自体が「自己強制になっている」ことの確認でもある。

gsc_fixture() {
  fx_guard check-guard-selftest-coverage

  fx_write scripts/check-foo.sh <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  # 合成ツリー用のダミーケース（本ガードは存在と命名だけを見るため、中身は参照されない）。
  fx_write scripts/test/cases/10-check-foo.sh <<'EOF'
# dummy
EOF
  fx_write scripts/test/cases/70-check-guard-selftest-coverage.sh <<'EOF'
# dummy
EOF
}

t_begin 'check-guard-selftest-coverage: ガードとケースが 1:1 なら緑（件数まで照合）'
gsc_fixture
fx_run check-guard-selftest-coverage
expect_green
# 「OK」だけでなく件数を照合する。走査が空振りしたまま緑になる経路と区別するため。
expect_output_matches '2/2 ガードにケース・2 ケースファイル'
t_end

# ---------------------------------------------------------------------------
# 順方向: この PR（#93）のレビューで実測された穴そのもの。ケースファイルを 1 件外すと、
# 本体 run.sh は 20 ケース / 26 アサーションで緑 exit 0 を返していた。

t_begin 'check-guard-selftest-coverage: ケースファイルの欠落を検出する（#93 レビュー指摘）'
gsc_fixture
rm -f "${FX}/scripts/test/cases/10-check-foo.sh"
fx_run check-guard-selftest-coverage
expect_red 'check-foo に対応するケースファイルがありません'
t_end

t_begin 'check-guard-selftest-coverage: 同一ガードへ複数ケースがある状態を検出する'
gsc_fixture
fx_write scripts/test/cases/11-check-foo.sh <<'EOF'
# dummy
EOF
fx_run check-guard-selftest-coverage
expect_red 'check-foo に対応するケースファイルが 2 件あります'
t_end

# ---------------------------------------------------------------------------
# 逆方向: ガードを改名・削除したときにケースだけが残る形。順方向の照合では素通りする。

t_begin 'check-guard-selftest-coverage: 対応するガードが無い孤児ケースを検出する'
gsc_fixture
fx_write scripts/test/cases/99-check-bar.sh <<'EOF'
# dummy
EOF
fx_run check-guard-selftest-coverage
expect_red '99-check-bar.sh に対応するガード scripts/check-bar.sh がありません'
t_end

t_begin 'check-guard-selftest-coverage: NN- 接頭を持たないケースファイルを検出する'
gsc_fixture
fx_write scripts/test/cases/helpers.sh <<'EOF'
# dummy
EOF
fx_run check-guard-selftest-coverage
expect_red 'NN-<ガード名>.sh の形になっていません'
t_end

# ---------------------------------------------------------------------------

t_begin 'check-guard-selftest-coverage: ケースディレクトリ消失を空振りとして報告する'
gsc_fixture
rm -rf "${FX}/scripts/test/cases"
fx_run check-guard-selftest-coverage
expect_red 'ケースディレクトリがありません'
t_end
