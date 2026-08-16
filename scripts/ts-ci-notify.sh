#!/usr/bin/env bash
# Issue #118: main の ts-ci が失敗したことを追跡 Issue で通知する（状態判定と本文の組み立て）。
#
# 背景: main の ts-ci が赤になっても誰にも通知されなかった。deploy-prod には失敗通知ジョブが
# あるが、main の ts-ci が赤いときは deploy ジョブ自体が skip されるため発火しない
# （skip を失敗として扱わないのは正しい判断である）。結果として **「main が赤い」という最も
# 直接的で最も早い信号だけが通知経路を持っていなかった**。2026-08-09 の赤化は 3 時間 53 分後に
# prod-image-drift（症状側・6 時間ごと）が拾い、そこから 2 日放置され、本番が約 2 日 16 時間
# 停滞した。#91 で症状側を塞いだので、ここで原因側を塞ぐ。
#
# 本文の組み立てを yml の run ブロックではなくスクリプトへ置くのは Issue #109 の決定に従う。
# yml へ直接書くと、自己テストが区間の見出しコメントを目印に sed で抽出する脆い形になり、
# 検証対象がスクリプトでないため check-guard-selftest-coverage.sh の孤児ケース検出に掛かる
# （実際に main の ts-ci が 3 日間赤いままになった）。
# **本文の組み立てを ts-ci.yml の run ブロックへ戻さないこと。**
#
# 状態の判定もここに置く。完了条件の「判定対象のジョブ結果を 1 件も取得できない場合は赤にする」は
# 判定側の性質であり、yml の run ブロックへ書くと誰も検証できない。機械可読な出力を別モードへ
# 分ける形は check-deploy-image-coverage.sh --print-targets と同じである。
#
# 本文と状態は stdout へ出す（呼び出し側が `> "$body"` / `$(…)` で受ける）。要約行は stderr へ
# 出し、stdout へ混ぜない。環境変数へは依存せず、run の URL は --run-url で受ける。
#
# 使い方:
#   bash scripts/ts-ci-notify.sh --print-state --job <name>=<result> [--job …]
#     → stdout へ green / red / none を 1 行だけ出す
#
#   bash scripts/ts-ci-notify.sh --state green|red --run-url <url> --commit <sha> \
#        --job <name>=<result> [--job …] > body.md
#     → stdout へ追跡 Issue の本文を出す
#
#   read-only（引数を読むだけ・書き込みは stdout と stderr のみ）・bash 3.2 互換。

set -euo pipefail

mode='body'
state=''
run_url=''
commit=''
# ジョブ結果は "name=result" を改行で連ねて持つ（bash 3.2 に連想配列は無い）。
jobs=''
job_count=0

need_value() {
  # $1 = オプション名 / $2 = 残りの引数個数。値の無いオプションで shift 2 が黙って失敗するのを防ぐ。
  if [ "$2" -lt 2 ]; then
    echo "ERROR: ${1} に値がありません。" >&2
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --print-state) mode='print-state'; shift ;;
    --state) need_value --state "$#"; state="$2"; shift 2 ;;
    --run-url) need_value --run-url "$#"; run_url="$2"; shift 2 ;;
    --commit) need_value --commit "$#"; commit="$2"; shift 2 ;;
    --job)
      need_value --job "$#"
      jobs="${jobs}${2}
"
      job_count=$((job_count + 1))
      shift 2
      ;;
    *)
      echo "ERROR: 未知の引数: $1" >&2
      echo "       → 使い方: --print-state --job <name>=<result> …" >&2
      echo "                 --state green|red --run-url <url> --commit <sha> --job <name>=<result> …" >&2
      exit 1
      ;;
  esac
done

if [ "$mode" = 'print-state' ] && [ -n "$state" ]; then
  echo "ERROR: --print-state と --state は同時に指定できません。" >&2
  echo "       → 判定モードは状態を求めて出力するモードです。渡された状態は使いません。" >&2
  exit 1
fi

# **空振り防止の本命。** ジョブ結果が 1 件も無いまま状態を返すと、「判定したうえで通知不要と
# 判断した」と「何も判定していない」が区別できなくなる。届かなかった通知は観測できないため、
# 判定の空振りは永遠に発見されない。ここは必ず fail する。
if [ "$job_count" -eq 0 ]; then
  echo "ERROR: 判定対象のジョブ結果が 1 件もありません（--job <name>=<result> を渡してください）。" >&2
  echo "       → 判定していない状態を通知不要として返すと、通知装置が沈黙したまま異常なしを意味します。" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 状態の判定
#
#   failure が 1 つでもある            → red
#   すべて success                     → green
#   それ以外（cancelled / skipped 混在）→ none（通知しない）
#
# **cancelled / skipped を red へ倒さない。** docker-build のような PR 限定ジョブや、
# 先行ジョブの失敗で連鎖中断したジョブを失敗として扱うと、main が緑の run で偽の障害通知が飛ぶ。
# かといって green にも倒せない（緑は追跡 Issue を閉じるため、赤いままの障害を復旧したと偽る）。
# よって「判定できない」を第三の状態として持つ。
# ---------------------------------------------------------------------------
failed_jobs=''
all_success=1

# while はパイプではなく here-doc で回す（パイプだと subshell になり集計が呼び出し側へ残らない）。
while IFS= read -r entry; do
  [ -n "$entry" ] || continue

  case "$entry" in
    *=*) ;;
    *)
      echo "ERROR: --job は <name>=<result> の形で渡してください（現在: '${entry}'）。" >&2
      exit 1
      ;;
  esac

  name="${entry%%=*}"
  result="${entry#*=}"

  if [ -z "$name" ]; then
    echo "ERROR: --job のジョブ名が空です（現在: '${entry}'）。" >&2
    exit 1
  fi

  # **結果トークンは厳密に照合する。** `${{ needs.<綴り誤り>.result }}` は GitHub 上でエラーに
  # ならず**空文字へ展開される**。空文字を success 側へ倒すと、綴りを間違えた監視対象は何度
  # 落ちても通知が緑を返し続ける — 監視しているつもりの空振りが最も長く生き残る形である。
  case "$result" in
    success) ;;
    failure)
      all_success=0
      failed_jobs="${failed_jobs}${name} "
      ;;
    cancelled | skipped) all_success=0 ;;
    *)
      echo "ERROR: ジョブ '${name}' の結果が不正です（現在: '${result}'）。" >&2
      echo "       → 期待する値は success / failure / cancelled / skipped です。" >&2
      echo "         needs.<ジョブ名>.result は綴りを間違えると空文字へ展開されます。" >&2
      exit 1
      ;;
  esac
done <<EOF
${jobs}
EOF

if [ -n "$failed_jobs" ]; then
  computed='red'
elif [ "$all_success" -eq 1 ]; then
  computed='green'
else
  computed='none'
fi

if [ "$mode" = 'print-state' ]; then
  # stdout は機械可読な 1 行だけ。診断は stderr へ。
  echo "${computed}"
  echo "OK: ts-ci の状態を判定しました（state=${computed}・${job_count} ジョブ）。" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# 本文の組み立て
# ---------------------------------------------------------------------------

# **state は green / red のどちらかに限る（fail-closed）。**
# `= "red"` の else で red 以外をすべて緑扱いにすると、綴りを間違えた瞬間に、main が赤い最中に
# 「緑へ戻りました」という復旧通知が飛び、追跡 Issue が閉じる。本文が状態を偽る方向へ倒れるのは
# この通知が最も避けたい失敗である（deploy-notify.sh / prod-image-drift-notify.sh と同じ判定）。
case "$state" in
  green | red) ;;
  *)
    echo "ERROR: --state は green か red でなければなりません（現在: '${state}'）。" >&2
    echo "       → 未知の値を緑として扱うと、main が赤い最中に復旧通知が飛びます。" >&2
    exit 1
    ;;
esac

if [ -z "$run_url" ]; then
  echo "ERROR: --run-url が空です。" >&2
  echo "       → 通知から実行 run へ辿れなくなります。" >&2
  exit 1
fi

if [ -z "$commit" ]; then
  echo "ERROR: --commit が空です。" >&2
  echo "       → どの commit で赤くなったのかを通知から特定できなくなります。" >&2
  exit 1
fi

# 状態の判定と本文の組み立ては別々の呼び出しである。両者へ違う引数列が渡ると、判定は red なのに
# 本文は「緑へ戻りました」という組み合わせが成立し、追跡 Issue が赤の最中に閉じる。
# 呼び出し側の配線ミスをここで塞ぐ（判定を 2 度行うのはそのためであり、冗長ではない）。
if [ "$state" != "$computed" ]; then
  echo "ERROR: --state（${state}）とジョブ結果から求めた状態（${computed}）が食い違っています。" >&2
  echo "       → 判定と本文の組み立てへ別々のジョブ結果が渡っています。呼び出し側の配線を直してください。" >&2
  exit 1
fi

if [ "$state" = 'red' ]; then
  echo "main の ts-ci が失敗しました。**main が赤い間は deploy-prod が skip されるため、マージ済みの変更は本番へ反映されません。**"
else
  echo "main の ts-ci が緑へ戻りました。deploy-prod の起動条件（ts-ci の成功）が満たされています。"
fi
echo ""
echo "- run: ${run_url}"
echo "- commit: \`${commit}\`"

# **ここから先は赤専用。** 失敗ジョブの提示も対処手順も、緑で追跡 Issue を閉じるコメントの上では
# 実行すべきでない作業を指す。report-ci-issue.sh は本文を加工せずそのまま送るため、緑で出せば
# 復旧コメントが障害指示として描画される（PR #104 / #112 で実測した defect の同型）。
if [ "$state" = 'red' ]; then
  # 失敗したジョブだけを並べる。全ジョブを並べるとどこを見れば良いかが消え、通知が「赤い」以上の
  # ことを伝えなくなる（本文の唯一の固有情報がこの行である）。
  listed=''
  for name in $failed_jobs; do
    if [ -z "$listed" ]; then
      listed="\`${name}\`"
    else
      listed="${listed} / \`${name}\`"
    fi
  done
  echo "- 失敗したジョブ: ${listed}"
  echo ""
  echo "## 対処"
  echo ""
  echo "1. 上の run で失敗したジョブのログを確認する"
  echo "2. main を緑へ戻す"
  echo ""
  # コマンド例は必ずフェンス内に置く（裸だと行中の # が他 Issue への参照通知を、@ が誤メンションを
  # 飛ばす）。report-ci-issue.sh は本文を加工しないため、フェンスはこの呼び出し側にしか無い。
  echo '```'
  echo "gh run list --workflow ts-ci.yml --branch main"
  echo '```'
  echo ""
  echo "状態が変わらない間はコメントを増やしません。復旧を検出するとこの Issue は自動で閉じます。"
fi

# 要約は stderr へ。stdout は本文専用にしておかないと、リダイレクト先の Issue 本文へ診断行が混ざる。
echo "OK: ts-ci の通知本文を組み立てました（state=${state}・${job_count} ジョブ）。" >&2
