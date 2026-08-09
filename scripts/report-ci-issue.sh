#!/usr/bin/env bash
# Issue #91: CI の異常を GitHub Issue で通知する共用ユーティリティ。
#
# 背景: deploy-prod は workflow_run 起動のため PR のチェック欄に現れず、2026-08-08〜09 に
# 6 回連続で失敗しても誰にも通知されなかった。本スクリプトは「追跡 Issue を 1 本だけ維持する」
# 方式で通知する（ラベルごとに 1 本）。ドリフト検証（prod-image-drift）と deploy-prod の失敗通知が
# 共用する。
#
# 動作:
#   状態  追跡Issue  動作
#   ----  ---------  --------------------------------------------------
#   red   無し       起票する（gh issue create --label <label>）
#   red   有り       署名が前回と同じなら**何もしない**／変わっていればコメントする
#   green 有り       復旧コメントを付けて close する
#   green 無し       何もしない（API 書き込みゼロ）
#
# **Issue 増殖を絶対に起こさないための 3 原則**（運用事故として最も痛いのがこれ）:
#   1. 追跡 Issue の同定は**ラベル**で行う。Issue の list API は強一貫だが、検索 API
#      （タイトル一致・本文マーカー）はインデックス反映にラグがあり、ラグ中に「見つからない →
#      新規起票」を繰り返して Issue が増殖する。
#   2. 追跡 Issue の**検索に失敗したら（レート制限・権限不足）起票せずに fail する**。
#      盲目的な create が増殖の唯一の経路であるため、ここだけは fail-closed にする。
#   3. 探索は `--state open` に限る。復旧で閉じた過去の追跡 Issue を再利用しない
#      （再発は新しい Issue として立つほうが履歴が読める）。
#
# 使い方:
#   bash scripts/report-ci-issue.sh --state red|green --label <label> --title <title> \
#        --body-file <path> [--signature <string>]
#
#   --signature は「同じ状態が続く間はコメントを増やさない」ための鍵。本文末尾へ
#   `CI-REPORT-SIGNATURE: <string>` の 1 行として埋め込み、次回は追跡 Issue の本文とコメントから
#   最後の出現を読んで比較する（外部に状態を持たない）。
#
# 環境変数:
#   GH_TOKEN                gh の認証トークン（ワークフローでは ${{ github.token }}）
#   GH_REPO                 対象リポジトリ（owner/repo）。gh のリモート自動判定に依存しない
#   REPORT_CI_ISSUE_DRY_RUN 1 なら gh の書き込みを実行せず、打つはずのコマンドを出力する
#
# 注意: 本文にコマンド出力を載せるときは**必ずフェンス（```）の中に入れること**。裸で置くと
# `#123` が他 Issue への参照通知を飛ばし、`@name` が誤メンションになる。

set -euo pipefail

state=""
label=""
title=""
body_file=""
signature=""

while [ $# -gt 0 ]; do
  case "$1" in
    --state) state="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    --title) title="${2:-}"; shift 2 ;;
    --body-file) body_file="${2:-}"; shift 2 ;;
    --signature) signature="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *)
      echo "ERROR: 未知の引数です: $1" >&2
      exit 2
      ;;
  esac
done

case "$state" in
  red|green) ;;
  *)
    echo "ERROR: --state は red または green を指定してください（指定値: '${state}'）。" >&2
    exit 2
    ;;
esac
if [ -z "$label" ] || [ -z "$title" ] || [ -z "$body_file" ]; then
  echo "ERROR: --label / --title / --body-file は必須です。" >&2
  exit 2
fi
if [ ! -f "$body_file" ]; then
  echo "ERROR: --body-file が見つかりません: ${body_file}" >&2
  exit 2
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI が見つかりません。" >&2
  exit 1
fi

dry_run="${REPORT_CI_ISSUE_DRY_RUN:-}"

run_gh() {
  if [ -n "$dry_run" ]; then
    printf 'DRY-RUN:'
    printf ' %s' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

# ---------------------------------------------------------------------------
# 追跡 Issue の同定（fail-closed）
# ---------------------------------------------------------------------------
tracker=""
tracker_count=0
if [ -n "$dry_run" ] && [ -n "${REPORT_CI_ISSUE_FAKE_TRACKER:-}" ]; then
  # dry-run 時の注入（分岐の実証用）。空文字なら「追跡 Issue 無し」を意味する。
  tracker="${REPORT_CI_ISSUE_FAKE_TRACKER}"
  [ -n "$tracker" ] && tracker_count=1
else
  if ! tracker_json="$(gh issue list --label "$label" --state open --limit 5 --json number 2>&1)"; then
    echo "ERROR: 追跡 Issue の検索に失敗しました（label=${label}）。" >&2
    printf '%s\n' "$tracker_json" | sed 's/^/       | /' >&2
    echo "       → ここで起票すると、検索が失敗するたびに Issue が増殖します。起票せずに fail します。" >&2
    exit 1
  fi
  tracker_count="$(printf '%s' "$tracker_json" | tr ',' '\n' | grep -c '"number"' || true)"
  tracker="$(printf '%s' "$tracker_json" | tr ',' '\n' | grep '"number"' | sed -E 's/[^0-9]*([0-9]+).*/\1/' | sed -n '1p' || true)"
fi

if [ "$tracker_count" -gt 1 ]; then
  echo "WARNING: ラベル '${label}' の open な Issue が ${tracker_count} 件あります。最新の #${tracker} へ報告します。" >&2
  echo "         → 手動起票と衝突している可能性があります。不要なものを閉じてください。" >&2
fi

# ---------------------------------------------------------------------------
# 緑（復旧）
# ---------------------------------------------------------------------------
if [ "$state" = "green" ]; then
  if [ -z "$tracker" ]; then
    echo "OK: 追跡 Issue はありません（通知不要）。"
    exit 0
  fi
  recover_body="$(mktemp)"
  {
    echo "復旧を確認しました。追跡 Issue を閉じます。"
    echo ""
    echo '```'
    cat "$body_file"
    echo '```'
  } > "$recover_body"
  run_gh gh issue comment "$tracker" --body-file "$recover_body"
  run_gh gh issue close "$tracker" --reason completed
  rm -f "$recover_body"
  echo "OK: 追跡 Issue #${tracker} へ復旧を報告し、閉じました。"
  exit 0
fi

# ---------------------------------------------------------------------------
# 赤
# ---------------------------------------------------------------------------
payload="$(mktemp)"
cat "$body_file" > "$payload"
if [ -n "$signature" ]; then
  {
    echo ""
    echo "CI-REPORT-SIGNATURE: ${signature}"
  } >> "$payload"
fi

if [ -z "$tracker" ]; then
  # ラベルは冪等に用意する（初回のみ実際に作られる）。
  if [ -z "$dry_run" ]; then
    gh label create "$label" --color B60205 --description "CI が自動で維持する追跡 Issue（scripts/report-ci-issue.sh）" >/dev/null 2>&1 || true
  else
    echo "DRY-RUN: gh label create ${label}（既存なら無視）"
  fi
  run_gh gh issue create --title "$title" --label "$label" --body-file "$payload"
  rm -f "$payload"
  echo "OK: 追跡 Issue を起票しました（label=${label}）。"
  exit 0
fi

# 既存の追跡 Issue: 署名が変わっていなければ何もしない（同じ障害でコメントを積み上げない）。
if [ -n "$signature" ]; then
  prev=""
  if [ -n "$dry_run" ] && [ -n "${REPORT_CI_ISSUE_FAKE_PREV_SIGNATURE+x}" ]; then
    prev="${REPORT_CI_ISSUE_FAKE_PREV_SIGNATURE}"
  else
    if ! seen="$(gh issue view "$tracker" --json body,comments \
      --jq '[.body] + [.comments[].body] | .[]' 2>&1)"; then
      echo "ERROR: 追跡 Issue #${tracker} の読み取りに失敗しました。" >&2
      printf '%s\n' "$seen" | sed 's/^/       | /' >&2
      exit 1
    fi
    prev="$(printf '%s\n' "$seen" | grep '^CI-REPORT-SIGNATURE: ' | tail -n 1 | sed 's/^CI-REPORT-SIGNATURE: //' || true)"
  fi
  if [ "$prev" = "$signature" ]; then
    rm -f "$payload"
    echo "OK: 追跡 Issue #${tracker} は継続中で状態に変化がありません（コメントしません）。"
    exit 0
  fi
fi

run_gh gh issue comment "$tracker" --body-file "$payload"
rm -f "$payload"
echo "OK: 追跡 Issue #${tracker} へ状態の変化を報告しました。"
exit 0
