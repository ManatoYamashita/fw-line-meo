#!/usr/bin/env bash
# Issue #90 追補ガードレール: `scripts/test/run.sh` の空振り防止は「アサーション 0 件」でしか
# 発火せず、**ケースファイルが 1 つ消えても残りが緑なら OK を返す**。PR #93 のレビューで実測:
# `50-check-deploy-image-coverage.sh` を退避すると `--require-full` でも
# `20 ケース / 26 アサーション … OK: ガード自己テスト緑` / exit 0 になった。拡張子を `.bash` へ
# 変えただけでも同じ（`find -name '*.sh'` から外れるため）。
#
# これは本リポジトリが #33（tf のサービスが push 対象に無い）・#51（typecheck が定義されて
# いるのに CI から呼ばれない）・#78（設定ファイルが検査の器に入っていない）で繰り返し踏んだ
# 「定義はあるが器に入っていない」形状そのものであり、しかも一段上（ガードを守る装置）で
# 起きている。ガードの本数が増えるほど、ケースの取りこぼしは差分上に痕跡を残さなくなる。
#
# 本スクリプトは以下を機械検証する（read-only の走査・副作用なし・連想配列を使わず bash 3.2 でも走る）:
#   1. `scripts/check-*.sh` の各ガードに `scripts/test/cases/NN-<ガード名>.sh` がちょうど 1 件ある
#      （層で分けたい場合の変種 `NN-<ガード名>.<変種>.sh` は 0 件以上を許す。基本ケースは必須）
#   2. 逆に、各ケースファイルが実在するガードを指している（改名の取り残し＝孤児ケースの検出）
#   3. 意図的除外はこのファイル内の WHITELIST に Issue 番号付きで明記されている
#      （ホワイトリスト項目が実はカバー済みになったら警告し、削除を促す）
#   4. 空振り防止: ガード 0 件・ケースファイル 0 件・ケースディレクトリ消失はいずれも赤
#
# 本スクリプト自身も `check-*.sh` に一致するため、自分にもケースファイルを要求する（自己強制）。
#
# 使い方: bash scripts/check-guard-selftest-coverage.sh
#   漏れがあれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GUARD_DIR="${ROOT}/scripts"
CASES_DIR="${ROOT}/scripts/test/cases"

# 意図的に自己テストを持たないガード（必ず理由と Issue を明記すること）。
# 現在は空。追加時は `WHITELIST=(check-foo)` 形式で、直上に理由と Issue 番号を書く。
WHITELIST=()

if [ ! -d "$CASES_DIR" ]; then
  echo "ERROR: ケースディレクトリがありません: ${CASES_DIR#$ROOT/}（ガードの自己テストが丸ごと消えています）。" >&2
  exit 1
fi

in_list() {
  # $1=needle, 残り=list
  needle="$1"
  shift
  for x in "$@"; do
    [ "$x" = "$needle" ] && return 0
  done
  return 1
}

fail=0
guard_count=0
covered=0

# 検証1/3: 各ガードに対応するケースファイルがちょうど 1 件あること。
for guard_path in "$GUARD_DIR"/check-*.sh; do
  [ -f "$guard_path" ] || continue
  name="$(basename "$guard_path" .sh)"
  guard_count=$((guard_count + 1))

  n=0
  for case_path in "$CASES_DIR"/[0-9][0-9]-"${name}".sh; do
    [ -f "$case_path" ] || continue
    n=$((n + 1))
  done

  # ${arr[@]+...} は空配列でも set -u（bash 3.2 含む）で unbound エラーにしない安全な展開。
  if in_list "$name" ${WHITELIST[@]+"${WHITELIST[@]}"}; then
    if [ "$n" -gt 0 ]; then
      echo "WARNING: ${name} は WHITELIST に載っていますが既にケースがあります。WHITELIST から削除してください。" >&2
    else
      echo "SKIP: ${name}（WHITELIST・理由はスクリプト内コメント参照）"
    fi
    continue
  fi

  if [ "$n" -eq 0 ]; then
    echo "ERROR: ${name} に対応するケースファイルがありません（scripts/test/cases/NN-${name}.sh）。" >&2
    echo "       → ガードは走りますが「壊れたときに壊れたと言える」ことを誰も検証していない状態になります（Issue #90）。" >&2
    fail=1
  elif [ "$n" -gt 1 ]; then
    echo "ERROR: ${name} に対応するケースファイルが ${n} 件あります。1 件へ統合してください。" >&2
    fail=1
  else
    covered=$((covered + 1))
  fi
done

# 空振り防止: 命名前提（scripts/check-*.sh）が崩れていれば、この検証自体が成立していない。
if [ "$guard_count" -eq 0 ]; then
  echo "ERROR: ${GUARD_DIR#$ROOT/} から check-*.sh を 1 件も検出できませんでした（命名前提が崩れています）。" >&2
  exit 1
fi

# 検証2: 逆方向。ケースファイルが実在しないガードを指していないこと（改名の取り残し）。
case_count=0
for case_path in "$CASES_DIR"/*.sh; do
  [ -f "$case_path" ] || continue
  case_count=$((case_count + 1))
  base="$(basename "$case_path" .sh)"

  case "$base" in
    [0-9][0-9]-*)
      target="${base#??-}"
      # 変種ケース `NN-<ガード名>.<変種>.sh` は最初の `.` 以降を落として対応先を決める。
      # 1 つのガードの自己テストを層で分けたいときに使う（Tier A / Tier B 等）。基本ケース
      # `NN-<ガード名>.sh` は上の順方向照合でちょうど 1 件必須のまま、変種は 0 件以上を許す。
      target="${target%%.*}"
      ;;
    *)
      echo "ERROR: ${base}.sh の名前が NN-<ガード名>.sh の形になっていません（対応関係を機械照合できません）。" >&2
      fail=1
      continue
      ;;
  esac

  if [ ! -f "${GUARD_DIR}/${target}.sh" ]; then
    echo "ERROR: ${base}.sh に対応するガード scripts/${target}.sh がありません（ガード改名の取り残しです）。" >&2
    fail=1
  fi
done

# 空振り防止: ケースファイルが 1 件も無ければ、harness は何も検証していない。
if [ "$case_count" -eq 0 ]; then
  echo "ERROR: ${CASES_DIR#$ROOT/} にケースファイルが 1 件もありません。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: ガード自己テストのカバレッジに漏れがあります（上記参照）。" >&2
  exit 1
fi

echo "OK: ガード自己テストカバレッジ緑（${covered}/${guard_count} ガードにケース・${case_count} ケースファイル・WHITELIST ${#WHITELIST[@]} 件）。"
exit 0
