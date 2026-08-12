# scripts/prod-image-drift-notify.sh の自己テスト（PR #104 のレビュー指摘 / Issue #109）。
#
# 背景: report-ci-issue.sh が緑経路で本文を ``` で包むのをやめた結果、呼び出し側の本文が
# そのまま Markdown として描画されるようになった。ところが本ワークフローは緑でも赤用の本文を
# 組んでいたため、復旧コメントに「乖離しています」の断定と「## 対処」手順が**見出し付きで**
# 描画された（実測: Issue #102 のコメント。GitHub /markdown API で h2 0 件 → 2 件、番号付き
# リスト 0 件 → 1 件へ変化することを確認）。包みが隠していた誤りが、包みを外した瞬間に表へ出た。
#
# 検証方法の変遷（Issue #109）: 導入時は組み立てが prod-image-drift.yml へ直接書かれていたため、
# `# >>> compose-issue-body >>>` 区間を **sed で抽出して実走**していた。抽出は動いていたが、
# 検証対象がスクリプトでないため `scripts/prod-image-drift-notify.sh` が存在せず、
# check-guard-selftest-coverage.sh の孤児ケース検出に掛かって **main の ts-ci が 3 日間赤**に
# なった。組み立てをスクリプトへ切り出したことで、抽出という脆い手順ごと不要になっている。
# **yml から本文を抽出する形へ戻さないこと。** 区間見出しのコメント 1 行で検証が壊れる。

pin_report() {
  # 検証結果ファイル。本文へフェンス付きで埋め込まれる。
  fx_write report.txt <<'EOF'
OK: 本番稼働イメージは origin/main（5e9308e）と一致（7 件検証）。
EOF
}

pin_compose() {
  # $1 = state。組み立てを実走し、**stdout だけ**を OUT へ入れる。
  # stderr まで混ぜると、診断行を本文の一部として照合してしまう。
  fx_run_stdout prod-image-drift-notify \
    --state "$1" \
    --report report.txt \
    --main-short 5e9308e \
    --run-url https://github.com/owner/repo/actions/runs/1
}

# **本命**: 緑（復旧）の本文に、赤用の断定と対処手順を出さないこと。
t_begin 'prod-image-drift 通知: 緑の本文に乖離の断定と対処手順を出さない'
fx_guard prod-image-drift-notify
pin_report
pin_compose green
# 正常終了であることも見る。`OK:` は本スクリプト自身の要約行ではなく、**検証結果ファイルの
# 内容がそのまま本文へ載っている**ことを示す（drift 検証の成功行が `OK: …` である）。
# つまりこの 1 行で「exit 0」と「report を素通しで埋め込んだ」の両方を固定できる。
expect_green
expect_output_matches '## 検証結果'
expect_output_matches '7 件検証'
expect_absent '乖離しています'
expect_absent '## 対処'
expect_absent '復旧したら deploy-prod を再実行する'
t_end

# 対照: 赤では断定も対処手順も出す。緑の是正で赤まで削ってしまうと、障害通知が無内容になる。
t_begin 'prod-image-drift 通知: 赤の本文には断定と対処手順を出す（対照）'
fx_guard prod-image-drift-notify
pin_report
pin_compose red
expect_output_matches '乖離しています'
expect_output_matches '## 対処'
expect_output_matches '復旧したら deploy-prod を再実行する'
t_end

# コマンド出力を裸で置くと、出力中の #123 が他 Issue への参照通知を、@name が誤メンションを飛ばす。
# report-ci-issue.sh は本文を加工しない契約なので、フェンスはこの呼び出し側にしか無い。
t_begin 'prod-image-drift 通知: 検証結果は必ずフェンス内に置く（緑・赤とも）'
fx_guard prod-image-drift-notify
pin_report
for pin_state in green red; do
  pin_compose "$pin_state"
  OUT="FENCES: $(printf '%s\n' "$OUT" | grep -cE '^```$' || true)"
  expect_output_matches '^FENCES: 2$'
done
t_end

# ---------------------------------------------------------------------------
# 切り出しに伴って足した fail-closed の検証（Issue #109）。
#
# 旧実装は `if [ "$state" = "red" ]; then … else …` の形で、**red 以外はすべて緑**として扱った。
# state の綴りを間違えた瞬間、乖離が続いている最中に「一致しています（乖離は解消済みです）」という
# 復旧通知が飛ぶ。本文が状態を偽る方向へ倒れるのは、このワークフローが最も避けたい失敗である。

t_begin 'prod-image-drift 通知: 未知の state を緑として扱わない'
fx_guard prod-image-drift-notify
pin_report
fx_run_args prod-image-drift-notify \
  --state gren \
  --report report.txt \
  --main-short 5e9308e \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '--state は green か red でなければなりません'
# 綴り誤りが緑の本文として通ると、乖離中に復旧通知が飛ぶ。本文を 1 行も出していないこと。
expect_absent '一致しています'
t_end

t_begin 'prod-image-drift 通知: 検証結果ファイルが無ければ無内容の本文を返さない'
fx_guard prod-image-drift-notify
fx_run_args prod-image-drift-notify \
  --state red \
  --report missing-report.txt \
  --main-short 5e9308e \
  --run-url https://github.com/owner/repo/actions/runs/1
expect_red '検証結果ファイルがありません'
# 本文を 1 行も出していないこと。**照合は本文の先頭文ヘ当てる。** 見出し（`## 検証結果`）は
# エラーメッセージ自身が「本文の『## 検証結果』が空になり」と説明のために含んでおり、
# 診断文の言い回しを変えただけでケースが赤/緑へ転ぶ。本文にしか現れない語を選ぶこと。
expect_absent '本番 Cloud Run'
t_end
