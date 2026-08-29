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
#   1. `scripts/check-*.sh` の各ガードに対応するケースファイルが **tier ごとに 1 件** ある
#      （`NN-<ガード名>.sh` = Tier A / `NN-<ガード名>.tier-b.sh` = Tier B）。基本ケース（Tier A）は
#      全ガード必須、TIER_SPLIT へ宣言したガードは Tier B も必須
#      （片側が消えても残る層の緑で通るのを防ぐ）
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

# tier 分割済みガードの宣言（Issue #90 の二層化・PR #103 レビュー指摘）。
# ここに載せたガードは Tier B（`.tier-b`）のケースファイルの実在も要求する。
# Tier A（接尾辞なし）の基本ケースは宣言に依らず全ガード必須である（check_tier_set の (1)）。
#
# 「tier ごとに 1 件」だけでは **片側の消失** を検出できない。2 tier へ割れたガードは片方の
# ファイルを削除しても残り 1 件で「カバー済み」と数えられ、その層の検証が丸ごと消えても
# 本ガードは `8/8 ガードにケース` と申告し、run.sh --tier=a も緑を返した（PR #103 のレビューで
# base 赤 / head 緑を実測）。これは本スクリプトが PR #93 で塞いだ「ケースファイルが 1 件消えても
# 残りの緑で通る」形状が、tier 粒度へ移っただけである。
#
# 宣言のずれは **両方向** で赤にする。載っているのに片側が無ければ欠落、載っていないのに
# 2 tier あれば宣言漏れ。片方向だけだと、この一覧そのものが実態から乖離していく。
# ガードを改名した場合は新しい名前が「2 tier あるのに未宣言」で赤になるため、取り残された
# 旧名の項目は不活性になるだけで見逃しにはならない。
TIER_SPLIT=(check-test-code-coverage)

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

# ケースファイル名から tier 接尾辞を取り出す（`NN-<ガード名>[.tier-b].sh` の `tier-b` の部分）。
# 接尾辞の無いものは Tier A である。run.sh の所属判定（`*.tier-b.sh` だけが Tier B）と
# **同じ前提をここでも使う**ため、対応表は増やさず「run.sh が知っている接尾辞」だけを許す。
# 未知の接尾辞（`.tier-c` 等）は run.sh が黙って Tier A へ倒すため、宣言と実態が乖離する。
case_tier_of() {
  # $1 = 拡張子を除いたケースファイル名。tier トークンを stdout へ返す（Tier A は空文字）。
  case "$1" in
    *.tier-b) echo 'tier-b' ;;
    *.tier-*) echo "${1##*.}" ;;
    *) echo '' ;;
  esac
}

case_guard_of() {
  # $1 = 拡張子と NN- 接頭を除いたケースファイル名。tier 接尾辞を落としてガード名を返す。
  case "$1" in
    *.tier-*) echo "${1%.tier-*}" ;;
    *) echo "$1" ;;
  esac
}

check_tier_set() {
  # 期待する tier 集合が実在することを要求する（PR #103 レビュー指摘）。
  #   $1 = ガード名 / $2 = そのガードで実在した tier トークンの一覧（空白区切り・Tier A は tier-a）
  #
  # 件数を見る上のループとは検出する欠陥が違う。あちらは「同じ層が 2 ファイルへ散る」、
  # 本関数は「あるべき層が丸ごと消える」。後者は件数が tier ごとに 1 件のままなので、
  # 件数をいくら厳しくしても捕まらない。
  cts_name="$1"
  cts_seen="$2"

  # (1) 基本ケース（Tier A）は **宣言に依らず** 必須。
  #
  # 宣言の要求だけでは足りない。基本ケースを変種へ置き換える改変は「未宣言のまま 2 tier」と
  # いう赤の状態を **一度も通らない** ため、宣言を課しても緑で素通りする（PR #116 との衝突分析で
  # 実測）。Tier A は install 前に走る唯一の層であり、消えたまま気づけない層でもある。
  # 宣言から独立した構造的要件として課すことで、経路に依らず必ず捕まる。
  if ! in_list 'tier-a' $cts_seen; then
    echo "ERROR: ${cts_name} に Tier A の基本ケース（NN-${cts_name}.sh）がありません。" >&2
    echo "       → tier 変種だけが残っています。install 前に走る層の検証が丸ごと消えており、" >&2
    echo "         残る層の緑だけで CI が通ってしまいます（件数は 1 件のままです）。" >&2
    fail=1
  fi

  # (2) TIER_SPLIT に載せたガードは Tier B も必須。こちらは構造から導けない（Tier B を持たない
  #     ガードのほうが普通である）ため、宣言でしか要求できない。
  if in_list "$cts_name" ${TIER_SPLIT[@]+"${TIER_SPLIT[@]}"}; then
    if ! in_list 'tier-b' $cts_seen; then
      echo "ERROR: ${cts_name} は TIER_SPLIT の宣言に反して Tier B のケースファイルがありません。" >&2
      echo "       → 実物の tsc / eslint にしか答えられない層の検証が消えても、Tier A の緑だけで通ります。" >&2
      echo "         復旧するか、その層を持たない構成にしたのなら TIER_SPLIT から外してください。" >&2
      fail=1
    fi
    return 0
  fi

  # (3) 未宣言のまま 2 tier へ割れている状態。放置すると、以後 Tier B が消えても検出できない。
  if in_list 'tier-a' $cts_seen && in_list 'tier-b' $cts_seen; then
    echo "ERROR: ${cts_name} は Tier A / Tier B の両方にケースファイルがありますが TIER_SPLIT に宣言されていません。" >&2
    echo "       → 宣言が無いと、Tier B が消えても Tier A の緑だけで通ります（件数は 1 件のままです）。" >&2
    echo "         TIER_SPLIT へ ${cts_name} を追加してください。" >&2
    fail=1
  fi
  return 0
}

# 検証1/3: 各ガードに対応するケースファイルがあること。
#
# **tier ごとに 1 件**とする（Issue #90 の二層化）。1 本のガードのケースは Tier A / Tier B の
# 2 ファイルへ割れるため「ガード 1 本にファイル 1 件」を素朴に課すと正しい構成が赤になる。
# かといって何件でも許すと、同じ層のケースが 2 つのファイルへ散る事故を見逃す。
for guard_path in "$GUARD_DIR"/check-*.sh; do
  [ -f "$guard_path" ] || continue
  name="$(basename "$guard_path" .sh)"
  guard_count=$((guard_count + 1))

  n=0
  seen_tiers=''
  for case_path in "$CASES_DIR"/[0-9][0-9]-"${name}".sh "$CASES_DIR"/[0-9][0-9]-"${name}".tier-*.sh; do
    [ -f "$case_path" ] || continue
    n=$((n + 1))
    case_base="$(basename "$case_path" .sh)"
    tier="$(case_tier_of "${case_base#??-}")"
    tier_label='A'
    [ -z "$tier" ] || tier_label="$(printf '%s' "${tier#tier-}" | tr 'a-z' 'A-Z')"
    if in_list "${tier:-tier-a}" $seen_tiers; then
      echo "ERROR: ${name} の Tier ${tier_label} のケースファイルが 2 件あります。1 件へ統合してください。" >&2
      echo "       → 同じ層の検証が 2 つのファイルへ散ると、片方だけが更新される日が来ます。" >&2
      fail=1
    fi
    seen_tiers="${seen_tiers} ${tier:-tier-a}"
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
  else
    # 件数そのものは制約にしない（tier ごとに 1 件を上のループで見ている）。
    # ただし **期待する tier がすべて実在すること** は別に要求する。件数だけを見ていると、
    # 2 tier へ割れたガードの片方が消えても n=1 のまま「カバー済み」になる（PR #103）。
    check_tier_set "$name" "$seen_tiers"
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
    [0-9][0-9]-*) stem="${base#??-}" ;;
    *)
      echo "ERROR: ${base}.sh の名前が NN-<ガード名>.sh の形になっていません（対応関係を機械照合できません）。" >&2
      fail=1
      continue
      ;;
  esac

  # tier 接尾辞は run.sh が所属判定に使う唯一の情報源である。run.sh が知らない接尾辞を
  # 許すと、`.tier-c` のようなファイルが「Tier C のつもり」で置かれたまま黙って Tier A として
  # 走る（実物を要するケースなら install 前の CI で落ち、原因は名前だと気づけない）。
  case "$(case_tier_of "$stem")" in
    '' | 'tier-b') ;;
    *)
      echo "ERROR: ${base}.sh は run.sh が未知の tier 接尾辞です（既知: 接尾辞なし = Tier A / .tier-b = Tier B）。" >&2
      echo "       → run.sh は未知の接尾辞を黙って Tier A として扱うため、宣言と実態が食い違います。" >&2
      fail=1
      continue
      ;;
  esac

  # 対応先は `scripts/<stem>.sh` を第一候補とし、`db/test/<stem>.sh` も受け付ける。
  # `db/test/*.sh` は #156 / #158 で **CI から毎 PR 実行される検査資産**になったので、
  # ケースを書く先として正当である（それを禁じると、CI が回すガードだけ自己テストを
  # 持てないという逆転が起きる）。**逆方向（このガードがケースを要求する側）は依然
  # `scripts/check-*.sh` のみである**。db/test の検査資産へ要求を広げるのは Issue #162。
  target="$(case_guard_of "$stem")"
  if [ ! -f "${GUARD_DIR}/${target}.sh" ] && [ ! -f "${ROOT}/db/test/${target}.sh" ]; then
    echo "ERROR: ${base}.sh に対応するガードが scripts/${target}.sh にも db/test/${target}.sh にもありません（ガード改名の取り残しです）。" >&2
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
