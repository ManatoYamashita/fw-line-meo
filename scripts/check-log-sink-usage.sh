#!/usr/bin/env bash
# Issue #228 ガードレール（タスク 2.3）: 共有経路を通らない記録の出力を検出する。
#
# 記録の品質が実行面ごとに割れていたのは、各面が自前で書き出していたからである。共有経路へ
# 一本化しても、後から直接の書き出しを足せば同じ状態へ戻る。経路の逸脱を機械検出して、
# 割れていく力を構造で止める。
#
# **移送が完了するまで本ガードは赤である。それが正しい**（CI への登録は移送完了後・タスク 5.3）。
#
# ## 走査対象は「実行時ソース」に限る
#
# 運用者が手で叩く補助スクリプトの人間向け出力・テスト・ビルド成果物は記録ではない。
# ここを対象から外さないと、移送を全部終えても消えない赤が残り、実装者が本ガード自身の
# 規則に反する除外を発明する羽目になる。
#
# ## 検出は 3 記法すべてを見る
#
# ドット記法だけを見ると**唯一の合格実装を検出できない**。共有経路の sink はブラケット記法
# （`console[level](...)`）で書かれており、ドット記法では 1 件も当たらない。除外すべき許可箇所を
# 検出できなければ「除外を外したら赤くなるか」の検証自体が成立しない。標準出力への直接の
# 書き込み（`process.stdout.write`）も同じ理由で対象に含める。
#
# 検証すること:
#   1. 実行時ソースに、共有経路を経由しない書き出しが無い（許可箇所は sink 自身のみ）
#   2. 記録に載せてよい項目の型に、利用者を一意に識別する値が現れない
#   3. 走査対象・抽出が 0 件のときは赤にする（空振り防止）
#
# 使い方: bash scripts/check-log-sink-usage.sh
#   逸脱があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APPS_DIR="${ROOT}/ts/apps"
PACKAGES_DIR="${ROOT}/ts/packages"
FIELDS_TS="${ROOT}/ts/packages/observability/src/fields.ts"

# 記録の出力経路として直接の書き込みが許される唯一の場所。
SINK_PATH='ts/packages/observability/src/sink.ts'

# 記録に載せてはならない値（オーナーを外部プラットフォーム上で一意に識別する）。
FORBIDDEN_IDENTIFIER='lineUserId'

if [ ! -d "$APPS_DIR" ] || [ ! -d "$PACKAGES_DIR" ]; then
  echo "ERROR: ${APPS_DIR} または ${PACKAGES_DIR} が存在しません。走査前提が崩れています。" >&2
  exit 1
fi

# 実行時ソースの一覧を出す。
#
# 対象: 各アプリの src / app / lib と、共有パッケージの src。
#   （店舗詳細面の記録は app/ 配下にあるため、src/ だけに絞ると移送前でも赤くならない）
# 対象外: 運用者が手で叩く補助スクリプト・テスト・E2E・性能計測・評価・生成物。
runtime_sources() {
  # **リポジトリ相対へ落としてから照合する。** 絶対パスのまま `/(src|app|lib)/` を当てると、
  # チェックアウト先が `…/app/…` 配下にある環境で全ファイルが通り、ガードが丸ごと空振りする。
  find "$APPS_DIR" "$PACKAGES_DIR" \
    \( -path '*/node_modules' -o -path '*/dist' -o -path '*/.next' \
       -o -path '*/test' -o -path '*/e2e' -o -path '*/perf' -o -path '*/eval' \
       -o -path "${APPS_DIR}/line-webhook/scripts" \) -prune -o \
    -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' \) -print \
    | sed "s|^${ROOT}/||" \
    | grep -E "^ts/(apps|packages)/[^/]+/(src|app|lib)/" \
    | grep -vE "\.(test|spec)\.[cm]?tsx?$" \
    | sort
}

fail=0
file_count=0
hit_count=0

# --- 1: 共有経路を通らない書き出し ---
while IFS= read -r path; do
  [ -n "$path" ] || continue
  file_count=$((file_count + 1))
  rel="$path"
  path="${ROOT}/${rel}"

  # 直接の書き出しを 3 記法すべてで探す。ドット記法だけでは sink 自身を検出できない。
  n=0
  rc=0
  # `const c = console; c.error(...)` のように束縛し直せば 3 記法の外へ出られる。
  # **識別子としての出現**まで網を広げ、迂回の余地を残さない。
  n="$(grep -cE '(^|[^a-zA-Z0-9_.$])(console|process\.(stdout|stderr))([^a-zA-Z0-9_]|$)' "$path")" || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "ERROR: ${rel} の走査が評価不能でした（grep exit ${rc}）。" >&2
    exit 1
  fi
  [ "$n" -gt 0 ] || continue

  hit_count=$((hit_count + n))

  # 許可箇所は sink 自身のみ。除外をここへ限定するのは、増やせばそのぶん
  # 「共有経路を通らない出力」が見えなくなるためである。
  if [ "$rel" = "$SINK_PATH" ]; then
    continue
  fi

  echo "ERROR: ${rel} が共有経路を経由せず ${n} 件の書き出しを行っています。" >&2
  echo "       → @fwlm/observability の writeStructuredLog を通してください。" >&2
  echo "         移送が未了ならこの赤は正常です（移送対象の一覧になります）。" >&2
  fail=1
done <<EOF
$(runtime_sources)
EOF

# --- 2: 記録してはならない値が型に入っていないか ---
if [ ! -f "$FIELDS_TS" ]; then
  echo "ERROR: 型定義 ${FIELDS_TS#$ROOT/} がありません。" >&2
  exit 1
fi
forbidden_rc=0
forbidden_n="$(grep -cE "(^|[^a-zA-Z0-9_])${FORBIDDEN_IDENTIFIER}([^a-zA-Z0-9_]|\$)" "$FIELDS_TS")" || forbidden_rc=$?
if [ "$forbidden_rc" -gt 1 ]; then
  echo "ERROR: 型定義の走査が評価不能でした（grep exit ${forbidden_rc}）。" >&2
  exit 1
fi
if [ "$forbidden_n" -gt 0 ]; then
  echo "ERROR: 記録の型に「${FORBIDDEN_IDENTIFIER}」が現れます。" >&2
  echo "       → 利用者を一意に識別する値は記録に載せません。持たないものは漏れません。" >&2
  fail=1
fi

# --- 3: 空振り防止 ---
# 走査は find の除外条件と拡張子に依存する。条件の綻びで **全ファイルを取りこぼしても
# 0 件＝緑** になる。経路の逸脱を検出するのが目的である以上、取りこぼしを緑と報告してはならない。
if [ "$file_count" -eq 0 ]; then
  echo "ERROR: 実行時ソースを 1 件も走査できませんでした。ガードが空振りしています。" >&2
  echo "       → find の除外条件か、src / app / lib の前提が崩れています。" >&2
  exit 1
fi
if [ "$hit_count" -eq 0 ]; then
  echo "ERROR: 書き出しを 1 件も抽出できませんでした。ガードが空振りしています。" >&2
  echo "       → 共有経路の sink 自身が検出されないのは、記法の前提が崩れた証拠です。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: 共有経路を通らない記録の出力があります（上記参照）。" >&2
  exit 1
fi

echo "OK: 記録の経路ガード緑（実行時ソース ${file_count} 件 / 書き出し ${hit_count} 件を検証）。"
exit 0
