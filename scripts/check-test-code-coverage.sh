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
# 併せて `@ts-nocheck` の**不在**を要求する（拡張子を問わず全コードファイル）。プラグマの
# **存在**だけを数えると、`@ts-nocheck` を 1 行足すだけで検査が消えるのにガードは緑のままになる。
# 実測: survey-web/vitest.config.ts の先頭へ `// @ts-nocheck` を置き、同ファイルへ
# `const probe: number = '文字列'` を注入したところ、tsc は exit 0・報告 0 件、本ガードは緑。
# `@ts-nocheck` を外すと同じ注入で TS2322 が 1 件出る。**プラグマ 1 行で検査が消え、
# 誰も気づけない。** `.ts` 系は JS 系のプラグマ分岐の外にあったため、拡張子を問わず素通りした。
# `@ts-check` と併記しても `@ts-nocheck` が優先されるため、存在の確認だけでは足りない。
#
# 走査窓は意図的に非対称である。
#   - 拒否側（@ts-nocheck）: **先頭コメントブロック全体**。TypeScript が pragma を honor する
#     範囲（先頭のコメント trivia）に合わせ、4 行目以降に置かれた有効なプラグマを見逃さない。
#   - 要求側（@ts-check）: **先頭 3 行**。プラグマを先頭近くへ強制する。
# 窓の広い/狭いは逆向きだが、いずれも fail-closed（見逃しではなく過検出）の方向である。
#
# 拒否側の照合は「コメント行の先頭が @ts-nocheck」までで打ち切り、行末までは要求しない。
# TypeScript が **行頭の @ts-nocheck に続く散文を無視して pragma として受理する**ためである。
# 実測: postcss.config.mjs の 2 行目を `//   @ts-nocheck は使用禁止（ADR-012）` にすると、
# 同ファイルの TS2322 は報告されなくなる（その行を消すと 1 件出る）。**「使うな」と書いた
# コメントそれ自体が検査を消す。** 行末までアンカーすると、この経路を見逃す。
# 一方 `// このファイルでは @ts-nocheck を使わない` のように語が行頭に来ない散文は
# TypeScript も pragma として扱わないため、本ガードも検出しない（実測で一致を確認済み）。
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
# `perf` を含めるのは Issue #83 の後始末である。以前は候補にも無く、下の「候補外」検出の
# スキップ一覧へ明示的に列挙されていたため、**perf/ に .ts が入っても永久に不可視**だった。
# 現在 perf/ は .mjs しか持たないため下の `.ts` 判定で skip されるが（JS 側は
# check_js_files が担当する）、.ts が入った時点で本ループの判定が効くようになる。
CODE_DIR_CANDIDATES="src app lib test e2e scripts perf"

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
checked_js_files=0

# tsc の `--listFiles` 出力が実質空か（= tsc が走らなかった／プログラムを構成できなかった）
# を判定する（Issue #81）。**workspace 側と ts/ 直下側で同じ器を共有する。**
# 片側にだけ空振り検出が無いと、tsc が動かなかっただけの状況で「プログラムに含まれていません
# → exclude から外すか include へ追加してください」という**原因と逆向きの診断**が出る。
# 本ガードは「緑が信用できるか」を守る装置であり、装置が壊れたときに壊れたと言えないのは
# 設計上の欠落である。判定を関数へ括り出しておけば、呼び出し漏れが目視で分かる。
program_is_blank() {
  [ -z "$(printf '%s' "$1" | tr -d '[:space:]')" ]
}

# ファイル先頭のコメント trivia（1 行目から最初の非コメント・非空行の手前まで）を出力する。
# TypeScript が `@ts-nocheck` / `@ts-check` を honor するのはこの範囲であるため、走査窓を
# ここへ合わせる（`head -n 3` では 4 行目以降に置かれた有効なプラグマを見逃す）。
# ブロックコメントの厳密な解析はしない。`*` 始まりの行を継続行として受理する近似であり、
# 誤差は「窓が広くなる」方向にしか出ない（過検出＝fail-closed のため許容する）。
# 1 行目の shebang は読み飛ばす（TypeScript も shebang の後ろのプラグマを honor する）。
leading_comment_block() {
  awk 'NR == 1 && /^#!/ { next }
       /^[[:space:]]*(\/\/|\/\*|\*|$)/ { print; next }
       { exit }' "$1"
}

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

    # プログラムに載っていても `@ts-nocheck` があればファイル全体の型検査が消える。
    # **拡張子を問わず全コードファイルへ適用する**（`.ts` 系を下の JS 系分岐に任せると、
    # `.ts` はプラグマを一度も見られないまま「型検査に掛かっている」と報告される）。
    crf_hits="$(leading_comment_block "${crf_dir}${crf_base}" \
      | grep -Ec '^[[:space:]]*(//|/\*)[*[:space:]]*@ts-nocheck([[:space:]*]|$)' || true)"
    if [ "${crf_hits:-0}" -ne 0 ]; then
      echo "ERROR: ${crf_rel}${crf_base} は @ts-nocheck でファイル全体の型検査を無効化しています。" >&2
      echo "       → tsc のプログラムには載るため本ガードは緑になりますが、型エラーは" >&2
      echo "         1 件も報告されません（@ts-check と併記しても @ts-nocheck が優先されます）。" >&2
      echo "         プラグマを除去し、個別の抑止が要る箇所へ @ts-expect-error を使ってください。" >&2
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

# ---------------------------------------------------------------------------
# Issue #83: サブディレクトリに置かれた JS 系ファイルは、上の 2 つの器のどちらにも入らない。
# ディレクトリ列挙は `.ts`/`.tsx` を含む dir しか対象にせず（`perf/` は `.mjs` のみ）、
# check_root_files は -maxdepth 1 で降りない。しかも `perf` は候補外検出のスキップ一覧へ
# 明示的に列挙されていたため、「片側だけカバーされた状態」がどのガードにも見えなかった。
#
# 実害: survey-web/perf/bundle-budget.mjs は CI の性能ゲートで**実行される**。実行される
# ことは検査の代わりにならない。`readdirSync(dir, { recursive: true })` のキー名が壊れても
# 実行時エラーにはならず、サブディレクトリを辿らなくなるだけである。結果として
# **チャンクの部分集合だけを gzip 合計し、予算内に収まって緑になる**。壊れると落ちるのでは
# なく、別のものを測って緑になる。e2e/mock-gemini.mjs（NODE_OPTIONS で読み込まれる）も同型。
#
# 役割分担: ディレクトリ列挙 = TS のカバレッジ担当 / 本関数 = JS のカバレッジ担当。
# 拡張子ベースの列挙にするのは、上の check_root_files と同じ理由（列挙が陳腐化しない）。
#
# 呼出元の fail / checked_js_files を更新する（サブシェルを挟まないこと）。
#   $1 対象 workspace ディレクトリ（末尾 / 付きの絶対パス）
#   $2 表示用の相対パス（末尾 / 付き）
#   $3 その単位の lint スクリプト文字列
#   $4 その単位の tsc プログラム構成（--listFiles の出力）
check_js_files() {
  cjf_dir="$1"
  cjf_rel="$2"
  cjf_lint="$3"
  cjf_program="$4"

  # **`-mindepth` を併用してはならない（実測で確認済み）。** prune 対象（.next / dist /
  # dist-scripts）は workspace から見て深さ 1 にあり、`-mindepth 2` は深さ 1 の**述語評価
  # そのものを飛ばす**ため -prune が発火しない。実測では survey-web だけで .next 配下の
  # 生成物が数百件流れ込んだ。直下ファイル（check_root_files の担当）の除外は、下のループの
  # シェル側で「相対パスに / を含むか」で行う。
  #
  # なお prune 一覧はディレクトリ名の列挙であり、本スクリプトが避けたい形ではある。走査対象が
  # git ではなく作業ツリーであるため、未追跡の生成物にも晒される（Issue #82 と同型の弱さ）。
  # #82 の提案どおり列挙を `git ls-files` 由来へ寄せれば、この prune 一覧ごと不要になる。
  cjf_found="$(find "$cjf_dir" \
    \( -name node_modules -o -name dist -o -name dist-scripts -o -name .next \
       -o -name public -o -name coverage -o -name playwright-report -o -name test-results \) -prune -o \
    -type f \( -name '*.mjs' -o -name '*.cjs' -o -name '*.js' -o -name '*.jsx' \) -print 2>/dev/null | sort)"
  [ -n "$cjf_found" ] || return 0

  # 対象（サブディレクトリ配下のみ）の相対パスを集める。eslint はファイル毎に起動すると
  # 遅いため 1 回でまとめて尋ねる。
  cjf_rels=''
  while IFS= read -r cjf_path; do
    [ -n "$cjf_path" ] || continue
    cjf_relfile="${cjf_path#$cjf_dir}"
    case "$cjf_relfile" in
      */*) cjf_rels="${cjf_rels} ${cjf_relfile}" ;;
    esac
  done <<EOF
$cjf_found
EOF
  [ -n "$(printf '%s' "$cjf_rels" | tr -d '[:space:]')" ] || return 0

  # (A) eslint の ignores に消されていないこと。設定文字列ではなく eslint 自身に尋ねる。
  cjf_json="$(cd "$cjf_dir" && npx --no-install eslint \
    --no-error-on-unmatched-pattern --format json $cjf_rels 2>/dev/null || true)"

  cjf_ignored=''
  if [ -z "$(printf '%s' "$cjf_json" | tr -d '[:space:]')" ]; then
    echo "ERROR: ${cjf_rel} でサブディレクトリの JS 系について eslint の判定結果を取得できませんでした。" >&2
    echo "       → eslint を実行できていません。本ガードの lint 判定が空振りします。" >&2
    fail=1
  else
    # basename ではなく workspace 相対パスで返させる（サブディレクトリ間で basename が
    # 衝突しうるため）。node の cwd は workspace ではないので基準を環境変数で渡す。
    cjf_ignored="$(printf '%s' "$cjf_json" | CJF_BASE="$cjf_dir" node -e "
      const path = require('node:path');
      let s = '';
      process.stdin.on('data', (d) => (s += d)).on('end', () => {
        const results = JSON.parse(s);
        const ignored = results
          .filter((r) => r.messages.some((m) => m.ruleId === null && /ignore/i.test(m.message)))
          .map((r) => path.relative(process.env.CJF_BASE, r.filePath));
        process.stdout.write(ignored.join('\n'));
      });
    " 2>/dev/null || printf '__PARSE_FAILED__')"
    if [ "$cjf_ignored" = '__PARSE_FAILED__' ]; then
      echo "ERROR: ${cjf_rel} でサブディレクトリの JS 系について eslint の JSON 出力を解釈できませんでした。" >&2
      echo "       → 出力形式が変わっています。本ガードの lint 判定が空振りします。" >&2
      fail=1
      cjf_ignored=''
    fi
  fi

  # 照合はすべて `grep -c`（件数）で行う。`grep -q` を使わない理由は check_root_files と同じ。
  while IFS= read -r cjf_path; do
    [ -n "$cjf_path" ] || continue
    cjf_relfile="${cjf_path#$cjf_dir}"
    # 直下のファイルは check_root_files が担当する（二重報告しない）。
    case "$cjf_relfile" in
      */*) ;;
      *) continue ;;
    esac
    checked_js_files=$((checked_js_files + 1))

    cjf_hits="$(printf '%s\n' "$cjf_ignored" | grep -Fxc "$cjf_relfile" || true)"
    if [ "${cjf_hits:-0}" -ne 0 ]; then
      echo "ERROR: ${cjf_rel}${cjf_relfile} は eslint の ignores に除外されています。" >&2
      echo "       → lint スクリプトの引数が届いても走査そのものが行われません。" >&2
      echo "         ts/eslint.config.js の ignores は生成物のみへ絞ってください。" >&2
      fail=1
    fi

    # (B) lint の走査対象に含まれているか。lint の引数はディレクトリ指定が普通なので、
    #     ファイル自身から祖先ディレクトリへ順に遡って、どれかが引数に現れることを要求する。
    cjf_reach=0
    cjf_cand="$cjf_relfile"
    while [ -n "$cjf_cand" ]; do
      # パスはドットを含む。正規表現で使う箇所はエスケープする。
      cjf_re="$(printf '%s' "$cjf_cand" | sed 's/[.]/\\./g')"
      cjf_hits="$(printf '%s' "$cjf_lint" | grep -Ec "(^|[[:space:]])${cjf_re}([[:space:]]|/|\$)" || true)"
      if [ "${cjf_hits:-0}" -ne 0 ]; then
        cjf_reach=1
        break
      fi
      case "$cjf_cand" in
        */*) cjf_cand="${cjf_cand%/*}" ;;
        *) cjf_cand='' ;;
      esac
    done
    if [ "$cjf_reach" -eq 0 ]; then
      echo "ERROR: ${cjf_rel}${cjf_relfile} が lint スクリプトの走査対象にありません（現在: '${cjf_lint}'）。" >&2
      echo "       → any や未使用が混入しても CI は緑のまま通ります。" >&2
      echo "         lint スクリプトの引数へ ${cjf_relfile%%/*} を追加してください。" >&2
      fail=1
    fi

    # (C) tsc のプログラムに含まれているか。
    cjf_hits="$(printf '%s' "$cjf_program" | grep -Fc "$cjf_path" || true)"
    if [ "${cjf_hits:-0}" -eq 0 ]; then
      echo "ERROR: ${cjf_rel}${cjf_relfile} が tsc のプログラムに含まれていません。" >&2
      echo "       → CI で実行されるスクリプトであっても、未知のキーが黙って無視される形状の" >&2
      echo "         誤りは実行時エラーにならず「別のものを測って緑」になります。" >&2
      echo "         tsconfig の include へ '${cjf_relfile%/*}/*.mjs' 等を追加してください。" >&2
      fail=1
      continue
    fi

    # (D) 型検査が実際に効いているか。判定は check_root_files と**同じ器を共有する**
    #     （別実装にすると、#78 のレビューで塞いだ @ts-nocheck の穴がここで再発する）。
    cjf_hits="$(leading_comment_block "$cjf_path" \
      | grep -Ec '^[[:space:]]*(//|/\*)[*[:space:]]*@ts-nocheck([[:space:]*]|$)' || true)"
    if [ "${cjf_hits:-0}" -ne 0 ]; then
      echo "ERROR: ${cjf_rel}${cjf_relfile} は @ts-nocheck でファイル全体の型検査を無効化しています。" >&2
      echo "       → tsc のプログラムには載るため本ガードは緑になりますが、型エラーは" >&2
      echo "         1 件も報告されません（@ts-check と併記しても @ts-nocheck が優先されます）。" >&2
      echo "         プラグマを除去し、個別の抑止が要る箇所へ @ts-expect-error を使ってください。" >&2
      fail=1
      continue
    fi

    cjf_hits="$(head -n 3 "$cjf_path" \
      | grep -Ec '^[[:space:]]*(//|/\*)[*[:space:]]*@ts-check([[:space:]*]|$)' || true)"
    if [ "${cjf_hits:-0}" -eq 0 ]; then
      echo "ERROR: ${cjf_rel}${cjf_relfile} は tsc のプログラムに載っていますが型検査されていません。" >&2
      echo "       → allowJs は「プログラムに含める」だけで、checkJs も @ts-check も無ければ" >&2
      echo "         型エラーは 1 件も報告されません（本ガードが緑のまま素通りします）。" >&2
      echo "         ファイル先頭 3 行以内へ、コメント行の先頭が '@ts-check' となる形" >&2
      echo "         （'// @ts-check'）で追加してください。散文中の言及は証拠になりません。" >&2
      fail=1
    fi
  done <<EOF
$cjf_found
EOF
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

    if program_is_blank "$program_files"; then
      echo "ERROR: ${rel_pkg} で tsc のプログラム構成を取得できませんでした。" >&2
      echo "       → tsconfig が読めないか tsc を実行できていません。本ガードが空振りします。" >&2
      fail=1
      continue
    fi

    for dir in $CODE_DIR_CANDIDATES; do
      [ -d "${pkg_dir}${dir}" ] || continue
      # TypeScript ファイルを含まないディレクトリは対象外（JS 系は check_js_files が担当する）。
      # `grep -q` を使わない理由は上（crf_* の照合）と同じ。ここは `if !` の内側にあるため、
      # SIGPIPE × pipefail による失敗が「.ts を含まないディレクトリ」と同じ扱い、すなわち
      # **ディレクトリを黙ってスキップする**方向へ化ける。件数判定へ揃える。
      dir_ts_hits="$(find "${pkg_dir}${dir}" \( -name '*.ts' -o -name '*.tsx' \) -print 2>/dev/null | grep -c . || true)"
      [ "${dir_ts_hits:-0}" -ne 0 ] || continue
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
      # `perf` は CODE_DIR_CANDIDATES へ移した（Issue #83）。ここへ明示列挙しておくと、
      # perf/ に .ts が入っても候補外検出に掛からず、永久に不可視のままになる。
      case " $CODE_DIR_CANDIDATES node_modules dist dist-scripts .next public db " in
        *" $name "*) continue ;;
      esac
      entry_ts_hits="$(find "$entry" \( -name '*.ts' -o -name '*.tsx' \) -print 2>/dev/null | grep -c . || true)"
      if [ "${entry_ts_hits:-0}" -ne 0 ]; then
        echo "ERROR: ${rel_pkg}${name}/ は TypeScript を含みますが本ガードの走査候補にありません。" >&2
        echo "       → CODE_DIR_CANDIDATES へ追加してください（候補の列挙が実態に追いついていません）。" >&2
        fail=1
      fi
    done

    # (4) workspace 直下のコードファイル（Issue #78）。上のディレクトリ走査では構造的に拾えない。
    check_root_files "$pkg_dir" "$rel_pkg" "$lint_script" "$program_files"

    # (5) サブディレクトリの JS 系ファイル（Issue #83）。(3) は `.ts`/`.tsx` を含む
    #     ディレクトリしか見ず、(4) は -maxdepth 1 で降りないため、どちらにも入らない。
    check_js_files "$pkg_dir" "$rel_pkg" "$lint_script" "$program_files"
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
# プログラム構成を取得できたか。取れていないまま check_root_files へ渡すと、tsc が動かな
# かっただけの状況で「プログラムに含まれていません」という**別原因の診断**が出る（Issue #81）。
root_program_ok=1
if [ -z "$root_tsconfig_names" ]; then
  echo "ERROR: ts/package.json の typecheck が ts/ 直下用の tsconfig を走らせていません（現在: '${root_typecheck_script}'）。" >&2
  echo "       → ts/ 直下のファイル（eslint.config.js 等）はどの workspace にも属さないため、" >&2
  echo "         'pnpm -r typecheck' では永久に型検査されません。" >&2
  echo "         \"typecheck\": \"pnpm -r typecheck && tsc -p tsconfig.tools.json\" のように追加してください。" >&2
  fail=1
  # プログラムは空のままである。この先へ進めると上の指摘に「include へ追加してください」が
  # 積み重なり、同じ 1 つの原因が 2 種類の指示になる。ここで打ち切る。
  root_program_ok=0
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

  # workspace 側（上の `program_is_blank "$program_files"`）と対称の空振り検出（Issue #81）。
  # ts/ 直下は `pnpm -r typecheck` の外にあり配線が壊れやすいため、ここでこそ要る。
  if program_is_blank "$root_program_files"; then
    echo "ERROR: ts/ 直下で tsc のプログラム構成を取得できませんでした。" >&2
    echo "       → tsconfig が読めないか ts/ で tsc を実行できていません。本ガードの ts/ 直下判定が空振りします。" >&2
    fail=1
    root_program_ok=0
  fi
fi

# 空振りが確定した経路では検査自体を行わない（workspace 側が `continue` で丸ごと飛ばすのと対称）。
# **この判定は check_root_files の外側かつ呼出前に置くこと。** 関数の内側へ入れると、ts/ 直下の
# コードファイルが 0 件になったときの早期 return より後ろになり、tsc の空振りが何も出さずに
# 素通りする（現在は eslint.config.js があるため顕在化しないが、構造としての穴は残る）。
if [ "$root_program_ok" -eq 1 ]; then
  check_root_files "${TS_DIR}/" "ts/" "$root_lint_script" "$root_program_files"
fi

# ここで check_js_files は呼ばない。ts/ 直下から再帰すると apps/ と packages/ へ降り、
# 上の workspace ループが既に検査したファイルを二重に報告することになる（prune 一覧に
# workspace ディレクトリは入っていない）。ts/ 直下の JS 系は check_root_files が担当する。

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
if [ "$checked_js_files" -eq 0 ]; then
  echo "ERROR: サブディレクトリの JS 系ファイルを1件も検証できませんでした。ガードが空振りしています。" >&2
  echo "       → prune 一覧が広すぎるか find の式が壊れています（Issue #83 の走査）。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: テストコードのカバレッジガードに違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: テストコードのカバレッジガード緑（${checked_workspaces} workspace / ${checked_dirs} ディレクトリ / ${checked_root_files} 直下ファイル / ${checked_js_files} サブディレクトリ JS が lint と型検査の双方に掛かっている）。"
exit 0
