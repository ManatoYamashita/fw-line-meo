# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-guard-selftest-coverage.sh の自己テスト（Issue #90 追補）。
#
# 本ガードは「ガードは増えたがケースが追いつかない」を機械検出する。対応関係は順方向
# （ガード → ケース）と逆方向（ケース → ガード）で別々に切れるため、両方に赤ケースを置く。
#
# 合成ツリーにも本ガード自身が複製される（fx_guard）。本ガードは自分にもケースを要求するため、
# fixture には 70-check-guard-selftest-coverage.sh のダミーが必要になる。この自己参照が
# 成立していること自体が「自己強制になっている」ことの確認でもある。

gsc_tree() {
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

gsc_fixture() {
  fx_guard check-guard-selftest-coverage
  gsc_tree
}

# TIER_SPLIT へ `check-foo` を宣言した状態のガードを置く。
#
# 実在するガード名（`check-test-code-coverage`）を合成ツリーへ持ち込む案は採らない。宣言の
# 中身を fixture が写経することになり、ガードを改名しただけで「宣言と食い違う」以外の理由で
# ケースが赤くなる。宣言そのものを変異で与えれば、合成ツリーは実リポジトリの構成から独立する。
# 変異が当たらなければ fx_guard_mutate が落とすため、宣言の書式が変われば黙って空振りしない。
gsc_fixture_declared() {
  fx_guard_mutate check-guard-selftest-coverage \
    -e 's/^TIER_SPLIT=(.*)$/TIER_SPLIT=(check-foo)/'
  gsc_tree
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
#
# ただしそれだけでは**片側の消失**が残る。件数は tier ごとに 1 件のままなので、削除しても
# 「カバー済み」と数えられてしまう（PR #103 のレビューで実測）。期待する tier 集合を
# TIER_SPLIT で宣言し、その実在を要求することで塞ぐ — 以下 4 件がその検証である。

t_begin 'check-guard-selftest-coverage: 宣言済みガードが Tier A / Tier B を揃えていれば緑'
gsc_fixture_declared
fx_write scripts/test/cases/15-check-foo.tier-b.sh <<'EOF'
# dummy
EOF
fx_run check-guard-selftest-coverage
expect_green
t_end

t_begin 'check-guard-selftest-coverage: 基本ケース（Tier A）の消失を検出する（#103 レビュー指摘）'
gsc_fixture_declared
fx_write scripts/test/cases/15-check-foo.tier-b.sh <<'EOF'
# dummy
EOF
# Tier B だけが残る。**件数は 1 件のまま**なので、件数を見る既存の検証では捕まらない。
# 実リポジトリではこれが 10-check-test-code-coverage.sh（Tier A・17 ケース）の消失に当たる。
rm -f "${FX}/scripts/test/cases/10-check-foo.sh"
fx_run check-guard-selftest-coverage
expect_red 'check-foo に Tier A の基本ケース（NN-check-foo.sh）がありません'
# 件数不足として報告してはいけない。n=1 で素通りしていたことが本件の欠陥であり、
# この不在アサーションが「件数の分岐で偶然赤くなった」との取り違えを防ぐ。
expect_absent 'check-foo に対応するケースファイルがありません'
t_end

t_begin 'check-guard-selftest-coverage: 基本ケースの消失は宣言の有無に依らず赤（PR #116 との衝突分析）'
gsc_fixture
# 基本ケースを **1 手で** 変種へ置き換える。この経路は「未宣言のまま 2 tier」という赤の状態を
# 一度も通らないため、宣言の要求だけを課しても捕まらない（TIER_SPLIT 導入直後は緑で素通り
# することを実測した）。基本ケースの実在は宣言から独立した**構造的要件**として課す。
mv "${FX}/scripts/test/cases/10-check-foo.sh" "${FX}/scripts/test/cases/15-check-foo.tier-b.sh"
fx_run check-guard-selftest-coverage
expect_red 'check-foo に Tier A の基本ケース（NN-check-foo.sh）がありません'
# 宣言漏れとして報告してはいけない。tier-a が無いのだから「2 tier ある」ではないうえ、
# 同じ 1 つの原因に「TIER_SPLIT へ追加せよ」と「基本ケースを戻せ」の 2 種類の指示が並ぶ。
expect_absent 'TIER_SPLIT に宣言されていません'
t_end

t_begin 'check-guard-selftest-coverage: 宣言済みガードの Tier B 消失を検出する（#103 レビュー指摘）'
gsc_fixture_declared
# tier-b ファイルを置かない。Tier B は「実物の tsc / eslint にしか答えられない層」であり、
# 消えても Tier A の緑だけで CI は通る。宣言があって初めて欠落として検出できる。
fx_run check-guard-selftest-coverage
expect_red 'check-foo は TIER_SPLIT の宣言に反して Tier B のケースファイルがありません'
t_end

t_begin 'check-guard-selftest-coverage: 2 tier あるのに宣言が無ければ赤（宣言の陳腐化を防ぐ）'
gsc_fixture
fx_write scripts/test/cases/15-check-foo.tier-b.sh <<'EOF'
# dummy
EOF
# 宣言のずれを片方向だけ見ると、宣言そのものが実態から乖離していく。tier を分けた本人へ
# その場で宣言を要求することで、TIER_SPLIT が「後から誰も更新しない一覧」になるのを防ぐ。
fx_run check-guard-selftest-coverage
expect_red 'check-foo は Tier A / Tier B の両方にケースファイルがありますが TIER_SPLIT に宣言されていません'
t_end

t_begin 'check-guard-selftest-coverage: 同じ層のケースが 2 件に散っていれば赤（tier 分割でも緩めない）'
# 宣言済みの fixture を使う。未宣言のままだと上の「宣言されていません」も同時に出て、
# 赤の原因が 2 つ混ざる（このハーネスが避けようとしている取り違えそのものである）。
gsc_fixture_declared
fx_write scripts/test/cases/15-check-foo.tier-b.sh <<'EOF'
# dummy
EOF
fx_write scripts/test/cases/16-check-foo.tier-b.sh <<'EOF'
# dummy
EOF
fx_run check-guard-selftest-coverage
expect_red 'check-foo の Tier B のケースファイルが 2 件あります'
expect_absent 'TIER_SPLIT に宣言されていません'
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
expect_red '99-check-bar.sh に対応するガードが scripts/check-bar.sh にも db/test/check-bar.sh にもありません'
t_end

t_begin 'check-guard-selftest-coverage: db/test 配下のガードを指すケースは孤児にしない（#158 (a)）'
# `db/test/*.sh` は #156 / #158 で CI から毎 PR 実行される検査資産になった。ケースの対応先として
# 受け付けないと、**CI が回すガードだけ自己テストを持てない**という逆転が起きる。
# 上の孤児ケースと違うのは「対応先の実体が db/test にあるかどうか」の 1 点だけである。
gsc_fixture
fx_write db/test/check_baz.sh <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
fx_write scripts/test/cases/99-check_baz.sh <<'EOF'
# dummy
EOF
fx_run check-guard-selftest-coverage
expect_green
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
