#!/usr/bin/env bash
# 面が部品の見た目を借りて **描画する** ときに cn() を通していることの機械強制（Issue #208）。
#
# 背景: `Button` 部品は `className={cn(buttonVariants({ variant, size, className }))}` と
# tailwind-merge を通している。cn は基底の `border-transparent` と outline 変種の
# `border-input` のような競合を後勝ちで解決し、前者を削除する。
#
# 面の側が裸の `buttonVariants()` を className へ渡すと、cva の生出力がそのまま class になり、
# 競合するユーティリティが**両方残る**。詳細度が同じなので生成 CSS の順序で決まり、
# outline 変種では `border-transparent` が勝って**枠が実描画で透明になる**。
# 寸法・角丸・文字色はすべて一致するため、**class 文字列の比較でも jsdom でも落ちない**。
# PR #200（survey-web 2 箇所）と PR #211（dashboard-web 1 箇所）で同じ壊れ方を 3 回踏んだ。
#
# **判定の射程は「描画への受け渡し」だけである。** `buttonVariants(` を呼ぶこと自体は禁じない。
# テストは「部品が variant / size から自分で作るぶん」を差し引く基準として生の cva を呼んでおり、
# そこへ cn() を通すと差し引きの基準が変わって**検査のほうが壊れる**。したがって
# `className={` へ直接渡している形だけを見る。
#
# **既知の射程外**: 一度変数へ束ねてから渡す形（`const c = buttonVariants(...)` →
# `className={c}`）は捕まえられない。実在しないので追わない。現れたらここを広げること。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS_DIR="${ROOT}/ts/apps"

if [ ! -d "$APPS_DIR" ]; then
  echo "ERROR: 走査対象 ${APPS_DIR} が存在しません（配置が変わった可能性があります）。" >&2
  exit 1
fi

GREP_OPTS=(
  -rn --include='*.ts' --include='*.tsx'
  --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=.turbo
)

# grep の exit を握り潰さない。1（無一致）は正常、2 以上（評価不能・読み取り不能）は
# 「検出できなかった」であって「違反が無い」ではない。潰すと壊れたガードが緑を返す。
#
# **結果は標準出力ではなく変数で返す。** `out="$(scan ...)"` の形にすると grep は
# 二重の部分シェルの中で走り、`rc=$?` の代入も `exit` も外へ伝わらない。
# 評価不能が無一致と同じ扱いになり、**壊れたガードが緑を返す**（自己テストで実測した）。
scan_out=''
scan() { # $1 = ERE → scan_out へ入れる
  local rc=0
  scan_out="$(grep -E "${GREP_OPTS[@]}" "$1" "$APPS_DIR")" || rc=$?
  if [ "$rc" -ge 2 ]; then
    echo "ERROR: 走査を評価できません（grep exit=${rc}・pattern=$1）。" >&2
    exit 1
  fi
}

# className へ渡している箇所（包んでいる / 裸 の両方）。空白は許容する。
scan 'className=\{[[:space:]]*(cn\([[:space:]]*)?buttonVariants\('
handoffs="$scan_out"
scan 'className=\{[[:space:]]*buttonVariants\('
naked="$scan_out"

count_lines() { [ -z "$1" ] && { echo 0; return; }; printf '%s\n' "$1" | grep -c ''; }
total="$(count_lines "$handoffs")"
bad="$(count_lines "$naked")"

# 空振り防止。受け渡しが 0 件なら「守っている」ではなく「何も見ていない」である。
# 借りる面が本当に無くなったなら、惰性で残さずこのガードごと撤去すること。
if [ "$total" -eq 0 ]; then
  echo "ERROR: ts/apps 配下に className へ buttonVariants を渡している箇所が 1 件もありません。" >&2
  echo "  → 走査が壊れているか、借りる面が無くなっています。後者ならこのガードを撤去してください。" >&2
  exit 1
fi

if [ "$bad" -gt 0 ]; then
  echo "ERROR: cn() を通さずに buttonVariants を className へ渡している箇所があります:" >&2
  printf '%s\n' "$naked" >&2
  echo "" >&2
  echo "  → className={cn(buttonVariants({ ... }))} の形にしてください。" >&2
  echo "    裸で渡すと競合するユーティリティが両方残り、outline 変種では枠が実描画で透明になります" >&2
  echo "    （PR #200 / #211 で 3 回踏んだ形。class 比較でも jsdom でも落ちません）。" >&2
  exit 1
fi

echo "OK: className へ渡す buttonVariants はすべて cn() を通っています（${total} 件検証）。"
