#!/usr/bin/env bash
# Issue #251: prod-schema-drift の追跡 Issue 本文を組み立てる。
#
# 本文は stdout へ出す。緑と赤で断定・対処を分け、report の中身は必ずコードフェンスへ入れる。

set -euo pipefail

state=''
report=''
run_url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --state) state="${2:-}"; shift 2 ;;
    --report) report="${2:-}"; shift 2 ;;
    --run-url) run_url="${2:-}"; shift 2 ;;
    *) echo "ERROR: 未知の引数です: $1" >&2; exit 1 ;;
  esac
done

case "$state" in
  green|red) ;;
  *) echo "ERROR: --state は green か red でなければなりません。" >&2; exit 1 ;;
esac
[ -n "$report" ] && [ -f "$report" ] || { echo "ERROR: --report の検証結果ファイルがありません。" >&2; exit 1; }
[ -n "$run_url" ] || { echo "ERROR: --run-url が空です。" >&2; exit 1; }

if [ "$state" = red ]; then
  echo "本番 Cloud SQL のスキーマが db/migrations 適用後の catalog と乖離しています（prod-schema-drift が自動検出）。"
else
  echo "本番 Cloud SQL のスキーマは db/migrations 適用後の catalog と一致しています（乖離は解消済みです）。"
fi
echo ""
echo "- 実行 run: ${run_url}"
echo "- 比較元: \`db/migrations/*.sql\` を使い捨て PostgreSQL へ適用した catalog"
echo "- 本番側: \`pg_catalog\` の対象名のみ（表の行は読みません）"
echo ""
echo "## 検証結果"
echo ""
echo '```'
cat "$report"
echo '```'

if [ "$state" = red ]; then
  echo ""
  echo "## 対処"
  echo ""
  echo "\`本番に存在しない対象\` は migration の適用漏れ、または本番からの削除を示します。対象の migration を番号順に確認し、\`infra/README.md §3\` の手順で運用者が本番へ適用してください。"
  echo "\`migration に無い本番対象\` は本番だけに残ったスキーマです。migration の欠落・手動変更を調べ、必要な定義を migration に反映してください。"
  echo "適用後は次回の定期検証で自動的に追跡 Issue が閉じます。表の行データや定義内容の差は本検査の対象外です。"
fi
