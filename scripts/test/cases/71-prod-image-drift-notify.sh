# .github/workflows/prod-image-drift.yml の**通知本文**の自己テスト（PR #104 のレビュー指摘）。
#
# 背景: report-ci-issue.sh が緑経路で本文を ``` で包むのをやめた結果、呼び出し側の本文が
# そのまま Markdown として描画されるようになった。ところが本ワークフローは緑でも赤用の本文を
# 組んでいたため、復旧コメントに「乖離しています」の断定と「## 対処」手順が**見出し付きで**
# 描画された（実測: Issue #102 のコメント。GitHub /markdown API で h2 0 件 → 2 件、番号付き
# リスト 0 件 → 1 件へ変化することを確認）。包みが隠していた誤りが、包みを外した瞬間に表へ出た。
#
# 検証方法: yml の `# >>> compose-issue-body >>>` 〜 `# <<< compose-issue-body <<<` を抽出して
# **そのまま bash で実走**し、state=green / state=red それぞれの本文を突き合わせる。yml を
# grep で構造照合するだけだと「分岐があること」しか言えず、緑の本文に何が出るかは検証できない。

PIN_YML=.github/workflows/prod-image-drift.yml

pin_compose() {
  # $1 = state。抽出した本文組み立てを実走し、生成された本文を OUT へ入れる。
  # 依存する変数はここで全部与える（yml 側がこれ以外へ依存し始めたら extract で落ちる）。
  OUT=''
  RC=0
  sed -n '/# >>> compose-issue-body >>>/,/# <<< compose-issue-body <<</p' "${FX}/${PIN_YML}" \
    | sed 's/^          //' > "${FX}/compose.sh"
  # 抽出できたか自体を先に確かめる（0 行を実走して「緑」にするのが最悪の空振り）。
  # shellcheck disable=SC2016 # 抽出結果の中の $body を literal として探すので展開させない
  if [ "$(grep -cE '^\s*\} > "\$body"$' "${FX}/compose.sh")" -ne 1 ]; then
    OUT='EXTRACT-FAILED: compose-issue-body の区間を抽出できませんでした'
    RC=1
    return 0
  fi
  printf 'OK: 本番稼働イメージは origin/main（5e9308e）と一致（7 件検証）。\n' > "${FX}/report.txt"
  # shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
  OUT="$(cd "$FX" && \
    state="$1" \
    report="${FX}/report.txt" \
    body="${FX}/issue-body.md" \
    main_short=5e9308e \
    GITHUB_SERVER_URL=https://github.com \
    GITHUB_REPOSITORY=owner/repo \
    GITHUB_RUN_ID=1 \
    bash compose.sh 2>&1 && cat "${FX}/issue-body.md")" || RC=$?
}

# **本命**: 緑（復旧）の本文に、赤用の断定と対処手順を出さないこと。
t_begin 'prod-image-drift 通知: 緑の本文に乖離の断定と対処手順を出さない'
fx_copy "$PIN_YML"
pin_compose green
expect_output_matches '## 検証結果'
expect_output_matches '7 件検証'
expect_absent '乖離しています'
expect_absent '## 対処'
expect_absent '復旧したら deploy-prod を再実行する'
t_end

# 対照: 赤では断定も対処手順も出す。緑の是正で赤まで削ってしまうと、障害通知が無内容になる。
t_begin 'prod-image-drift 通知: 赤の本文には断定と対処手順を出す（対照）'
fx_copy "$PIN_YML"
pin_compose red
expect_output_matches '乖離しています'
expect_output_matches '## 対処'
expect_output_matches '復旧したら deploy-prod を再実行する'
t_end

# コマンド出力を裸で置くと、出力中の #123 が他 Issue への参照通知を、@name が誤メンションを飛ばす。
# report-ci-issue.sh は本文を加工しない契約なので、フェンスはこの呼び出し側にしか無い。
t_begin 'prod-image-drift 通知: 検証結果は必ずフェンス内に置く（緑・赤とも）'
fx_copy "$PIN_YML"
for pin_state in green red; do
  pin_compose "$pin_state"
  OUT="FENCES: $(printf '%s\n' "$OUT" | grep -cE '^```$' || true)"
  expect_output_matches '^FENCES: 2$'
done
t_end
