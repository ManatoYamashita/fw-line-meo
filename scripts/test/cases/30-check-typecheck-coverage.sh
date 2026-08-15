# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/check-typecheck-coverage.sh の自己テスト（Issue #90）。
#
# 本ガードは Issue #51 の「定義されているのに CI から呼ばれない」を機械検出する。
# 呼出の有無は ts-ci.yml という外部ファイルへの依存であり、片方だけ壊れる形が起きやすい。

tcv_fixture() {
  fx_guard check-typecheck-coverage
  fx_write ts/pnpm-workspace.yaml <<'EOF'
packages:
  - 'packages/*'
EOF
  fx_write ts/package.json <<'EOF'
{
  "name": "selftest-root",
  "private": true,
  "scripts": {
    "build:packages": "pnpm --filter \"./packages/**\" run build",
    "typecheck": "pnpm run build:packages && pnpm -r typecheck"
  }
}
EOF
  fx_write ts/packages/w1/package.json <<'EOF'
{
  "name": "w1",
  "private": true,
  "scripts": { "typecheck": "tsc -p tsconfig.json --noEmit" }
}
EOF
  fx_write .github/workflows/ts-ci.yml <<'EOF'
jobs:
  lint-build-test:
    steps:
      - run: pnpm -C ts run build
      - run: pnpm -C ts run typecheck
EOF
}

t_begin 'check-typecheck-coverage: 定義と CI 呼出が揃っていれば緑'
tcv_fixture
fx_run check-typecheck-coverage
expect_green
expect_output_matches '1 workspace'
t_end

t_begin 'check-typecheck-coverage: workspace の typecheck 未定義を検出する'
tcv_fixture
fx_write ts/packages/w1/package.json <<'EOF'
{ "name": "w1", "private": true, "scripts": { "build": "tsc -b" } }
EOF
fx_run check-typecheck-coverage
expect_red '"typecheck" スクリプトがありません'
t_end

t_begin 'check-typecheck-coverage: CI からの呼出漏れを検出する（#51 の穴の再来）'
tcv_fixture
fx_write .github/workflows/ts-ci.yml <<'EOF'
jobs:
  lint-build-test:
    steps:
      - run: pnpm -C ts run build
EOF
fx_run check-typecheck-coverage
expect_red "'pnpm -C ts run typecheck' の呼出がありません"
t_end

t_begin 'check-typecheck-coverage: root の typecheck が build:packages を呼ばない状態を検出する（#66）'
tcv_fixture
fx_write ts/package.json <<'EOF'
{
  "name": "selftest-root",
  "private": true,
  "scripts": {
    "build:packages": "pnpm --filter \"./packages/**\" run build",
    "typecheck": "pnpm -r typecheck"
  }
}
EOF
fx_run check-typecheck-coverage
expect_red '"typecheck" が build:packages を呼んでいません'
t_end

t_begin 'check-typecheck-coverage: workspace を 1 件も拾えないとき緑を返さない（空振り防止）'
tcv_fixture
rm -rf "${FX}/ts/packages"
fx_run check-typecheck-coverage
expect_red '1件も検証できませんでした'
t_end
