#!/usr/bin/env bash
# Issue #63: secret-version-drift の Issue 本文を組み立てる。
#
# **本文の組み立てをワークフローの run ブロックへ戻さないこと。** yml に埋め込むと自己テストが
# 「見出しコメントを sed で抜いて実走する」形になり、Issue #109 では抽出対象のスクリプトが
# 存在しないことで孤児ケース検出に掛かり main の ts-ci が 3 日赤いままになった
# （scripts/prod-image-drift-notify.sh の冒頭コメントに経緯がある）。同じ轍を踏まない。
#
# 本文は **stdout へ出す**。呼び出し側がリダイレクトする（`> "$body"`）。
# **環境変数へ依存しない。** run の URL は呼び出し側で組んで --run-url で渡す（CI でしか
# 組み立てられない形にすると契約が暗黙になる）。
#
# prod-image-drift-notify.sh と違い `--main-short` は持たない。本検証は git の状態に一切
# 依存しない（version 番号と state だけで判定する）ため、本文へ main の SHA を入れる意味が無い。
#
# 使い方:
#   bash scripts/secret-version-drift-notify.sh \
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
# `red 以外はすべて緑` の形にすると、綴りを間違えた瞬間に、乖離が続いている最中へ
# 「一致しています（乖離は解消済みです）」という復旧通知が飛ぶ。本文が状態を偽る方向へ
# 倒れるのは、このワークフローが最も避けたい失敗である。
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

if [ -z "$run_url" ]; then
  echo "ERROR: --run-url が空です。" >&2
  echo "       → 通知から実行 run へ辿れなくなります。" >&2
  exit 1
fi

# 本文は**必ず state で組み分ける**。report-ci-issue.sh は本文を加工せずそのまま送るため、
# 赤用の断定と「## 対処」を緑でも出すと、復旧コメントが見出し付きの障害指示として描画され、
# 不要な障害対応を誘発する（Issue #102 のコメントで実測）。
if [ "$state" = "red" ]; then
  echo "本番 Secret Manager の version 構成が infra/secrets-provisioned.tsv の宣言と乖離しています（secret-version-drift が自動検出）。"
else
  echo "本番 Secret Manager の version 構成は infra/secrets-provisioned.tsv の宣言と一致しています（乖離は解消済みです）。"
fi
echo ""
echo "- 実行 run: ${run_url}"
echo "- 宣言（正典）: \`infra/secrets-provisioned.tsv\`"
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
  echo "1. まず **宣言が正しいか** を疑う（実値を投入した PR で \`infra/secrets-provisioned.tsv\` を更新し忘れていませんか）"
  echo "2. 実値が未投入なら \`infra/README.md\` の §1 項目 5 の \`gcloud secrets versions add\` を実行し、**同じ PR で宣言の version と投入日と参照を更新する**"
  echo "3. 旧 version が ENABLED のまま残っているなら disable する: \`gcloud secrets versions disable <n> --secret=<id> --project=<PROJECT_ID>\`（disable は可逆。destroy は使わない）"
  echo "4. 権限不足で落ちているなら \`infra/modules/cicd-wif\` の \`metadata_viewer_secret_ids\` を配線して \`make tf-apply\` する"
  echo ""
  echo "**値そのものの正当性は本ガードの範囲外です**（CI は payload を読めません）。失効キーや別プロジェクトのキーは検出できないため、外部 API への疎通確認は別途行ってください。"
  echo ""
  echo "状態が変わらない間はコメントを増やしません。復旧を検出するとこの Issue は自動で閉じます。"
fi
