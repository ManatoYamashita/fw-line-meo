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
# ---------------------------------------------------------------------------
# Issue #78 拡張: 上の 1〜3 の走査単位は「ディレクトリ列挙」であり、**workspace 直下に置かれる
# 設定ファイルは構造的に対象外**だった。実測（origin/main 0f8e273）では設定ファイル 11 件のうち
# 9 件が型検査にも lint にも掛かっていない。
#
# 設定ファイルは実行されるコードではなく **検証の配線そのもの** である。壊れたときの症状は
# 「テストが落ちる」ではなく「**テストが走らなくなる／別のものを測る**」であり、緑のまま失敗する。
#   - `vitest.config.ts` の `test.exclude` のキー名を誤る → 意図した除外が効かない
#   - `playwright.config.ts` の `webServer.reuseExistingServer` を誤る → 他プロセスのサーバを測る
# いずれも「未知のキーは黙って無視される」形状のため、型検査の外にある限り誰も気づけない。
#
# 追加の検証内容（workspace 直下 ＋ ts/ 直下の各コードファイル）:
#   A. eslint の ignores に除外されていない（eslint 自身に JSON で答えさせる）
#   B. lint スクリプトの引数に現れる（ディレクトリ限定の引数では直下のファイルへ到達しない）
#   C. tsc のプログラムに含まれ、**かつ実際に型検査される**
#
# C の後段が肝である。`allowJs: true` だけだと JS 系（.js/.mjs/.cjs/.jsx）は `--listFiles` に
# 現れるが型検査されない。プログラム所属を検査の証拠として扱うと**ガードが緑のまま素通りする**。
# ファイル局所で機械検証できる証拠として `@ts-check` プラグマを要求する。照合はコメント行の
# 先頭へアンカーする。部分一致にすると散文の言及だけで緑になり、上と同じ代理証拠の誤りを繰り返す。
#
# 対象の列挙は拡張子ベースで行う。ディレクトリ名の列挙（CODE_DIR_CANDIDATES）と違い、
# 新しい設定ファイルが増えても列挙が陳腐化しない（穴が構造的に空かない）。
# ---------------------------------------------------------------------------
#
# 使い方: bash scripts/check-test-code-coverage.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。
#   read-only（tsc は --noEmit、eslint は --fix なしで走らせる）・副作用なし・
#   連想配列を使わず bash 3.2 でも走る。

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

# lint の検査（A/B）のみ免除してよい直下ファイル（Issue #78）。
# next-env.d.ts は Next が生成し、自ら「This file should not be edited」と書いているファイルで、
# 内容は Next のバージョンに従って変わる。lint 引数へ入れると、我々が編集できないファイルの
# 指摘で CI が赤くなり、しかも直す手段が無い（実測では現状 0 件だが将来の保証が無い）。
# **型検査（C）は免除しない。** tsconfig の include に既に入っており、検査には価値があるため、
# この免除が型検査側の穴を隠すことはない。
LINT_EXEMPT_ROOT_FILES="next-env.d.ts"

fail=0
checked_workspaces=0
checked_dirs=0
checked_root_files=0

# ディレクトリ直下のコードファイルが lint と型検査の双方に掛かっているかを検査する（Issue #78）。
# 呼出元の fail / checked_root_files を更新する（サブシェルを挟まないこと）。
#   $1 対象ディレクトリ（末尾 / 付きの絶対パス）
#   $2 表示用の相対パス（末尾 / 付き）
#   $3 その単位の lint スクリプト文字列
#   $4 その単位の tsc プログラム構成（--listFiles の出力）
check_root_files() {
  crf_dir="$1"
  crf_rel="$2"
  crf_lint="$3"
  crf_program="$4"

  # 拡張子ベースの列挙。ディレクトリ名を列挙する方式と違い、新設ファイルで穴が空かない。
  crf_files="$(find "$crf_dir" -maxdepth 1 -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' \
       -o -name '*.mjs' -o -name '*.cjs' -o -name '*.js' -o -name '*.jsx' \) \
    -exec basename {} \; | sort)"
  [ -n "$crf_files" ] || return 0

  # (A) eslint の ignores に消されていないこと。
  #     flat config の ignores は複数ブロックの合成結果で決まるため、設定ファイルの文字列を
  #     読んでも判定できない。tsc に --listFiles を尋ねるのと同じ流儀で eslint 自身に尋ねる。
  #     lint エラーの有無は関与しない（それは `pnpm lint` の仕事）。「無視されたか」だけを見る。
  crf_json="$(cd "$crf_dir" && npx --no-install eslint \
    --no-error-on-unmatched-pattern --format json $crf_files 2>/dev/null || true)"

  crf_ignored=''
  if [ -z "$(printf '%s' "$crf_json" | tr -d '[:space:]')" ]; then
    echo "ERROR: ${crf_rel} で eslint の判定結果を取得できませんでした。" >&2
    echo "       → eslint を実行できていません。本ガードの lint 判定が空振りします。" >&2
    fail=1
  else
    crf_ignored="$(printf '%s' "$crf_json" | node -e "
      const path = require('node:path');
      let s = '';
      process.stdin.on('data', (d) => (s += d)).on('end', () => {
        const results = JSON.parse(s);
        const ignored = results
          .filter((r) => r.messages.some((m) => m.ruleId === null && /ignore/i.test(m.message)))
          .map((r) => path.basename(r.filePath));
        process.stdout.write(ignored.join('\n'));
      });
    " 2>/dev/null || printf '__PARSE_FAILED__')"
    if [ "$crf_ignored" = '__PARSE_FAILED__' ]; then
      echo "ERROR: ${crf_rel} で eslint の JSON 出力を解釈できませんでした。" >&2
      echo "       → 出力形式が変わっています。本ガードの lint 判定が空振りします。" >&2
      fail=1
      crf_ignored=''
    fi
  fi

  # 以降の照合はすべて `grep -c`（件数）で行い、`grep -q` は使わない。
  # `grep -q` は最初の一致で打ち切るため、上流の printf が書き切る前にパイプが閉じて
  # SIGPIPE で死に、`set -o pipefail` によってパイプライン全体が失敗扱いになる。
  # 入力が小さいと printf が先に完走するため一致するが、tsc の --listFiles のように
  # 1000 行を超えると一致していても「不一致」と判定される（実測: store-detail の
  # next-env.d.ts が 1179 行の出力で偽陽性になった）。**入力サイズ依存で緑にも赤にもなる。**
  for crf_base in $crf_files; do
    checked_root_files=$((checked_root_files + 1))
    # ファイル名はドットを含む。正規表現で使う箇所はエスケープする
    # （next.config.ts が nextXconfigYts に誤ヒットしないように）。
    crf_re="$(printf '%s' "$crf_base" | sed 's/[.]/\\./g')"

    crf_lint_exempt=0
    case " $LINT_EXEMPT_ROOT_FILES " in
      *" $crf_base "*) crf_lint_exempt=1 ;;
    esac

    if [ "$crf_lint_exempt" -eq 0 ]; then
      crf_hits="$(printf '%s\n' "$crf_ignored" | grep -Fxc "$crf_base" || true)"
      if [ "${crf_hits:-0}" -ne 0 ]; then
        echo "ERROR: ${crf_rel}${crf_base} は eslint の ignores に除外されています。" >&2
        echo "       → lint スクリプトの引数へ足しても走査そのものが行われません。" >&2
        echo "         ts/eslint.config.js の ignores は生成物のみへ絞ってください。" >&2
        fail=1
      fi

      crf_hits="$(printf '%s' "$crf_lint" | grep -Ec "(^|[[:space:]])${crf_re}([[:space:]]|\$)" || true)"
      if [ "${crf_hits:-0}" -eq 0 ]; then
        echo "ERROR: ${crf_rel}${crf_base} が lint スクリプトの引数にありません（現在: '${crf_lint}'）。" >&2
        echo "       → lint 引数がディレクトリ限定のため直下のファイルへ到達しません。" >&2
        echo "         lint スクリプトの引数末尾へ ${crf_base} を追加してください。" >&2
        fail=1
      fi
    fi

    crf_hits="$(printf '%s' "$crf_program" | grep -Fc "${crf_dir}${crf_base}" || true)"
    if [ "${crf_hits:-0}" -eq 0 ]; then
      echo "ERROR: ${crf_rel}${crf_base} が tsc のプログラムに含まれていません。" >&2
      echo "       → 未知のキーが黙って無視される形状の設定でも誰も気づけません。" >&2
      echo "         tsconfig の exclude から外すか、include へ追加してください。" >&2
      fail=1
      continue
    fi

    # JS 系は allowJs でプログラムに載るだけでは型検査されない。載っていることを
    # 検査の証拠として扱うとガードが緑のまま素通りするため、プラグマを別途要求する。
    #
    # 照合は「コメント行の先頭が @ts-check であること」までアンカーする。単なる部分一致
    # （grep -F '@ts-check'）にすると、先頭 3 行の**散文に語が現れるだけ**で緑になる。
    # 実測: dashboard-web/postcss.config.mjs の 1 行目を
    #   `// この設定では @ts-check を有効にしない方針（PostCSS 側の型が無いため）。`
    # に差し替えると、本ガードは exit 0 で通る一方、同ファイルへ意図的な型エラーを入れても
    # tsc は 0 件しか報告しなかった（本物のプラグマへ戻すと TS2339 を検出）。
    # これは上段の「プログラム所属を検査の証拠として扱う」誤りと同じ代理証拠の罠であり、
    # 本ガードが防ごうとしている失敗を本ガード自身が再演することになる。
    # 文字クラスの `*` は /** @ts-check */（JSDoc 形式）と /*@ts-check*/ を受理するために要る。
    case "$crf_base" in
      *.js | *.jsx | *.mjs | *.cjs)
        crf_hits="$(head -n 3 "${crf_dir}${crf_base}" \
          | grep -Ec '^[[:space:]]*(//|/\*)[*[:space:]]*@ts-check([[:space:]*]|$)' || true)"
        if [ "${crf_hits:-0}" -eq 0 ]; then
          echo "ERROR: ${crf_rel}${crf_base} は tsc のプログラムに載っていますが型検査されていません。" >&2
          echo "       → allowJs は「プログラムに含める」だけで、checkJs も @ts-check も無ければ" >&2
          echo "         型エラーは 1 件も報告されません（本ガードが緑のまま素通りします）。" >&2
          echo "         ファイル先頭 3 行以内へ、コメント行の先頭が '@ts-check' となる形" >&2
          echo "         （'// @ts-check'）で追加してください。散文中の言及は証拠になりません。" >&2
          fail=1
        fi
        ;;
    esac
  done
}

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

    # (4) workspace 直下のコードファイル（Issue #78）。上のディレクトリ走査では構造的に拾えない。
    check_root_files "$pkg_dir" "$rel_pkg" "$lint_script" "$program_files"
  done
done <<EOF
$globs
EOF

# --- ts/ 直下（workspace ではない）--------------------------------------------
# ts/eslint.config.js は pnpm-workspace.yaml のどの glob にも入らないため、上のループは
# 一度も触れない。root の package.json と、その typecheck が指す tsconfig を対象に同じ検査をする。
root_pkg_json="${TS_DIR}/package.json"
if [ ! -f "$root_pkg_json" ]; then
  echo "ERROR: 検証対象が見つかりません: ${root_pkg_json#$ROOT/}" >&2
  exit 1
fi

root_lint_script="$(node -e "
  const p = require('${root_pkg_json}');
  process.stdout.write(p.scripts && p.scripts.lint ? p.scripts.lint : '');
")"
root_typecheck_script="$(node -e "
  const p = require('${root_pkg_json}');
  process.stdout.write(p.scripts && p.scripts.typecheck ? p.scripts.typecheck : '');
")"

# workspace と同じく、対象 tsconfig は **root の typecheck が実際に走らせるもの** から取る。
# `pnpm -r typecheck` だけでは ts/ 直下のファイルはどの workspace にも属さず永久に検査されない。
root_tsconfig_names="$(printf '%s' "$root_typecheck_script" | sed -nE 's/.*(-p|--project)[[:space:]]+([^[:space:]]+).*/\2/p')"
root_program_files=''
if [ -z "$root_tsconfig_names" ]; then
  echo "ERROR: ts/package.json の typecheck が ts/ 直下用の tsconfig を走らせていません（現在: '${root_typecheck_script}'）。" >&2
  echo "       → ts/ 直下のファイル（eslint.config.js 等）はどの workspace にも属さないため、" >&2
  echo "         'pnpm -r typecheck' では永久に型検査されません。" >&2
  echo "         \"typecheck\": \"pnpm -r typecheck && tsc -p tsconfig.tools.json\" のように追加してください。" >&2
  fail=1
else
  for root_tsconfig_name in $root_tsconfig_names; do
    if [ ! -f "${TS_DIR}/${root_tsconfig_name}" ]; then
      echo "ERROR: ts/package.json の typecheck が指す ${root_tsconfig_name} が存在しません。" >&2
      fail=1
      continue
    fi
    root_listed="$(cd "$TS_DIR" && npx --no-install tsc -p "$root_tsconfig_name" --noEmit --listFiles 2>/dev/null || true)"
    root_program_files="${root_program_files}
${root_listed}"
  done
fi

check_root_files "${TS_DIR}/" "ts/" "$root_lint_script" "$root_program_files"

# 空振り防止: workspace もディレクトリも 1 件も検証できていなければ、この検証自体が壊れている。
if [ "$checked_workspaces" -eq 0 ]; then
  echo "ERROR: workspace を1件も検証できませんでした。抽出前提が崩れています。" >&2
  exit 1
fi
if [ "$checked_dirs" -eq 0 ]; then
  echo "ERROR: コードディレクトリを1件も検証できませんでした。ガードが空振りしています。" >&2
  exit 1
fi
if [ "$checked_root_files" -eq 0 ]; then
  echo "ERROR: 直下のコードファイルを1件も検証できませんでした。ガードが空振りしています。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: テストコードのカバレッジガードに違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: テストコードのカバレッジガード緑（${checked_workspaces} workspace / ${checked_dirs} ディレクトリ / ${checked_root_files} 直下ファイルが lint と型検査の双方に掛かっている）。"
exit 0
