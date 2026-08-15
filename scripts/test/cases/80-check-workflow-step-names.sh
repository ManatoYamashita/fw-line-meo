# scripts/check-workflow-step-names.sh の自己テスト（Issue #105）。
#
# 本ガードは「引用符なしの `name:` に ` #` が入ると表示名がそこで切れる」を機械検出する。
# YAML としては妥当なので構文チェックには映らず、CI ログの見た目でしか気づけない類の欠陥である。
#
# 誤検出しないことの担保が要る観点が 2 つある。引用符で囲んであれば `#` を含んでよいこと、
# および `#` の直前に空白が無ければ（`build#1`）YAML はコメントにしないので緑であること。
# 前者を落とすと既存の全ステップが赤くなり、後者を落とすと無関係な名前まで書き換えさせられる。
#
# 検出は 2 形ある。値の途中の ` #` は表示名を **途中で切り**、値の先頭の `#` は値ごと捨てて
# 表示名を **消す**。後者は PR #113 のレビューで検出漏れが実測された形である。

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

wsn_whitelist() {
  # 合成ツリーへ複製したガードの `WHITELIST=()` へ項目を注入する（$1 = 括弧の中身をそのまま）。
  # `sed -i` はプラットフォームで引数が異なるため awk と mv で行う。
  awk -v entry="$1" '
    /^WHITELIST=\(\)$/ { print "WHITELIST=(" entry ")"; next }
    { print }
  ' "${FX}/scripts/check-workflow-step-names.sh" > "${FX}/scripts/wsn-whitelist.tmp"
  mv "${FX}/scripts/wsn-whitelist.tmp" "${FX}/scripts/check-workflow-step-names.sh"

  # **注入が当たったことを先に確かめる。** 空振りしたまま走らせると、ガードが元のまま緑を
  # 返した結果を「WHITELIST が効いた証拠」と読み違える（[[guard-before-fix-discipline]]）。
  if [ "$(grep -cF "$1" "${FX}/scripts/check-workflow-step-names.sh")" -eq 0 ]; then
    _t_fail "WHITELIST の注入が空振りしました: $1"
  fi
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

# ---------------------------------------------------------------------------
# 値の先頭が `#`（PR #113 レビュー指摘1）。YAML は値ごとコメントとして捨てるので
# name は null になり、表示名は「切れる」のではなく **消える**。切れた名前より観測が
# 難しいうえ、検出条件が「2 つ目の空白付き #」だったため素通りしていた。

t_begin 'check-workflow-step-names: 値の先頭が # の name を検出する（name が null になる形）'
wsn_fixture
fx_write .github/workflows/nullname.yml <<'EOF'
name: nullname
jobs:
  build:
    steps:
      - name: #105 再発防止ガード
        run: echo hi
EOF
fx_run check-workflow-step-names
expect_red 'nullname.yml:5 の name: の値が # で始まります'
expect_output_matches '105 再発防止ガード'
t_end

t_begin 'check-workflow-step-names: 先頭と途中の両方に # がある行を二重報告しない'
wsn_fixture
fx_write .github/workflows/both.yml <<'EOF'
name: both
jobs:
  build:
    steps:
      - name: #105 のガード # 補足
        run: echo hi
EOF
fx_run check-workflow-step-names
# 原因は 1 つ（値ごと捨てられる）なので、切れる側の指示を重ねて出してはいけない。
expect_red 'both.yml:5 の name: の値が # で始まります'
expect_absent '引用符で囲まれておらず'
expect_output_matches 'が 1 件あります'
t_end

t_begin 'check-workflow-step-names: 対照 — 先頭の # も引用符で囲めば緑'
wsn_fixture
fx_write .github/workflows/quoted.yml <<'EOF'
name: quoted
jobs:
  build:
    steps:
      - name: '#105 再発防止ガード'
        run: echo hi
EOF
fx_run check-workflow-step-names
expect_green
t_end

# ---------------------------------------------------------------------------
# `.yaml` 拡張子（PR #113 レビュー指摘3）。glob は両拡張子を並べているが、`.yaml` の
# workflow がリポジトリに 1 件も無いため、この分岐が消えても誰も検出できなかった。

t_begin 'check-workflow-step-names: .yaml 拡張子の workflow も走査対象に含める'
wsn_fixture
fx_write .github/workflows/release.yaml <<'EOF'
name: release
jobs:
  release:
    steps:
      - name: Placeholder 稼働検出（Issue #33 再発防止）
        run: echo hi
EOF
fx_run check-workflow-step-names
expect_red "release.yaml:5 の name: が引用符で囲まれておらず ' #' を含みます"
t_end

# ---------------------------------------------------------------------------
# WHITELIST（PR #113 レビュー指摘2）。除外の同定を行番号で行うと、上に行が挿入された
# だけで **別の行の違反を無言で抑止する**。同定は行の内容で行い、当たらなくなった項目は
# WARNING で回収を促す（check-deploy-image-coverage.sh / check-guard-selftest-coverage.sh と同形）。

t_begin 'check-workflow-step-names: WHITELIST は行の内容で照合し、上に行が増えても同定がずれない'
wsn_fixture
fx_write .github/workflows/hasrun.yml <<'EOF'
name: hasrun
jobs:
  build:
    steps:
      - name: 先に足された無関係なステップ
        run: echo first
      - name: 除外したい行 # これは run ブロック内の見かけ上の name である
        run: echo hi
EOF
wsn_whitelist "'hasrun.yml|- name: 除外したい行 # これは run ブロック内の見かけ上の name である'"
fx_run check-workflow-step-names
expect_green
expect_output_matches 'SKIP: hasrun.yml:7'
t_end

t_begin 'check-workflow-step-names: 当たらなくなった WHITELIST 項目を WARNING で報告する'
wsn_fixture
wsn_whitelist "'ci.yml|- name: 既に是正済みの行 # 残骸'"
fx_run check-workflow-step-names
expect_green
expect_output_matches 'WARNING: .*既に是正済みの行.* は WHITELIST に載っていますが'
t_end

# ---------------------------------------------------------------------------
# Issue #120: 検出パターンが評価不能になったとき、緑ではなく赤にすること。
#
# 起票時の実測では、scan() の照合が後置 `true` で失敗を潰していたため、引用符なし + ' #' の
# 違反を置いたままガードが exit 0 を返した。空振り防止の母数は別パターン（NAME_LINE_RE）
# なので生き残り、「5 ファイル / 42 件の name: を検証」と **件数まで健全な実行と一致**した。
# 痕跡は stderr の 1 行だけで、CI ログでは他の出力に埋もれる。
t_begin 'check-workflow-step-names: 検出パターンが評価不能なら緑ではなく赤にする（Issue #120）'
wsn_fixture
fx_write .github/workflows/deploy.yml <<'EOF'
name: deploy
jobs:
  deploy:
    steps:
      - name: Placeholder 稼働検出（Issue #33 再発防止）
        run: echo hi
EOF
awk '/^TRUNC_LINE_RE=/ { print "TRUNC_LINE_RE='"'"'['"'"'"; next } { print }' \
  "${FX}/scripts/check-workflow-step-names.sh" > "${FX}/scripts/wsn-broken.tmp"
mv "${FX}/scripts/wsn-broken.tmp" "${FX}/scripts/check-workflow-step-names.sh"
fx_run check-workflow-step-names
expect_red '検出パターンを評価できません'
t_end
