# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/report-ci-issue.sh の自己テスト（PR #104 のレビュー指摘）。
#
# 背景: 緑（復旧）経路が `--body-file` の内容をもう一度 ``` で包んでいたため、呼び出し側が既に
# フェンスを持つ本文を渡すと内側の ``` が外側を閉じ、復旧コメントの描画が崩れた（Issue #102 で実測）。
# 包みを外して直したが、**復旧本文は dry-run でも直後に rm される一時ファイルにしか現れず**、
# 自己テストから観測できなかった。観測できないものは守れない。run_gh が dry-run で送信本文そのものを
# `DRY-RUN-BODY-BEGIN` / `DRY-RUN-BODY-END` で挟んで出す契約にし、ここで本文を直接照合する。
#
# gh は**スタブで殺す**。dry-run では書き込み系の gh を 1 度も起動しないのが契約であり、
# スタブが起動されたら STUB-GH-INVOKED が出て赤になる（契約の実証も兼ねる）。
#
# 注入変数は必ず rci_run の env 前置きで渡す（ケース側でただ代入しても子プロセスへは渡らない）。
# これを怠ると「追跡 Issue 無し」経路へ落ちて issue create を検証してしまい、コメント経路を
# 検証したつもりの空振りになる。

RCI_TRACKER=''
RCI_PREV_SIG=''

rci_stub_gh() {
  # issue list だけは「該当なし」を返す（追跡 Issue の探索経路を本物のまま通すため）。
  # それ以外＝書き込みは、呼ばれた時点で赤にする。
  mkdir -p "${FX}/stub"
  {
    echo '#!/usr/bin/env bash'
    # shellcheck disable=SC2016 # スタブの中身をそのまま書き出すので展開させない
    echo 'case "${1:-} ${2:-}" in'
    echo "  'issue list') exit 0 ;;"
    echo 'esac'
    # shellcheck disable=SC2016 # 同上
    echo 'echo "STUB-GH-INVOKED: $*" >&2'
    echo 'exit 97'
  } > "${FX}/stub/gh"
  chmod +x "${FX}/stub/gh"
}

rci_body_file() {
  # 呼び出し側が組む本文を模す。**既にフェンスを 1 組持っている**のが要点で、
  # スクリプトがもう 1 組足すと 4 本になり、内側が外側を閉じて描画が崩れる。
  {
    echo "本番 Cloud Run の稼働イメージが main と乖離しています（prod-image-drift が自動検出）。"
    echo ""
    echo "## 検証結果"
    echo ""
    echo '```'
    echo "ERROR: service/dashboard-api のイメージが behind です。"
    echo '```'
  } | fx_write body.md
}

rci_run() {
  # $1 以降 = report-ci-issue.sh へ渡す引数。RCI_TRACKER が空なら追跡 Issue の探索が本物の経路を
  # 通り、スタブの `issue list` が空を返す＝「該当なし」になる。
  OUT=''
  RC=0
  # shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
  OUT="$(cd "$FX" && PATH="${FX}/stub:$PATH" \
    REPORT_CI_ISSUE_DRY_RUN=1 \
    REPORT_CI_ISSUE_FAKE_TRACKER="$RCI_TRACKER" \
    REPORT_CI_ISSUE_FAKE_PREV_SIGNATURE="$RCI_PREV_SIG" \
    bash scripts/report-ci-issue.sh "$@" 2>&1)" || RC=$?
}

rci_sent_body() {
  # DRY-RUN が実際に送る本文だけを OUT へ残す。以後のアサーションは本文そのものに対して行う。
  OUT="$(printf '%s\n' "$OUT" \
    | sed -n '/^DRY-RUN-BODY-BEGIN$/,/^DRY-RUN-BODY-END$/p' | sed '1d;$d')"
}

rci_fences() {
  # 本文中のフェンス行数を数え、OUT を 1 行へ畳む。件数まで見ないと「崩れていない」と言えない。
  OUT="FENCES: $(count_output_matches '^```$')"
}

# **本命**: 復旧コメントが本文を二重のフェンスで包まないこと（Issue #102 の再発検出）。
t_begin 'report-ci-issue: 緑の復旧コメントは本文を二重のフェンスで包まない'
fx_guard report-ci-issue
rci_stub_gh
rci_body_file
RCI_TRACKER=102
rci_run --state green --label prod-image-drift --title t --body-file "${FX}/body.md"
RCI_TRACKER=''
expect_green
expect_absent 'STUB-GH-INVOKED'
# コメント経路を通ったことまで見る。追跡 Issue 無しへ落ちると本文が出ず、下の照合が空振りする。
expect_output_matches '^DRY-RUN: gh issue comment 102 '
expect_output_matches '^DRY-RUN: gh issue close 102 '
rci_sent_body
rci_fences
expect_output_matches '^FENCES: 2$'
t_end

# 本文を加工しないのが契約。見出しや箇条書きが素通しで届くことまで見る。
t_begin 'report-ci-issue: 緑の復旧コメントは呼び出し側の本文をそのまま含む'
fx_guard report-ci-issue
rci_stub_gh
rci_body_file
RCI_TRACKER=102
rci_run --state green --label prod-image-drift --title t --body-file "${FX}/body.md"
RCI_TRACKER=''
expect_green
rci_sent_body
expect_output_matches '^復旧を確認しました。追跡 Issue を閉じます。$'
expect_output_matches '^## 検証結果$'
expect_output_matches '^ERROR: service/dashboard-api のイメージが behind です。$'
t_end

# 対照: 赤も本文を加工しない（署名だけを足す）。緑だけ直して赤を壊していないことを示す。
t_begin 'report-ci-issue: 赤は本文を加工せず署名だけを足す（対照）'
fx_guard report-ci-issue
rci_stub_gh
rci_body_file
RCI_TRACKER=102
RCI_PREV_SIG=old
rci_run --state red --label prod-image-drift --title t --body-file "${FX}/body.md" --signature new
RCI_TRACKER=''
RCI_PREV_SIG=''
expect_green
expect_output_matches '^DRY-RUN: gh issue comment 102 '
rci_sent_body
expect_output_matches '^CI-REPORT-SIGNATURE: new$'
rci_fences
expect_output_matches '^FENCES: 2$'
t_end

# 対照: 署名が変わっていなければコメントしない（同じ障害でコメントを積み上げない契約）。
t_begin 'report-ci-issue: 赤でも署名が同じならコメントしない（対照）'
fx_guard report-ci-issue
rci_stub_gh
rci_body_file
RCI_TRACKER=102
RCI_PREV_SIG=same
rci_run --state red --label prod-image-drift --title t --body-file "${FX}/body.md" --signature same
RCI_TRACKER=''
RCI_PREV_SIG=''
expect_green
expect_output_matches '状態に変化がありません'
expect_absent 'DRY-RUN: gh issue comment'
expect_absent 'DRY-RUN-BODY-BEGIN'
t_end

# 緑で追跡 Issue が無ければ API 書き込みはゼロ。ここが崩れると復旧のたびに空の Issue が動く。
t_begin 'report-ci-issue: 緑で追跡 Issue が無ければ書き込みを一切行わない'
fx_guard report-ci-issue
rci_stub_gh
rci_body_file
rci_run --state green --label prod-image-drift --title t --body-file "${FX}/body.md"
expect_green
expect_output_matches '追跡 Issue はありません'
expect_absent 'DRY-RUN: gh issue'
expect_absent 'STUB-GH-INVOKED'
t_end

# ---------------------------------------------------------------------------
# 赤ケース（Issue #109）。
#
# 本ファイルは導入以来すべて緑ケースで、**「検出できること」を一度も検証していなかった**
# （expect_green=5 / expect_red=0）。run.sh のファイル単位規則はこれを赤にするが、
# その手前で check-guard-selftest-coverage.sh が孤児ケースにより先に落ちていたため、
# run.sh がケースを 1 件も走らせず、この穴は **main が赤い間ずっと隠れていた**。
# 空振り防止が別の空振り防止に隠される形であり、直す順序を誤ると片方しか見えない。
t_begin 'report-ci-issue: 未知の state を受理しない'
fx_guard report-ci-issue
rci_stub_gh
rci_body_file
RCI_TRACKER=102
rci_run --state gren --label prod-image-drift --title t --body-file "${FX}/body.md"
RCI_TRACKER=''
expect_red '--state は red または green を指定してください'
# 受理してしまうと、綴りを間違えただけで「red 以外＝緑」の経路へ落ち、乖離が続いている最中に
# 追跡 Issue を閉じうる。引数の検証は gh の存在確認より前にあるため、書き込みは一切起きないこと。
expect_absent 'DRY-RUN: gh issue'
expect_absent 'STUB-GH-INVOKED'
t_end
