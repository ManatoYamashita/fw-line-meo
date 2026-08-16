#!/usr/bin/env bash
# Issue #125: external-api-smoke-freshness の Issue 本文を組み立てる。
#
# **本文の組み立てをワークフローの run ブロックへ戻さないこと。** yml に埋め込むと自己テストが
# 「見出しコメントを sed で抜いて実走する」形になり、Issue #109 では抽出対象のスクリプトが
# 存在しないことで孤児ケース検出に掛かり main の ts-ci が 3 日赤いままになった
# （scripts/prod-image-drift-notify.sh の冒頭コメントに経緯がある）。同じ轍を踏まない。
#
# 本文は **stdout へ出す**。呼び出し側がリダイレクトする（`> "$body"`）。
# **環境変数へ依存しない。** run の URL は呼び出し側で組んで --run-url で渡す。
#
# 使い方:
#   bash scripts/external-api-smoke-notify.sh \
#     --state green|red --report <path> --run-url <url> > body.md
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
      echo "       → 使い方: --state green|red --report <path> --run-url <url>" >&2
      exit 1
      ;;
  esac
done

# **state は green / red のどちらかに限る（fail-closed）。**
# `red 以外はすべて緑` の形にすると、綴りを間違えた瞬間に、実疎通が未実施のまま
# 「すべて有効期間内です」という復旧通知が飛ぶ。本文が状態を偽る方向へ倒れるのは、
# このワークフローが最も避けたい失敗である。
case "$state" in
  green | red) ;;
  *)
    echo "ERROR: --state は green か red でなければなりません（現在: '${state}'）。" >&2
    echo "       → 未知の値を緑として扱うと、未実施のまま復旧通知が飛びます。" >&2
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
if [ "$state" = "red" ]; then
  echo "外部 API への実疎通が未実施または期限切れです（external-api-smoke-freshness が自動検出）。"
else
  echo "外部 API への実疎通はすべて有効期間内です（未実施・期限切れは解消済みです）。"
fi
echo ""
echo "- 実行 run: ${run_url}"
echo "- 記録（正典）: \`infra/external-api-smoke.tsv\`"
echo "- 実疎通の手順: \`infra/README.md\` §8"
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
  echo "1. \`infra/README.md\` §8 の手順で該当 API を**本番に対して実際に叩く**（\`bash scripts/run-external-api-smoke.sh --place-id <place_id> --model <GEMINI_MODEL> --channel-id <LINE_CHANNEL_ID>\` で 3 API まとめて実行できます。値の調べ方は §8-0）"
  echo "2. 全て成功したら、同じ PR で \`infra/external-api-smoke.tsv\` の該当行の最終確認日と証拠を更新する"
  echo "3. 失敗した場合は**キーそのものが死んでいます**。\`infra/README.md\` §1 項目 5 で実値を投入し直し、\`infra/secrets-provisioned.tsv\` も同じ PR で更新する"
  echo ""
  echo "**日付だけを更新して実疎通を省略しないでください。** このガードは人間の実施を強制できず、記録の鮮度しか見ていません。証拠欄は「本当に叩いたのか」を第三者が後から辿るための唯一の手掛かりです。"
  echo ""
  echo "実疎通は CI では行いません。CI へ \`roles/secretmanager.secretAccessor\` を付けることは Req 5.4 に反するため、鍵は CI へ渡さない設計です（\`infra/README.md\` §5）。"
  echo ""
  echo "状態が変わらない間はコメントを増やしません。復旧を検出するとこの Issue は自動で閉じます。"
fi
