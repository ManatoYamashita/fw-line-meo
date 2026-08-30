#!/usr/bin/env bash
# Issue #148 ガードレール: **spec 文書は誰の検査対象でもない。**
#
# `.kiro/specs/store-qr-issuance-ui/tasks.md` の 4.2 実施手順は、リポジトリのどこにも存在しない
# env 名 `CORS_ORIGIN` を設定するよう指示していた（PR #142 のレビューで検出・42a46bc で是正）。
# 正しくは `DASHBOARD_WEB_ORIGIN`（`ts/apps/dashboard-api/src/config.ts` の `loadConfig`）で、
# 手順どおりに起動すると `DASHBOARD_WEB_ORIGIN is required` で落ちる。同じ手順からは必須 env の
# `SURVEY_BASE_URL` と `PLACES_API_KEY` も欠落していた。この手順は spec の唯一の残タスクの
# 引き継ぎ文書であり、実行者が最初に読む場所だった。
#
# 壊れ方は #33 / #51 / #63 / #78 / #156 と同型である。実装側の `loadConfig` を変えても文書は
# 追随せず、文書に存在しない env 名を書いても CI は緑のまま通る。**書いた本人が実行していない
# 手順は、実行されるまで誤りが露見しない。**
#
# ## 抽出は「env 宣言表」へアンカーする（素朴な字句抽出は成立しない）
#
# 実測: `.kiro/specs/**/*.md` から `[A-Z][A-Z0-9_]{2,}` を拾うと異なり 353 種で、うち env は
# 24 種しかない（**誤検知 93%**）。アンダースコア必須へ絞ってもなお 87 種中 23 種（誤検知 74%）。
# 中身は SQL キーワード・略語（`RBAC` `WCAG`）・**16 進の色コード（`F0FBF4`）**・行番号参照
# （`L383`）・アプリのエラーコード（`NOT_FOUND`）である。出現頻度の上位 32 位まで env は 1 件も無い。
#
# さらに致命的なのは、**是正済みの tasks.md が `CORS_ORIGIN` を意図的に散文へ残している**ことである
# （「この名前は存在しない」と読者へ教えるため）。素朴な grep ガードは、自分の起票理由になった
# 最も正しく書かれた行を真っ先に叩き落とす。
#
# したがって抽出源を **`| env | 出典 | … |` のヘッダを持つ markdown 表**に限定する。第 2 列
# 「出典」がソースファイルのリポジトリ相対パスなので、**両方向の照合が 1 つの表の中で閉じる**。
#
# 本スクリプトは以下を機械検証する（read-only の走査・副作用なし・連想配列を使わず bash 3.2 でも走る）:
#   1. 追跡下の `.kiro/specs/**/*.md` から env 宣言表を抽出する
#      （ヘッダ行 `| env | 出典 |` ＋ 直後の区切り行。区切り行が無ければ表として成立せず赤）
#   2. 各行の第 1 列がバッククォートで囲んだ env 名の形である（`` `FOO` ``）
#   3. 第 2 列の出典が解決する（バッククォート囲みのリポジトリ相対パス、または直前行を継ぐ `同上`）。
#      解決したパスが実在しなければ赤（パスの腐りを検出する）
#   4. **方向 1（文書 → 実装）**: 表の env 名が出典ファイルに **語として** 実在する
#      （`CORS_ORIGIN` を表へ書くと `config.ts` に無いので赤）。
#      **部分一致で見てはならない**（Issue #176）。旧名はより長い新名の部分文字列として当たり
#      続けるため、`grep -F` だけだと **実装側の改名が丸ごと素通りする**。実測: `pool.ts` の
#      `DATABASE_URL` を `DATABASE_URL_PRIMARY` へ改名しても `-cF` は 4 件当たって緑、`-cwF` は
#      0 件で赤。改名は「実在しない env 名が手順に残る」最も普通の経路であり、#148 が塞ごうと
#      した形そのものがそこだけ開いていた。露出するのは方向 2 が守らない行だけで
#      （必須 env は「新名が表に無い」と方向 2 が赤にする）、現状は `DATABASE_URL`（条件付き
#      必須）と `PORT`（任意 env）の 2 行である。とくに前者は、名前がずれると手順どおりに値を
#      置いても**黙って無視され Cloud SQL IAM 接続へ倒れる**。起動は成功するので失敗として現れない。
#      `-w` の語構成文字は英数字と `_` で、上記 2 が強制する env 名の文法と一致する。先行例は
#      `db/test/check_docs.sh` の `count_matches -wF`（テーブル名の実在確認）。
#   5. **方向 2（実装 → 文書）**: 出典ファイルの `throw new Error('<NAME> is required')` が
#      すべてその表に載っている（`SURVEY_BASE_URL` / `PLACES_API_KEY` の欠落で赤）
#   6. 空振り防止: 走査対象 0 件・表 0 件・本文行 0 件・方向 2 の対象出典が全体で 0 件はいずれも赤
#      （対象 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため）
#   7. WHITELIST の項目が 1 件も当たらなくなったら WARNING を出す
#
# ## 検証しないこと（意図的な非対象）
#
#   - **散文中の env 名**。`CORS_ORIGIN` は「存在しない名前だ」と教えるために意図的に残されている。
#     表の外を見た瞬間、このガードは最も正しい記述を罰する装置になる。
#   - **表を持たない spec の手順**（`export FOO=...` 形式）。抽出源を増やすと誤検知の母数が戻る。
#   - **ヘルパ経由で必須化される env**。方向 2 の抽出は `Error('<NAME> is required')` の
#     リテラルに限る。`ts/apps/line-webhook/src/config.ts` の `` Error(`${key} is required`) `` や
#     `ts/packages/db/src/pool.ts` の `requireEnv(env, key)` は env 名が式なので 0 件に落ち、
#     その出典は方向 2 の対象から自動的に外れる。**これは手書きの除外ではなく、実装側が
#     「必須であることをエラーメッセージで自己申告する」規約を守っているかどうかと連動する。**
#     `pool.ts` の `DATABASE_URL` 系は条件付き必須（`DATABASE_URL` があれば他は不要）であり、
#     単一の必須集合を持たないため、この落ち方が正しい。
#   - `NEXT_PUBLIC_*` の build 時注入（`scripts/check-next-public-buildargs.sh` の担当）。
#   - **「実装の全 env が spec に書かれている」方向は見ない。** `EVAL_*` や `LIFF_VERIFY_ENDPOINT`
#     のように文書化を要しない env が正当に存在するため、その方向は誤検出になる
#     （`scripts/check-secret-declaration-coverage.sh` が消費側について採ったのと同じ判断）。
#
# 使い方: bash scripts/check-spec-env-names.sh
#   乖離があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 意図的に方向 1（文書 → 実装）の照合から外す項目。`<出典パス>::<ENV>` 形式で、
# 直上に理由と Issue 番号を必ず書くこと。1 件も当たらなくなったら WARNING で回収を促す。
#
# GOOGLE_APPLICATION_CREDENTIALS は Application Default Credentials の標準 env で、
# firebase-admin の `initializeApp()` が SDK 内部で読む。実行には必須でありながら
# **ソースに文字列が 1 度も現れない**（実測 0 件）ため、出典ファイルとの照合が成立しない。
# 手順から落とすと ID トークン検証が動かないので、表からは外せない（Issue #148）。
WHITELIST=(
  'ts/apps/dashboard-api/src/index.ts::GOOGLE_APPLICATION_CREDENTIALS'
)

fail=0
note_fail() {
  fail=1
  echo "ERROR: $1" >&2
}

in_list() {
  # $1=needle, 残り=list
  needle="$1"
  shift
  for x in "$@"; do
    [ "$x" = "$needle" ] && return 0
  done
  return 1
}

count_lines() {
  # $1=改行区切りの文字列。空なら 0。`wc -l` は入力を最後まで読むので SIGPIPE を起こさない
  # （`grep -c` を素で代入すると無一致の exit 1 で set -e に殺されるため、件数はこちらで数える）。
  if [ -z "$1" ]; then
    printf '0\n'
    return 0
  fi
  printf '%s\n' "$1" | wc -l | tr -d '[:space:]'
}

if ! git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: git の作業ツリーではありません: ${ROOT}（走査対象を列挙できません）。" >&2
  exit 1
fi

# --- 1. 走査対象の列挙 ----------------------------------------------------------
specs_rc=0
specs="$(git -C "$ROOT" -c core.quotePath=false ls-files --cached -- '.kiro/specs/*.md')" || specs_rc=$?
if [ "$specs_rc" -ne 0 ]; then
  echo "ERROR: .kiro/specs 配下の Markdown を列挙できません（git ls-files exit=${specs_rc}）。" >&2
  exit 1
fi
spec_count="$(count_lines "$specs")"
if [ "$spec_count" -eq 0 ]; then
  echo "ERROR: 追跡下の .kiro/specs/**/*.md が 1 件もありません（走査の前提が崩れています）。" >&2
  echo "       → 対象 0 件のまま「乖離なし」で緑にするのが最悪の空振りであるため、ここで fail します。" >&2
  exit 1
fi

# env 宣言表を正規化した行へ落とす。出力の第 1 列が種別:
#   TABLE   <file> <ヘッダ行番号> <表番号>            … 表として成立した
#   ROW     <file> <表番号> <行番号> <ENV> <出典パス>  … 本文行 1 行
#   BADSEP  <file> <ヘッダ行番号>                     … ヘッダの直後が区切り行でない
#   EMPTY   <file> <ヘッダ行番号>                     … 表はあるが本文行が 0 件
#   BADROW  <file> <行番号> <行の中身>                … 列が 3 つ未満
#   BADENV  <file> <行番号> <第 1 列>                 … 第 1 列が `FOO` の形でない
#   BADIDEM <file> <行番号> <ENV>                     … 表の先頭行が `同上`
#   BADSRC  <file> <行番号> <ENV> <第 2 列>           … 出典にバッククォート囲みが無い
TABLE_AWK='
BEGIN { FS = "|"; state = 0; tbl = 0; rows = 0; prevsrc = ""; hdr = 0 }
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
{
  if (state == 0) {
    if ($0 ~ /^[ \t]*\|[ \t]*env[ \t]*\|[ \t]*出典[ \t]*\|/) { state = 1; hdr = FNR }
    next
  }
  if (state == 1) {
    if ($0 ~ /^[ \t]*\|[-: \t|]+\|[ \t]*$/) {
      tbl++; rows = 0; prevsrc = ""; state = 2
      printf "TABLE\t%s\t%d\t%d\n", FILENAME, hdr, tbl
      next
    }
    printf "BADSEP\t%s\t%d\n", FILENAME, hdr
    state = 0
    next
  }
  if ($0 !~ /^[ \t]*\|/) {
    if (rows == 0) printf "EMPTY\t%s\t%d\n", FILENAME, hdr
    state = 0
    next
  }
  rows++
  if (NF < 4) { printf "BADROW\t%s\t%d\t%s\n", FILENAME, FNR, $0; next }
  envcell = trim($2); srccell = trim($3)
  if (envcell !~ /^`[A-Z][A-Z0-9_]*`$/) { printf "BADENV\t%s\t%d\t%s\n", FILENAME, FNR, envcell; next }
  name = substr(envcell, 2, length(envcell) - 2)
  if (index(srccell, "同上") > 0) {
    if (prevsrc == "") { printf "BADIDEM\t%s\t%d\t%s\n", FILENAME, FNR, name; next }
    use = prevsrc
  } else {
    if (match(srccell, /`[^`]+`/) == 0) { printf "BADSRC\t%s\t%d\t%s\t%s\n", FILENAME, FNR, name, srccell; next }
    use = substr(srccell, RSTART + 1, RLENGTH - 2)
    prevsrc = use
  }
  printf "ROW\t%s\t%d\t%d\t%s\t%s\n", FILENAME, tbl, FNR, name, use
}
END { if (state == 2 && rows == 0) printf "EMPTY\t%s\t%d\n", FILENAME, hdr }
'

parsed=''
while IFS= read -r spec; do
  [ -n "$spec" ] || continue
  [ -f "${ROOT}/${spec}" ] || continue
  out="$(cd "$ROOT" && awk "$TABLE_AWK" "$spec")"
  [ -n "$out" ] || continue
  parsed="${parsed}${out}"$'\n'
done <<EOF
$specs
EOF

# --- 2-3. 表の構造と出典の解決 ---------------------------------------------------
while IFS= read -r rec; do
  [ -n "$rec" ] || continue
  kind="${rec%%	*}"
  rest="${rec#*	}"
  case "$kind" in
    BADSEP)
      note_fail "$(printf '%s' "$rest" | tr '\t' ':') の env 宣言表がヘッダの直後に区切り行を持ちません（表として成立していません）。"
      echo "       → ヘッダ行の次に '|---|---|---|' を置いてください。" >&2
      ;;
    EMPTY)
      note_fail "$(printf '%s' "$rest" | tr '\t' ':') の env 宣言表に本文行が 1 件もありません（見出しだけが残っています）。"
      echo "       → 表ごと消すか、手順が要求する env を書いてください。" >&2
      ;;
    BADROW)
      note_fail "$(printf '%s' "$rest" | cut -f1,2 | tr '\t' ':') の env 宣言表の行が 3 列に足りません。"
      echo "       → '| \`ENV\` | 出典 | 説明 |' の 3 列で書いてください。" >&2
      ;;
    BADENV)
      note_fail "$(printf '%s' "$rest" | cut -f1,2 | tr '\t' ':') の env 宣言表の第 1 列が env 名の形ではありません: $(printf '%s' "$rest" | cut -f3)"
      echo "       → 第 1 列はバッククォートで囲んだ大文字の env 名（例 \`SURVEY_BASE_URL\`）にしてください。" >&2
      ;;
    BADIDEM)
      note_fail "$(printf '%s' "$rest" | cut -f1,2 | tr '\t' ':') の '同上' が表の先頭行にあり、継ぐ出典がありません。"
      echo "       → 表の最初の行にはリポジトリ相対パスを書いてください。" >&2
      ;;
    BADSRC)
      note_fail "$(printf '%s' "$rest" | cut -f1,2 | tr '\t' ':') の出典にバッククォート囲みのパスがありません: $(printf '%s' "$rest" | cut -f4)"
      echo "       → 出典は \`ts/apps/…/src/config.ts\` のリポジトリ相対パスか '同上' で書いてください。" >&2
      ;;
  esac
done <<EOF
$parsed
EOF

table_count="$(count_lines "$(printf '%s' "$parsed" | awk -F'\t' '$1 == "TABLE" { print }')")"
rows="$(printf '%s' "$parsed" | awk -F'\t' '$1 == "ROW" { print }')"
row_count="$(count_lines "$rows")"

if [ "$table_count" -eq 0 ]; then
  echo "ERROR: env 宣言表（'| env | 出典 | … |' のヘッダを持つ表）を 1 件も抽出できませんでした。" >&2
  echo "       → 表の書式が変わったか、走査の前提が崩れています。対象 0 件のまま緑にはしません。" >&2
  exit 1
fi
if [ "$row_count" -eq 0 ]; then
  echo "ERROR: env 宣言表の本文行を 1 件も抽出できませんでした（表 ${table_count} 件は見つかっています）。" >&2
  echo "       → 行の書式（'| \`ENV\` | 出典 | 説明 |'）の前提が崩れています。" >&2
  exit 1
fi

# --- 4. 方向 1（文書 → 実装）: 表の env 名が出典ファイルに実在するか -----------------
wl_hit=''
while IFS=$'\t' read -r _kind spec _tbl lineno name src; do
  [ -n "$name" ] || continue
  if [ ! -f "${ROOT}/${src}" ]; then
    note_fail "${spec}:${lineno} の出典 '${src}' がリポジトリに存在しません（\`${name}\` の出典として指せません）。"
    echo "       → 出典はリポジトリ相対パスで書いてください。ファイルを移したなら表も追随させてください。" >&2
    continue
  fi
  key="${src}::${name}"
  if in_list "$key" ${WHITELIST[@]+"${WHITELIST[@]}"}; then
    wl_hit="${wl_hit}${key}"$'\n'
    echo "SKIP: ${key}（WHITELIST・理由はスクリプト内コメント参照）"
    continue
  fi
  hit_rc=0
  # **語として照合する（`-w`）。部分一致では改名の取り残しが素通りする。** 旧名はより長い新名の
  # 部分文字列として当たり続けるため、`-F` だけだと `PORT` が `SERVER_PORT` に、`DATABASE_URL` が
  # `DATABASE_URL_PRIMARY` に当たって緑を返す（Issue #176）。`-w` の語構成文字は英数字と `_` で、
  # 上の BADENV 判定が強制する env 名の文法（`[A-Z][A-Z0-9_]*`）と一致する。
  hits="$(grep -cwF -- "$name" "${ROOT}/${src}")" || hit_rc=$?
  if [ "$hit_rc" -gt 1 ]; then
    note_fail "${spec}:${lineno} の出典 '${src}' を走査できません（grep exit=${hit_rc}）。"
    continue
  fi
  if [ "${hits:-0}" -eq 0 ]; then
    note_fail "${spec}:${lineno} の \`${name}\` は出典 '${src}' に存在しません（実在しない env 名です）。"
    # 語としては 0 件でも部分一致で当たるなら、原因はほぼ確実に「より長い名前への改名の取り残し」
    # である。ここを黙っていると、読み手はソースを素朴に grep して新名に当たり、**ガードのほうが
    # 誤っていると読む**。件数を添えて両者を区別できるようにする。
    sub_rc=0
    sub="$(grep -cF -- "$name" "${ROOT}/${src}")" || sub_rc=$?
    if [ "$sub_rc" -eq 0 ] && [ "${sub:-0}" -gt 0 ]; then
      echo "       → ただし部分一致では ${sub} 件当たります。より長い env 名へ改名され、表が" >&2
      echo "         取り残された可能性があります（例 PORT → SERVER_PORT）。" >&2
    fi
    echo "       → 実装が読んでいる名前へ直してください。手順どおりに起動しても env が効かず、" >&2
    echo "         必須 env なら起動時に '<NAME> is required' で落ちます（Issue #148 の CORS_ORIGIN と同型）。" >&2
  fi
done <<EOF
$rows
EOF

# --- 5. 方向 2（実装 → 文書）: 出典の必須 env がすべて表に載っているか ---------------
# 出典ごとに、その出典を引いている表（file+表番号）単位で照合する。
pairs="$(printf '%s' "$rows" | awk -F'\t' '{ print $2 "\t" $3 "\t" $6 }' | sort -u)"
src_count="$(count_lines "$pairs")"
dir2_src_count=0

while IFS=$'\t' read -r spec tbl src; do
  [ -n "$src" ] || continue
  [ -f "${ROOT}/${src}" ] || continue
  req_rc=0
  req="$(grep -oE "Error\('[A-Z][A-Z0-9_]* is required'\)" "${ROOT}/${src}" | sed -E "s/^Error\('([A-Z][A-Z0-9_]*) is required'\)$/\1/" | sort -u)" || req_rc=$?
  if [ "$req_rc" -gt 1 ]; then
    note_fail "出典 '${src}' の必須 env を走査できません（grep exit=${req_rc}）。"
    continue
  fi
  if [ -z "$req" ]; then
    # 必須であることをエラーメッセージへ再掲していない出典。方向 2 の対象外とする
    # （ヘルパ経由・条件付き必須のため単一の必須集合を持たない。ヘッダの「検証しないこと」参照）。
    echo "SKIP: ${src}（必須 env をリテラルで自己申告していないため方向 2 の対象外）"
    continue
  fi
  dir2_src_count=$((dir2_src_count + 1))
  listed="$(printf '%s' "$rows" | awk -F'\t' -v f="$spec" -v t="$tbl" '$2 == f && $3 == t { print $5 }' | sort -u)"
  # shellcheck disable=SC2086 # req / listed は改行区切りで意図的に単語分割する
  for r in $req; do
    if ! in_list "$r" $listed; then
      note_fail "${spec} の env 宣言表に '${src}' の必須 env \`${r}\` がありません（手順どおりでは起動しません）。"
      echo "       → 表へ '| \`${r}\` | ${src} または 同上 | <ローカルでの値> |' の行を足してください。" >&2
      echo "         実装は起動時に '${r} is required' を投げて即座に落ちます。" >&2
    fi
  done
done <<EOF
$pairs
EOF

if [ "$dir2_src_count" -eq 0 ]; then
  echo "ERROR: 必須 env を抽出できた出典が 1 件もありません（出典 ${src_count} 件を走査）。" >&2
  echo "       → 実装側の \"Error('<NAME> is required')\" 規約か、出典の解決が崩れています。" >&2
  echo "         方向 2（実装 → 文書）が丸ごと空振りしたまま緑を返すのを防ぐため、ここで fail します。" >&2
  exit 1
fi

# --- 6. WHITELIST の腐り検出 -----------------------------------------------------
# shellcheck disable=SC2086 # wl_hit は改行区切りで意図的に単語分割する
for w in ${WHITELIST[@]+"${WHITELIST[@]}"}; do
  if ! in_list "$w" $wl_hit; then
    echo "WARNING: '${w}' は WHITELIST に載っていますが、対応する表の行がありません。WHITELIST から削除してください。" >&2
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "NG: spec の env 宣言表と実装の必須 env に乖離があります（上記参照）。" >&2
  exit 1
fi

echo "OK: spec env 名ガード緑（spec ${spec_count} 件 / 表 ${table_count} 件 / 行 ${row_count} 件 / 出典 ${src_count} 件（方向 2 の対象 ${dir2_src_count} 件）照合・WHITELIST ${#WHITELIST[@]} 件）。"
exit 0
