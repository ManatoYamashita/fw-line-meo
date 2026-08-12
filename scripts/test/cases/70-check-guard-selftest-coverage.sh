# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
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
# 文言が tier 付きになったのは二層化（Issue #90）で判定単位が「ガード」から「ガード × tier」へ
# 変わったためである。検出する欠陥（同じ層の検証が 2 ファイルへ散る）は変わっていない。
expect_red 'check-foo の Tier A のケースファイルが 2 件あります'
t_end

# ---------------------------------------------------------------------------
# tier 分割（Issue #90 の二層化）。1 つのガードのケースが Tier A / Tier B の 2 ファイルへ
# 割れるため、「ガード 1 本にケース 1 件」を素朴に課すと正しい構成が赤になる。逆に tier の
# 区別を捨てて何件でも許すと、同じ層のケースが 2 つに散る事故を見逃す。**同じ層に 2 件を
# 許さない**という形で両立させる。

t_begin 'check-guard-selftest-coverage: tier 分割（Tier A + Tier B）は 1 件扱いで緑'
gsc_fixture
fx_write scripts/test/cases/15-check-foo.tier-b.sh <<'EOF'
# dummy
EOF
fx_run check-guard-selftest-coverage
expect_green
t_end

t_begin 'check-guard-selftest-coverage: 同じ層のケースが 2 件に散っていれば赤（tier 分割でも緩めない）'
gsc_fixture
fx_write scripts/test/cases/15-check-foo.tier-b.sh <<'EOF'
# dummy
EOF
fx_write scripts/test/cases/16-check-foo.tier-b.sh <<'EOF'
# dummy
EOF
fx_run check-guard-selftest-coverage
expect_red 'check-foo の Tier B のケースファイルが 2 件あります'
t_end

t_begin 'check-guard-selftest-coverage: run.sh が知らない tier 接尾辞を検出する'
gsc_fixture
# run.sh の所属判定は `*.tier-b.sh` だけを Tier B とし、それ以外は Tier A へ倒す。
# `.tier-c` は「Tier C のつもり」で書いても黙って Tier A として走る（宣言と実態の乖離）。
fx_write scripts/test/cases/15-check-foo.tier-c.sh <<'EOF'
# dummy
EOF
fx_run check-guard-selftest-coverage
expect_red '未知の tier 接尾辞です'
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
