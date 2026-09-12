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
# 状態は 3 つ:
#   green  すべて有効期間内で期限間近も無い（追跡 Issue があれば復旧として閉じる本文）
#   warn   有効期間内だが期限間近（検証は exit 0・ジョブは緑のまま、追跡 Issue で予告する本文）
#   red    未実施・期限切れ（検証は exit 1）
# 有効期限は検証結果の機械可読行 `EXTERNAL-API-SMOKE-EXPIRY: YYYY-MM-DD`
# （scripts/check-external-api-smoke-freshness.sh の契約）から取る。WARN 行の散文は解析しない。
#
# 使い方:
#   bash scripts/external-api-smoke-notify.sh \
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
# `red 以外はすべて緑` の形にすると、綴りを間違えた瞬間に、実疎通が未実施のまま
# 「すべて有効期間内です」という復旧通知が飛ぶ。本文が状態を偽る方向へ倒れるのは、
# このワークフローが最も避けたい失敗である。
case "$state" in
  green | warn | red) ;;
  *)
    echo "ERROR: --state は green / warn / red のいずれかでなければなりません（現在: '${state}'）。" >&2
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

# --- 有効期限の行（期限間近のときだけ検証が出す） ---------------------------------------------
#
# 行の有無を先に数え（書式を問わない）、書式どおりの日付はその 1 行からだけ取る。数える段で
# 書式まで絞ると、崩れた行が「行が無い」と同義になり、緑の拒否（下）をすり抜ける。
# 終了コードを捕捉し、無一致（exit 1）と読めない・評価不能（exit 2 以上）を分ける（Issue #120）。
expiry_rc=0
expiry_lines="$(grep -c '^EXTERNAL-API-SMOKE-EXPIRY:' "$report")" || expiry_rc=$?
if [ "$expiry_rc" -gt 1 ]; then
  echo "ERROR: 検証結果ファイルから有効期限の行を走査できません（grep exit=${expiry_rc}）。" >&2
  exit 1
fi
expiry=''
if [ "${expiry_lines:-0}" -eq 1 ]; then
  expiry="$(sed -n 's/^EXTERNAL-API-SMOKE-EXPIRY: \([0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\)$/\1/p' "$report")"
fi

# 期限間近なのに有効期限を示せない予告は「いつまでに」を欠いた無内容な通知になる。
if [ "$state" = "warn" ] && [ -z "$expiry" ]; then
  echo "ERROR: --state warn ですが、検証結果に有効期限の行（EXTERNAL-API-SMOKE-EXPIRY: YYYY-MM-DD）がちょうど 1 行ありません（該当行 ${expiry_lines:-0} 行）。" >&2
  echo "       → 期限を告げられない予告は、いつまでに叩けばよいかを告げない無内容な通知になります。" >&2
  exit 1
fi

# 期限間近を示す検証結果を緑（復旧）として組み立てない。組み立てると report-ci-issue.sh が
# 予告中の追跡 Issue を「復旧」として閉じ、予告が黙って消える。ここへ来るのは呼び出し側
# （ワークフロー）が署名の warn を state へ写し損ねたときであり、黙って緑へ倒さず赤で告げる。
if [ "$state" = "green" ] && [ "${expiry_lines:-0}" -ne 0 ]; then
  echo "ERROR: 検証結果は期限間近を示しています（EXTERNAL-API-SMOKE-EXPIRY の行があります）が、--state green が渡されました。" >&2
  echo "       → 復旧の本文を組むと、予告中の追跡 Issue が閉じられて予告が消えます。" >&2
  echo "         呼び出し側が署名の <api>=warn; を state へ反映できているか確認してください。" >&2
  exit 1
fi

# 赤と予告に共通の対処手順。予告は「期限までに同じことをする」だけなので、手順を二重に持たない
# （片方だけ直る日が来る）。
print_remedy() {
  echo "1. \`infra/README.md\` §8 の手順で該当 API を**本番に対して実際に叩く**（\`bash scripts/run-external-api-smoke.sh --place-id <place_id> --model <GEMINI_MODEL> --channel-id <LINE_CHANNEL_ID>\` で 3 API まとめて実行できます。値の調べ方は §8-0）"
  echo "2. 全て成功したら、同じ PR で \`infra/external-api-smoke.tsv\` の該当行の最終確認日と証拠を更新する"
  echo "3. 失敗した場合は**キーそのものが死んでいます**。\`infra/README.md\` §1 項目 5 で実値を投入し直し、\`infra/secrets-provisioned.tsv\` も同じ PR で更新する"
  echo ""
  echo "**日付だけを更新して実疎通を省略しないでください。** このガードは人間の実施を強制できず、記録の鮮度しか見ていません。証拠欄は「本当に叩いたのか」を第三者が後から辿るための唯一の手掛かりです。"
  echo ""
  echo "実疎通は CI では行いません。CI へ \`roles/secretmanager.secretAccessor\` を付けることは Req 5.4 に反するため、鍵は CI へ渡さない設計です（\`infra/README.md\` §5）。"
}

# 本文は**必ず state で組み分ける**。report-ci-issue.sh は本文を加工せずそのまま送るため、
# 赤用の断定と「## 対処」を緑でも出すと、復旧コメントが見出し付きの障害指示として描画され、
# 不要な障害対応を誘発する（Issue #102 のコメントで実測）。予告も同じで、期限前に
# 「期限切れです」と断定すると予告と障害の区別が付かなくなる。
case "$state" in
  red)
    echo "外部 API への実疎通が未実施または期限切れです（external-api-smoke-freshness が自動検出）。"
    ;;
  warn)
    echo "外部 API への実疎通記録が期限間近です（external-api-smoke-freshness が自動検出）。"
    echo ""
    echo "有効期限: **${expiry}**（JST）。この日の検証までは有効期間内で、翌日の検証から期限切れ（赤）になります。まだ期限切れではないため、このジョブは緑のままです。"
    ;;
  green)
    echo "外部 API への実疎通はすべて有効期間内です（未実施・期限切れ・期限間近はいずれも解消済みです）。"
    ;;
esac
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
case "$state" in
  red)
    echo ""
    echo "## 対処"
    echo ""
    print_remedy
    echo ""
    echo "状態が変わらない間はコメントを増やしません。復旧を検出するとこの Issue は自動で閉じます。"
    ;;
  warn)
    echo ""
    echo "## 対処（${expiry} までに）"
    echo ""
    print_remedy
    echo ""
    echo "記録の更新が main へ載れば、次の実行で緑になりこの Issue は自動で閉じます。叩き直さないまま期限を過ぎると、同じ Issue へ期限切れとしてコメントが付きます。状態が変わらない間はコメントを増やしません。"
    ;;
  green) ;;
esac
