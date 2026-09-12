#!/usr/bin/env bash
# Issue #228 ガードレール（タスク 2.1）: 記録の項目名と事象名の正典
# `docs/observability/log-field-canon.md` **自身の構造**を検証する。
#
# 正典は 6 実行面の移送タスクが読む単一の基準である。構造が壊れたまま移送が進むと、
# 是正コストが全タスクへ乗る。したがって正典を消費する側より先に、正典の形を固定する。
#
# 本スクリプトは正典だけを読む（read-only・副作用なし・連想配列を使わず bash 3.2 でも走る）。
# 正典と**実装**の突き合わせは check-log-field-binding.sh が別に負う。この分離は意図的で、
# 前者は移送の前から緑にでき、後者は移送が完了するまで赤であることに意味がある。
#
# 検証すること:
#   1. 項目名の表の各行が全列を持ち、該当のない欄が「該当なし」と明示されている
#   2. 事象名の表の各行が全列を持ち、空欄が無い
#   3. 由来が「既存」または「新規」のいずれかである
#   4. 新規に由来する項目が、実行面ごとに異なる名前で登録されていない（要件 4.5 / 4.6）
#   5. 相関識別子の行が正典から失われていない（要件 5.4）
#   6. 抽出が 0 件のときは赤にする（空振り防止）
#
# 使い方: bash scripts/check-log-field-canon.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CANON="${ROOT}/docs/observability/log-field-canon.md"

# 抽出源は**ヘッダを持つ表**に限定する。散文から素朴に名前を拾うと、
# 「変更してはならない」と説明している行まで違反として叩くことになる
# （check-spec-env-names.sh が同じ理由で表へアンカーしている）。
FIELD_HEADER='| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |'
EVENT_HEADER='| 事象名 | 実行面 | 由来 | 出典 | 備考 |'
NOT_APPLICABLE='該当なし'
CORRELATION_MEANING='相関識別子'

if [ ! -f "$CANON" ]; then
  echo "ERROR: 正典 ${CANON#$ROOT/} がありません。" >&2
  exit 1
fi

# 指定ヘッダを持つ表のデータ行だけを取り出す（ヘッダ行と区切り行は捨てる）。
# 同じヘッダの表が複数節にあってもすべて拾う。
table_rows() {
  # $1: ヘッダ行（完全一致）
  awk -v hdr="$1" '
    $0 == hdr          { in_table = 1; skip_sep = 1; next }
    in_table && skip_sep { skip_sep = 0; next }
    in_table && /^\|/  { print; next }
    in_table           { in_table = 0 }
  ' "$CANON"
}

# 表の行から n 列目を取り出して前後の空白を落とす。
row_col() {
  # $1: 行 / $2: 列番号（1 始まり）
  printf '%s\n' "$1" | awk -F'|' -v n="$2" '{
    v = $(n + 1)
    gsub(/^[ \t]+|[ \t]+$/, "", v)
    print v
  }'
}

# 行の列数（先頭と末尾の空セルを除く）。
row_width() {
  printf '%s\n' "$1" | awk -F'|' '{ print NF - 2 }'
}

fail=0
field_count=0
event_count=0
correlation_found=0

# --- 1〜5: 項目名の表 ---
field_rows="$(table_rows "$FIELD_HEADER")"
while IFS= read -r row; do
  [ -n "$row" ] || continue
  field_count=$((field_count + 1))

  width="$(row_width "$row")"
  if [ "$width" -ne 6 ]; then
    echo "ERROR: 項目名の表に列数 ${width} の行があります（6 列であるべき）: ${row}" >&2
    fail=1
    continue
  fi

  meaning="$(row_col "$row" 1)"
  realtime="$(row_col "$row" 2)"
  batch="$(row_col "$row" 3)"
  origin="$(row_col "$row" 4)"
  source="$(row_col "$row" 5)"

  # (1) 該当のない欄は「該当なし」と明示させる。空欄を許すと、棚卸しの漏れが
  #     「行が無い」ではなく「欄が空」という別の不可視の形になる。
  for cell_name in 意味:"$meaning" 応答層:"$realtime" 日次バッチ層:"$batch" 由来:"$origin" 出典:"$source"; do
    label="${cell_name%%:*}"
    value="${cell_name#*:}"
    if [ -z "$value" ]; then
      echo "ERROR: 項目名の表に空欄があります（列「${label}」）: ${row}" >&2
      fail=1
    fi
  done

  # (3) 由来は 2 値
  case "$origin" in
    既存 | 新規) ;;
    *)
      echo "ERROR: 由来は「既存」か「新規」であるべきです（実際: ${origin}）: ${row}" >&2
      fail=1
      ;;
  esac

  # (4) 新規に由来する項目は、両実行面に名前を持つなら同一でなければならない。
  #     既存の分岐は固定したまま、前方だけ統一する（要件 4.5）。
  if [ "$origin" = "新規" ] \
    && [ "$realtime" != "$NOT_APPLICABLE" ] && [ "$batch" != "$NOT_APPLICABLE" ] \
    && [ "$realtime" != "$batch" ]; then
    echo "ERROR: 新規に由来する項目が実行面ごとに別名で登録されています（応答層「${realtime}」／日次バッチ層「${batch}」）。" >&2
    echo "       → 新規の項目名は全実行面で同一にしてください（既存の分岐のみ固定します）。" >&2
    fail=1
  fi

  # (5) 相関識別子の行の存在
  case "$meaning" in
    *"$CORRELATION_MEANING"*) correlation_found=1 ;;
  esac
done <<EOF
$field_rows
EOF

# --- 2〜3: 事象名の表 ---
event_rows="$(table_rows "$EVENT_HEADER")"
while IFS= read -r row; do
  [ -n "$row" ] || continue
  event_count=$((event_count + 1))

  width="$(row_width "$row")"
  if [ "$width" -ne 5 ]; then
    echo "ERROR: 事象名の表に列数 ${width} の行があります（5 列であるべき）: ${row}" >&2
    fail=1
    continue
  fi

  name="$(row_col "$row" 1)"
  surface="$(row_col "$row" 2)"
  origin="$(row_col "$row" 3)"
  source="$(row_col "$row" 4)"

  for cell_name in 事象名:"$name" 実行面:"$surface" 由来:"$origin" 出典:"$source"; do
    label="${cell_name%%:*}"
    value="${cell_name#*:}"
    if [ -z "$value" ]; then
      echo "ERROR: 事象名の表に空欄があります（列「${label}」）: ${row}" >&2
      fail=1
    fi
  done

  case "$origin" in
    既存 | 新規) ;;
    *)
      echo "ERROR: 由来は「既存」か「新規」であるべきです（実際: ${origin}）: ${row}" >&2
      fail=1
      ;;
  esac
done <<EOF
$event_rows
EOF

# (5) 相関識別子の行が失われていないこと。#229 がこの受け皿へ値を入れる前提で動くため、
#     行ごと消えると「用意したはずの器が無い」ことに誰も気づけない（要件 5.4）。
if [ "$correlation_found" -eq 0 ]; then
  echo "ERROR: 項目名の表に「${CORRELATION_MEANING}」の行がありません。" >&2
  echo "       → 相関識別子の受け皿は #229 の前提です。行ごと消さないでください。" >&2
  fail=1
fi

# (6) 空振り防止: 抽出が 0 件なら、この検証自体が壊れている。
# 表の抽出はヘッダ行の完全一致に依存しており、列の追加・改名で **全件を取りこぼしても
# 0 件＝緑** になる。正典が壊れたまま移送が進む事態を防ぐのが本ガードの目的であり、
# 取りこぼしを緑と報告してはならない。
if [ "$field_count" -eq 0 ]; then
  echo "ERROR: 項目名の表から 1 行も抽出できませんでした。ガードが空振りしています。" >&2
  echo "       → ヘッダが期待と異なります: ${FIELD_HEADER}" >&2
  exit 1
fi
if [ "$event_count" -eq 0 ]; then
  echo "ERROR: 事象名の表から 1 行も抽出できませんでした。ガードが空振りしています。" >&2
  echo "       → ヘッダが期待と異なります: ${EVENT_HEADER}" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: 正典の構造に違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: 記録の正典ガード緑（項目 ${field_count} 行 / 事象 ${event_count} 行を検証）。"
exit 0
