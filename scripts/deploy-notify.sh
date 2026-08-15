#!/usr/bin/env bash
# PR #104 レビュー指摘: deploy-prod の追跡 Issue 本文を組み立てる
# （旧: .github/workflows/deploy.yml の notify ジョブへ直接書かれていた埋め込み bash）。
#
# 経緯: PR #104 が report-ci-issue.sh の緑経路から外側フェンスを外した。それ以前は復旧コメントが
# 本文を丸ごと ``` で包んでいたため、呼び出し側の本文は（内側フェンスと衝突して崩れながらも）
# コードブロックとして描画されていた。包みが外れた結果、**呼び出し側の本文がそのまま Markdown
# として描画される**ようになり、緑でも赤用の文面を出していた箇所が指示文として表へ出た。
#
# prod-image-drift.yml は同 PR で state による組み分けを入れたが、deploy.yml は 1 行目だけを
# 組み分け、後半（失敗の範囲を遡れという指示と復旧後の再実行コマンド）は緑でも無条件に出していた。
# GitHub /markdown API で base / head を実描画した実測:
#
#   「失敗の範囲は…遡って確定してください」  base: <pre> 内（崩れたコードブロック）
#                                            head: <p> として正常な指示文
#
# つまりデプロイ**成功**で追跡 Issue を閉じるコメントが、失敗調査の指示を読める形で掲げていた。
# これは prod-image-drift.yml について「不要な障害対応を誘発する」として潰した defect の同型である。
#
# 組み立てを yml ではなくスクリプトへ置くのは Issue #109 の決定に従う。yml の run ブロックへ
# 直接書くと、自己テストが区間の見出しコメントを目印に sed で抽出する脆い形になり、
# 検証対象がスクリプトでないため check-guard-selftest-coverage.sh の孤児ケース検出に掛かる。
# **本文の組み立てを deploy.yml の run ブロックへ戻さないこと。**
#
# 本文は stdout へ出す（呼び出し側が `> "$body"` でリダイレクトする）。要約行は stderr へ出し、
# 本文へ混ぜない。環境変数へは依存せず、run の URL は --run-url で受ける。
#
# 使い方:
#   bash scripts/deploy-notify.sh \
#     --state green|red --run-url <url> --deployed-sha <sha> > body.md
#
#   read-only（引数を読むだけ・書き込みは stdout と stderr のみ）・bash 3.2 互換。

set -euo pipefail

state=''
run_url=''
deployed_sha=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --state) state="${2:-}"; shift 2 ;;
    --run-url) run_url="${2:-}"; shift 2 ;;
    --deployed-sha) deployed_sha="${2:-}"; shift 2 ;;
    *)
      echo "ERROR: 未知の引数: $1" >&2
      echo "       → 使い方: --state green|red --run-url <url> --deployed-sha <sha>" >&2
      exit 1
      ;;
  esac
done

# **state は green / red のどちらかに限る（fail-closed）。**
# `= "red"` の else で red 以外をすべて緑扱いにすると、綴りを間違えた瞬間に、デプロイが失敗して
# いる最中に「成功しました」という復旧通知が飛ぶ。本文が状態を偽る方向へ倒れるのは、この通知が
# 最も避けたい失敗である（Issue #109 で prod-image-drift-notify.sh へ入れた判定と同じ理由）。
case "$state" in
  green | red) ;;
  *)
    echo "ERROR: --state は green か red でなければなりません（現在: '${state}'）。" >&2
    echo "       → 未知の値を緑として扱うと、失敗中に復旧通知が飛びます。" >&2
    exit 1
    ;;
esac

if [ -z "$run_url" ]; then
  echo "ERROR: --run-url が空です。" >&2
  echo "       → 通知から実行 run へ辿れなくなります。" >&2
  exit 1
fi

if [ -z "$deployed_sha" ]; then
  echo "ERROR: --deployed-sha が空です。" >&2
  echo "       → どの commit が本番へ反映されたのかを通知から特定できなくなります。" >&2
  exit 1
fi

if [ "$state" = "red" ]; then
  echo "deploy-prod が失敗しました。**本番は旧イメージのままです。**"
else
  echo "deploy-prod が成功しました。"
fi
echo ""
echo "- run: ${run_url}"
echo "- 反映対象 commit: \`${deployed_sha}\`"
# **ここから先は赤専用。** 失敗の範囲を遡れという指示も、復旧後の再実行コマンドも、
# デプロイが成功して追跡 Issue を閉じるコメントの上では実行すべきでない作業を指す。
# report-ci-issue.sh が本文を加工せずそのまま送る以上、緑で出せば指示文としてそのまま描画される。
if [ "$state" = "red" ]; then
  echo ""
  echo "deploy-prod は workflow_run 起動のため PR のチェック欄には現れません。"
  echo "失敗の範囲は「最後に成功した run」まで遡って確定してください（当日分だけ見ると過小報告になります）。"
  echo ""
  # コマンド例は必ずフェンス内に置く（裸だと行中の # や @ が
  # 他 Issue への参照通知・誤メンションを飛ばす）。report-ci-issue.sh は本文を加工しないため、
  # フェンスはこの呼び出し側にしか無い。
  echo '```'
  echo "gh run list --workflow deploy.yml"
  echo "gh workflow run deploy.yml --ref main   # 復旧後の再実行"
  echo '```'
fi

# 要約は stderr へ。stdout は本文専用にしておかないと、リダイレクト先の Issue 本文へ診断行が混ざる。
echo "OK: deploy-prod の通知本文を組み立てました（state=${state}）。" >&2
