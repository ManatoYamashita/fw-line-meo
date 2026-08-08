#!/usr/bin/env bash
# Issue #70 ガードレール: テストコードが型検査にも lint にも掛かっていなかった。
#
# 実態（本ガード導入前）:
#   - 型検査: **全 10 workspace のどれもテストコードを見ていない**。packages / backend は
#     tsconfig の include が `src/**` のみ、Next 3 面は exclude に `test` / `e2e` を持つ。
#   - lint: survey-web と dashboard-web は `eslint src` のみで、`test/` も `e2e/` も走査外。
#
# 実害: #57 のタスク 4.3 で、調査用プローブが **宣言外パッケージを動的 import** したまま
# 残ったが、型検査も lint も走らないため機械検証は一切働かなかった（人手のレビューで拾った）。
# テストは「実行して緑」なら通るため、型の破綻・未使用・any の混入は静かに蓄積する。
#
# 検証内容（workspace ごと）:
#   1. 存在する TypeScript コードディレクトリ（src / app / test / e2e / scripts）を列挙する
#   2. 各ディレクトリが lint スクリプトの走査対象に含まれている
#   3. 各ディレクトリのファイルが tsc のプログラムに実際に含まれている
#      （`tsc --listFiles` の出力で判定する。include/exclude のグロブを自前で解釈しない）
#
# 3 が本ガードの核心である。tsconfig の include/exclude は `extends` と glob の組合せで
# 実効範囲が決まるため、設定ファイルの文字列を見るだけでは「本当に型検査されているか」を
# 判定できない。コンパイラ自身にプログラムの構成を答えさせる。
#
# 使い方: bash scripts/check-test-code-coverage.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。
#   read-only（tsc は --noEmit で走らせる）・副作用なし・連想配列を使わず bash 3.2 でも走る。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TS_DIR="${ROOT}/ts"
WORKSPACE_YAML="${TS_DIR}/pnpm-workspace.yaml"

if [ ! -f "$WORKSPACE_YAML" ]; then
  echo "ERROR: 検証対象が見つかりません: ${WORKSPACE_YAML#$ROOT/}" >&2
  exit 1
fi

# 走査候補。ここに無いディレクトリ名を新設した場合は追加すること
# （網羅性はディレクトリ名の列挙に依存する。増えたら気づけるよう下の「候補外」検出を置く）。
CODE_DIR_CANDIDATES="src app lib test e2e scripts"

fail=0
checked_workspaces=0
checked_dirs=0

globs="$(sed -nE "s/^[[:space:]]*-[[:space:]]*'([^']+)'.*/\1/p" "$WORKSPACE_YAML")"
if [ -z "$globs" ]; then
  echo "ERROR: ${WORKSPACE_YAML#$ROOT/} から workspace glob を1件も抽出できません。抽出前提が崩れています。" >&2
  exit 1
fi

while IFS= read -r glob; do
  [ -n "$glob" ] || continue
  for pkg_dir in "$TS_DIR"/$glob/; do
    pkg_json="${pkg_dir}package.json"
    [ -f "$pkg_json" ] || continue
    checked_workspaces=$((checked_workspaces + 1))
    rel_pkg="${pkg_dir#$ROOT/}"

    lint_script="$(node -e "
      const p = require('${pkg_json}');
      process.stdout.write(p.scripts && p.scripts.lint ? p.scripts.lint : '');
    ")"

    typecheck_script="$(node -e "
      const p = require('${pkg_json}');
      process.stdout.write(p.scripts && p.scripts.typecheck ? p.scripts.typecheck : '');
    ")"

    # 対象 tsconfig は **typecheck スクリプトが実際に走らせるもの** から取る。
    # workspace 直下の tsconfig を総なめにすると、「テストをカバーする tsconfig は存在するが
    # CI は一度も走らせない」という状態が緑になる（カバレッジではなく設定ファイルの棚卸しになる）。
    # `-p <path>` 指定が無い場合は tsc の既定である tsconfig.json を対象とする。
    tsconfig_names="$(printf '%s' "$typecheck_script" | sed -nE 's/.*(-p|--project)[[:space:]]+([^[:space:]]+).*/\2/p')"
    if [ -z "$tsconfig_names" ]; then
      if printf '%s' "$typecheck_script" | grep -q 'tsc'; then
        tsconfig_names='tsconfig.json'
      else
        echo "ERROR: ${rel_pkg} の typecheck スクリプトが tsc を呼んでいません（現在: '${typecheck_script}'）。" >&2
        echo "       → 型検査の実効範囲を判定できません。" >&2
        fail=1
        continue
      fi
    fi

    # tsc のプログラムに含まれるファイル一覧を集める（複数 tsconfig の和集合）。
    program_files=''
    for tsconfig_name in $tsconfig_names; do
      tsconfig="${pkg_dir}${tsconfig_name}"
      if [ ! -f "$tsconfig" ]; then
        echo "ERROR: ${rel_pkg} の typecheck が指す ${tsconfig_name} が存在しません。" >&2
        fail=1
        continue
      fi
      # 型エラーがあっても --listFiles はプログラム構成を出すため、終了コードは無視する。
      listed="$(cd "$pkg_dir" && npx --no-install tsc -p "$tsconfig_name" --noEmit --listFiles 2>/dev/null || true)"
      program_files="${program_files}
${listed}"
    done

    if [ -z "$(printf '%s' "$program_files" | tr -d '[:space:]')" ]; then
      echo "ERROR: ${rel_pkg} で tsc のプログラム構成を取得できませんでした。" >&2
      echo "       → tsconfig が読めないか tsc を実行できていません。本ガードが空振りします。" >&2
      fail=1
      continue
    fi

    for dir in $CODE_DIR_CANDIDATES; do
      [ -d "${pkg_dir}${dir}" ] || continue
      # TypeScript ファイルを含まないディレクトリは対象外（perf/*.mjs 等）。
      if ! find "${pkg_dir}${dir}" -name '*.ts' -o -name '*.tsx' 2>/dev/null | grep -q .; then
        continue
      fi
      checked_dirs=$((checked_dirs + 1))

      # (2) lint の走査対象に含まれているか。スクリプトの引数として現れることを要求する。
      if ! printf '%s' "$lint_script" | grep -qE "(^|[[:space:]])${dir}([[:space:]]|/|$)"; then
        echo "ERROR: ${rel_pkg} の lint スクリプトが ${dir}/ を走査していません（現在: '${lint_script}'）。" >&2
        echo "       → ${dir}/ に any や未使用が混入しても CI は緑のまま通ります。" >&2
        echo "         lint スクリプトの引数へ ${dir} を追加してください。" >&2
        fail=1
      fi

      # (3) tsc のプログラムに実際に含まれているか。設定文字列ではなくコンパイラの答えで判定する。
      #
      # 判定は「workspace の絶対パス＋ディレクトリ名」を固定文字列で数える。
      # `/test/` のような部分一致にすると node_modules 配下の同名ディレクトリに当たり、
      # 未カバーでも件数が立って**常に緑**になる（実際にこの誤りを踏んだ）。
      # `grep -q` は最初の一致で打ち切るため件数が取れず判定が不透明になるので使わない。
      dir_hits="$(printf '%s' "$program_files" | grep -Fc "${pkg_dir}${dir}/" || true)"
      if [ "${dir_hits:-0}" -eq 0 ]; then
        echo "ERROR: ${rel_pkg}${dir}/ が tsc のプログラムに含まれていません。" >&2
        echo "       → このディレクトリの型エラーは CI を素通りします（テストは実行して緑なら通るため気づけません）。" >&2
        echo "         tsconfig の include へ '${dir}/**/*.ts'（tsx があれば併せて）を追加するか、exclude から外してください。" >&2
        fail=1
      fi
    done

    # 候補外のコードディレクトリが増えていないか（列挙の陳腐化を検出する）。
    for entry in "${pkg_dir}"*/; do
      [ -d "$entry" ] || continue
      name="$(basename "$entry")"
      case " $CODE_DIR_CANDIDATES node_modules dist dist-scripts .next perf public db " in
        *" $name "*) continue ;;
      esac
      if find "$entry" -name '*.ts' -o -name '*.tsx' 2>/dev/null | grep -q .; then
        echo "ERROR: ${rel_pkg}${name}/ は TypeScript を含みますが本ガードの走査候補にありません。" >&2
        echo "       → CODE_DIR_CANDIDATES へ追加してください（候補の列挙が実態に追いついていません）。" >&2
        fail=1
      fi
    done
  done
done <<EOF
$globs
EOF

# 空振り防止: workspace もディレクトリも 1 件も検証できていなければ、この検証自体が壊れている。
if [ "$checked_workspaces" -eq 0 ]; then
  echo "ERROR: workspace を1件も検証できませんでした。抽出前提が崩れています。" >&2
  exit 1
fi
if [ "$checked_dirs" -eq 0 ]; then
  echo "ERROR: コードディレクトリを1件も検証できませんでした。ガードが空振りしています。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: テストコードのカバレッジガードに違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: テストコードのカバレッジガード緑（${checked_workspaces} workspace / ${checked_dirs} ディレクトリが lint と型検査の双方に掛かっている）。"
exit 0
