#!/usr/bin/env bash
# Issue #109: prod-image-drift の Issue 本文を組み立てる（旧: prod-image-drift.yml の埋め込み bash）。
#
# 経緯: 本文の組み立ては PR #104 まで `.github/workflows/prod-image-drift.yml` の run ブロックへ
# 直接書かれており、自己テスト（scripts/test/cases/71-prod-image-drift-notify.sh）は
# `# >>> compose-issue-body >>>` 区間を **sed で抽出して実走**していた。抽出は動いていたが、
# 検証対象がスクリプトでないため `scripts/prod-image-drift-notify.sh` が存在せず、
# check-guard-selftest-coverage.sh の孤児ケース検出（ケース名 → 実在するスクリプト）に掛かって
# **main の ts-ci が赤いまま 3 日間放置された**。ts-ci が赤いと deploy-prod が起動しないため、
# 乖離が解消せず prod-image-drift も 6 時間ごとに失敗し続けた。1 つの赤が 2 本を止めていた。
#
# したがって本文の組み立ては yml ではなくここに置く。副次的に次も直る:
#   - 「yml から bash を sed で抜いて実走する」という、区間の見出しコメントに依存した脆い検証が消える
#   - yml へ 1 行足すたびに抽出が壊れないかを気にする必要が無くなる
#
# 本文は **stdout へ出す**。呼び出し側がリダイレクトする（`> "$body"`）。ファイル書き込みにすると
# 自己テストが出力先を用意して読み直す必要があり、検証の器が余計に増える。
#
# **環境変数へ依存しない。** 旧実装は GITHUB_SERVER_URL / GITHUB_REPOSITORY / GITHUB_RUN_ID を
# 直接参照していたが、それだと「CI でしか組み立てられない」形になり、契約が暗黙になる。
# run の URL は呼び出し側で組んで --run-url で渡す。
#
# 使い方:
#   bash scripts/prod-image-drift-notify.sh \
#     --state green|red --report <path> --main-short <sha> --run-url <url> > body.md
#
#   read-only（report を読むだけ・書き込みは stdout のみ）・連想配列を使わず bash 3.2 でも走る。

set -euo pipefail

state=''
report=''
main_short=''
run_url=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --state) state="${2:-}"; shift 2 ;;
    --report) report="${2:-}"; shift 2 ;;
    --main-short) main_short="${2:-}"; shift 2 ;;
    --run-url) run_url="${2:-}"; shift 2 ;;
    *)
      echo "ERROR: 未知の引数: $1" >&2
      echo "       → 使い方: --state green|red --report <path> --main-short <sha> --run-url <url>" >&2
      exit 1
      ;;
  esac
done

# **state は green / red のどちらかに限る（fail-closed）。**
# 旧実装は `if [ "$state" = "red" ]; then … else …` の形で、**red 以外はすべて緑**として扱っていた。
# state の綴りを間違えた瞬間、乖離が続いている最中に「一致しています（乖離は解消済みです）」という
# 復旧通知が飛ぶ。本文が状態を偽る方向へ倒れるのは、このワークフローが最も避けたい失敗である。
# 判定は呼び出し側（yml の DRIFT_STATUS）にあるため、ここで綴りを厳密に照合しても実害は無い。
case "$state" in
  green | red) ;;
  *)
    echo "ERROR: --state は green か red でなければなりません（現在: '${state}'）。" >&2
    echo "       → 未知の値を緑として扱うと、乖離中に復旧通知が飛びます。" >&2
    exit 1
    ;;
esac

if [ -z "$report" ] || [ ! -f "$report" ]; then
  echo "ERROR: --report の検証結果ファイルがありません（現在: '${report}'）。" >&2
  echo "       → 本文の「## 検証結果」が空になり、通知が無内容になります。" >&2
  exit 1
fi

if [ -z "$main_short" ]; then
  echo "ERROR: --main-short が空です。" >&2
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
if [ "$state" = "red" ]; then
  echo "本番 Cloud Run の稼働イメージが main と乖離しています（prod-image-drift が自動検出）。"
else
  echo "本番 Cloud Run の稼働イメージは main と一致しています（乖離は解消済みです）。"
fi
echo ""
echo "- 実行 run: ${run_url}"
echo "- main: \`${main_short}\`"
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
  echo "1. main で ts-ci が緑か確認する（赤いと deploy-prod が起動せず、乖離が解消しない）"
  echo "2. 直近の deploy-prod を確認する: \`gh run list --workflow deploy.yml\`"
  echo "3. GCP の課金と WIF を確認する（gcp-auth-smoke を workflow_dispatch で起動）"
  echo "4. 復旧したら deploy-prod を再実行する: \`gh workflow run deploy.yml --ref main\`"
  echo ""
  echo "状態が変わらない間はコメントを増やしません。復旧を検出するとこの Issue は自動で閉じます。"
fi
