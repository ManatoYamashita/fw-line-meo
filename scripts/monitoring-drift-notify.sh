#!/usr/bin/env bash
# Issue #230: monitoring-drift の Issue 本文を組み立てる。
#
# **本文の組み立てをワークフローの run ブロックへ戻さないこと。** yml に埋め込むと自己テストが
# 「見出しコメントを sed で抜いて実走する」形になり、Issue #109 では抽出対象のスクリプトが
# 存在しないことで孤児ケース検出に掛かり main の ts-ci が 3 日赤いままになった。同じ轍を踏まない。
#
# 本文は **stdout へ出す**。呼び出し側がリダイレクトする（`> "$body"`）。
# **環境変数へ依存しない。** run の URL は呼び出し側で組んで --run-url で渡す。
#
# secret-version-drift-notify.sh と同じく `--main-short` は持たない。本検証は git の状態に
# 一切依存しない（宣言ファイルと本番の集合だけで判定する）。
#
# 使い方:
#   bash scripts/monitoring-drift-notify.sh \
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
# 「一致しています（乖離は解消済みです）」という復旧通知が飛ぶ。
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
  echo "本番の監視構成が infra/modules/guardrails/main.tf の宣言と乖離しています（monitoring-drift が自動検出）。"
else
  echo "本番の監視構成は infra/modules/guardrails/main.tf の宣言と一致しています（乖離は解消済みです）。"
fi
echo ""
echo "- 実行 run: ${run_url}"
echo "- 宣言（正典）: \`infra/modules/guardrails/main.tf\`"
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
  echo "**\`undeclared-in-prod\`（本番に在って宣言に無い）が出ている場合は、先に \`make tf-plan\` を打つこと。**"
  echo "これは 2026-09-06 に実際に起きた形で、apply 済みなのに .tf が commit されず state だけが保持していた。"
  echo "この状態で \`terraform apply\` すると、**その監視は destroy される**（宣言に無いものは削除対象）。"
  echo ""
  echo "1. \`make tf-plan\` で destroy 予定に入っていないか確認する"
  echo "2. 意図して作った監視なら \`infra/modules/guardrails/main.tf\` へ書き起こす。**state のリソースアドレスに厳密一致させること**（ずれると destroy→create になり、その隙間に起きた障害が誰にも通知されない）"
  echo "3. 不要なら宣言と本番の両方から消す（片方だけ消すと同じ乖離が残る）"
  echo ""
  echo "\`missing-in-prod\`（宣言に在って本番に無い）は apply 忘れか本番からの削除である。宣言だけが在る監視は 1 件も鳴らない。"
  echo ""
  echo "権限不足で落ちている場合は \`infra/modules/cicd-wif\` の \`roles/monitoring.viewer\` の付与を確認して \`make tf-apply\` する。"
  echo ""
  echo "**ポリシーの中身（閾値・filter・通知先）の一致は本ガードの範囲外です**（見ているのは display_name と指標名の集合だけ）。中身は \`terraform plan\` の差分が担当します。"
  echo ""
  echo "状態が変わらない間はコメントを増やしません。復旧を検出するとこの Issue は自動で閉じます。"
fi
