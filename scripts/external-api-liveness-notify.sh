#!/usr/bin/env bash
# Issue #139: external-api-liveness の Issue 本文を組み立てる。
#
# **本文の組み立てをワークフローの run ブロックへ戻さないこと。** yml に埋め込むと自己テストが
# 「見出しコメントを sed で抜いて実走する」形になり、Issue #109 では抽出対象のスクリプトが
# 存在しないことで孤児ケース検出に掛かり main の ts-ci が 3 日赤いままになった
# （scripts/prod-image-drift-notify.sh の冒頭コメントに経緯がある）。同じ轍を踏まない。
#
# 本文は **stdout へ出す**。呼び出し側がリダイレクトする（`> "$body"`）。
# **環境変数へ依存しない。** run の URL は呼び出し側で組んで --run-url で渡す。
#
# 状態は 3 つ（scripts/check-external-api-liveness.sh の署名から呼び出し側が導く）:
#   green  places / line-messaging とも ALIVE（追跡 Issue があれば復旧として閉じる本文）
#   warn   赤は無いが UNOBSERVED がある（検証は exit 0・ジョブは緑のまま、追跡 Issue で知らせる本文）
#   red    DEAD / NOT_RUN / 構成の異常（検証は exit 1）
#
# 使い方:
#   bash scripts/external-api-liveness-notify.sh \
#     --state green|warn|red --report <path> --run-url <url> > body.md
#
#   read-only（report を読むだけ・書き込みは stdout のみ）・連想配列を使わず bash 3.2 でも走る。

set -euo pipefail

state=''
report=''
run_url=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --state) state="${2:-}"; shift 2 ;;
    --report) report="${2:-}"; shift 2 ;;
    --run-url) run_url="${2:-}"; shift 2 ;;
    *)
      echo "ERROR: 未知の引数: $1" >&2
      echo "       → 使い方: --state green|warn|red --report <path> --run-url <url>" >&2
      exit 1
      ;;
  esac
done

# **state は green / warn / red のいずれかに限る（fail-closed）。**
# `red 以外はすべて緑` の形にすると、綴りを間違えた瞬間に、API が死んでいる最中へ
# 「生きています」という復旧通知が飛ぶ。
case "$state" in
  green | warn | red) ;;
  *)
    echo "ERROR: --state は green / warn / red のいずれかでなければなりません（現在: '${state}'）。" >&2
    echo "       → 未知の値を緑として扱うと、障害中に復旧通知が飛びます。" >&2
    exit 1
    ;;
esac

if [ -z "$report" ] || [ ! -f "$report" ]; then
  echo "ERROR: --report の検証結果ファイルがありません（現在: '${report}'）。" >&2
  echo "       → 本文の「## 検証結果」が空になり、通知が無内容になります。" >&2
  exit 1
fi

if [ -z "$run_url" ]; then
  echo "ERROR: --run-url が空です。" >&2
  echo "       → 通知から実行 run へ辿れなくなります。" >&2
  exit 1
fi

# 本文は**必ず state で組み分ける**。report-ci-issue.sh は本文を加工せずそのまま送るため、
# 赤用の断定と「## 対処」を緑でも出すと、復旧コメントが見出し付きの障害指示として描画され、
# 不要な障害対応を誘発する（Issue #102 のコメントで実測）。
case "$state" in
  red) echo "外部 API（places / line-messaging）の恒常観測で異常を検出しました（external-api-liveness が自動検出）。" ;;
  warn) echo "外部 API（places / line-messaging）の生死を実トラフィックから判定できていません（external-api-liveness が自動検出）。" ;;
  green) echo "外部 API（places / line-messaging）はどちらも実トラフィックで成功を観測しています（異常は解消済みです）。" ;;
esac
echo ""
echo "- 実行 run: ${run_url}"
echo "- 判定: \`scripts/check-external-api-liveness.sh\`（Issue \`#139\`）"
echo ""
echo "## 検証結果"
echo ""
# コマンド出力は必ずフェンス内に置く（裸だと出力中の # や @ が
# 他 Issue への参照通知・誤メンションを飛ばす）。フェンスはこの呼び出し側にしか無い。
echo '```'
cat "$report"
echo '```'

if [ "$state" = "red" ]; then
  echo ""
  echo "## 対処"
  echo ""
  echo "- **DEAD**（実行して全部失敗した）: 資格情報・課金・API の有効化を疑う。\`bash scripts/run-external-api-smoke.sh\` で実疎通し（手順は \`infra/README.md\` §8）、結果を \`infra/external-api-smoke.tsv\` へ記録する"
  echo "- **NOT_RUN**（実行していない）: API ではなくジョブが走っていない。Cloud Scheduler のトリガーとジョブの状態を確認する"
  echo "- **config-error**: 構成の異常（権限・ジョブ名の改名・応答の形）。検証結果の ERROR 行を読む"
  echo ""
  echo "状態が変わらない間はコメントを増やしません。復旧を検出するとこの Issue は自動で閉じます。"
fi
if [ "$state" = "warn" ]; then
  echo ""
  echo "## この状態の意味"
  echo ""
  echo "**UNOBSERVED は「生きている」ではない。** 実行はあるが判定材料が無い（places の対象店舗が 0 件・指標の作成直後・指標が未作成）。この間、生死の証拠は \`#125\` の手動実疎通（\`infra/external-api-smoke.tsv\`・有効期間 14 日）だけである。"
  echo ""
  echo "指標を terraform apply した直後は、次の実行（daily-batch は毎日 06:00 JST・summary-delivery は毎時）が終わるまでこの状態になる。それを過ぎても続くなら対象店舗の有無と指標の定義を確認する。"
  echo ""
  echo "状態が変わらない間はコメントを増やしません。両方の成功を観測するとこの Issue は自動で閉じます。"
fi
