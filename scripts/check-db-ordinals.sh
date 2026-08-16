#!/usr/bin/env bash
# Issue #128 ガードレール: 連番ファイルの番号衝突を git は衝突として報告しない。
#
# 背景（2026-08-16 実測・PR #121）: main に `db/migrations/0005_agency_dashboard.sql` が在る一方、
# PR #121 は `db/migrations/0005_gbp_post_review_reply.sql` を追加していた。**ファイル名が違うため
# git は衝突を報告せず**、`git merge-tree` の衝突一覧にも出ない。同型が
# `db/test/assertions/50_*` にもあった。
#
# しかも **どちらの側からも見えない**:
#   ブランチ単体 … 0001 0002 0003 0004 0005_gbp   → 重複なし
#   main 単体   … 0001 0002 0003 0004 0005_agency → 重複なし
#   両方を並べて … 0005 が 2 つ
# 単一ツリーだけを見るガードは、この形を **原理的に** 検出できない。だから本ガードは
# HEAD と `origin/main` の **合成集合** を判定対象にする。
#
# 症状が出ないことが厄介さの本体である。適用は `db/test/run.sh` / `check_docs.sh` の
# `for f in .../*.sql`（シェル glob = 辞書順）なので `0005_agency` → `0005_gbp` の順で
# **「たまたま」正しく流れ**、make db-migrate / db-test / db-verify-docs はすべて緑になる。
# 壊れるのは「番号が適用順を表す」という不変条件だけで、次に誰かが番号を基準に順序を
# 判断した時点で初めて事故になる。
#
# 検証内容（対象ごとに規則が違う）:
#   db/migrations/      … 命名 NNNN_snake.sql / 番号の一意 / 欠番なし / 辞書順=数値順
#   db/test/assertions/ … 命名 NN_snake.sql   / 番号の一意 /    ―     / 辞書順=数値順
#
# **assertions に欠番検査を課さない**のは 0000/10/15/20/30/40/50/60 という飛び番が設計
# だからである。逆に桁数が混在する（0000 と 10）ため、辞書順と数値順の一致はここでこそ効く
# （`100_x.sql` を足すと辞書順で 15 の前へ来る）。
#
# **`scripts/test/cases/` は対象外**。`60-` `70-` が正当に重複しており規約が違う（実測）。
#
# **除外リスト（WHITELIST）は用意しない。** 偽陽性は「main に在るファイルをブランチが同じ番号の
# まま改名する」場合に限られ、その正しい対処は別番号への改番である。対照ケースを持たない除外は
# 検出穴として機能した実測（PR #119 / #123）があるため、逃げ道を作るより赤で止める。
#
# 使い方: bash scripts/check-db-ordinals.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。
#
# 環境変数:
#   DB_ORDINAL_MAIN_REF       既定 origin/main。解決できなければ hard fail（HEAD へ暗黙に
#                             落とさない。落とすと単体ツリー判定に退化し「常に緑」の装置になる）
#   DB_ORDINAL_MAIN_SNAPSHOT  main 側パス一覧の注入口（1 行 1 パス）。自己テストの合成ツリーは
#                             origin/main を持たないため必要。**未設定と空文字を区別**し、
#                             空文字は hard fail（空注入が実 git へ落ちる事故の防止）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DB_ORDINAL_MAIN_REF="${DB_ORDINAL_MAIN_REF:-origin/main}"

# 未設定（実 git を引く）と空文字（注入したつもりで中身が無い）は別物として扱う。
if [ "${DB_ORDINAL_MAIN_SNAPSHOT+set}" = 'set' ]; then
  snapshot_declared=1
else
  snapshot_declared=0
fi
snapshot_path="${DB_ORDINAL_MAIN_SNAPSHOT:-}"

fail=0
# 空振り防止のカウンタ。「検査した番号の総数」と「対象ディレクトリの数」を分けて数える
# （0 件が skip 由来なのか未定義由来なのかを取り違えないため）。
checked_ordinals=0
checked_dirs=0

# --- main 側の取得経路を 1 回だけ決め、通った経路を明示する ---------------------
if [ "$snapshot_declared" -eq 1 ]; then
  if [ -z "$snapshot_path" ]; then
    echo "ERROR: DB_ORDINAL_MAIN_SNAPSHOT が空文字です（注入したつもりで中身がありません）。" >&2
    echo "       → 未設定なら変数ごと外してください（その場合は ${DB_ORDINAL_MAIN_REF} を引きます）。" >&2
    exit 1
  fi
  if [ ! -f "$snapshot_path" ]; then
    echo "ERROR: DB_ORDINAL_MAIN_SNAPSHOT のファイルがありません: ${snapshot_path}" >&2
    exit 1
  fi
  echo "INFO: main 側は snapshot から読みます: ${snapshot_path}" >&2
else
  if ! git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    echo "ERROR: git リポジトリではないため ${DB_ORDINAL_MAIN_REF} を解決できません。" >&2
    echo "       → 合成ツリーで実行する場合は DB_ORDINAL_MAIN_SNAPSHOT を注入してください。" >&2
    exit 1
  fi
  if ! git -C "$ROOT" rev-parse --verify --quiet "${DB_ORDINAL_MAIN_REF}^{commit}" >/dev/null; then
    echo "ERROR: ${DB_ORDINAL_MAIN_REF} を解決できません（HEAD へは落としません）。" >&2
    echo "       → CI では checkout の後に次を実行してください:" >&2
    echo "         git fetch --no-tags --depth=1 origin main" >&2
    echo "       → 単体ツリーだけの判定に退化させると、番号衝突は原理的に検出できません。" >&2
    exit 1
  fi
  echo "INFO: main 側は ${DB_ORDINAL_MAIN_REF} から読みます。" >&2
fi

# $1 = ディレクトリ。main 側のパスを 1 行 1 件で出す。
main_paths_in() {
  if [ "$snapshot_declared" -eq 1 ]; then
    # snapshot はリポジトリ全体のパス一覧。対象ディレクトリ直下だけを取り出す。
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      case "$line" in
        "$1"/*)
          # サブディレクトリを含むパスは対象外（直下のみ）。
          case "${line#"$1"/}" in
            */*) ;;
            *) printf '%s\n' "$line" ;;
          esac
          ;;
      esac
    done < "$snapshot_path"
  else
    git -C "$ROOT" -c core.quotePath=false ls-tree -r --name-only \
      "${DB_ORDINAL_MAIN_REF}" -- "$1/"
  fi
}

# $1 = ディレクトリ。HEAD 側（作業ツリーの追跡ファイル）のパスを出す。
head_paths_in() {
  git -C "$ROOT" -c core.quotePath=false ls-files --cached -- "$1/*.sql"
}

# 先頭の連続数字を 10 進として正規化する（0005 と 5 を同一視する）。
ordinal_of() {
  local digits="${1%%_*}"
  printf '%s\n' "$((10#$digits))"
}

# 非空行の件数を数える。**grep は使わない。** `grep -c` は無一致で exit 1 を返すため素の代入では
# set -e で落ち、`|| true` で潰すと評価不能（exit 2 以上）まで飲み込んで壊れた判定が 0 に化ける
# （steering「シェルガードの実装規律」）。空文字は 0 行として扱う（printf は空でも改行を 1 つ出す
# ので wc -l では 1 になってしまう）。
count_lines() {
  if [ -z "$1" ]; then
    printf '0\n'
    return 0
  fi
  printf '%s\n' "$1" | wc -l | tr -d '[:space:]'
}

# --- 対象ごとの検査 -------------------------------------------------------------
# 形式: <dir>|<命名の数字部の正規表現>|<欠番検査を行うか>
for spec in \
  'db/migrations|[0-9]{4}|yes' \
  'db/test/assertions|[0-9]+|no'
do
  dir="${spec%%|*}"
  rest="${spec#*|}"
  digit_re="${rest%%|*}"
  gap_check="${rest##*|}"

  union="$( { head_paths_in "$dir"; main_paths_in "$dir"; } | sort -u )"

  # 空振り防止: 対象が 1 件も無ければ、この検査自体が成立していない。
  count="$(count_lines "$union")"
  if [ "${count:-0}" -eq 0 ]; then
    echo "ERROR: ${dir} に .sql が 1 件もありません（走査前提が崩れています）。" >&2
    echo "       → ディレクトリの移動・改名か、ls-files の pathspec の破損を疑ってください。" >&2
    fail=1
    continue
  fi
  checked_dirs=$((checked_dirs + 1))

  name_re="^${digit_re}_[a-z0-9]+(_[a-z0-9]+)*\.sql$"
  ordinals=''
  bad_name=0

  while IFS= read -r path; do
    [ -n "$path" ] || continue
    base="${path##*/}"
    if ! [[ $base =~ $name_re ]]; then
      echo "ERROR: ${dir}/${base} が命名規約 <番号>_<snake_case>.sql に合いません。" >&2
      echo "       → 番号で適用順を決めているため、番号を機械抽出できない名前は置けません。" >&2
      fail=1
      bad_name=1
      continue
    fi
    ordinals="${ordinals}$(ordinal_of "$base")|${base}
"
  done <<EOF
$union
EOF

  # 命名が壊れている状態で以降の番号検査を続けると、原因を取り違えた二次エラーが出る。
  if [ "$bad_name" -ne 0 ]; then
    continue
  fi

  # (1) 番号の一意性。1 番号に 2 つ以上の basename があれば衝突。
  dups="$(printf '%s' "$ordinals" | cut -d'|' -f1 | sort -n | uniq -d)"
  if [ -n "$dups" ]; then
    while IFS= read -r dup; do
      [ -n "$dup" ] || continue
      names="$(printf '%s' "$ordinals" | awk -F'|' -v n="$dup" '$1 == n { print $2 }' | sort | tr '\n' ' ')"
      echo "ERROR: ${dir} の番号 ${dup} が重複しています: ${names}" >&2
      echo "       → ファイル名が違うため git は衝突として報告しません（HEAD と ${DB_ORDINAL_MAIN_REF} の合成で検出）。" >&2
      echo "         後から追加した側を次の空き番号へ改番し、参照している文書も更新してください。" >&2
      fail=1
    done <<EOF
$dups
EOF
  fi

  sorted_nums="$(printf '%s' "$ordinals" | cut -d'|' -f1 | sort -n -u)"
  checked_ordinals=$((checked_ordinals + $(count_lines "$sorted_nums")))

  # (2) 辞書順と数値順の一致。適用は shell glob（辞書順）なので、両者がずれると
  #     番号から適用順が読めなくなる。桁数混在の assertions でこそ効く。
  lex_order="$(printf '%s' "$ordinals" | cut -d'|' -f2 | sort | awk -F'_' '{ print $1 }' | awk '{ print $1+0 }')"
  num_order="$(printf '%s' "$ordinals" | sort -t'|' -k1,1n | cut -d'|' -f1)"
  if [ "$lex_order" != "$num_order" ]; then
    echo "ERROR: ${dir} の辞書順と数値順が一致しません（適用順が番号から決まりません）。" >&2
    echo "       → 桁数を揃えるか、番号を振り直してください。" >&2
    echo "         辞書順: $(printf '%s' "$lex_order" | tr '\n' ' ')" >&2
    echo "         数値順: $(printf '%s' "$num_order" | tr '\n' ' ')" >&2
    fail=1
  fi

  # (3) 欠番検査（migrations のみ）。1 から始まる連番であること。
  if [ "$gap_check" = 'yes' ]; then
    expected=1
    while IFS= read -r n; do
      [ -n "$n" ] || continue
      if [ "$n" -ne "$expected" ]; then
        echo "ERROR: ${dir} の番号が連番ではありません（${expected} が欠番です・実際は ${n}）。" >&2
        echo "       → HEAD と ${DB_ORDINAL_MAIN_REF} を合成した集合で判定しています。" >&2
        echo "         ブランチ側だけを見て欠番に見える場合は main 側が埋めているので正常です。" >&2
        fail=1
        break
      fi
      expected=$((expected + 1))
    done <<EOF
$sorted_nums
EOF
  fi
done

# 空振り防止: 対象ディレクトリを 1 つも検査できていなければ、この装置自体が壊れている。
if [ "$checked_dirs" -eq 0 ]; then
  echo "ERROR: 検査できた対象ディレクトリが 0 件です（走査前提が崩れています）。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: 連番の一意性ガードに違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: 連番一意性ガード緑（${checked_dirs} ディレクトリ・${checked_ordinals} 番号を HEAD と ${DB_ORDINAL_MAIN_REF} の合成集合で検証）。"
exit 0
