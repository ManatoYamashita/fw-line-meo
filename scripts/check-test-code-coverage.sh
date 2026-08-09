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
#
# ---------------------------------------------------------------------------
# Issue #81 拡張: 上の器はいずれも「workspace の中」か「ディレクトリの直下」しか見ておらず、
# **`ts/<非 workspace ディレクトリ>/**` は深さ 2 以上に担当者が居なかった**。
# `ts/` 直下は pnpm-workspace.yaml のどの glob にも入らないため `pnpm -r lint` /
# `pnpm -r typecheck` が届かず、tsconfig.tools.json の include は eslint.config.js のみ、
# check_root_files は -maxdepth 1 で降りない。実在する `ts/scripts/` へ probe を置いた実測では
# **ガード・lint・型検査の三方すべてが exit 0**（probe への言及 0 件）だった。
# 塞ぎ方は check_subdir_files の定義箇所を参照（走査済み workspace を接頭辞で落とす）。
#
# 併せて、空振り検出の診断品質も揃える。`checked_subdir_files` の系だけは **占有者ゼロが
# 正常状態になり得る**（実測で 2 件しかない）。それを「走査系が壊れている」と断定すると、
# 対象が消えただけの状況で原因と逆方向へ誘導する。本ガードは「緑が信用できるか」を
# 守る装置であり、装置が壊れたときに壊れたと言えないのは設計上の欠落である。
#
# ただし**逆向きの断定も同じ欠落である**。列挙の出力だけでは「対象の消失」と「担当域だけが
# 列挙から漏れた破損」を区別できず、両者は同じ 0 件を生む。よって断定はせず両論併記とし、
# 判別できる範囲（列挙が深さ 2 へ到達したか）だけを証拠として添える。Issue #82 で列挙を
# git 管理下へ寄せたことで漏れの入口は「追跡漏れ」と「CODE_EXT_RE の破損」の 2 つへ絞られ、
# 前者は未追跡警告が示すようになったが、「対象の消失」との完全な分離までは至っていない。
# 判別子の置き方の失敗例は変数宣言箇所の注記を参照。
# ---------------------------------------------------------------------------
#
# 使い方: bash scripts/check-test-code-coverage.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。
#   追跡ファイルは書き換えない（tsc は --noEmit、eslint は --fix なしで走らせる）・
#   連想配列を使わず bash 3.2 でも走る。
#   **「副作用なし」ではない。** `incremental: true` を持つ Next 3 面では、--noEmit でも
#   tsconfig.tsbuildinfo が生成される（実測: survey-web の同ファイルを消して本ガードだけを
#   走らせると再生成される）。.gitignore の `*.tsbuildinfo` で無害化されているだけである。
#   この 1 行は「主張は必ず実測で裏を取る」という本スクリプトの規律に合わせた訂正である（Issue #81）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TS_DIR="${ROOT}/ts"
WORKSPACE_YAML="${TS_DIR}/pnpm-workspace.yaml"

if [ ! -f "$WORKSPACE_YAML" ]; then
  echo "ERROR: 検証対象が見つかりません: ${WORKSPACE_YAML#$ROOT/}" >&2
  exit 1
fi

# 走査対象の列挙は git 管理下を情報源にする（Issue #82）。git work tree でなければ、
# 列挙は 0 件になり**全ガードが黙って緑**になる。それは本スクリプトが最も嫌う形なので、
# 前提が崩れていることを明示して落とす。
if ! (cd "$ROOT" && git rev-parse --is-inside-work-tree >/dev/null 2>&1); then
  echo "ERROR: ${ROOT} は git work tree ではありません。" >&2
  echo "       → 本ガードは走査対象を git 管理下から列挙します（Issue #82）。" >&2
  echo "         列挙できないまま進むと 0 件のまま緑になるため、ここで打ち切ります。" >&2
  exit 1
fi

# 走査候補。ここに無いディレクトリ名を新設した場合は追加すること
# （網羅性はディレクトリ名の列挙に依存する。増えたら気づけるよう下の「候補外」検出を置く）。
# `perf` を含めるのは Issue #83 の後始末である。以前は候補にも無く、下の「候補外」検出の
# スキップ一覧へ明示的に列挙されていたため、**perf/ に .ts が入っても永久に不可視**だった。
# 現在 perf/ は .mjs しか持たないため下の `.ts` 判定で skip されるが（JS 側は
# check_subdir_files が担当する）、.ts が入った時点で本ループの判定が効くようになる。
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
checked_subdir_files=0
# 列挙が**深さ 2 以上へ到達して**返したコードファイルの件数（担当域・拡張子で落とす前）。
# checked_subdir_files が 0 になったときに「列挙そのものが深さ 2 へ届いていない」のか
# 「届いてはいるが担当対象が無い」のかを切り分けるために持つ（Issue #81）。
#
# **担当域・拡張子で絞った後の件数を使ってはならない（実測で確認済み）。** それだと
# 深さ 1 のコードファイル（ts/eslint.config.js と各 workspace の postcss.config.mjs）が
# 常に数に入り、判別子が構造的に非ゼロへ固定される。実測では当時の find の拡張子を一部だけ
# 壊しても、prune 一覧を広げて担当域だけを消しても、判定は必ず「走査は生きている」側へ倒れた
# （列挙は現在 git 管理下由来であり、find も prune 一覧も持たない — Issue #82）。
# 深さ 2 以上に限ることで、この値は「列挙が深さ 2 へ到達したか」だけを表す量になる。
found_deep_paths=0

# 実際に workspace として走査したディレクトリ（末尾 / 付きの絶対パス・改行区切り）。
# ts/ 直下のサブディレクトリ走査で「既に担当済みの領域」を落とすために使う。
# **pnpm-workspace.yaml の glob 文字列からは作らない**（理由は subdir_owned_elsewhere を参照）。
scanned_pkg_dirs=''

# サブディレクトリ走査で見るべき拡張子か（Issue #81）。
#   $1 パス / $2 範囲（js / js+ts）
# JS 系は常に対象。TS 系は `ts/` 直下呼び出し（js+ts）でだけ対象にする。workspace 配下の
# `.ts` / `.tsx` は CODE_DIR_CANDIDATES のディレクトリ走査（候補外検出を含む）が担当済みで、
# 広げると二重報告になる。
#
# **`.mts` / `.cts` はこの「担当済み」に含まれない（Issue #95）。** ディレクトリ走査の
# dir_ts_hits も候補外検出の entry_ts_hits も `*.ts` / `*.tsx` しか数えないため、
# workspace 配下の深さ 2 以上に置かれた `.mts` / `.cts` はどの器も見ていない（base・head とも
# 緑になることを実測済み）。本 PR より前から開いている穴であり、是正は #95 で扱う。
# ここを js+ts へ広げるだけでは `.ts` / `.tsx` が二重報告になるため、範囲指定の分割が要る。
subdir_ext_in_scope() {
  case "$1" in
    *.mjs | *.cjs | *.js | *.jsx) return 0 ;;
  esac
  [ "$2" = 'js+ts' ] || return 1
  case "$1" in
    *.ts | *.tsx | *.mts | *.cts) return 0 ;;
  esac
  return 1
}

# 別の呼出が既に担当した領域のパスか（Issue #81）。
#   $1 絶対パス / $2 担当済みディレクトリの絶対パス一覧（改行区切り・末尾 / 付き）
#
# **判定は「実際に走査した workspace の絶対パス接頭辞」で行う。**
# pnpm-workspace.yaml の glob から第 1 セグメント（`packages/*` → `packages`）を取り出して
# 「apps の下だから担当済み」と推定してはならない。workspace ループは package.json の無い
# ディレクトリを `continue` で飛ばすため、`ts/apps/<package.json を持たないディレクトリ>/**`
# は**どの workspace にも属さない**。第 1 セグメントで落とすと、そこが誰の担当でもないまま
# 消える — Issue #81 が塞ごうとしているのと同型の穴を、塞ぐ側の実装で作ることになる。
# 列挙ではなく実測に問うのは本スクリプト全体の流儀でもある（tsc に --listFiles を尋ね、
# eslint に --format json を尋ねるのと同じ）。
subdir_owned_elsewhere() {
  soe_hit=1
  while IFS= read -r soe_owned; do
    [ -n "$soe_owned" ] || continue
    case "$1" in
      "$soe_owned"*) soe_hit=0; break ;;
    esac
  done <<EOF
$2
EOF
  return "$soe_hit"
}

# コードファイルの拡張子。列挙側とフィルタ側で二重管理しないよう 1 箇所へ置く。
CODE_EXT_RE='\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$'

# 走査対象を **git 管理下のファイル**から列挙する（Issue #82）。
# $1 = 起点の絶対パス（末尾 / 付き）。$1 からの相対パスを返す。
#
# 作業ツリーを find で列挙すると、未追跡の生成物・一時ファイルまで「配線すべきコードファイル」
# として扱ってしまう。現実に踏むのは vitest / vite が設定ファイルと同じディレクトリへ生成する
# `<config>.timestamp-<ms>-<rand>.mjs` である（強制終了時に残る・.gitignore にも無い）。
# その結果 **「一時ファイル名を lint 引数へ恒久的に追加せよ」という従ってはいけない指示**が出る。
# CI では build → guard の順で一時ファイルが生じないため CI は緑のままで、踏むのはローカルの
# 開発者だけである。ガードへの信頼を損なう類の誤爆であり、対症療法（`*.timestamp-*` の除外）は
# 新種の一時ファイルで再発する。情報源を git へ寄せて構造的に断つ。
#
# 副産物として prune 一覧が不要になる。生成物ディレクトリは .gitignore 済みで追跡されないため
# `git ls-files` に現れない（実測: node_modules / dist / dist-scripts / .next / public /
# coverage / playwright-report / test-results の追跡ファイルはいずれも 0 件）。
# ディレクトリ名の列挙という、本スクリプトが避けたい形をひとつ減らせる。
#
# 見落としの方向も変わる。find は「未追跡を過検出」する側へ、git は「未 add を見逃す」側へ倒れる。
# 後者は fail-open であり本スクリプトの思想に反するため、下の untracked 警告と**対で**運用する。
#
# **`core.quotePath=false` を外してはならない。** 既定（true）の git ls-files は非 ASCII を
# 含むパスを `"packages/w1/\346\227\245..."` の形（引用符 + 8 進エスケープ）で返す。すると
# 行末が `"` になり **CODE_EXT_RE の `$` アンカーに一致しない**ため、そのファイルは上の
# 列挙からも下の全判定からも**丸ごと消える**。lint にも型検査にも配線されていないのに
# 件数は変わらず、ガードは緑のまま素通りする。情報源を替えると対象の集合だけでなく
# **対象の表現**まで替わる、という形の退行であり、find 由来の頃には存在しなかった。
#
# 改行を含むファイル名までは扱えない（`-z` と NUL 区切りが要るが、bash 3.2 互換のまま
# ヒアドキュメントで受け渡す本実装では NUL を運べない）。find 由来の頃と同じ制約である。
tracked_code_files() {
  (cd "$1" && git -c core.quotePath=false ls-files --cached -- .) 2>/dev/null | grep -E "$CODE_EXT_RE" || true
}

# 追跡されていない（= 上の列挙から漏れた）コードファイル。.gitignore 済みは除く。
tracked_code_files_untracked() {
  (cd "$1" && git -c core.quotePath=false ls-files --others --exclude-standard -- .) 2>/dev/null | grep -E "$CODE_EXT_RE" || true
}

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
  # 情報源は git 管理下（Issue #82）。`/` を含まない行＝直下のファイルだけを採る。
  crf_files="$(tracked_code_files "$crf_dir" | grep -v '/' | sort || true)"
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
# 役割分担（workspace の中）: ディレクトリ列挙 = TS のカバレッジ担当 / 本関数 = JS の担当。
# 拡張子ベースの列挙にするのは、上の check_root_files と同じ理由（列挙が陳腐化しない）。
#
# ---------------------------------------------------------------------------
# Issue #81 拡張: 上の役割分担は **workspace の中でしか成立しない**。`ts/` 直下は
# pnpm-workspace.yaml のどの glob にも入らないため、ディレクトリ列挙のループが一度も回らない。
# 結果として `ts/<非 workspace ディレクトリ>/**` は拡張子を問わず担当者が居なかった:
#   - lint:   ts/package.json の lint は `eslint eslint.config.js && pnpm -r lint`。
#             workspace の外にあるため `pnpm -r lint` が届かない。
#   - 型検査: tsconfig.tools.json の include は `eslint.config.js` のみ。
#             `pnpm -r typecheck` の外でもある。
#   - 本ガード: check_root_files は -maxdepth 1 で降りず、本関数は呼ばれていなかった。
# 実在する `ts/scripts/`（当時の占有者は with-test-db.sh のみ）へ probe を置いて実測したところ、
# **ガード・lint・型検査の三方すべてが exit 0**（probe への言及 0 件）だった。
#
# そこで本関数を `ts/` 直下からも呼ぶ。既に別の呼出が担当した領域は $5（走査済み workspace の
# 絶対パス一覧）で落とし、workspace ループとの二重報告を避ける。
# **ディレクトリ名では落とさない。** 名前で消すと深さを問わず一致するため、`apps` を落とす
# つもりが `ts/scripts/apps/` のような無関係なディレクトリまで巻き込む（当時の find 式では
# `-name apps -prune` がこれに当たった）。列挙は git 管理下由来へ移ったが（Issue #82）、
# 落とし方を絶対パス接頭辞に置く理由は変わらない。
#
# $6 で拡張子の範囲を切り替える。workspace 呼び出しは JS 系のみに留める。workspace 配下の
# `.ts` は CODE_DIR_CANDIDATES のディレクトリ走査が既に担当しており、広げると同じ穴を
# 二重に報告することになる。`ts/` 直下呼び出しだけが TS 系まで見る（そちらには
# CODE_DIR_CANDIDATES のディレクトリ走査が回らず、TS 系の担当者が誰も居ないため）。
# ---------------------------------------------------------------------------
#
# 呼出元の fail / checked_subdir_files / found_deep_paths を更新する
# （サブシェルを挟まないこと）。
#   $1 対象ディレクトリ（末尾 / 付きの絶対パス）
#   $2 表示用の相対パス（末尾 / 付き）
#   $3 その単位の lint スクリプト文字列
#   $4 その単位の tsc プログラム構成（--listFiles の出力）
#   $5 別の呼出が担当済みのディレクトリの絶対パス一覧（改行区切り・末尾 / 付き・空可）
#   $6 拡張子の範囲: js（JS 系のみ）/ js+ts（TS 系も含む）
check_subdir_files() {
  csf_dir="$1"
  csf_rel="$2"
  csf_lint="$3"
  csf_program="$4"
  csf_skip_dirs="$5"
  csf_exts="$6"

  # 未知の範囲指定は fail-closed にする。既定値へ倒すと、呼出側の引数がずれたときに
  # 「走査したつもりで何も見ていない」状態が緑のまま通る。
  case "$csf_exts" in
    js | js+ts) ;;
    *)
      echo "ERROR: check_subdir_files の呼出で未知の拡張子指定です: '${csf_exts}'。" >&2
      echo "       → 呼出側の引数が壊れています。${csf_rel} のサブディレクトリ走査は行われませんでした。" >&2
      fail=1
      return 0
      ;;
  esac

  # 情報源は git 管理下（Issue #82）。以前は find + prune 一覧だったが、
  #   - 未追跡の生成物・一時ファイルを拾い、従ってはいけない指示を出していた
  #   - prune 一覧はディレクトリ名の列挙であり、本スクリプトが避けたい形そのものだった
  #   - `-mindepth` を足すと prune が発火しなくなるという罠を、注記で避け続ける必要があった
  # の 3 つが同時に消える。生成物ディレクトリは .gitignore 済みで追跡されないため、
  # 除外の指定なしに最初から現れない（実測: 該当 8 ディレクトリの追跡ファイルは 0 件）。
  #
  # 拡張子は常に JS 系＋TS 系で拾い、範囲の絞り込みは subdir_ext_in_scope でシェル側に置く。
  # ここで担当域を絞ると、下の found_deep_paths が定数化して判別子として機能しなくなる。
  #
  # 下流は絶対パスを前提にしている（subdir_owned_elsewhere の接頭辞判定・${csf_path#"$csf_dir"}）
  # ため、git が返す相対パスへ起点を戻して絶対パスにする。
  csf_found=''
  while IFS= read -r csf_rel_entry; do
    [ -n "$csf_rel_entry" ] || continue
    csf_found="${csf_found}${csf_dir}${csf_rel_entry}
"
  done <<EOF
$(tracked_code_files "$csf_dir" | sort)
EOF
  [ -n "$(printf '%s' "$csf_found" | tr -d '[:space:]')" ] || return 0

  # 絞り込みは**ここ 1 箇所だけ**で行い、下の本ループは絞り込み済みの一覧を回す。
  # 同じ述語を 2 つのループへ書くと、片方だけ直る日が来る。それは本スクリプトが防ごうと
  # している失敗形状そのものである。eslint はファイル毎に起動すると遅いので、絞り込んだ
  # 相対パスを 1 回でまとめて尋ねる。
  csf_rels=''      # eslint へ渡す相対パス（空白区切り）
  csf_targets=''   # 本検査の対象（改行区切り）
  while IFS= read -r csf_path; do
    [ -n "$csf_path" ] || continue
    csf_relfile="${csf_path#"$csf_dir"}"

    # (i) 列挙が深さ 2 以上へ到達したことの実測。**担当域・拡張子で落とす前に数える。**
    # ここは「この呼出が担当すべきか」ではなく「列挙がそこまで降りられたか」を測る量である。
    # 担当域で絞った後に数えると深さ 1 のファイルが常に混ざり、判別子が定数化する
    # （変数宣言箇所の注記を参照）。他の呼出が担当する領域を数えるのは意図どおりで、
    # 列挙が深さ方向へ生きていることの証拠としてはそれで十分である。
    case "$csf_relfile" in
      */*) found_deep_paths=$((found_deep_paths + 1)) ;;
    esac

    # (ii) 別の呼出が既に担当した領域か（絶対パス接頭辞で判定する。理由は関数の定義箇所を参照）。
    subdir_owned_elsewhere "$csf_path" "$csf_skip_dirs" && continue

    # (iii) この呼出が見るべき拡張子か。
    subdir_ext_in_scope "$csf_path" "$csf_exts" || continue

    # (iv) 直下のファイルは check_root_files の担当（二重報告しない）。
    case "$csf_relfile" in
      */*) ;;
      *) continue ;;
    esac

    csf_rels="${csf_rels} ${csf_relfile}"
    csf_targets="${csf_targets}
${csf_relfile}"
  done <<EOF
$csf_found
EOF
  [ -n "$(printf '%s' "$csf_rels" | tr -d '[:space:]')" ] || return 0

  # (A) eslint の ignores に消されていないこと。設定文字列ではなく eslint 自身に尋ねる。
  csf_json="$(cd "$csf_dir" && npx --no-install eslint \
    --no-error-on-unmatched-pattern --format json $csf_rels 2>/dev/null || true)"

  csf_ignored=''
  if [ -z "$(printf '%s' "$csf_json" | tr -d '[:space:]')" ]; then
    echo "ERROR: ${csf_rel} でサブディレクトリのコードファイルについて eslint の判定結果を取得できませんでした。" >&2
    echo "       → eslint を実行できていません。本ガードの lint 判定が空振りします。" >&2
    fail=1
  else
    # basename ではなく workspace 相対パスで返させる（サブディレクトリ間で basename が
    # 衝突しうるため）。node の cwd は workspace ではないので基準を環境変数で渡す。
    csf_ignored="$(printf '%s' "$csf_json" | CSF_BASE="$csf_dir" node -e "
      const path = require('node:path');
      let s = '';
      process.stdin.on('data', (d) => (s += d)).on('end', () => {
        const results = JSON.parse(s);
        const ignored = results
          .filter((r) => r.messages.some((m) => m.ruleId === null && /ignore/i.test(m.message)))
          .map((r) => path.relative(process.env.CSF_BASE, r.filePath));
        process.stdout.write(ignored.join('\n'));
      });
    " 2>/dev/null || printf '__PARSE_FAILED__')"
    if [ "$csf_ignored" = '__PARSE_FAILED__' ]; then
      echo "ERROR: ${csf_rel} でサブディレクトリのコードファイルについて eslint の JSON 出力を解釈できませんでした。" >&2
      echo "       → 出力形式が変わっています。本ガードの lint 判定が空振りします。" >&2
      fail=1
      csf_ignored=''
    fi
  fi

  # 照合はすべて `grep -c`（件数）で行う。`grep -q` を使わない理由は check_root_files と同じ。
  # 回すのは絞り込み済みの一覧（csf_targets）である。ここで再度フィルタを書かないこと。
  while IFS= read -r csf_relfile; do
    [ -n "$csf_relfile" ] || continue
    csf_path="${csf_dir}${csf_relfile}"
    checked_subdir_files=$((checked_subdir_files + 1))

    csf_hits="$(printf '%s\n' "$csf_ignored" | grep -Fxc "$csf_relfile" || true)"
    if [ "${csf_hits:-0}" -ne 0 ]; then
      echo "ERROR: ${csf_rel}${csf_relfile} は eslint の ignores に除外されています。" >&2
      echo "       → lint スクリプトの引数が届いても走査そのものが行われません。" >&2
      echo "         ts/eslint.config.js の ignores は生成物のみへ絞ってください。" >&2
      fail=1
    fi

    # (B) lint の走査対象に含まれているか。
    #
    # 既知の弱さ（Issue #81 で ts/ 直下呼び出しを足して初めて到達可能になった）: 照合は
    # lint スクリプト文字列にディレクトリ名がトークンとして現れるかを見るだけなので、
    # スクリプトが**引数以外の裸のトークン**を含む場合に偽陰性が出る。ts/ の lint は
    # `eslint eslint.config.js && pnpm -r lint` であり、`ts/lint/` や `ts/pnpm/` を作ると
    # 「lint 対象に入っている」と誤判定する。workspace 側の lint は `eslint src test …` の形で
    # 引数しか持たないため、この罠は ts/ 直下にしかない。実害の確率が低いのでここでは塞がない。
    #
    # lint の引数はディレクトリ指定が普通なので、
    #     ファイル自身から祖先ディレクトリへ順に遡って、どれかが引数に現れることを要求する。
    csf_reach=0
    csf_cand="$csf_relfile"
    while [ -n "$csf_cand" ]; do
      # パスはドットを含む。正規表現で使う箇所はエスケープする。
      csf_re="$(printf '%s' "$csf_cand" | sed 's/[.]/\\./g')"
      csf_hits="$(printf '%s' "$csf_lint" | grep -Ec "(^|[[:space:]])${csf_re}([[:space:]]|/|\$)" || true)"
      if [ "${csf_hits:-0}" -ne 0 ]; then
        csf_reach=1
        break
      fi
      case "$csf_cand" in
        */*) csf_cand="${csf_cand%/*}" ;;
        *) csf_cand='' ;;
      esac
    done
    if [ "$csf_reach" -eq 0 ]; then
      echo "ERROR: ${csf_rel}${csf_relfile} が lint スクリプトの走査対象にありません（現在: '${csf_lint}'）。" >&2
      echo "       → any や未使用が混入しても CI は緑のまま通ります。" >&2
      # 提案するのは**直上のディレクトリ**であり、先頭セグメントではない。ts/ 直下呼び出しでは
      # 先頭セグメントが `apps` / `packages` になり得るため、それを lint 引数へ足せと言うと
      # 「root の eslint で全 workspace を舐めろ」という過大な指示になる（実測: workspace 化
      # されていない ts/apps/<package.json 無し>/ で発生）。上の到達判定は祖先ディレクトリを
      # 順に遡って**どれか 1 つ**が引数に現れれば通すため、直上を足すだけで要求は満たされる。
      # 既存の占有者（perf/*.mjs・e2e/*.mjs）では直上＝先頭セグメントであり、文言は変わらない。
      echo "         lint スクリプトの引数へ ${csf_relfile%/*} を追加してください" >&2
      echo "         （そのディレクトリが workspace であるべきなら package.json の配置でも解消します）。" >&2
      fail=1
    fi

    # (C) tsc のプログラムに含まれているか。
    csf_hits="$(printf '%s' "$csf_program" | grep -Fc "$csf_path" || true)"
    if [ "${csf_hits:-0}" -eq 0 ]; then
      echo "ERROR: ${csf_rel}${csf_relfile} が tsc のプログラムに含まれていません。" >&2
      echo "       → CI で実行されるスクリプトであっても、未知のキーが黙って無視される形状の" >&2
      echo "         誤りは実行時エラーにならず「別のものを測って緑」になります。" >&2
      echo "         tsconfig の include へ '${csf_relfile%/*}/*.${csf_relfile##*.}' 等を追加してください" >&2
      echo "         （tsconfig の '*' はディレクトリを跨がないため、階層ごとに要ります）。" >&2
      fail=1
      continue
    fi

    # (D) 型検査が実際に効いているか。判定は check_root_files と**同じ器を共有する**
    #     （別実装にすると、#78 のレビューで塞いだ @ts-nocheck の穴がここで再発する）。
    csf_hits="$(leading_comment_block "$csf_path" \
      | grep -Ec '^[[:space:]]*(//|/\*)[*[:space:]]*@ts-nocheck([[:space:]*]|$)' || true)"
    if [ "${csf_hits:-0}" -ne 0 ]; then
      echo "ERROR: ${csf_rel}${csf_relfile} は @ts-nocheck でファイル全体の型検査を無効化しています。" >&2
      echo "       → tsc のプログラムには載るため本ガードは緑になりますが、型エラーは" >&2
      echo "         1 件も報告されません（@ts-check と併記しても @ts-nocheck が優先されます）。" >&2
      echo "         プラグマを除去し、個別の抑止が要る箇所へ @ts-expect-error を使ってください。" >&2
      fail=1
      continue
    fi

    # @ts-check の要求は **JS 系だけ**へ掛ける。TS 系はプログラムに載った時点で型検査される
    # ため、同じ要求を掛けると `.ts` にまでプラグマを強要することになる（Issue #81 で走査を
    # TS 系へ広げた際に顕在化した）。分岐の形は check_root_files と揃えてある。
    case "$csf_relfile" in
      *.js | *.jsx | *.mjs | *.cjs)
        csf_hits="$(head -n 3 "$csf_path" \
          | grep -Ec '^[[:space:]]*(//|/\*)[*[:space:]]*@ts-check([[:space:]*]|$)' || true)"
        if [ "${csf_hits:-0}" -eq 0 ]; then
          echo "ERROR: ${csf_rel}${csf_relfile} は tsc のプログラムに載っていますが型検査されていません。" >&2
          echo "       → allowJs は「プログラムに含める」だけで、checkJs も @ts-check も無ければ" >&2
          echo "         型エラーは 1 件も報告されません（本ガードが緑のまま素通りします）。" >&2
          echo "         ファイル先頭 3 行以内へ、コメント行の先頭が '@ts-check' となる形" >&2
          echo "         （'// @ts-check'）で追加してください。散文中の言及は証拠になりません。" >&2
          fail=1
        fi
        ;;
    esac
  done <<EOF
$csf_targets
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
    # 「この絶対パスは workspace として実際に走査した」という実測を残す。
    # ts/ 直下の走査がここへ降りないための唯一の情報源である（推定で落とさない）。
    scanned_pkg_dirs="${scanned_pkg_dirs}
${pkg_dir}"

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
      # TypeScript ファイルを含まないディレクトリは対象外（JS 系は check_subdir_files が担当する）。
      # `grep -q` を使わない理由は上（crf_* の照合）と同じ。ここは `if !` の内側にあるため、
      # SIGPIPE × pipefail による失敗が「.ts を含まないディレクトリ」と同じ扱い、すなわち
      # **ディレクトリを黙ってスキップする**方向へ化ける。件数判定へ揃える。
      # 情報源は git 管理下（Issue #82）。未追跡の一時 .ts でディレクトリを対象化しない。
      dir_ts_hits="$(tracked_code_files "${pkg_dir}${dir}/" | grep -cE '\.(ts|tsx)$' || true)"
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
      # 情報源は git 管理下（Issue #82）。未追跡の一時 .ts で「候補外」を誤報しない。
      entry_ts_hits="$(tracked_code_files "$entry" | grep -cE '\.(ts|tsx)$' || true)"
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
    #     ここは JS 系に限る（TS 系は (3) の担当。広げると同じ穴を二重に報告する）。
    #     workspace の内側なので、降りてはいけないトップディレクトリは無い。
    check_subdir_files "$pkg_dir" "$rel_pkg" "$lint_script" "$program_files" '' 'js'
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

  # ts/ 直下の**サブディレクトリ**（Issue #81）。以前はここで check_subdir_files を呼ばず、
  # 「ts/ 直下の JS 系は check_root_files が担当する」と注記していた。それが成立するのは
  # **深さ 1 のファイルだけ**である（check_root_files は -maxdepth 1 で降りない）。深さ 2 以上、
  # 例えば実在する ts/scripts/ 配下は lint・型検査・本ガードのどれにも入らなかった。
  #
  # 呼ばなかった理由（apps/ と packages/ へ降りて workspace ループと二重報告になる）は
  # 第 5 引数で解消する。**走査済み workspace の絶対パス**を渡すのがポイントで、`apps` /
  # `packages` というディレクトリ名で落とすと `ts/apps/<package.json 無し>/**` が
  # 「どの workspace にも属さないのに担当済み扱い」になり、同型の穴がそこへ移るだけになる。
  # 第 6 引数を js+ts にするのは、ts/ 直下には CODE_DIR_CANDIDATES のディレクトリ走査が
  # 回らず、TS 系にも担当者が居ないためである（workspace 側とは事情が違う）。
  check_subdir_files "${TS_DIR}/" "ts/" "$root_lint_script" "$root_program_files" \
    "$scanned_pkg_dirs" 'js+ts'
fi

# 未追跡のコードファイルを警告する（Issue #82）。列挙を git 管理下へ寄せたことで
# 誤爆は消えたが、代わりに「新規作成してまだ add していないファイルを見逃す」fail-open が
# 生じる。**この警告は git 列挙と対で運用すること。** 片方だけでは、
#   - 作業ツリー列挙だけ → 未追跡の生成物で誤爆する（#82 の症状）
#   - git 列挙だけ → 未 add のファイルを黙って見逃す（本スクリプトの思想に反する）
# のいずれかへ倒れる。
#
# fail は立てない。未 add は作業途中の正常な状態であり、赤にすると「とりあえず add する」
# という誤った習慣を強いる。CI ではクリーン checkout のため 0 件になり、この警告は出ない。
# 件数と先頭数件だけを出す（生成物が大量に残っている作業ツリーで壁のような出力にしないため）。
#
# **下の空振り防止より前に置くこと。** 追跡漏れは「0 件」の第一の原因であり、この警告こそが
# その手掛かりである。後ろに置くと、原因を説明できる材料を持ったまま何も言わずに exit 1 する
# 経路ができる（下の checked_subdir_files の分岐がまさにそれに当たる）。
#
# 一覧の絞り込みに `head` のような**入力を読み切らない consumer** をパイプで挟まないこと。
# 一覧が buffer を超えると上流の printf が EPIPE を受け、`set -e` × `pipefail` により
# **ガードごと exit 141 で中断する**（OK も NG も出ないまま赤になる）。しかも上流が
# 書き込める上限は consumer の buffer 2 杯分あるため、同じ条件で赤にも緑にも転ぶ。
# 入力サイズ依存で判定が変わるという点で、下の `grep -q` を避ける理由とまったく同型である。
# `sed -n '1,3s///p'` は `q` を持たないため入力を最後まで読み、この経路を作らない。
untracked_code="$(tracked_code_files_untracked "${TS_DIR}/")"
untracked_count="$(printf '%s' "$untracked_code" | grep -c . || true)"
if [ "${untracked_count:-0}" -ne 0 ]; then
  echo "WARNING: ts/ 配下に未追跡のコードファイルが ${untracked_count} 件あります（本ガードは走査していません）。" >&2
  printf '%s\n' "$untracked_code" | sed -n '1,3s|^|         ts/|p' >&2
  echo "         → 検査対象に含めるなら git add してください。生成物なら .gitignore へ足してください。" >&2
fi

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
# この系だけは **占有者ゼロが正常状態になり得る**（Issue #81）。workspace / ディレクトリ /
# 直下ファイルは構造的に非ゼロだが、サブディレクトリのコードファイルは実測で 2 件しかなく、
# どちらも survey-web 配下である。にもかかわらず「走査系が壊れている」と断定すると、
# 対象が消えただけの状況で**原因と逆方向へ誘導する**（#82 が問題視した形）。
#
# **どちらか一方を断定しない。** 列挙の出力だけでは「担当域のファイルが消えた」と
# 「担当域だけが列挙から漏れた」を区別できない。両者は同じ観測（0 件）を生む。
# 列挙を git 管理下へ寄せた（Issue #82）ことで prune 一覧と find 式は無くなり、
# 漏れの入口は **追跡漏れ**（未 add）と **CODE_EXT_RE の破損** の 2 つへ絞られた。
# 前者は上の未追跡警告が示すため、案内はそこへ向ける。それでも「対象の消失」との
# 完全な分離はできないため両論併記とし、判別できる範囲＝「列挙が深さ 2 へ到達したか」
# だけを証拠として添える。
#
# 一度は「走査は生きている」と断定する実装にしたが、判別子を担当域で絞った後に数えていたため
# 深さ 1 のファイルで常に非ゼロへ固定され、当時の find の拡張子を部分的に壊しても prune を
# 広げても必ず断定側へ倒れた（PR #92 のレビューで実測）。断定の根拠が量として存在していなかった。
if [ "$checked_subdir_files" -eq 0 ]; then
  echo "ERROR: サブディレクトリのコードファイルを1件も検証できませんでした。" >&2
  if [ "$found_deep_paths" -eq 0 ]; then
    echo "       → 列挙が深さ 2 以上へ一度も到達していません（git 管理下の返却が 0 件）。" >&2
    echo "         該当拡張子のファイルが 1 件も追跡されていないか、CODE_EXT_RE か" >&2
    echo "         tracked_code_files が壊れている可能性が高いです（Issue #83 の走査）。" >&2
    echo "         直下ファイルは ${checked_root_files} 件検証できているため、走査系の一部だけが死んでいます。" >&2
  else
    echo "       → 列挙は深さ 2 以上へ ${found_deep_paths} 件到達しています。ただしこれは" >&2
    echo "         **担当域が列挙から漏れていないことを保証しません**。次の両方があり得ます:" >&2
    echo "         (1) 対象の消失 — 占有者が実際に無くなった（直近の占有者は survey-web の" >&2
    echo "             perf/*.mjs と e2e/*.mjs）。占有者ゼロは正常状態になり得ます。" >&2
    echo "         (2) 列挙の破損 — 担当域のファイルが追跡されていない（上の未追跡警告を参照）、" >&2
    echo "             または CODE_EXT_RE の拡張子パターンが部分的に壊れた。" >&2
    echo "         まず git 上で占有者の実在を確認してください。実在するなら (2) です。" >&2
    echo "         (1) が意図した消失であれば、本チェック自体の要否を見直してください。" >&2
  fi
  echo "       いずれの場合も本ガードは fail-closed のため赤にします。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: テストコードのカバレッジガードに違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: テストコードのカバレッジガード緑（${checked_workspaces} workspace / ${checked_dirs} ディレクトリ / ${checked_root_files} 直下ファイル / ${checked_subdir_files} サブディレクトリファイル が lint と型検査の双方に掛かっている）。"
exit 0
