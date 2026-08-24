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
expect_output_matches 'RUN 表にも SKIP 表にも宣言されていません'
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

t_begin 'check-db-test-ci-coverage: RUN/SKIP 表の書式が変わって抽出が空になると赤'
# ガードは実行装置を sed で読む。表の書式が変わると抽出が空になり、
# 「宣言 0 件だから違反 0 件」という**最も静かな緑**へ倒れうる。
dbtc_fixture
sed -i.bak 's/^RUN_SCRIPTS=(/RUN_SCRIPTS_RENAMED=(/; s/^SKIP_SCRIPTS=(/SKIP_SCRIPTS_RENAMED=(/' \
  "${FX}/scripts/run-db-test-suites.sh"
rm -f "${FX}/scripts/run-db-test-suites.sh.bak"
fx_run check-db-test-ci-coverage
expect_red '宣言を 1 件も抽出できません'
t_end
