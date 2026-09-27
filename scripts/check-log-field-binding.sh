#!/usr/bin/env bash
# Issue #228 ガードレール（逆方向は Issue #288 で全ソースへ拡張）: 記録の正典と**実装**を両方向で突き合わせる。
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
#   4. 実装の事象名がすべて正典に登録され、正典の出典はすべて逆方向の走査対象に含まれる
#   5. 抽出・走査が 0 件のときは赤にする（空振り防止）
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

# grep の不一致（exit 1）は空として扱い、評価不能（exit 2 以上）は必ず失敗にする。
grep_optional() {
  local pattern file matches rc
  pattern="$1"
  file="$2"
  matches="$(grep -oE -- "$pattern" "$file")" && rc=0 || rc=$?
  if [ "$rc" -gt 1 ]; then
    echo "ERROR: ${file#$ROOT/} の事象抽出が評価不能でした（grep exit ${rc}）。" >&2
    exit 1
  fi
  [ "$rc" -eq 0 ] && printf '%s\n' "$matches"
  return 0
}

# TypeScript の実行時ログ呼び出しから事象名を抽出する。
# `logger.info('event', ...)` / 注入された logger メソッドと、
# `log('warn', 'event', ...)` / writeStructuredLog・correlationLog の Sink 形式を扱う。
# optional call の log?.(...) と optional property の logger?.warn(...) も扱う。
extract_ts_events() {
  local file
  file="$1"
  {
    # Sink 関数（名前付き logger / log / requestLog を含む）の level, event 形式。
    grep_optional "(^|[^a-zA-Z0-9_])[a-zA-Z_][a-zA-Z0-9_]*[[:space:]]*(\\?)?\\([[:space:]]*'(info|warn|error|debug)'[[:space:]]*,[[:space:]]*'[a-zA-Z0-9_.-]+" "$file" \
      | sed -E "s/.*,[[:space:]]*'//; s/'$//"

    # 共有 Sink の引数に条件式を使う呼び出し（line-webhook の起動状態）。
    grep_optional "(writeStructuredLog|correlationLog)\\([[:space:]]*'(info|warn|error|debug)'[,]([^)]*)\\?[^)]*'[a-zA-Z0-9_.-]+'[[:space:]]*:[[:space:]]*'[a-zA-Z0-9_.-]+'" "$file" \
      | grep -oE "'[a-zA-Z0-9_.-]+'" \
      | tr -d "'"

    # 注入されたオブジェクト logger と、withCorrelation の戻り値を log と呼ぶ Sink。
    grep_optional "\\.(info|warn|error|debug)[[:space:]]*(\\?)?\\([[:space:]]*'[a-zA-Z0-9_.-]+" "$file" \
      | sed -E "s/.*\\('//; s/'$//"
    grep_optional "(^|[^a-zA-Z0-9_])log[[:space:]]*(\\?)?\\([[:space:]]*'[a-zA-Z0-9_.-]+" "$file" \
      | sed -E "s/.*\\('//; s/'$//"

    # 変数を経由して Sink に渡す実行サマリーの literal（delivery-job.run）。
    grep_optional "event[[:space:]]*:[[:space:]]*'[a-zA-Z0-9_.-]+" "$file" \
      | sed -E "s/.*:[[:space:]]*'//; s/'$//"
  } | grep -E '^[a-z][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_.-]+|_[a-zA-Z0-9_-]+)$' | sort -u || true
}

# Go の日次バッチは slog の `"event", value` 属性で事象を出す。
# event 変数は同じファイル内の const literal として解決し、動的値は fail-closed にする。
extract_go_events() {
  local file direct refs ref event
  file="$1"
  direct="$(grep_optional '"event"[[:space:]]*,[[:space:]]*"[a-zA-Z0-9_.-]+"' "$file" \
    | sed -E 's/.*,[[:space:]]*"//; s/"$//')"
  refs="$(grep_optional '"event"[[:space:]]*,[[:space:]]*[a-zA-Z_][a-zA-Z0-9_]*' "$file" \
    | sed -E 's/.*,[[:space:]]*//')"
  printf '%s\n' "$direct"
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    event="$(grep_optional "^[[:space:]]*const[[:space:]]+${ref}[[:space:]]*=[[:space:]]*\\\"[a-zA-Z0-9_.-]+\\\"" "$file" \
      | sed -E 's/.*=[[:space:]]*"//; s/"$//')"
    if [ -z "$event" ]; then
      echo "ERROR: ${file#$ROOT/} の slog event 変数「${ref}」を同一ファイル内の const literal として解決できません。" >&2
      exit 1
    fi
    printf '%s\n' "$event"
  done <<EOF
$refs
EOF
}

fail=0
checked=0
realtime_names=''
event_names=''
canon_source_paths=''

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

    if ! set_contains "$canon_source_paths" "$src"; then
      canon_source_paths="${canon_source_paths}
${src}"
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

    if ! set_contains "$canon_source_paths" "$src"; then
      canon_source_paths="${canon_source_paths}
${src}"
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
# 抽出源は実行時のログ呼び出しに限る。散文から拾うと誤検知が支配的になる。
# 走査対象は ts/apps・ts/packages・go の実行時ソース全体とし、正典の出典集合がそこから
# 1 ファイルも漏れていないことを先に検証する。出典ファイルを追加したときも、走査対象から
# 除外したときも、緑のまま通さない。
emitted_events=0
observed_events=''
ts_source_files=''
go_source_files=''
if [ -d "${ROOT}/ts/apps" ] && [ -d "${ROOT}/ts/packages" ]; then
  ts_source_files="$(find "${ROOT}/ts/apps" "${ROOT}/ts/packages" \
    -type d \( -name node_modules -o -name dist -o -name .next -o -name test -o -name e2e -o -name perf -o -name eval \) -prune -o \
    -type f \( -name '*.ts' -o -name '*.tsx' \) -print | sort)"
fi
if [ -d "${ROOT}/go" ]; then
  go_source_files="$(find "${ROOT}/go" \
    -type d \( -name vendor -o -name testdata \) -prune -o \
    -type f -name '*.go' ! -name '*_test.go' -print | sort)"
fi
scan_files="${ts_source_files}
${go_source_files}"
scanned_source_files=0

while IFS= read -r src; do
  [ -n "$src" ] || continue
  if [ ! -f "${ROOT}/${src}" ]; then
    echo "ERROR: 正典の事象出典 ${src} が実在しません。" >&2
    fail=1
    continue
  fi
  if ! set_contains "$scan_files" "${ROOT}/${src}"; then
    echo "ERROR: 正典の出典 ${src} が逆方向の事象走査対象に含まれていません。" >&2
    echo "       → 実行時ソースの走査範囲を広げるか、正典の出典を実装に合わせてください。" >&2
    fail=1
  fi
done <<EOF
$(printf '%s\n' "$canon_source_paths" | sed '/^$/d' | sort -u)
EOF
while IFS= read -r f; do
  [ -n "$f" ] || continue
  scanned_source_files=$((scanned_source_files + 1))
  case "$f" in
    *.go) used="$(extract_go_events "$f" | sort -u)" ;;
    *) used="$(extract_ts_events "$f")" ;;
  esac
  while IFS= read -r ev; do
    [ -n "$ev" ] || continue
    if ! set_contains "$observed_events" "$ev"; then
      observed_events="${observed_events}
${ev}"
      emitted_events=$((emitted_events + 1))
    fi
    if ! set_contains "$event_names" "$ev"; then
      echo "ERROR: ${f#$ROOT/} が事象名「${ev}」を出しますが、正典に登録されていません。" >&2
      echo "       → 先に ${CANON#$ROOT/} へ行を足してください（正典が先、実装が後）。" >&2
      fail=1
    fi
  done <<INNER
$used
INNER
done <<EOF
$scan_files
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
  echo "       → 共有 Sink・注入 logger・Go slog の呼び出し形式が前提と異なります。" >&2
  exit 1
fi
if [ "$scanned_source_files" -eq 0 ]; then
  echo "ERROR: 実行時ソースを 1 件も走査できませんでした。ガードが空振りしています。" >&2
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

echo "OK: 正典と実装の照合ガード緑（出典 ${checked} 件 / 型の項目 ${declared_count} 件 / 実装の事象名 ${emitted_events} 件 / 実行時ソース ${scanned_source_files} ファイルを両方向検証）。"
exit 0
