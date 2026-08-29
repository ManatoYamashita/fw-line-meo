# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-db-test-ci-coverage.sh の自己テスト（Issue #156）。
#
# 本ガードが守るのは「実行装置がワークフローから呼ばれていること」であり、壊れ方は
# **差分に痕跡が残らない**（#156 の原状は「一度も配線されたことがない」だった）。したがって
# ここで最も重要なのは、**配線の有無だけを変えた対照**である。配線ありで緑・配線なしで赤に
# ならなければ、このガードは「常に緑の装置」と区別できない。
#
# 合成ツリーは実リポジトリの構造を再現する:
#   (1) scripts/run-db-test-suites.sh は **実物を複製する**（RUN 表 / SKIP 表の書式が変わったら
#       ガードの sed 抽出が空になる。それをここで赤として検出する）
#   (2) SKIP 表が指す db/test/*.sh は実体を置く（宣言と実体の照合が本題のため）
#   (3) ワークフローは push / pull_request で発火するものと、workflow_dispatch だけのものの 2 本
#   (4) ELSEWHERE 表（#158 (b)）が名指しする job を合成 ts-ci.yml に置く。**この job は
#       最後に置く**（下の「job ごと消す」ケースが `/^  cross-runtime:$/,$d` で消せるように）

dbtc_fixture() {
  fx_guard check-db-test-ci-coverage
  # 実物の実行装置を複製する（表の書式そのものを検査対象にする）。
  fx_copy scripts/run-db-test-suites.sh

  # SKIP 表と RUN 表が指す db/test 直下の shell（中身は要らない・実在することが本題）。
  for f in check_docs.sh run.sh check_no_optional_capabilities.sh \
           cross_runtime_integration.sh cross_runtime_steps.sh; do
    fx_write "db/test/${f}" <<'EOF'
#!/usr/bin/env bash
: # 本ケースでは実行しない
EOF
  done

  fx_write db/test/assertions/10_x.sql <<'EOF'
-- assertion
EOF
  fx_write db/test/smoke/20_y.sql <<'EOF'
-- smoke
EOF

  # 発火するワークフロー（配線あり）。
  fx_write .github/workflows/ts-ci.yml <<'EOF'
name: ts-ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  lint-build-test:
    runs-on: ubuntu-latest
    steps:
      - name: apply migrations
        run: for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
      - name: 'db/test スイート（Issue #156）'
        run: bash scripts/run-db-test-suites.sh
  cross-runtime:
    runs-on: ubuntu-latest
    steps:
      - name: 'クロスランタイム契約検証（Issue #158）'
        run: CROSS_RUNTIME_USE_EXISTING_DB=1 bash db/test/cross_runtime_integration.sh
EOF

  # 手動起動しかないワークフロー（ここへ配線を移すと「蓋が閉じている」状態になる）。
  fx_write .github/workflows/manual-only.yml <<'EOF'
name: manual-only
on:
  workflow_dispatch: {}
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
EOF
}

# ---------------------------------------------------------------------------
# 中核: 配線の有無だけを変えた対照
# ---------------------------------------------------------------------------

t_begin 'check-db-test-ci-coverage: 配線されていれば緑（件数を出す）'
dbtc_fixture
fx_run check-db-test-ci-coverage
expect_green
expect_output_matches 'db/test は CI から実行されている'
expect_output_matches 'スイート 2 ディレクトリ'
expect_output_matches '別ジョブ 1 件'
t_end

t_begin 'check-db-test-ci-coverage: ワークフローから実行行を消すと赤（このガードの存在理由）'
# **上のケースと違うのは配線の 1 行だけである。** ここが赤にならなければ、上の緑は
# 「何も見ていないから緑」と区別できない。
dbtc_fixture
sed -i.bak '/run-db-test-suites\.sh/d' "${FX}/.github/workflows/ts-ci.yml"
rm -f "${FX}/.github/workflows/ts-ci.yml.bak"
fx_run check-db-test-ci-coverage
expect_red 'を実行しているワークフローが 1 件もありません'
t_end

t_begin 'check-db-test-ci-coverage: 実行行をコメントにすると赤（説明文を配線と数えない）'
dbtc_fixture
sed -i.bak 's|^        run: bash scripts/run-db-test-suites.sh|        # run: bash scripts/run-db-test-suites.sh|' \
  "${FX}/.github/workflows/ts-ci.yml"
rm -f "${FX}/.github/workflows/ts-ci.yml.bak"
fx_run check-db-test-ci-coverage
expect_red 'を実行しているワークフローが 1 件もありません'
t_end

t_begin 'check-db-test-ci-coverage: 手動起動だけのワークフローへ移すと赤（器に入っていても蓋が閉じている）'
dbtc_fixture
sed -i.bak '/run-db-test-suites\.sh/d' "${FX}/.github/workflows/ts-ci.yml"
rm -f "${FX}/.github/workflows/ts-ci.yml.bak"
printf '      - run: bash scripts/run-db-test-suites.sh\n' >> "${FX}/.github/workflows/manual-only.yml"
fx_run check-db-test-ci-coverage
expect_red 'push / pull_request で発火しません'
t_end

# ---------------------------------------------------------------------------
# 宣言の網羅（db/test へ置いたのに誰も呼ばない、を無言で起こさない）
# ---------------------------------------------------------------------------

t_begin 'check-db-test-ci-coverage: 未宣言の db/test/*.sh を置くと赤'
dbtc_fixture
fx_write db/test/new_suite.sh <<'EOF'
#!/usr/bin/env bash
: # RUN にも SKIP にも宣言されていない
EOF
fx_run check-db-test-ci-coverage
expect_red 'db/test/new_suite.sh'
expect_output_matches 'RUN 表にも SKIP 表にも ELSEWHERE 表にも宣言されていません'
t_end

t_begin 'check-db-test-ci-coverage: SKIP 宣言の実体が消えると赤（指す対象が消えた宣言は虚偽）'
dbtc_fixture
rm -f "${FX}/db/test/cross_runtime_steps.sh"
fx_run check-db-test-ci-coverage
expect_red 'SKIP 宣言の db/test/cross_runtime_steps.sh が存在しません'
t_end

t_begin 'check-db-test-ci-coverage: SKIP 宣言から Issue 番号を落とすと赤'
dbtc_fixture
# 実行装置側の SKIP 行から `#NNN` を落とす（理由と追跡先の無い除外を作らせない）。
sed -i.bak "s/|#15[0-9]|/|理由なし|/" "${FX}/scripts/run-db-test-suites.sh"
rm -f "${FX}/scripts/run-db-test-suites.sh.bak"
fx_run check-db-test-ci-coverage
expect_red 'Issue 番号がありません'
t_end

# ---------------------------------------------------------------------------
# ELSEWHERE 宣言の実行先の実在（Issue #158 (b)）
#
# 「CI では実行されるが実行装置からは呼ばない」を表す第 3 の状態。実行装置は呼ばないので
# 何も報告せず、**宣言だけが残る**。job を消しても、ステップを別 job へ移しても、差分にも
# 実行結果にも痕跡が出ないまま CI は全緑を返す — #156 が潰した当の形である。
# 以下の 7 ケースは、ガード側の 7 分岐に 1 対 1 で対応する。
#
# **sed による変異は当たったことを先に assert する。** 当たっていない変異の緑を
# 「検出できなかった」と読み違えると、無効な実験を成功と誤読する（#158 (a) で実際に踏んだ）。
# ---------------------------------------------------------------------------

t_begin 'check-db-test-ci-coverage: ELSEWHERE 宣言の実体が消えると赤'
dbtc_fixture
rm -f "${FX}/db/test/cross_runtime_integration.sh"
fx_run check-db-test-ci-coverage
expect_red 'ELSEWHERE 宣言の db/test/cross_runtime_integration.sh が存在しません'
t_end

t_begin 'check-db-test-ci-coverage: ELSEWHERE 宣言が <workflow>:<job> の形でないと赤'
# 書式が崩れたまま先へ進むと、job 名が空のまま「見つからない」と報告され、原因が
# 「消された」なのか「書式が壊れた」なのか読み手に区別できなくなる。
dbtc_fixture
sed -i.bak 's|ts-ci\.yml:cross-runtime|ts-ci.yml|' "${FX}/scripts/run-db-test-suites.sh"
rm -f "${FX}/scripts/run-db-test-suites.sh.bak"
OUT="MUTATED: $(grep -c "|ts-ci.yml|" "${FX}/scripts/run-db-test-suites.sh")"
expect_output_matches '^MUTATED: 1$'
fx_run check-db-test-ci-coverage
expect_red '<workflow>:<job> の形ではありません'
t_end

t_begin 'check-db-test-ci-coverage: ELSEWHERE の実行先ワークフローが実在しないと赤'
dbtc_fixture
sed -i.bak 's|ts-ci\.yml:cross-runtime|nonexistent.yml:cross-runtime|' "${FX}/scripts/run-db-test-suites.sh"
rm -f "${FX}/scripts/run-db-test-suites.sh.bak"
OUT="MUTATED: $(grep -c 'nonexistent.yml:cross-runtime' "${FX}/scripts/run-db-test-suites.sh")"
expect_output_matches '^MUTATED: 1$'
fx_run check-db-test-ci-coverage
expect_red '実行先ワークフローがありません'
t_end

t_begin 'check-db-test-ci-coverage: 宣言された job をワークフローごと消すと赤（本 PR の中核）'
# **これが #158 (b) を機械強制にしている当のケースである。** ジョブを消しても実行装置は
# 何も報告しない（そもそも呼んでいないため）。ここが赤にならなければ、ELSEWHERE 宣言は
# 「書いてあるだけ」で、CI から外れても誰も気づけない。
dbtc_fixture
sed -i.bak '/^  cross-runtime:$/,$d' "${FX}/.github/workflows/ts-ci.yml"
rm -f "${FX}/.github/workflows/ts-ci.yml.bak"
OUT="MUTATED: $(grep -c 'cross-runtime' "${FX}/.github/workflows/ts-ci.yml")"
expect_output_matches '^MUTATED: 0$'
fx_run check-db-test-ci-coverage
expect_red '実行先ジョブがありません'
t_end

t_begin 'check-db-test-ci-coverage: job は残して実行行だけ消すと赤（ステップの消失）'
# job 名だけを見るガードだと、ステップを消しても・別 job へ移しても緑を返す。
# 参照が **その job のブロック内** にあることまで見る理由がここにある。
dbtc_fixture
sed -i.bak '/cross_runtime_integration\.sh/d' "${FX}/.github/workflows/ts-ci.yml"
rm -f "${FX}/.github/workflows/ts-ci.yml.bak"
OUT="MUTATED: job=$(grep -c '^  cross-runtime:$' "${FX}/.github/workflows/ts-ci.yml") ref=$(grep -c 'cross_runtime_integration' "${FX}/.github/workflows/ts-ci.yml")"
expect_output_matches '^MUTATED: job=1 ref=0$'
fx_run check-db-test-ci-coverage
expect_red "は db/test/cross_runtime_integration.sh を実行していません"
t_end

t_begin 'check-db-test-ci-coverage: 実行先を手動起動だけのワークフローへ移すと赤（蓋が閉じている）'
dbtc_fixture
sed -i.bak '/cross_runtime_integration\.sh/d' "${FX}/.github/workflows/ts-ci.yml"
rm -f "${FX}/.github/workflows/ts-ci.yml.bak"
printf '      - run: bash db/test/cross_runtime_integration.sh\n' >> "${FX}/.github/workflows/manual-only.yml"
sed -i.bak 's|ts-ci\.yml:cross-runtime|manual-only.yml:smoke|' "${FX}/scripts/run-db-test-suites.sh"
rm -f "${FX}/scripts/run-db-test-suites.sh.bak"
OUT="MUTATED: $(grep -c 'manual-only.yml:smoke' "${FX}/scripts/run-db-test-suites.sh")"
expect_output_matches '^MUTATED: 1$'
fx_run check-db-test-ci-coverage
expect_red 'push / pull_request で発火しません'
t_end

t_begin 'check-db-test-ci-coverage: ELSEWHERE 表の書式が変わって抽出が空になると赤'
# 表を改名すると宣言が 0 件へ落ち、cross_runtime_integration.sh が「未宣言」になる。
# 抽出の空振りが**緑ではなく赤**へ倒れることを固定する。
dbtc_fixture
sed -i.bak 's/^ELSEWHERE_SCRIPTS=(/ELSEWHERE_SCRIPTS_RENAMED=(/' "${FX}/scripts/run-db-test-suites.sh"
rm -f "${FX}/scripts/run-db-test-suites.sh.bak"
OUT="MUTATED: $(grep -c '^ELSEWHERE_SCRIPTS_RENAMED=(' "${FX}/scripts/run-db-test-suites.sh")"
expect_output_matches '^MUTATED: 1$'
fx_run check-db-test-ci-coverage
expect_red 'db/test/cross_runtime_integration.sh'
expect_output_matches 'ELSEWHERE 表にも宣言されていません'
t_end

# ---------------------------------------------------------------------------
# 空振り防止（走査の前提が崩れたまま「違反 0 件だから緑」を返さない）
# ---------------------------------------------------------------------------

t_begin 'check-db-test-ci-coverage: ワークフローが 1 件も無いと赤'
dbtc_fixture
rm -f "${FX}"/.github/workflows/*.yml
fx_run check-db-test-ci-coverage
expect_red 'ワークフローファイルが 1 件もありません'
t_end

t_begin 'check-db-test-ci-coverage: スイートの *.sql が 1 件も無いと赤'
dbtc_fixture
rm -f "${FX}"/db/test/assertions/*.sql "${FX}"/db/test/smoke/*.sql
fx_run check-db-test-ci-coverage
expect_red 'スイートディレクトリが 1 件もありません'
t_end

t_begin 'check-db-test-ci-coverage: 実行装置そのものが消えると赤'
dbtc_fixture
rm -f "${FX}/scripts/run-db-test-suites.sh"
fx_run check-db-test-ci-coverage
expect_red '実行装置がありません'
t_end

t_begin 'check-db-test-ci-coverage: RUN/SKIP/ELSEWHERE 表の書式が変わって抽出が空になると赤'
# ガードは実行装置を sed で読む。表の書式が変わると抽出が空になり、
# 「宣言 0 件だから違反 0 件」という**最も静かな緑**へ倒れうる。
# **3 表すべてを潰す。** 1 表だけ残すと合計は 0 件にならず、この分岐へ到達しない
# （その場合は網羅側が赤にする。両方の経路をそれぞれのケースで固定している）。
dbtc_fixture
sed -i.bak 's/^RUN_SCRIPTS=(/RUN_SCRIPTS_RENAMED=(/; s/^SKIP_SCRIPTS=(/SKIP_SCRIPTS_RENAMED=(/; s/^ELSEWHERE_SCRIPTS=(/ELSEWHERE_SCRIPTS_RENAMED=(/' \
  "${FX}/scripts/run-db-test-suites.sh"
rm -f "${FX}/scripts/run-db-test-suites.sh.bak"
OUT="MUTATED: $(grep -c '^[A-Z_]*_RENAMED=(' "${FX}/scripts/run-db-test-suites.sh")"
expect_output_matches '^MUTATED: 3$'
fx_run check-db-test-ci-coverage
expect_red '宣言を 1 件も抽出できません'
t_end
