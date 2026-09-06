#!/usr/bin/env bash
# Issue #179 ガードレール: **「検知を回避する」という目的の記述は、実装が正しくても外部審査で
# 検知回避（evasion）の意図表明として読まれる。**
#
# 背景（2026-09-06・Google の 2026-04-17 改定を一次情報で確認）:
# 「マップユーザーの投稿コンテンツに関するポリシー」へ **「評価の操作」** が新設され、
# 「異常なパターンのクチコミ」が販売者の禁止事項として明記された。原文（日英とも）を直接引くと、
# 禁止の実体は一貫して次の一点である。
#
#   Content that is not based on a real experience or does not accurately represent the location
#   （実体験に基づいていないコンテンツ）
#
# そして明示的に **許可** される行為はこう書かれている。ここが合否の分水嶺である。
#
#   Solicit or encourage the posting of content that does represent a genuine experience,
#   without offering incentives
#   （インセンティブを提供したり、評価やクチコミの内容に影響を与えようとしたりせずに、
#     実体験に基づくコンテンツの投稿を募ったり促したりする行為）
#
# **AI・自動生成への言及は原文に存在しない**（日英とも確認済み。二次情報の「AI 生成レビュー禁止」は誤報）。
# 判定は「AI を使ったか」ではなく **「販売者が内容に影響を与えたか」** である。
#
# したがって本製品の多様性生成（`ts/apps/survey-web/src/lib/draft/prompt.ts` の `pickVariation`）は
# **実装としては正しい** —— 素材が客ごとに異なるのだから文面も異なる、という当然の帰結である。
# 問題だったのは**目的の書き方**だけで、是正前は 4 箇所が「検知を回避するために語彙を変える」という
# 順序で書かれていた（`CLAUDE.md` / `requirements.md` ×2 / `.kiro/steering/product.md`）。
# これは GBP API 利用申請（Issue #146）の審査で読まれる文書群である。
#
# **既存の検査はすべて緑を返した**（是正前の状態で実測）:
#   scripts/check-markdown-emphasis.sh      … 強調記号しか見ない
#   scripts/check-doc-section-ordinals.sh   … 見出しの序数しか見ない。走査対象も docs/** infra/** requirements.md
#   scripts/check-spec-env-names.sh         … spec の env 宣言表しか見ない
# CLAUDE.md ・ .kiro/steering/** の**内容**を検査するガードは 1 本も存在しなかった。
#
# 検証内容（3 規則。否定と肯定を対で持つ）:
#   規則1a 正典文書に検知器の名前が現れないこと。必要な概念は「同一店舗で定型文が並ばない」で
#          あって検知器の名前ではない。**この規則だけが `requirements.md` §9 のリスク表の行を
#          捕らえる**（あの行には回避語が無いので、共起の正規表現では当たらない）。
#   規則1b 正典文書に「検知の回避」型の複合語が現れないこと。検知器の名前を出さずに同じ動機を
#          書く抜け道を塞ぐ。**是正の経緯を正典の更新履歴へ書こうとすると、まさにここへ掛かる**
#          （実際に一度そう書き、独立レビューに捕まった）。経緯は Issue と PR に置く。
#   規則2  追跡下の文書・コードで、同一行に検知器の名前と回避語が共起しないこと。正典の外へ
#          同じ動機が漏れ出す形を塞ぐ（是正前は `ts/apps/line-webhook/test/line/messages.test.ts`
#          が実際にそうなっていた。Issue #179 の本文はこの 1 件を数え落としている）。
#   規則3  **肯定側のアンカー。** 「無いことの証明」は単独では空振りする。制約節を持つ 2 文書に
#          文面介入の禁止が明文で在ることを対で要求する。オーナー・代理店が下書きの文面へ
#          介入する経路が無いことは、改定後に新設された「特定のコンテンツを含めるよう依頼すること」
#          の禁止に対する最大の防御でありながら、是正前は**偶然そうなっていただけ**だった。
#
# 正規表現を共起の形にした理由（候補を実測して決めた・2026-09-06）:
#   候補A 検知器の名前・検知・判定・検出 × 回避・逃れ・すり抜・くぐり抜・検出されな
#           → 21 件中 17 件が誤爆（「検出されない」「機械検証をすり抜けた」等の健全な技術的用法。
#             検知・判定はこのリポジトリの日常語である）
#   候補B 検知器の名前 × 回避・逃れ・すり抜・くぐり抜
#           → 4 件・誤爆 0
#   採用は B。**回避の語だけで見ると「循環回避」「衝突回避」で 50 件超が誤爆する。**
#   なお `[^。]{0,24}` のような窓は使わない。C ロケールの GNU grep では `[^。]` がバイト否定に
#   なり、手元（BSD grep・UTF-8）と CI（Linux）で意味が変わる。
#
# 射程外（**この 2 つは意図的に見ていない**）:
#   `AGENTS.md`  … git 未追跡のため `git ls-files` に現れない。同ファイルにも同じ記述があるが、
#                  本ガードからは構造的に見えない（Issue #214 で追跡）。
#   `.claude/skills/**` … 外部から取り込んだ vendored 文書（check-markdown-emphasis.sh と同じ理由）。
#
# 是正後の実測: 規則1 = 0 件 / 規則2 = 0 件 / 規則3 = 2 文書とも充足。
# `scripts/test/cases/60-check-prod-image-drift.sh` の「通知の…防止」は**別概念**であり、
# 規則1 の対象外（scripts/ は正典ではない）かつ規則2 にも当たらない（回避語が無い）。
# 除外を 1 件も要さずに緑になることを確認済みで、WHITELIST は空である。
#
# 使い方: bash scripts/check-compliance-wording.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

NL='
'

# 規則1 の走査対象。**外部監査・審査で読まれる正典**に限る。ここを広げるときは、既存の
# 該当が無いことを先に測ること。生まれた瞬間に赤いガードは WHITELIST 漬けになって死ぬ。
CANON_PATHSPECS='CLAUDE.md requirements.md .kiro/steering/*.md .kiro/specs/review-acquisition/*.md'

# 規則2 の走査対象。文書とコードの両方（動機の記述はコメントにも漏れる）。
# **散文を抱える拡張子を落とさない。** `infra/**/*.tf` は日本語の設計コメントを大量に持ち、
# `eval/dataset.json` の `_comment` や `.mjs` の道具類も同様である。`check-e2e-goto-ownership.sh`
# が「`.ts` だけに絞ると `.spec.mts` へ隠した goto が見えない」で踏んだ形と同型なので、
# 拡張子で絞る側の穴を先に塞いでおく（広げた時点で違反 0 件であることを実測済み。
# 追加分は .tf 47 件 / .mjs 系 5 件 / .json 64 件）。
SCAN_PATHSPECS='*.md *.ts *.tsx *.mts *.cts *.mjs *.sql *.sh *.go *.yml *.yaml *.tf *.json'

# **アンカー。走査対象が glob である以上、文書が移動・改名されると「対象から静かに外れて
# 件数が減る」形で検査が痩せる。** 差分にも CI にも痕跡が出ない。2 種類を分けて持つ。
#
# CANON_ANCHORS: 規則1 の走査集合に必ず居ること。**4 件すべてを挙げる。** 実際の違反 4 件のうち
#   2 件は `requirements.md` にあり、うち 1 件（§9 リスク表の行）は回避語を持たないため
#   **規則2 では原理的に捕らえられない**。この 1 件を守っているのは規則1 だけなので、
#   requirements.md が対象から外れると「二度と検出されない形」が復活する。
CANON_ANCHORS='CLAUDE.md requirements.md .kiro/steering/product.md .kiro/specs/review-acquisition/requirements.md'

# MARKER_ANCHORS: 規則3。文面介入の禁止が明文で在ること。制約節を持つ 2 文書に限る
#   （requirements.md と spec は制約の一覧を持たないので、ここへ入れると恒常的に赤くなる）。
MARKER_ANCHORS='CLAUDE.md .kiro/steering/product.md'

# 規則3 が要求する明文。この語をラベルとして持つ行が各アンカーに 1 つ以上あること。
INTERVENTION_MARKER='下書き文面への介入禁止'

# 自己言及の除外。**自己テストは違反の形そのものを fixture に書く**ため規則2 に当たる。
# 除外は**この 1 ファイルに限る**（射程を広げる除外を自己言及の名目で作らない）。
#
# **本ガード自身は除外していない。** 検知器の名前のリテラルを `SPAM_RE` の 1 行だけに閉じ、
# 診断文では「検知器の名前」と呼ぶことで、規則2 に当たらない書き方を選んである（実測 0 件）。
# 除外で通すより強い性質であり、**空振りする除外を残さない**ためでもある。ヘッダへ違反例を
# そのまま引用したくなったときは、除外を足す前に「呼び名で書けないか」を先に考えること。
#
# 実在も要求する（下の SELF_EXEMPT 検証）。消えたら、除外だけが残って射程が静かに広がる。
SELF_EXEMPT='scripts/test/cases/62-check-compliance-wording.sh'

# 意図的除外。形式は `'<リポジトリ相対パス>|<理由と Issue 番号>'`。
# **必ず理由と Issue を書くこと。** 理由の無い除外は「面倒だから外した」と区別が付かない。
# 現在は空（是正後は 1 件も要らないことを実測済み）。
WHITELIST=()

# 検知器の名前。正典ではこの語自体を使わない。**リテラルをここに 1 箇所だけ置く**
# （本文中で繰り返すと、このファイルが規則2 の自己言及除外に依存する度合いが増える）。
SPAM_RE=$'スパム'
# 回避の意図を表す語。**回避の語だけでは技術的用法が大量に誤爆する**ので共起で見る。
EVASION_RE='(回避|逃れ|すり抜|くぐり抜)'
# 規則1b。検知器の名前を出さずに同じ動機を書く形（「検知の回避」「判定を回避」）。
# **正典にだけ課す。** 追跡下全体へ広げると、禁止対象を名指しする本ガード自身と ts-ci の
# ステップ注記が当たり、自己言及の除外を 3 件へ増やすことになる。**禁じる側は禁じる対象を
# 名指しできなければならない**ので、射程を正典に絞るほうが筋が通る（正典 11 ファイルでの
# 実測は 0 件。なお `(検知|判定|検出)` と回避語の**行内共起**まで広げると
# `.kiro/specs/review-acquisition/design.md` と `.kiro/steering/tech.md` の正当な 2 行が
# 誤爆するため、隣接した複合語に限っている）。
EVASION_COMPOUND_RE='(検知|判定|検出)[のをはも]?回避'

fail=0
canon_scanned=0
canon_hits=0
scan_scanned=0
scan_hits=0
used_whitelist=""

# grep を走らせ件数を stdout へ出す。rc 2 以上（評価不能）は 2 を返して呼び出し側へ委ねる。
# **後置 true で潰してはならない。** 「読めなかった」が「違反 0 件」と同じ結果に化ける。
#
# **判定フラグをこの関数の中で立ててはならない。** 本関数は `n="$(grep_count ...)"` の形で
# 呼ばれるため中身はコマンド置換の副シェルで走り、そこで `fail=1` を立てても親へ戻らない。
# ERROR を出しながら exit 0 で緑を返す装置ができあがる（check-doc-section-ordinals.sh が
# 実際に踏み、自己テストに捕まった形である）。エラーの申告も fail の設定も親で行う。
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
# 作業ツリーを列挙すると未追跡の第三者文書まで対象に入り、こちらの管理外の内容で赤くなる）。
# quotePath=false は非 ASCII を含むパスを 8 進エスケープさせないために要る。
#
# **`set -f` でシェルの展開を止めてから git へ渡す。** ここを止めないと、`*.md` はコマンドが
# 走る前に**リポジトリ直下だけ**へ展開され、git は glob ではなく 3 つの実ファイル名を受け取る。
# 実測（2026-09-06・是正前の自分のコードが実際にそうなっていた）:
#     シェルが先に展開   git ls-files -- *.md    →   3 件（CLAUDE.md / README.md / requirements.md）
#     git へ glob を渡す  git ls-files -- '*.md'  → 116 件（うち 87 件が .kiro/ 配下）
# 直下に該当ファイルが無い `*.ts` などは展開されずに glob のまま渡るため、**拡張子ごとに
# 射程が食い違う**という最悪の形になる。差分にも CI にも痕跡は出ない。
list_files() {
  local pathspecs="$1" out rc
  set -f
  # shellcheck disable=SC2086
  out="$(git -c core.quotePath=false ls-files -- ${pathspecs})" && rc=0 || rc=$?
  set +f
  if [ "$rc" -ge 1 ]; then
    return 2
  fi
  printf '%s' "$out"
  return 0
}

canon_files="$(list_files "$CANON_PATHSPECS")" && crc=0 || crc=$?
if [ "$crc" -ne 0 ]; then
  echo "ERROR: 正典文書の列挙が評価不能でした（pathspec: ${CANON_PATHSPECS}）。読めなかったことを「対象 0 件」と読みません。" >&2
  exit 1
fi
if [ -z "$canon_files" ]; then
  echo "ERROR: 正典文書が 1 件もありません（pathspec: ${CANON_PATHSPECS}）。" >&2
  echo "       対象が消えた状態を「違反 0 件」として緑にしません。" >&2
  exit 1
fi

scan_files_all="$(list_files "$SCAN_PATHSPECS")" && srcc=0 || srcc=$?
if [ "$srcc" -ne 0 ]; then
  echo "ERROR: 走査対象の列挙が評価不能でした（pathspec: ${SCAN_PATHSPECS}）。読めなかったことを「対象 0 件」と読みません。" >&2
  exit 1
fi
# vendored 文書を落とす。`grep -v` は入力を読み切るので SIGPIPE の穴には当たらない。
# 無一致（exit 1）＝全件が vendored という状態は下の 0 件判定が捕らえる。
scan_files="$(printf '%s\n' "$scan_files_all" | grep -v '^\.claude/skills/')" && vrc=0 || vrc=$?
if [ "$vrc" -ge 2 ]; then
  echo "ERROR: vendored 文書の除外が評価不能でした（grep exit=${vrc}）。" >&2
  exit 1
fi
if [ -z "$scan_files" ]; then
  echo "ERROR: 走査対象が 1 件もありません（pathspec: ${SCAN_PATHSPECS}）。" >&2
  echo "       対象が消えた状態を「違反 0 件」として緑にしません。" >&2
  exit 1
fi

# ---- 規則1: 正典文書に検知器の名前を書かない ----
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

  canon_scanned=$((canon_scanned + 1))

  # 規則1a: 検知器の名前そのもの。
  n="$(grep_count "$SPAM_RE" "$f")" && grc=0 || grc=$?
  if [ "$grc" -ne 0 ]; then
    echo "ERROR: ${f} の走査が評価不能でした（grep exit=2）。読めなかったことを違反 0 件と読みません。" >&2
    fail=1
  elif [ "$n" -gt 0 ]; then
    canon_hits=$((canon_hits + n))
    fail=1
    echo "NG: ${f} は外部審査で読まれる正典ですが、検知器の名前が書かれています（${n} 件）。" >&2
    lines="$(grep -nE "$SPAM_RE" "$f")" && lrc=0 || lrc=$?
    if [ "$lrc" -ge 2 ]; then
      echo "ERROR: ${f} の該当行を再走査できませんでした（grep exit=${lrc}）。" >&2
    else
      printf '%s\n' "$lines" | sed 's/^/    /' >&2
    fi
  fi

  # 規則1b: 検知器の名前を出さずに同じ動機を書く形。**是正の経緯を正典へ書き残そうとすると
  # ここに掛かる。** 何を直したかは Issue と PR に書けばよく、正典には直った後の記述だけを置く。
  m="$(grep_count "$EVASION_COMPOUND_RE" "$f")" && mrc=0 || mrc=$?
  if [ "$mrc" -ne 0 ]; then
    echo "ERROR: ${f} の走査が評価不能でした（grep exit=2）。読めなかったことを違反 0 件と読みません。" >&2
    fail=1
    continue
  fi
  [ "$m" -gt 0 ] || continue

  canon_hits=$((canon_hits + m))
  fail=1
  echo "NG: ${f} は外部審査で読まれる正典ですが、検知の回避を目的として述べる語形があります（${m} 件）。" >&2
  lines="$(grep -nE "$EVASION_COMPOUND_RE" "$f")" && lrc=0 || lrc=$?
  if [ "$lrc" -ge 2 ]; then
    echo "ERROR: ${f} の該当行を再走査できませんでした（grep exit=${lrc}）。" >&2
  else
    printf '%s\n' "$lines" | sed 's/^/    /' >&2
  fi
done <<EOF
${canon_files}
EOF

# ---- 規則2: 検知の回避を目的として述べる語形を置かない ----
while IFS= read -r f; do
  [ -n "$f" ] || continue

  skip=0
  for ex in ${SELF_EXEMPT}; do
    if [ "$ex" = "$f" ]; then
      skip=1
      break
    fi
  done
  [ "$skip" -eq 0 ] || continue

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

  scan_scanned=$((scan_scanned + 1))

  # 2 段に分けるのは exit code のためである。パイプで繋ぐと pipefail が**右端の非ゼロ**を返すため、
  # 上流の評価不能（2）が下流の無一致（1）に上書きされ、読めなかった状態が静かに通る。
  spam_lines="$(grep -nE "$SPAM_RE" "$f")" && s1=0 || s1=$?
  if [ "$s1" -ge 2 ]; then
    echo "ERROR: ${f} の走査が評価不能でした（grep exit=${s1}）。読めなかったことを違反 0 件と読みません。" >&2
    fail=1
    continue
  fi
  [ "$s1" -eq 0 ] || continue

  hits="$(grep -E "$EVASION_RE" <<EOF
${spam_lines}
EOF
)" && s2=0 || s2=$?
  if [ "$s2" -ge 2 ]; then
    echo "ERROR: ${f} の共起判定が評価不能でした（grep exit=${s2}）。" >&2
    fail=1
    continue
  fi
  [ "$s2" -eq 0 ] || continue

  n="$(printf '%s\n' "$hits" | grep -c '')" && ncr=0 || ncr=$?
  if [ "$ncr" -ge 2 ]; then
    echo "ERROR: ${f} の該当件数を数えられませんでした（grep exit=${ncr}）。" >&2
    fail=1
    continue
  fi
  scan_hits=$((scan_hits + n))
  fail=1
  echo "NG: ${f} に検知の回避を目的として述べる語形があります（${n} 件）。" >&2
  printf '%s\n' "$hits" | sed 's/^/    /' >&2
done <<EOF
${scan_files}
EOF

# ---- 正典アンカー: 規則1 の走査集合が痩せていないこと ----
for anchor in ${CANON_ANCHORS}; do
  case "${NL}${canon_files}${NL}" in
    *"${NL}${anchor}${NL}"*) ;;
    *)
      echo "ERROR: アンカー ${anchor} が正典の走査対象に含まれていません（移動・改名・追跡漏れの疑い）。" >&2
      echo "       対象から外れたまま残りの緑で通ると、この文書は誰も見なくなります。" >&2
      fail=1
      ;;
  esac
done

# ---- 規則3: 肯定側のアンカー ----
# 「検知回避の記述が無い」だけでは、対象そのものが消えた場合にも緑になる。**あるべきものが
# 在ること**を対にして初めて意味を持つ。
for anchor in ${MARKER_ANCHORS}; do
  if [ ! -f "$anchor" ]; then
    echo "ERROR: 明文アンカー ${anchor} が実在しません（移動・改名の疑い）。" >&2
    fail=1
    continue
  fi
  an="$(grep_count "$INTERVENTION_MARKER" "$anchor")" && arc=0 || arc=$?
  if [ "$arc" -ne 0 ]; then
    echo "ERROR: アンカー ${anchor} の走査が評価不能でした（grep exit=2）。読めなかったことを「明文あり」と読みません。" >&2
    fail=1
    continue
  fi
  if [ "$an" -eq 0 ]; then
    echo "NG: ${anchor} に「${INTERVENTION_MARKER}」の明文がありません。" >&2
    echo "    オーナー・代理店が下書きの文面へ介入する経路が無いことは、現状は構造の偶然であって" >&2
    echo "    禁止事項ではありません。Google「評価の操作」の「特定のコンテンツを含めるよう依頼する" >&2
    echo "    こと」の禁止に直接対応する明文を、正典から落とさないでください。" >&2
    fail=1
  fi
done

# 自己言及の除外を実物へ縛る。片方が消えると、除外だけが残って射程が静かに広がる。
for ex in ${SELF_EXEMPT}; do
  if [ ! -f "$ex" ]; then
    echo "ERROR: 自己言及の除外 ${ex} が実在しません。除外だけが残ると規則2 の射程が静かに広がります。" >&2
    fail=1
  fi
done

# 当たらなくなった除外を残さない（check-doc-section-ordinals.sh / check-workflow-step-names.sh と同形）。
for wl in ${WHITELIST[@]+"${WHITELIST[@]}"}; do
  case "$used_whitelist" in
    *"${NL}${wl}${NL}"*) continue ;;
  esac
  echo "WARNING: ${wl} は WHITELIST に載っていますが走査対象に見当たりません。WHITELIST から削除してください。" >&2
done

if [ "$fail" -ne 0 ]; then
  echo "NG: コンプライアンス記述ガードが違反を検出しました（正典 ${canon_hits} 件 / 全体 ${scan_hits} 件）。" >&2
  echo "    書き直しの向きは「検知されないように変える」ではなく、**素材が客ごとに異なるのだから" >&2
  echo "    文面も異なる**という因果です（結果として定型文が並ばない、という順序にすること）。" >&2
  echo "    一次情報: https://support.google.com/contributionpolicy/answer/7400114" >&2
  exit 1
fi

echo "OK: コンプライアンス記述ガード緑（正典 ${canon_scanned} ファイル / 走査 ${scan_scanned} ファイル / 正典アンカー $(set -- ${CANON_ANCHORS}; echo $#) 件 / 明文アンカー $(set -- ${MARKER_ANCHORS}; echo $#) 件・WHITELIST ${#WHITELIST[@]} 件）。"
exit 0
