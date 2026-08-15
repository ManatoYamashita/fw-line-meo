# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# scripts/ts-ci-notify.sh の自己テスト（Issue #118）。
#
# 背景: main の ts-ci が赤になっても誰にも通知されなかった。deploy-prod の通知ジョブは
# 「ts-ci が赤いと deploy が skip される → skip は失敗ではないので黙る」という正しい判断のために
# 発火しない。結果、**最も直接的で最も早い信号だけが通知経路を持っていなかった**。
# 2026-08-09 の赤化は 3 時間 53 分後に prod-image-drift（症状側）が拾い、そこから 2 日放置された。
#
# 本ケースが守るものは 3 つある。
#   1. 緑と赤で文面が組み分かること。report-ci-issue.sh は本文を加工せずそのまま送るため、
#      出し分けの責務は呼び出し側にある（PR #104 / #112 で実際に破れた）。
#   2. 判定が cancelled / skipped を red へ倒さないこと。docker-build は PR 限定ジョブであり、
#      これを失敗として扱うと main push のたびに偽の障害通知が飛ぶ。
#   3. 監視対象（notify の needs と --job 引数）が ts-ci.yml の job 一覧から漏れないこと。
#      漏れても通知は「残りのジョブについては正しく」動くため、差分にも実行結果にも痕跡が出ない。
#
# 検証対象はスクリプトである。**yml の run ブロックから本文の組み立てを sed で抽出して実走する
# 形へ戻さないこと**（Issue #109 の実績: 検証対象がスクリプトでないため孤児ケースとして
# main の ts-ci が 3 日間赤になった）。下の配線照合は yml を読むが、実走ではなく**宣言の照合**で
# あり、run.sh の check_ci_tier_wiring と同型である。

TCN_RUN_URL=https://github.com/owner/repo/actions/runs/1
TCN_SHA=5e9308e
TCN_YML="${ROOT}/.github/workflows/ts-ci.yml"

tcn_compose() {
  # $1 = state。本文の組み立てを実走し、**stdout だけ**を OUT へ入れる。
  # stderr まで混ぜると、要約行（`OK: …`）を本文の一部として照合してしまう。
  # ジョブ結果は state と整合させる（スクリプトが両者の食い違いを赤にするため）。
  if [ "$1" = 'red' ]; then
    tcn_jobs_args='--job lint-build-test=failure --job e2e=failure --job lighthouse=success'
  else
    tcn_jobs_args='--job lint-build-test=success --job e2e=success --job lighthouse=success'
  fi
  # shellcheck disable=SC2086 # tcn_jobs_args は意図的に単語分割する
  fx_run_stdout ts-ci-notify \
    --state "$1" \
    --run-url "$TCN_RUN_URL" \
    --commit "$TCN_SHA" \
    $tcn_jobs_args
}

# ---------------------------------------------------------------------------
# 本文の組み分け
# ---------------------------------------------------------------------------

# **本命**: 緑（復旧）の本文に、赤用の断定・対処手順・失敗ジョブ行を出さないこと。
t_begin 'ts-ci 通知: 緑の本文に失敗の断定と対処手順を出さない'
fx_guard ts-ci-notify
tcn_compose green
expect_output_matches '^main の ts-ci が緑へ戻りました。'
# パターンを `-` で始めない（`grep -cE "$1"` へ渡るためオプションと解釈され exit=2 になる）。
expect_output_matches '^- commit:'
expect_absent 'ts-ci が失敗しました'
expect_absent '本番へ反映されません'
expect_absent '## 対処'
expect_absent '失敗したジョブ'
expect_absent 'gh run list --workflow ts-ci.yml'
t_end

# 対照: 赤では断定も対処手順も失敗ジョブ名も出す。緑の是正で赤まで削ってしまうと、
# 「main が赤い間は本番へ反映されない」という最も伝えるべき事実が通知から消える。
t_begin 'ts-ci 通知: 赤の本文には失敗の断定と対処手順と失敗ジョブ名を出す（対照）'
fx_guard ts-ci-notify
tcn_compose red
expect_output_matches '^main の ts-ci が失敗しました。'
expect_output_matches '本番へ反映されません'
expect_output_matches '## 対処'
expect_output_matches '失敗したジョブ: .*lint-build-test'
expect_output_matches '失敗したジョブ: .*e2e'
expect_output_matches 'gh run list --workflow ts-ci.yml'
t_end

# 成功したジョブを失敗として並べないこと。全部並べてしまうと、どこを見れば良いかが消えて
# 通知が「赤い」以上のことを伝えなくなる（本文の唯一の固有情報が失敗ジョブ名である）。
t_begin 'ts-ci 通知: 赤の失敗ジョブ行に成功したジョブを混ぜない'
fx_guard ts-ci-notify
fx_run_stdout ts-ci-notify \
  --state red \
  --run-url "$TCN_RUN_URL" \
  --commit "$TCN_SHA" \
  --job lint-build-test=success \
  --job e2e=failure \
  --job lighthouse=success
expect_output_matches '失敗したジョブ: `e2e`$'
expect_absent 'lint-build-test'
expect_absent 'lighthouse'
t_end

# コマンド例を裸で置くと、行中の #123 が他 Issue への参照通知を、@name が誤メンションを飛ばす。
# report-ci-issue.sh は本文を加工しない契約なので、フェンスはこの呼び出し側にしか無い。
# 緑にはコマンド例そのものが無いためフェンスは 0 本になる（件数まで見ないと「崩れていない」と言えない）。
t_begin 'ts-ci 通知: 赤のコマンド例はフェンス内に置き、緑にはフェンスを出さない'
fx_guard ts-ci-notify
tcn_compose red
OUT="FENCES: $(printf '%s\n' "$OUT" | grep -cE '^```$' || true)"
expect_output_matches '^FENCES: 2$'
tcn_compose green
OUT="FENCES: $(printf '%s\n' "$OUT" | grep -cE '^```$' || true)"
expect_output_matches '^FENCES: 0$'
t_end

# 緑の正常終了。要約行は stderr へ出すので、ここだけ stderr を混ぜて受ける。
# 本文が 1 行も出ないまま exit 0 する経路（最悪の空振り）と区別するため、要約行と本文の両方を見る。
t_begin 'ts-ci 通知: 緑は要約行を stderr へ出して正常終了する'
fx_guard ts-ci-notify
fx_run_args ts-ci-notify \
  --state green \
  --run-url "$TCN_RUN_URL" \
  --commit "$TCN_SHA" \
  --job lint-build-test=success \
  --job e2e=success \
  --job lighthouse=success
expect_green
expect_output_matches 'state=green'
expect_output_matches '^main の ts-ci が緑へ戻りました。'
t_end

# ---------------------------------------------------------------------------
# 状態判定（--print-state）
#
# 判定をスクリプトへ置くのは、完了条件の「判定対象のジョブ結果を 1 件も取得できない場合は
# 赤にする」が判定側の性質だからである。yml の run ブロックに置くと、この表を誰も検証できない。
# ---------------------------------------------------------------------------

tcn_state() {
  # 引数をそのまま渡し、**stdout だけ**を OUT へ入れる（機械可読な出力に診断行が混ざらないこと）。
  fx_run_stdout ts-ci-notify --print-state "$@"
}

t_begin 'ts-ci 通知: 全ジョブ success なら green'
fx_guard ts-ci-notify
tcn_state --job lint-build-test=success --job e2e=success --job lighthouse=success
expect_output_matches '^green$'
# 機械可読な出力に人間向けの行を混ぜない（要約行は stderr）。1 行であることまで見る。
OUT="LINES: $(printf '%s\n' "$OUT" | wc -l | tr -d ' ')"
expect_output_matches '^LINES: 1$'
t_end

t_begin 'ts-ci 通知: 1 つでも failure なら red'
fx_guard ts-ci-notify
tcn_state --job lint-build-test=success --job e2e=failure --job lighthouse=success
expect_output_matches '^red$'
t_end

# **完了条件**: cancelled / skipped を red へ倒さない。倒すと、main が緑のまま一部ジョブが
# 中断しただけの run で偽の障害通知が飛び、追跡 Issue の信頼が失われる（狼少年になった通知は
# 通知が無いのと同じである）。かといって green にもできない（緑なら追跡 Issue を閉じてしまい、
# 実際には赤いままの障害を「復旧した」と偽る）。よって none = 通知しない。
t_begin 'ts-ci 通知: failure が無く cancelled / skipped が混じるときは none（red へ倒さない）'
fx_guard ts-ci-notify
tcn_state --job lint-build-test=success --job e2e=cancelled --job lighthouse=success
expect_output_matches '^none$'
tcn_state --job lint-build-test=success --job e2e=skipped --job lighthouse=success
expect_output_matches '^none$'
# 対照: 同じ組み合わせでも failure が 1 つ混じれば red（cancelled が red を握り潰さないこと）。
tcn_state --job lint-build-test=failure --job e2e=cancelled --job lighthouse=skipped
expect_output_matches '^red$'
t_end

# ---------------------------------------------------------------------------
# 空振り防止と fail-closed
#
# 通知装置の失敗は「通知が来ない」という形で現れる。届かなかった通知は観測できないため、
# 装置は黙って成功してはならない。すべて exit 1 にし、本文は 1 行も出さない。
# ---------------------------------------------------------------------------

# **空振り防止の本命**（完了条件）。ジョブ結果が 1 件も無いのに緑を返すと、
# 「判定したうえで通知不要と判断した」と「何も判定していない」が区別できなくなる。
t_begin 'ts-ci 通知: 判定対象のジョブ結果が 0 件なら赤にする'
fx_guard ts-ci-notify
fx_run_args ts-ci-notify --print-state
expect_red '判定対象のジョブ結果が 1 件もありません'
expect_absent 'green'
t_end

# `${{ needs.<綴り誤り>.result }}` は**空文字へ展開される**。GitHub は未知のジョブ名を
# エラーにしないため、綴りを間違えた監視対象はここでしか捕まらない（空文字を success 側へ
# 倒せば、そのジョブが何度落ちても通知は永遠に緑を返す）。
t_begin 'ts-ci 通知: ジョブ結果が空文字なら赤にする（needs のジョブ名の綴り誤り）'
fx_guard ts-ci-notify
fx_run_args ts-ci-notify --print-state --job lint-build-test=success --job e2e=
expect_red 'e2e'
expect_absent 'green'
t_end

t_begin 'ts-ci 通知: 未知の結果トークンを赤にする'
fx_guard ts-ci-notify
fx_run_args ts-ci-notify --print-state --job lint-build-test=succes
expect_red 'succes'
expect_absent 'green'
t_end

t_begin 'ts-ci 通知: name=result の形でない --job を赤にする'
fx_guard ts-ci-notify
fx_run_args ts-ci-notify --print-state --job lint-build-test
expect_red 'lint-build-test'
expect_absent 'green'
t_end

# deploy-notify.sh / prod-image-drift-notify.sh と同じ理由。`= "red"` の else で red 以外を
# すべて緑扱いにすると、綴りを間違えた瞬間に main が赤い最中へ復旧通知が飛ぶ。
t_begin 'ts-ci 通知: 未知の state を緑として扱わない'
fx_guard ts-ci-notify
fx_run_args ts-ci-notify \
  --state gren \
  --run-url "$TCN_RUN_URL" \
  --commit "$TCN_SHA" \
  --job lint-build-test=success
expect_red '--state は green か red でなければなりません'
# **照合は本文にしか現れない語へ当てる。** 診断文の言い回しを変えただけでケースが転ぶのを避ける。
expect_absent '緑へ戻りました'
t_end

# 状態判定と本文の組み立ては別々の呼び出しである。両者へ違う引数列が渡ると、判定は red なのに
# 本文は「緑へ戻りました」という組み合わせが成立する。呼び出し側の配線ミスをスクリプト側で塞ぐ。
t_begin 'ts-ci 通知: --state とジョブ結果の食い違いを黙って通さない'
fx_guard ts-ci-notify
fx_run_args ts-ci-notify \
  --state green \
  --run-url "$TCN_RUN_URL" \
  --commit "$TCN_SHA" \
  --job lint-build-test=failure
expect_red 'ジョブ結果から求めた状態'
expect_absent '緑へ戻りました'
t_end

t_begin 'ts-ci 通知: run URL が空なら無内容の本文を返さない'
fx_guard ts-ci-notify
fx_run_args ts-ci-notify \
  --state green \
  --commit "$TCN_SHA" \
  --job lint-build-test=success
expect_red '--run-url が空です'
expect_absent '緑へ戻りました'
t_end

t_begin 'ts-ci 通知: commit が空なら無内容の本文を返さない'
fx_guard ts-ci-notify
fx_run_args ts-ci-notify \
  --state green \
  --run-url "$TCN_RUN_URL" \
  --job lint-build-test=success
expect_red '--commit が空です'
expect_absent '緑へ戻りました'
t_end

# ---------------------------------------------------------------------------
# 配線照合: 監視対象が ts-ci.yml の job 一覧から漏れていないこと
#
# ジョブを 1 つ足して notify の needs / --job へ入れ忘れても、通知は残りのジョブについては
# 正しく動く。したがって差分にも実行結果にも痕跡が出ない — #33（tf のサービスが push 対象に
# 無い）・#51（typecheck が定義されているのに CI から呼ばれない）と同じ形状である。
# ここで照合するのは**宣言**であり、yml から bash を抽出して実走する #109 の形ではない。
# ---------------------------------------------------------------------------

# ts-ci.yml の top-level job 名（`jobs:` 直下の 2 スペースキー）。
tcn_yml_jobs() {
  awk '
    /^jobs:[[:space:]]*$/  { injobs = 1; next }
    /^[^[:space:]#]/       { injobs = 0 }
    injobs && /^  [A-Za-z][A-Za-z0-9_-]*:[[:space:]]*$/ {
      name = $0
      sub(/:[[:space:]]*$/, "", name)
      sub(/^  /, "", name)
      print name
    }
  ' "$TCN_YML"
}

# notify が ts-ci-notify.sh へ渡しているジョブ名（`--job "<name>=…"`）。
tcn_yml_watched() {
  grep -oE -- '--job "[A-Za-z0-9_-]+=' "$TCN_YML" \
    | sed -e 's/^--job "//' -e 's/=$//' \
    | sort -u
}

# notify ジョブの `needs:` 一覧。
tcn_yml_needs() {
  awk '
    /^  notify:[[:space:]]*$/ { innotify = 1; next }
    innotify && /^  [A-Za-z]/ { innotify = 0 }
    innotify && /^[[:space:]]+needs:/ {
      line = $0
      sub(/^[[:space:]]*needs:[[:space:]]*/, "", line)
      gsub(/[][,]/, " ", line)
      n = split(line, a, " ")
      for (i = 1; i <= n; i++) if (a[i] != "") print a[i]
    }
  ' "$TCN_YML" | sort -u
}

# $1 の各行のうち $2 に無いものを空白区切りで返す（無ければ none）。
# 集合演算に comm を使わないのは、両側を毎回 sort する前提を持ち込むと、片側の抽出が壊れて
# 空になったときに「差分なし」と読める緑を返すからである（空振りは下で件数として別に見る）。
tcn_missing() {
  tcn_m_out=''
  while IFS= read -r tcn_m_x; do
    [ -n "$tcn_m_x" ] || continue
    case "
$2
" in
      *"
${tcn_m_x}
"*) ;;
      *) tcn_m_out="${tcn_m_out}${tcn_m_x} " ;;
    esac
  done <<EOF
$1
EOF
  if [ -z "$tcn_m_out" ]; then
    printf 'none'
  else
    printf '%s' "${tcn_m_out% }"
  fi
}

tcn_count() {
  [ -n "$1" ] || { printf '0'; return 0; }
  printf '%s\n' "$1" | wc -l | tr -d ' '
}

t_begin 'ts-ci 通知: 監視対象が ts-ci.yml の job 一覧と一致する（漏れも綴り誤りも検出）'
tcn_all_jobs="$(tcn_yml_jobs)"
tcn_watched="$(tcn_yml_watched)"
tcn_needs="$(tcn_yml_needs)"

# 空振り防止。抽出が 0 件のまま「差分なし」を返すのは、この照合自身の空振りである。
OUT="JOBS: $(tcn_count "$tcn_all_jobs") WATCHED: $(tcn_count "$tcn_watched") NEEDS: $(tcn_count "$tcn_needs")"
expect_output_matches '^JOBS: [1-9][0-9]* WATCHED: [1-9][0-9]* NEEDS: [1-9][0-9]*$'

# 除外している 2 件が実在すること。改名されると除外だけが残り、その job が無言で監視外になる。
OUT="EXCLUDED-MISSING: $(tcn_missing 'notify
docker-build' "$tcn_all_jobs")"
expect_output_matches '^EXCLUDED-MISSING: none$'

# (1) notify と docker-build を除く全 job が監視対象であること。
#     docker-build を除くのは PR イベント限定のジョブで main push では常に skipped になるため
#     （needs へ入れると judge が none へ倒れ、通知が永久に飛ばなくなる）。
tcn_expected=''
while IFS= read -r tcn_j; do
  [ -n "$tcn_j" ] || continue
  case "$tcn_j" in
    notify | docker-build) continue ;;
  esac
  tcn_expected="${tcn_expected}${tcn_j}
"
done <<EOF
$tcn_all_jobs
EOF
OUT="UNWATCHED: $(tcn_missing "$tcn_expected" "$tcn_watched")"
expect_output_matches '^UNWATCHED: none$'

# (2) 逆方向。実在しない job を監視していないこと（`${{ needs.<綴り誤り>.result }}` は
#     空文字へ展開されるだけでエラーにならないため、ここで名前の実在まで見る）。
OUT="PHANTOM: $(tcn_missing "$tcn_watched" "$tcn_all_jobs")"
expect_output_matches '^PHANTOM: none$'

# (3) needs と --job の食い違い。片方だけ増やしても、もう片方が黙って監視外を作る。
OUT="NEEDS-NOT-WATCHED: $(tcn_missing "$tcn_needs" "$tcn_watched")"
expect_output_matches '^NEEDS-NOT-WATCHED: none$'
OUT="WATCHED-NOT-IN-NEEDS: $(tcn_missing "$tcn_watched" "$tcn_needs")"
expect_output_matches '^WATCHED-NOT-IN-NEEDS: none$'
t_end
