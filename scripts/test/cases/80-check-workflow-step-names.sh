# scripts/check-workflow-step-names.sh の自己テスト（Issue #105）。
#
# 本ガードは「引用符なしの `name:` に ` #` が入ると表示名がそこで切れる」を機械検出する。
# YAML としては妥当なので構文チェックには映らず、CI ログの見た目でしか気づけない類の欠陥である。
#
# 誤検出しないことの担保が要る観点が 2 つある。引用符で囲んであれば `#` を含んでよいこと、
# および `#` の直前に空白が無ければ（`build#1`）YAML はコメントにしないので緑であること。
# 前者を落とすと既存の全ステップが赤くなり、後者を落とすと無関係な名前まで書き換えさせられる。

wsn_fixture() {
  fx_guard check-workflow-step-names

  fx_write .github/workflows/ci.yml <<'EOF'
name: ci
jobs:
  build:
    steps:
      - name: 'デザイントークンガード（Issue #41）'
        run: bash scripts/check-design-tokens.sh
      - name: "コードカバレッジガード（Issue #70 / #78）"
        run: bash scripts/check-test-code-coverage.sh
      - name: 依存インストール
        run: pnpm install
EOF
}

t_begin 'check-workflow-step-names: 引用符で囲まれていれば # を含んでも緑（件数まで照合）'
wsn_fixture
fx_run check-workflow-step-names
expect_green
# 「OK」だけでなく件数を照合する。走査が空振りしたまま緑になる経路と区別するため。
expect_output_matches '1 ファイル / 4 件の name: を検証'
t_end

# ---------------------------------------------------------------------------
# 本命: 引用符なし + ' #'。#89 / #100 / #106 で 3 度繰り返した形そのもの。

t_begin 'check-workflow-step-names: 引用符なしで # を含む name を検出する'
wsn_fixture
fx_write .github/workflows/deploy.yml <<'EOF'
name: deploy
jobs:
  deploy:
    steps:
      - name: Placeholder 稼働検出（Issue #33 再発防止）
        run: echo hi
EOF
fx_run check-workflow-step-names
expect_red "deploy.yml:5 の name: が引用符で囲まれておらず ' #' を含みます"
# 該当行そのものを添えて出す（どのステップかを名前で特定できないのが元の問題なので）。
expect_output_matches 'Placeholder 稼働検出'
t_end

t_begin 'check-workflow-step-names: 対照 — # の直前に空白が無ければ緑（コメントにならない）'
wsn_fixture
fx_write .github/workflows/build.yml <<'EOF'
name: build
jobs:
  build:
    steps:
      - name: build#1 の再実行
        run: echo hi
EOF
fx_run check-workflow-step-names
expect_green
expect_absent 'build#1'
t_end

# ---------------------------------------------------------------------------
# 空振り防止。対象 0 件のまま「違反 0 件だから緑」を返すのが最悪の結果である。

t_begin 'check-workflow-step-names: ワークフローが 1 件も無いとき緑を返さない（空振り防止）'
fx_guard check-workflow-step-names
mkdir -p "${FX}/.github/workflows"
fx_run check-workflow-step-names
expect_red 'ワークフローファイルが 1 件もありません'
t_end

t_begin 'check-workflow-step-names: name: 行を 1 件も拾えないとき緑を返さない（空振り防止）'
fx_guard check-workflow-step-names
fx_write .github/workflows/empty.yml <<'EOF'
on: push
jobs:
  build:
    steps:
      - run: echo hi
EOF
fx_run check-workflow-step-names
expect_red 'name: 行を 1 件も検出できませんでした'
t_end

t_begin 'check-workflow-step-names: ワークフローディレクトリ消失を空振りとして報告する'
fx_guard check-workflow-step-names
fx_run check-workflow-step-names
expect_red 'ワークフローディレクトリがありません'
t_end
