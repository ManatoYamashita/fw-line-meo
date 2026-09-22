#!/usr/bin/env bash
# JST の固定オフセットと暦日・時刻整形が実行面ごとに分岐しないことを機械強制する（Issue #299）。
#
# 背景: 「今日」を JST の暦日で決める実装は TypeScript 3 面と Go バッチに分散している。
# 書く側（Go）と読む側（TypeScript）の暦日がずれると、当日の daily_summaries 行が取得範囲から
# 外れる（Issue #268 で実発生）。さらに Issue #299 起票後、LINE の投稿時刻表示にも同じ +09:00
# が増えた。共有パッケージへ寄せても Go と SQL は残るため、ここでは分散そのものではなく、
# **値・整形方式・棚卸しの網羅**をガードする。
#
# 検証すること:
#   1. 固定オフセット 5 実装を列挙し、いずれも正確に +09:00（32,400 秒）である
#   2. 各用途が宣言した整形方式（UTC getter / UTC 0時への再構成）を保っている
#   3. SQL の Asia/Tokyo 月境界も棚卸しへ載り、宣言した式が実在する
#   4. 実装候補 → 宣言、宣言 → 実装を両方向で照合し、6つ目の列挙漏れを赤にする
#   5. テストコードは対象外にする（本番の時刻決定権を持たないため）
#
# 使い方: bash scripts/check-jst-offset-consistency.sh
# read-only・外部サービス不使用・bash 3.2 互換。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EXPECTED_OFFSET_SECONDS=32400

# `<用途>|<実装ファイル>|<定数名>|<単位>`。
#
# 用途は「その値をどう暦日・時刻へ直すか」の契約でもある。定数が +09:00 でも、ローカル時刻の
# getter に替われば実行環境の TZ に結果を委ねてしまうため、値だけでなく整形方式も検査する。
# SQL は tzdata を使うが、JST は DST を持たず結果は固定 +09:00 と一致する。ここでは値を再計算
# せず、`AT TIME ZONE 'Asia/Tokyo'` の宣言と棚卸しだけを守る。
IMPLEMENTATIONS=(
  'ts-iso-date|ts/apps/store-detail/lib/data.ts|JST_OFFSET_MS|milliseconds'
  'ts-components-date-hour|ts/apps/delivery-job/src/index.ts|JST_OFFSET_MS|milliseconds'
  'ts-components-date|ts/apps/line-webhook/src/report/handler.ts|JST_OFFSET_MS|milliseconds'
  'ts-review-time|ts/apps/line-webhook/src/report/builders/new-reviews.ts|JST_OFFSET_MINUTES|minutes'
  'go-date|go/internal/batch/run.go|jst|seconds'
  'sql-zone|ts/packages/db/src/tallies.ts|-|timezone'
)

# 新しい JST 実装を足したのに上の表へ載せなかった状態を検出するための候補パターン。
# ファイル単位で照合する。Go の既存コメントにある LoadLocation も同じ宣言済みファイルへ収まる。
CANDIDATE_ERE="const[[:space:]]+[A-Za-z0-9_]*([Jj][Ss][Tt]|[Tt][Oo][Kk][Yy][Oo])[A-Za-z0-9_]*[[:space:]]*=[[:space:]]*[0-9]|new[[:space:]]+Date[(].*[+][[:space:]]*[0-9_]+[[:space:]]*[*][[:space:]]*60|time[.]FixedZone[[:space:]]*[(][[:space:]]*['\"]JST['\"]|time[.]LoadLocation[[:space:]]*[(][[:space:]]*['\"]Asia/Tokyo['\"]|AT[[:space:]]+TIME[[:space:]]+ZONE[[:space:]]+['\"]Asia/Tokyo['\"]|timeZone[[:space:]]*:[[:space:]]*['\"]Asia/Tokyo['\"]|TZ=Asia/Tokyo"

line_count() {
  awk 'NF { n++ } END { print n + 0 }'
}

regex_matches=''
read_regex_matches() { # $1=file, $2=ERE
  local file="$1"
  local pattern="$2"
  local rc=0
  regex_matches="$(grep -E -- "$pattern" "$file")" || rc=$?
  if [ "$rc" -ge 2 ]; then
    echo "ERROR: ${file} を走査できません（grep exit=${rc}・pattern=${pattern}）。" >&2
    return 1
  fi
  return 0
}

literal_count=0
read_literal_count() { # $1=file, $2=literal
  local file="$1"
  local literal="$2"
  local rc=0
  literal_count="$(grep -Fc -- "$literal" "$file")" || rc=$?
  if [ "$rc" -ge 2 ]; then
    echo "ERROR: ${file} を走査できません（grep exit=${rc}・literal=${literal}）。" >&2
    return 1
  fi
  # grep -c は無一致でも 0 を出すが exit 1。1 は正常な「0 件」として扱う。
  [ "$rc" -eq 0 ] || literal_count=0
  return 0
}

require_literal_once() { # $1=file, $2=literal, $3=説明
  local file="$1"
  local literal="$2"
  local description="$3"
  if ! read_literal_count "$file" "$literal"; then
    return 1
  fi
  if [ "$literal_count" -ne 1 ]; then
    echo "ERROR: ${file} の ${description}は 1 件であるべきですが、${literal_count} 件です。" >&2
    echo "       期待する断片: ${literal}" >&2
    return 1
  fi
  return 0
}

product_value=''
parse_product() { # $1=数字と * だけからなる積。product_value へ結果を返す
  local expression="$1"
  local compact=''
  local old_ifs=''
  local factor=''
  local value=1

  compact="$(printf '%s' "$expression" | tr -d '[:space:]_')"
  case "$compact" in
    '' | *[!0-9*]* | \** | *\* | *\*\**)
      echo "ERROR: 固定オフセットの式を安全に評価できません: ${expression}" >&2
      echo "       数字と乗算（*）だけで記述してください。" >&2
      return 1
      ;;
  esac

  old_ifs="$IFS"
  IFS='*'
  # shellcheck disable=SC2086 # 上で数字と * だけに制限済み。積の各因子へ分割する。
  set -- $compact
  IFS="$old_ifs"
  for factor in "$@"; do
    value=$((value * factor))
  done
  product_value="$value"
  return 0
}

offset_seconds=''
read_ts_offset_seconds() { # $1=file, $2=定数名, $3=milliseconds|minutes
  local file="$1"
  local symbol="$2"
  local unit="$3"
  local pattern="const[[:space:]]+${symbol}[[:space:]]*=[[:space:]]*[0-9_[:space:]*]+;"
  local count=0
  local declaration=''
  local expression=''

  if ! read_regex_matches "$file" "$pattern"; then
    return 1
  fi
  count="$(printf '%s\n' "$regex_matches" | line_count)"
  if [ "$count" -ne 1 ]; then
    echo "ERROR: ${file} に ${symbol} の数値宣言が 1 件必要ですが、${count} 件です。" >&2
    return 1
  fi
  declaration="$regex_matches"
  expression="${declaration#*=}"
  expression="${expression%;}"
  if ! parse_product "$expression"; then
    return 1
  fi

  case "$unit" in
    milliseconds)
      if [ $((product_value % 1000)) -ne 0 ]; then
        echo "ERROR: ${file} の ${symbol} は整数秒へ変換できません（${product_value} ms）。" >&2
        return 1
      fi
      offset_seconds=$((product_value / 1000))
      ;;
    minutes) offset_seconds=$((product_value * 60)) ;;
    *)
      echo "ERROR: ガード内の単位宣言が不正です: ${unit}" >&2
      return 1
      ;;
  esac
  return 0
}

read_go_offset_seconds() { # $1=file
  local file="$1"
  local pattern='var[[:space:]]+jst[[:space:]]*=[[:space:]]*time[.]FixedZone[(][[:space:]]*"JST"[[:space:]]*,[[:space:]]*[0-9_[:space:]*]+[)]'
  local count=0
  local declaration=''
  local expression=''

  if ! read_regex_matches "$file" "$pattern"; then
    return 1
  fi
  count="$(printf '%s\n' "$regex_matches" | line_count)"
  if [ "$count" -ne 1 ]; then
    echo "ERROR: ${file} に time.FixedZone(\"JST\", ...) の jst 宣言が 1 件必要ですが、${count} 件です。" >&2
    return 1
  fi
  declaration="$regex_matches"
  expression="${declaration#*\"JST\",}"
  expression="${expression%)}"
  if ! parse_product "$expression"; then
    return 1
  fi
  offset_seconds="$product_value"
  return 0
}

file_is_candidate() { # $1=file
  local file="$1"
  local rc=0
  if grep -Eq -- "$CANDIDATE_ERE" "$file"; then
    return 0
  else
    rc=$?
  fi
  if [ "$rc" -ge 2 ]; then
    echo "ERROR: ${file} の JST 実装候補を走査できません（grep exit=${rc}）。" >&2
    return 2
  fi
  return 1
}

path_is_declared() { # $1=path
  local target="$1"
  local entry=''
  local kind=''
  local path=''
  local symbol=''
  local unit=''
  for entry in "${IMPLEMENTATIONS[@]}"; do
    IFS='|' read -r kind path symbol unit <<< "$entry"
    [ "$path" = "$target" ] && return 0
  done
  return 1
}

fail=0
offset_count=0
sql_zone_count=0
declared_paths=''

# --- 宣言 → 実装: 実体・固定値・整形方式を検証する -------------------------------
for entry in "${IMPLEMENTATIONS[@]}"; do
  IFS='|' read -r kind path symbol unit <<< "$entry"

  case "${declared_paths}" in
    *$'\n'"${path}"$'\n'*)
      echo "ERROR: ガードの IMPLEMENTATIONS に ${path} が重複しています。" >&2
      fail=1
      continue
      ;;
  esac
  declared_paths="${declared_paths}"$'\n'"${path}"$'\n'

  if [ ! -f "$path" ]; then
    echo "ERROR: 宣言された JST 実装が存在しません: ${path}" >&2
    fail=1
    continue
  fi

  candidate_rc=0
  file_is_candidate "$path" || candidate_rc=$?
  if [ "$candidate_rc" -ne 0 ]; then
    if [ "$candidate_rc" -eq 1 ]; then
      echo "ERROR: 宣言された ${path} から JST 実装候補を検出できません。実装または候補パターンが変わっています。" >&2
    fi
    fail=1
  fi

  if [ "$kind" = 'sql-zone' ]; then
    if ! require_literal_once "$path" "AT TIME ZONE 'Asia/Tokyo'" "Asia/Tokyo 月境界"; then
      fail=1
    else
      sql_zone_count=$((sql_zone_count + 1))
    fi
    continue
  fi

  case "$unit" in
    milliseconds | minutes)
      if ! read_ts_offset_seconds "$path" "$symbol" "$unit"; then
        fail=1
        continue
      fi
      ;;
    seconds)
      if ! read_go_offset_seconds "$path"; then
        fail=1
        continue
      fi
      ;;
    *)
      echo "ERROR: ${path} の単位宣言が不正です: ${unit}" >&2
      fail=1
      continue
      ;;
  esac

  offset_count=$((offset_count + 1))
  if [ "$offset_seconds" -ne "$EXPECTED_OFFSET_SECONDS" ]; then
    echo "ERROR: ${path} の固定オフセットは ${offset_seconds} 秒です。JST の +09:00（${EXPECTED_OFFSET_SECONDS} 秒）と一致しません。" >&2
    fail=1
  fi

  # 用途ごとの整形方式。ローカル getter や実行環境の TZ へ倒れる変更を検出する。
  case "$kind" in
    ts-iso-date)
      require_literal_once "$path" 'new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 10)' 'JST 暦日の ISO 整形' || fail=1
      ;;
    ts-components-date-hour)
      require_literal_once "$path" 'const jst = new Date(now.getTime() + JST_OFFSET_MS);' 'JST への時刻移動' || fail=1
      require_literal_once "$path" 'const year = jst.getUTCFullYear();' 'UTC 年の読取' || fail=1
      require_literal_once "$path" 'const month = String(jst.getUTCMonth() + 1).padStart(2, '\''0'\'');' 'UTC 月の読取' || fail=1
      require_literal_once "$path" 'const day = String(jst.getUTCDate()).padStart(2, '\''0'\'');' 'UTC 日の読取' || fail=1
      # shellcheck disable=SC2016 # TypeScript の template literal を文字列として照合する。
      require_literal_once "$path" 'return { hour: jst.getUTCHours(), date: `${year}-${month}-${day}` };' 'UTC 時・暦日の返却' || fail=1
      ;;
    ts-components-date)
      require_literal_once "$path" 'const jst = new Date(now.getTime() + JST_OFFSET_MS);' 'JST への時刻移動' || fail=1
      require_literal_once "$path" 'const month = String(jst.getUTCMonth() + 1).padStart(2, '\''0'\'');' 'UTC 月の読取' || fail=1
      require_literal_once "$path" 'const day = String(jst.getUTCDate()).padStart(2, '\''0'\'');' 'UTC 日の読取' || fail=1
      # shellcheck disable=SC2016 # TypeScript の template literal を文字列として照合する。
      require_literal_once "$path" 'return `${jst.getUTCFullYear()}-${month}-${day}`;' 'UTC 年・暦日の返却' || fail=1
      ;;
    ts-review-time)
      require_literal_once "$path" 'const jst = new Date(wallClock + (JST_OFFSET_MINUTES - offsetMinutes) * MINUTE_MS);' 'RFC 3339 から JST への時刻移動' || fail=1
      # shellcheck disable=SC2016 # TypeScript の template literal を文字列として照合する。
      require_literal_once "$path" 'return `${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日 ${pad2(jst.getUTCHours())}:${pad2(jst.getUTCMinutes())}`;' '投稿時刻の UTC getter 整形' || fail=1
      ;;
    go-date)
      require_literal_once "$path" 'local := t.In(jst)' '固定 JST zone への変換' || fail=1
      require_literal_once "$path" 'return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)' 'UTC 0時の暦日への再構成' || fail=1
      ;;
    *)
      echo "ERROR: ガード内の用途宣言が不正です: ${kind}" >&2
      fail=1
      ;;
  esac
done

if [ "$offset_count" -eq 0 ]; then
  echo "ERROR: 固定オフセットを 1 件も検証できませんでした。ガードが空振りしています。" >&2
  fail=1
fi
if [ "$sql_zone_count" -eq 0 ]; then
  echo "ERROR: SQL の Asia/Tokyo 実装を 1 件も検証できませんでした。ガードが空振りしています。" >&2
  fail=1
fi

# --- 実装 → 宣言: 新しい実装候補の列挙漏れを検証する -------------------------------
for source_root in ts/apps ts/packages go; do
  if [ ! -d "$source_root" ]; then
    echo "ERROR: JST 実装の走査対象が存在しません: ${source_root}" >&2
    fail=1
  fi
done

source_files=''
find_rc=0
source_files="$(find ts/apps ts/packages go -type f \( \
  -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' \
  -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.go' \
  \) -print)" || find_rc=$?
if [ "$find_rc" -ne 0 ]; then
  echo "ERROR: JST 実装候補のファイルを列挙できません（find exit=${find_rc}）。" >&2
  exit 1
fi

candidate_count=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  case "$file" in
    */node_modules/* | */.next/* | */dist/* | */.turbo/* | */test/* | */tests/* | */e2e/* \
      | *.test.ts | *.test.tsx | *.test.mts | *.test.cts | *.spec.ts | *.spec.tsx | *.spec.mts | *.spec.cts \
      | *_test.go)
      continue
      ;;
  esac

  candidate_rc=0
  file_is_candidate "$file" || candidate_rc=$?
  case "$candidate_rc" in
    0)
      candidate_count=$((candidate_count + 1))
      if ! path_is_declared "$file"; then
        echo "ERROR: 宣言されていない JST 実装候補があります: ${file}" >&2
        echo "       → IMPLEMENTATIONS へ用途・定数・単位を登録し、整形方式の検査を追加してください。" >&2
        fail=1
      fi
      ;;
    1) ;;
    *) fail=1 ;;
  esac
done <<EOF
$source_files
EOF

if [ "$candidate_count" -eq 0 ]; then
  echo "ERROR: JST 実装候補を 1 件も検出できませんでした。候補走査が空振りしています。" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: JST の固定オフセット・整形方式・棚卸しに不整合があります（Issue #299）。" >&2
  exit 1
fi

echo "OK: JST +09:00 の整合ガード緑（固定オフセット ${offset_count} 実装 / SQL zone ${sql_zone_count} 実装 / 候補 ${candidate_count} ファイル）。"
