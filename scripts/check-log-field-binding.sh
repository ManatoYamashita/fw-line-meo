#!/usr/bin/env bash
# Issue #228 ガードレール（タスク 2.2）: 記録の正典と**実装**を両方向で突き合わせる。
#
# 正典（docs/observability/log-field-canon.md）は、それ自身が整っていても実装と乖離していれば
# 意味がない。正典の構造検証は check-log-field-canon.sh が別に負い、本スクリプトは
# 「宣言した名前が実装に在るか」「実装の名前が宣言されているか」だけを見る。
#
# **移送が完了するまで本ガードは赤である。それが正しい。** 正典は移送後の姿で書かれており、
# 出典に名前がまだ現れない行が残っているうちは、その赤が移送すべき対象の一覧になる
# （steering review-gate.md の「ガードは是正前のコードに対して失敗することを確認してから
# 適用する」に対応する。CI への登録は移送完了後・タスク 5.3）。
#
# 検証すること:
#   1. 正典の各行の出典が実在する
#   2. 出典に、その層で期待される名前が現れる（ts/ なら応答層の名前、go/ なら日次バッチ層の名前）
#   3. 共有パッケージの型が持つ項目が、すべて正典に登録されている（逆方向）
#   4. 抽出が 0 件のときは赤にする（空振り防止）
#
# 使い方: bash scripts/check-log-field-binding.sh
#   乖離があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CANON="${ROOT}/docs/observability/log-field-canon.md"
FIELDS_TS="${ROOT}/ts/packages/observability/src/fields.ts"

FIELD_HEADER='| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |'
EVENT_HEADER='| 事象名 | 実行面 | 由来 | 出典 | 備考 |'
NOT_APPLICABLE='該当なし'

if [ ! -f "$CANON" ]; then
  echo "ERROR: 正典 ${CANON#$ROOT/} がありません。" >&2
  exit 1
fi

# 指定ヘッダを持つ表のデータ行だけを取り出す。
table_rows() {
  awk -v hdr="$1" '
    $0 == hdr          { in_table = 1; skip_sep = 1; next }
    in_table && skip_sep { skip_sep = 0; next }
    in_table && /^\|/  { print; next }
    in_table           { in_table = 0 }
  ' "$CANON"
}

# 表の行から n 列目を取り出して前後の空白を落とす。
row_col() {
  printf '%s\n' "$1" | awk -F'|' -v n="$2" '{
    v = $(n + 1)
    gsub(/^[ \t]+|[ \t]+$/, "", v)
    print v
  }'
}

# バッククォートで囲まれた値から中身だけを取り出す（囲まれていなければそのまま）。
unquote() {
  printf '%s\n' "$1" | sed -E 's/^`//; s/`$//'
}

# 出典セルは全角スラッシュで複数のパスを並べうる。1 行 1 パスへ割る。
split_sources() {
  printf '%s\n' "$1" | sed 's|／|\
|g' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/^`//; s/`$//' | sed '/^$/d'
}

# 正規表現のメタ文字を打ち消す（名前には . や - が含まれうる）。
escape_ere() {
  printf '%s\n' "$1" | sed -E 's/[][\\.^$*+?(){}|]/\\&/g'
}

# 本文が名前を**識別子として**含むか。
#
# 素朴な部分一致では別語に当たる。実測: 事象名の一部である `detail` が、
# コメント中の `store-detail` にマッチして緑になっていた（偽陰性）。
# 前後が識別子を構成しうる文字（英数字・アンダースコア・ハイフン・ドット）でないことを要求する。
# quiet 系はパイプ下流に置かない（EPIPE を避ける）。
file_contains_name() {
  # $1: ファイル / $2: 探す名前
  local n rc pattern
  pattern="(^|[^a-zA-Z0-9_.-])$(escape_ere "$2")([^a-zA-Z0-9_.-]|\$)"
  n="$(grep -cE -- "$pattern" "$1")" && rc=0 || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "ERROR: ${1#$ROOT/} の走査が評価不能でした（grep exit ${rc}）。" >&2
    exit 1
  fi
  [ "$n" -gt 0 ]
}

# 集合に含まれるか。quiet 系はパイプの下流に置かない（最初の一致で抜け、上流が EPIPE になる）。
set_contains() {
  # $1: 改行区切りの集合 / $2: 探す値
  local n rc
  n="$(printf '%s\n' "$1" | grep -cFx -- "$2")" && rc=0 || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "ERROR: 集合照合が評価不能でした（grep exit ${rc}）。" >&2
    exit 1
  fi
  [ "$n" -gt 0 ]
}

fail=0
checked=0
realtime_names=''
event_names=''

# --- 1〜2: 項目名の表（順方向） ---
while IFS= read -r row; do
  [ -n "$row" ] || continue

  realtime="$(unquote "$(row_col "$row" 2)")"
  batch="$(unquote "$(row_col "$row" 3)")"
  sources="$(row_col "$row" 5)"

  # 逆方向の照合に使うため、応答層の名前を集めておく。
  if [ "$realtime" != "$NOT_APPLICABLE" ]; then
    realtime_names="${realtime_names}
${realtime}"
  fi

  while IFS= read -r src; do
    [ -n "$src" ] || continue

    # 出典の層から、その出典で期待される名前を決める。
    # **毎回初期化する。** case が取りこぼすと前反復の値を持ち越し、静かに誤判定する。
    expected=''
    case "$src" in
      ts/*) expected="$realtime" ;;
      go/*) expected="$batch" ;;
      *)
        echo "ERROR: 出典のパスから層を判定できません（ts/ か go/ で始まるべき）: ${src}" >&2
        fail=1
        continue
        ;;
    esac

    # その層に名前が無い行は、その出典を持つべきではない。
    if [ "$expected" = "$NOT_APPLICABLE" ]; then
      echo "ERROR: 「${expected}」の層に出典 ${src} が宣言されています（名前が無いのに出典がある）。" >&2
      fail=1
      continue
    fi

    if [ -z "$expected" ]; then
      echo "ERROR: 出典 ${src} に対する期待名を決められませんでした。走査前提が崩れています。" >&2
      exit 1
    fi

    checked=$((checked + 1))

    if [ ! -f "${ROOT}/${src}" ]; then
      echo "ERROR: 出典 ${src} が実在しません（項目「${expected}」）。" >&2
      fail=1
      continue
    fi

    if ! file_contains_name "${ROOT}/${src}" "$expected"; then
      echo "ERROR: 出典 ${src} に項目名「${expected}」が現れません。" >&2
      echo "       → 移送が未了ならこの赤は正常です（移送対象の一覧になります）。" >&2
      fail=1
    fi
  done <<INNER
$(split_sources "$sources")
INNER
done <<EOF
$(table_rows "$FIELD_HEADER")
EOF

# --- 1〜2: 事象名の表（順方向） ---
while IFS= read -r row; do
  [ -n "$row" ] || continue

  name="$(unquote "$(row_col "$row" 1)")"
  sources="$(row_col "$row" 4)"

  # 逆方向の照合に使うため、宣言された事象名を集めておく。
  event_names="${event_names}
${name}"

  while IFS= read -r src; do
    [ -n "$src" ] || continue
    checked=$((checked + 1))

    if [ ! -f "${ROOT}/${src}" ]; then
      echo "ERROR: 出典 ${src} が実在しません（事象名「${name}」）。" >&2
      fail=1
      continue
    fi

    if ! file_contains_name "${ROOT}/${src}" "$name"; then
      echo "ERROR: 出典 ${src} に事象名「${name}」が現れません。" >&2
      echo "       → 移送が未了ならこの赤は正常です（移送対象の一覧になります）。" >&2
      fail=1
    fi
  done <<INNER
$(split_sources "$sources")
INNER
done <<EOF
$(table_rows "$EVENT_HEADER")
EOF

# --- 3: 逆方向（実装 → 正典） ---
# 抽出源を**共有パッケージの型定義**に限定する。実装全体から素朴に識別子を拾うと
# 誤検知が支配的になるため（check-spec-env-names.sh が同じ理由で表へアンカーしている）。
declared_count=0
if [ ! -f "$FIELDS_TS" ]; then
  echo "ERROR: 型定義 ${FIELDS_TS#$ROOT/} がありません。逆方向の照合ができません。" >&2
  exit 1
fi

type_keys="$(grep -oE '^  readonly [a-zA-Z][a-zA-Z0-9]*\??:' "$FIELDS_TS" | sed -E 's/^  readonly //; s/\??:$//' | sort -u)" || type_keys=''
while IFS= read -r key; do
  [ -n "$key" ] || continue
  declared_count=$((declared_count + 1))
  if ! set_contains "$realtime_names" "$key"; then
    echo "ERROR: 型定義に項目「${key}」がありますが、正典の応答層の列に登録されていません。" >&2
    echo "       → 先に ${CANON#$ROOT/} へ行を足してください（正典が先、実装が後）。" >&2
    fail=1
  fi
done <<EOF
$type_keys
EOF

# --- 3b: 逆方向（実装の事象名 → 正典） ---
#
# 正典は「名前の唯一の基準」である。実装が正典に無い事象名を出せてしまうと、その主張が
# 前方に対して成立しない（後から足された名前が規約の外で増えていく）。
# 抽出源は共有経路の呼び出しに限る。散文から拾うと誤検知が支配的になる。
emitted_events=0
call_sites="$(grep -rlE 'writeStructuredLog\(' "${ROOT}/ts/apps" "${ROOT}/ts/packages" \
  --include='*.ts' --include='*.tsx' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next \
  --exclude-dir=test --exclude-dir=e2e --exclude-dir=perf --exclude-dir=eval 2>/dev/null || true)"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  used="$(grep -oE "writeStructuredLog\('[a-z]+', *'[a-zA-Z0-9_.-]+'" "$f" \
    | sed -E "s/.*, *'//; s/'$//" | sort -u || true)"
  while IFS= read -r ev; do
    [ -n "$ev" ] || continue
    emitted_events=$((emitted_events + 1))
    if ! set_contains "$event_names" "$ev"; then
      echo "ERROR: ${f#$ROOT/} が事象名「${ev}」を出しますが、正典に登録されていません。" >&2
      echo "       → 先に ${CANON#$ROOT/} へ行を足してください（正典が先、実装が後）。" >&2
      fail=1
    fi
  done <<INNER
$used
INNER
done <<EOF
$call_sites
EOF

# --- 4: 空振り防止 ---
# 表の抽出はヘッダの完全一致に、型の抽出は宣言の書式に依存する。どちらも崩れると
# **全件を取りこぼしても 0 件＝緑** になる。乖離を検出するのが目的である以上、
# 取りこぼしを緑と報告してはならない。
if [ "$checked" -eq 0 ]; then
  echo "ERROR: 正典から出典を 1 件も検証できませんでした。ガードが空振りしています。" >&2
  exit 1
fi
if [ "$emitted_events" -eq 0 ]; then
  echo "ERROR: 実装から事象名を 1 件も抽出できませんでした。ガードが空振りしています。" >&2
  echo "       → writeStructuredLog の呼び出し形式が前提と異なります。" >&2
  exit 1
fi
if [ "$declared_count" -eq 0 ]; then
  echo "ERROR: 型定義から項目を 1 件も抽出できませんでした。ガードが空振りしています。" >&2
  echo "       → 'readonly <名前>?:' の書式が前提です。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: 正典と実装の間に乖離があります（上記参照）。" >&2
  exit 1
fi

echo "OK: 正典と実装の照合ガード緑（出典 ${checked} 件 / 型の項目 ${declared_count} 件 / 実装の事象名 ${emitted_events} 件を両方向検証）。"
exit 0
