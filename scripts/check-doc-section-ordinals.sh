#!/usr/bin/env bash
# Issue #202 ガードレール: **文書の節番号が二重になっても git は衝突として報告しない。**
#
# 背景（2026-09-06 実測・spec/ui-airbnb-surfaces-41 の合流）:
# `docs/design/design-language.md` の §7 へ、双方のブランチが別内容の同じ番号を足していた。
#
#   こちら側        7.8 帯の高さ / 7.9 ログインの版面 / 7.10 主操作の寸法区分 / 7.11 状態変化の遷移
#   PR #194 側      7.8 LINE 面の律 / 7.9 LINE の巨大表示 / 7.10 バブルの余白 / 7.11 LINE の緑
#
# **挿入位置が違うので別々のハンクとして両方採用される。** 衝突マーカーは 1 つも出ず
# `git status` は clean を返し、テキスト衝突は無関係な 1 行だけだった。これは
# `check-db-ordinals.sh` が連番**ファイル**について塞いだ形と同型で、舞台が文書の中へ移っただけである。
#
# **既存の検査はすべて緑を返した**（実測）:
#   ts/packages/ui/test/design-language-doc.test.ts … `##` の表しか見ない。`###` の重複を知らない
#   scripts/check-markdown-emphasis.sh              … 強調記号しか見ない
#   scripts/check-db-ordinals.sh                    … 連番ファイルが対象。文書の節は射程外
#
# なぜ緑のまま通ると困るのか: これらは**他所から節番号で参照される文書**である。実測で 17 箇所
# （コード・テスト・spec）が `§7.8`〜`§7.11` を指しており、うち 5 箇所は main に着地済みの
# コード自身だった。しかも **main は既に自家撞着していた** —— PR #196 の
# `dashboard-web/src/app/stores/new/page.tsx` が「正典 §7.8 が帯について定めた形」と書いているのに、
# PR #194 が入れた main の §7.8 は「LINE 面の意匠は…」である。#194 と #196 が別々に main へ
# 入った時点で壊れており、誰も気づいていなかった。
#
# 検証内容（規則は 1 つだけ）:
#   走査対象の文書で、ATX 見出しの序数（`7` / `7.8` / `7-1` など）が**同一ファイル内で一意**であること。
#
# **単調増加と欠番の検査は入れない。** 観測された欠陥は重複であり、それ以上は投機になる。
# 欠番を禁じると、節を 1 つ削除するたびに全体の改番を強いることになり、参照側が一斉に腐る。
#
# 走査対象と、`.kiro/**` を除外する根拠:
#   対象 … docs/**/*.md ・ infra/**/*.md ・ ルートの requirements.md
#          （いずれも節番号で外部から参照される。requirements.md は CLAUDE.md が
#            「章番号で参照される」と明記している）
#   除外 … .kiro/**。**外すと赤くなる**ことを実測済みで、しかもその重複はいずれも正当である:
#            .kiro/specs/ui-airbnb-surfaces/tasks.md          重複[1.4 2.1 7.1]
#              → 実施記録の見出しがタスク番号を指しているだけで、節番号ではない
#            .kiro/specs/form-non-text-contrast/research.md   重複[1 2 3]
#              → 別系列の番号を意図的に振り直している
#          除外を外して赤くなること自体が「除外が効いている」証拠である（空振りの除外を作らない）。
#
# 導入時点で対象 5 ファイルはすべてクリーンである（実測: architecture.md 8 件 /
# design-language.md 31 件 / proposal.md 7 件 / infra/README.md 32 件 / requirements.md 34 件）。
#
# 使い方: bash scripts/check-doc-section-ordinals.sh
#   重複があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

NL='
'

# 走査対象の pathspec。**ここを広げるときは、既存の重複が無いことを先に測ること。**
# 生まれた瞬間に赤いガードは WHITELIST 漬けになって死ぬ。
SCAN_PATHSPECS='docs/*.md docs/**/*.md infra/*.md infra/**/*.md requirements.md'

# **アンカー。** 走査対象が glob である以上、文書が移動・改名されると「対象から静かに外れて
# 件数が減る」形で検査が痩せる。差分にも CI にも痕跡が出ない。実在と「番号付き見出しを
# 1 つ以上持つこと」の双方を要求して、ガードを実物へ縛り付ける。
ANCHORS='docs/design/design-language.md infra/README.md requirements.md'

# 意図的除外。形式は `'<リポジトリ相対パス>|<理由と Issue 番号>'`。
# **必ず理由と Issue を書くこと。** 理由の無い除外は「面倒だから外した」と区別が付かない。
# 現在は空。
WHITELIST=()

# 序数の抽出規則。
#   `## 7. 章`     → 7
#   `### 7.8 節`   → 7.8
#   `### 7-1. 手順` → 7-1
#   `#### 9-2. 節`  → 9-2
# 各成分を 1〜2 桁に絞るのは、`### 2026-09-06 の記録` のような**日付見出しを序数と読まない**ため
# である（実測で確認済み。同じ日付の記録が 2 つあるだけで偽陽性になる）。
HEADING_RE='^#{2,6} [0-9]{1,2}([.-][0-9]{1,2})*\.?( |$)'

fail=0
scanned_count=0
heading_total=0
dup_file_count=0
used_whitelist=""

# grep を走らせ、件数を stdout へ出す。rc 2 以上（評価不能）は 2 を返して呼び出し側へ委ねる。
# **後置 true で潰してはならない。** 「読めなかった」が「重複 0 件」と同じ結果に化ける。
#
# **判定フラグをこの関数の中で立ててはならない。** 本関数は `n="$(grep_count ...)"` の形で
# 呼ばれるため、中身は**コマンド置換の副シェル**で走る。そこで `fail=1` を立てても親には
# 戻らず、ERROR を出しながら exit 0 で緑を返す装置ができあがる（**実際に一度そう書いて
# 自己テストに捕まった**。main の PR #192 が check-e2e-goto-ownership.sh で直したのと同型で、
# 副シェルは同じ罠を何度でも仕掛けてくる）。エラーの申告も fail の設定も親で行う。
grep_count() {
  local pattern="$1" file="$2" out rc
  out="$(grep -cE "$pattern" "$file")" && rc=0 || rc=$?
  if [ "$rc" -ge 2 ]; then
    return 2
  fi
  printf '%s' "$out"
  return 0
}

# 走査対象の列挙。**作業ツリーではなく git 管理下から採る**（check-markdown-emphasis.sh と同じ理由。
# 作業ツリーを列挙すると未追跡の第三者文書まで走査対象へ入り、こちらの管理外の内容で赤くなる）。
# quotePath=false は非 ASCII を含むパスを 8 進エスケープさせないために要る。
files="$(git -c core.quotePath=false ls-files -- ${SCAN_PATHSPECS} | grep -E '\.md$' | sort -u)" && frc=0 || frc=$?
# 無一致（exit 1）と評価不能（exit 2 以上）を分ける。後置 true で潰すと、走査が壊れた状態が
# 「対象 0 件」と同じ結果に化ける（下の 0 件判定も赤なので結果は同じだが、**原因の表示が
# 消える**。「pathspec に当たらない」と「列挙できない」は打つ手がまるで違う）。
if [ "$frc" -ge 2 ]; then
  echo "ERROR: 走査対象の列挙が評価不能でした（exit=${frc}）。読めなかったことを「対象 0 件」と読みません。" >&2
  exit 1
fi

if [ -z "$files" ]; then
  echo "ERROR: 走査対象の Markdown が 1 件もありません（pathspec: ${SCAN_PATHSPECS}）。" >&2
  echo "       対象が消えた状態を「重複 0 件」として緑にしません。" >&2
  exit 1
fi

while IFS= read -r f; do
  [ -n "$f" ] || continue

  skip=0
  for wl in ${WHITELIST[@]+"${WHITELIST[@]}"}; do
    wl_path="${wl%%|*}"
    if [ "$wl_path" = "$f" ]; then
      skip=1
      used_whitelist="${used_whitelist}${NL}${wl}${NL}"
      break
    fi
  done
  [ "$skip" -eq 0 ] || continue

  if [ ! -f "$f" ]; then
    echo "ERROR: ${f} は git の索引にありますが実体がありません。" >&2
    fail=1
    continue
  fi

  scanned_count=$((scanned_count + 1))

  n="$(grep_count "$HEADING_RE" "$f")" && grc=0 || grc=$?
  if [ "$grc" -ne 0 ]; then
    echo "ERROR: ${f} の走査が評価不能でした（grep exit=2）。読めなかったことを違反 0 件と読みません。" >&2
    fail=1
    continue
  fi
  heading_total=$((heading_total + n))
  [ "$n" -gt 0 ] || continue

  # 序数だけを取り出して重複を数える。`sort | uniq -d` は入力を読み切るので
  # SIGPIPE の穴（check-shell-pipe-consumers.sh が禁じる形）には当たらない。
  dups="$(grep -oE "$HEADING_RE" "$f" | sed -E 's/^#+ //; s/[. ]*$//' | sort | uniq -d)" && drc=0 || drc=$?
  # ここへ来る時点で $n > 0 なので grep は必ず一致する。無一致（1）が返るなら抽出規則が
  # 計数と抽出で食い違っている状態であり、評価不能（2 以上）と同じく黙って通してはならない。
  if [ "$drc" -ne 0 ]; then
    echo "ERROR: ${f} の序数抽出が失敗しました（exit=${drc}・計数では ${n} 件あった）。" >&2
    echo "       計数と抽出で規則が食い違っています。読めなかったことを「重複なし」と読みません。" >&2
    fail=1
    continue
  fi

  [ -n "$dups" ] || continue

  dup_file_count=$((dup_file_count + 1))
  fail=1
  echo "NG: ${f} に同じ節番号の見出しが複数あります。" >&2
  while IFS= read -r ord; do
    [ -n "$ord" ] || continue
    echo "    序数 ${ord}:" >&2
    # **序数の `.` をエスケープする。** 生のまま渡すと `7.8` が `718` の見出しにも当たり、
    # 無関係な行を「衝突している片割れ」として並べてしまう。
    ord_re="$(printf '%s' "$ord" | sed 's/\./\\./g')"
    # 報告のための再走査。ここも rc 2 以上は握り潰さない（`|| true` で潰すと、正規表現の
    # 組み立てを壊す改変が「該当行なし」と同じ静かな出力に化ける）。
    lines="$(grep -nE "^#{2,6} ${ord_re}\.?( |\$)" "$f")" && lrc=0 || lrc=$?
    if [ "$lrc" -ge 2 ]; then
      echo "ERROR: 序数 ${ord} の該当行を再走査できませんでした（grep exit=${lrc}）。" >&2
    else
      printf '%s\n' "$lines" | sed 's/^/      /' >&2
    fi
  done <<EOF
${dups}
EOF
done <<EOF
${files}
EOF

# アンカーの実在と実効性。走査対象から静かに外れていないことを、ここで実物へ縛る。
for anchor in ${ANCHORS}; do
  case "${NL}${files}${NL}" in
    *"${NL}${anchor}${NL}"*) ;;
    *)
      echo "ERROR: アンカー ${anchor} が走査対象に含まれていません（移動・改名・追跡漏れの疑い）。" >&2
      echo "       対象から外れたまま残りの緑で通ると、この文書の節番号は誰も見なくなります。" >&2
      fail=1
      continue
      ;;
  esac
  an="$(grep_count "$HEADING_RE" "$anchor")" && arc=0 || arc=$?
  if [ "$arc" -ne 0 ]; then
    echo "ERROR: アンカー ${anchor} の走査が評価不能でした（grep exit=2）。読めなかったことを「見出しあり」と読みません。" >&2
    fail=1
    continue
  fi
  if [ "$an" -eq 0 ]; then
    echo "ERROR: アンカー ${anchor} に番号付き見出しが 1 つもありません（走査しても何も検査していません）。" >&2
    fail=1
  fi
done

# 空振り防止。ファイルは在るのに見出しを 1 つも拾えていない状態は、抽出規則が壊れた形である。
if [ "$heading_total" -eq 0 ]; then
  echo "ERROR: 番号付き見出しを 1 つも検出できませんでした（走査 ${scanned_count} ファイル）。" >&2
  echo "       抽出規則の前提が崩れています。0 件を「重複なし」と読みません。" >&2
  exit 1
fi

# 当たらなくなった除外を残さない（check-workflow-step-names.sh / check-deploy-image-coverage.sh と同形）。
for wl in ${WHITELIST[@]+"${WHITELIST[@]}"}; do
  case "$used_whitelist" in
    *"${NL}${wl}${NL}"*) continue ;;
  esac
  echo "WARNING: ${wl} は WHITELIST に載っていますが走査対象に見当たりません。WHITELIST から削除してください。" >&2
done

if [ "$fail" -ne 0 ]; then
  echo "NG: 節番号の一意性が壊れています（重複を持つ文書 ${dup_file_count} 件）。" >&2
  echo "    どちらを繰り下げるかは「先に着地した側」ではなく**参照の実数**で決めること。" >&2
  echo "    参照の数え方: git grep -n '§<番号>' -- ts scripts docs .kiro" >&2
  exit 1
fi

echo "OK: 文書の節番号ガード緑（${scanned_count} ファイル / ${heading_total} 件の番号付き見出し / アンカー $(set -- ${ANCHORS}; echo $#) 件・WHITELIST ${#WHITELIST[@]} 件）。"
exit 0
