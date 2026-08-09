#!/usr/bin/env bash
# Issue #89 ガードレール: 日本語 Markdown で強調（**...**）が閉じず、生の `**` が表示される。
#
# CommonMark / GFM の強調は left-flanking / right-flanking 規則で判定される。デリミタ `**` は
#   - 開始できる条件: 直後が非空白 かつ（直後が非約物 または 直前が空白/約物）
#   - 終了できる条件: 直前が非空白 かつ（直前が非約物 または 直後が空白/約物）
# を満たす必要がある。日本語は `）` `」` `。` などの全角約物で語を閉じる頻度が高いため、
# `**強調（かっこ）**である` の形（終端 `**` の直前が約物・直後が文字）を踏みやすい。
# 英語では終端の直前がほぼ常に英字になるため、この失敗はほぼ日本語固有である。
#
# 実害: **壊れても CI は落ちない。見た目だけが黙って壊れる。** 書いた本人はエディタのプレビューでは
# 気づきにくく、GitHub 上で初めて露見する。#55 の「CI 全緑のまま実害が素通りする」系と同型である。
# しかも壊れるのは強調であり、spec の強調は「侵してはならない制約」を読み手へ伝えるために
# 使われている（例: four-tier-data-model/requirements.md の WHAT と HOW の境界宣言）。
#
# 検証内容（追跡対象の .md 全件）:
#   A. `**` が対にならず開いたままになっていないか
#   B. 対になっていても、開始側 / 終端側が flanking 規則を満たさず強調が成立しない形でないか
#
# 実測（導入時・origin/main 369a6c6）: A が 2 件、B が 6 件。B のうち 1 件は開始側と終端側の
# 両方が成立していなかった。Issue #89 起票時は終端側しか見ておらず A と開始側を取りこぼしていた。
#
# 誤検出源（いずれも実測で踏んだ。実装で必ず潰すこと）:
#   - fenced code block 内の JSDoc `/** ... */` → fence 除外が無いと 44 行以上が誤ヒットする
#   - インラインコード内の glob（`ts/apps/**` 等）→ masking が無いと誤ヒットする
#   - **複数行にまたがる正当な bold** → 行単位で対を作ると誤検出する（docs/architecture.md 等 3 箇所）
#   - **引用ブロック内の複数行 bold** → `>` 行ごとにブロックを切ると分断されて誤検出する
#     （.kiro/specs/ui-token-collision/design.md の該当段で実際に踏んだ）
#   - リスト項目をブロック境界にしないと、隣接項目の奇数個 `**` が打ち消し合って A を取りこぼす
#
# 判定本体を node へ委譲する理由: flanking 規則は Unicode の一般カテゴリ照会を要求し、
# BSD awk（macOS 既定）では多バイト文字を安定して扱えない。check-test-code-coverage.sh が
# 同じ理由で node -e に JSON 解釈を委譲している前例に従う。npm パッケージには依存しない。
#
# **約物の定義は GitHub の renderer（cmark-gfm）へ合わせる。** GFM が基づく CommonMark 0.29 の
# 「約物 = ASCII 約物 + Pc/Pd/Pe/Pf/Pi/Po/Ps」であり、S カテゴリ（Sm/Sc/Sk/So）は含まない。
# 後年の CommonMark 0.31 は S を約物へ加えたが、GitHub はその定義では描画しない。`\p{P}\p{S}`
# を使うと両方向へずれる（いずれも GitHub の /markdown API で実測）:
#   - 見逃し: `＋**/me …**`（全角プラス U+FF0B は Sm）は GitHub で開かないのにガードは緑
#   - 誤検出: `**設定→**反映` `**状態●**である` は GitHub で正しく描画されるのにガードが赤
#
# `***` 以上の連続アスタリスク（bold + italic）は対象外とする。導入時のコーパスに 0 箇所であり、
# 対にする規則が別（内側と外側で開閉が入れ子になる）ため、確実に判定できる範囲へ絞る。
#
# 使い方: bash scripts/check-markdown-emphasis.sh
#   違反があれば該当を stderr に出して exit 1、無ければ exit 0。
#   read-only（ファイルを読むだけ）・副作用なし・連想配列を使わず bash 3.2 でも走る。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 走査対象の列挙。git ls-files ではなく find を使う理由は 2 つある。
#   1. 既存ガード 5 本がすべて find / grep -r であり、作法を揃える
#   2. scripts/test/ の自己テストは mktemp の合成ツリーへガードを複製して走らせる。
#      合成ツリーは git リポジトリではないため、git ls-files ではテストできない
# prune 一覧は check-test-code-coverage.sh の check_js_files に倣う。
#
# **`-mindepth` を併用してはならない。** 深さ N 未満の述語評価そのものを飛ばすため -prune が
# 発火せず、生成物が流れ込む（check-test-code-coverage.sh で実測済みの罠）。
found="$(find "$ROOT" \
  \( -name node_modules -o -name dist -o -name dist-scripts -o -name .next \
     -o -name public -o -name coverage -o -name playwright-report -o -name test-results \
     -o -name .git -o -name .terraform -o -name build -o -name tmp -o -name .cache \) -prune -o \
  -type f -name '*.md' -print 2>/dev/null | sort)"

# .claude/skills/ 配下は vendored（ATTRIBUTION.md に Apache-2.0・"Modifications: None. Files
# copied verbatim" と明記された第三者文書）である。我々が書き換えてはならない文書の指摘で
# CI を赤くしても直す手段が無いため、走査から外す。導入時点で違反 0 件だが方針として除外する。
# 除外が広がりすぎて全件消えた場合は下の空振り防止が捕まえる。
targets=''
while IFS= read -r md_path; do
  [ -n "$md_path" ] || continue
  case "${md_path#$ROOT/}" in
    .claude/skills/*) continue ;;
  esac
  targets="${targets}${md_path}
"
done <<EOF
$found
EOF

# 判定本体。改行区切りのファイル一覧を stdin で渡し、次の 2 種類の行を受け取る。
#   V<TAB>相対パス<TAB>行<TAB>種別(open|close|unclosed)<TAB>抜粋
#   C<TAB>検査ファイル数<TAB>検査した強調対の数
# 出力の整形は bash 側で行い、既存ガードと ERROR 書式を揃える。
report="$(printf '%s' "$targets" | MD_ROOT="$ROOT" node -e "
  const fs = require(\"fs\");
  const ROOT = process.env.MD_ROOT;
  const FENCE = /^\s*(\`\`\`|~~~)/;
  const HEAD = /^\s{0,3}#{1,6}\s/;
  const LIST = /^\s*(?:[-*+]\s|\d+[.)]\s)/;
  // cmark-gfm（CommonMark 0.29）の約物: ASCII 約物 + Pc/Pd/Pe/Pf/Pi/Po/Ps。S は含めない。
  // ASCII 約物は U+0021-002F / U+003A-0040 / U+005B-0060 / U+007B-007E の 4 レンジ。
  // 文字そのままではなく \u で書くのは、3 番目のレンジ末尾がバッククォートであり、
  // node -e を囲む二重引用符の内側でコマンド置換として解釈されてしまうためである。
  const PUNCT = /[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\p{Pc}\p{Pd}\p{Pe}\p{Pf}\p{Pi}\p{Po}\p{Ps}]/u;
  const isPunct = (c) => c !== \"\" && PUNCT.test(c);
  const isSpace = (c) => c === \"\" || /\s/u.test(c);

  // インラインコードスパンを mask する。**生の文字は保持する。**
  // 空白へ置換すると判定対象の文字が変わり、\`**\` + backtick + \`**（\` のような
  // 正当な形を誤検出する（実測で踏んだ）。
  function codeMask(s) {
    const m = new Array(s.length).fill(false);
    const re = /(\`+)(?:(?!\1)[\s\S])*?\1/g;
    let x;
    while ((x = re.exec(s)) !== null) {
      for (let i = x.index; i < x.index + x[0].length; i++) m[i] = true;
    }
    return m;
  }

  // fence を除外し、ブロックへ分割する。ブロック境界は
  //   空行 / ATX 見出し / リスト項目マーカー / 引用かどうかの切り替わり
  // とする。引用は連続行を 1 ブロックにまとめ、\`>\` 接頭辞を剥がしてから解析する
  // （行ごとに切ると引用内の複数行 bold を分断して誤検出する）。
  function blocks(text) {
    const out = [];
    let cur = [];
    let fence = false;
    let prevQuote = null;
    const lines = text.split(\"\n\");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (FENCE.test(raw)) {
        fence = !fence;
        if (cur.length) { out.push(cur); cur = []; }
        prevQuote = null;
        continue;
      }
      if (fence) continue;
      const quote = /^\s*>/.test(raw);
      const content = quote ? raw.replace(/^\s*>\s?/, \"\") : raw;
      const boundary =
        content.trim() === \"\" || HEAD.test(content) || LIST.test(content) ||
        (prevQuote !== null && quote !== prevQuote);
      if (boundary && cur.length) { out.push(cur); cur = []; }
      prevQuote = quote;
      if (content.trim() === \"\") { prevQuote = null; continue; }
      cur.push({ line: i + 1, text: content });
    }
    if (cur.length) out.push(cur);
    return out;
  }

  let input = \"\";
  process.stdin.on(\"data\", (d) => (input += d)).on(\"end\", () => {
    const files = input.split(\"\n\").filter((s) => s.length > 0);
    let pairs = 0;
    const out = [];
    for (const file of files) {
      const rel = file.startsWith(ROOT + \"/\") ? file.slice(ROOT.length + 1) : file;
      let text;
      try { text = fs.readFileSync(file, \"utf8\"); } catch (e) { continue; }
      for (const blk of blocks(text)) {
        const joined = blk.map((b) => b.text).join(\"\n\");
        // ブロック内オフセット → 元ファイルの行番号
        const starts = [];
        let off = 0;
        for (const b of blk) { starts.push([off, b.line]); off += b.text.length + 1; }
        const lineOf = (pos) => {
          let r = blk[0].line;
          for (const [o, ln] of starts) { if (pos >= o) r = ln; }
          return r;
        };
        const mask = codeMask(joined);
        // mask 外のアスタリスク連続を取り、長さ 2 のものだけをデリミタとする。
        const delims = [];
        let i = 0;
        while (i < joined.length) {
          if (joined[i] === \"*\" && !mask[i]) {
            let j = i;
            while (j < joined.length && joined[j] === \"*\" && !mask[j]) j++;
            if (j - i === 2) delims.push(i);
            i = j;
          } else i++;
        }
        for (let k = 0; k + 1 < delims.length; k += 2) {
          const op = delims[k], cl = delims[k + 1];
          pairs++;
          const afterO = op + 2 < joined.length ? joined[op + 2] : \"\";
          const beforeO = op > 0 ? joined[op - 1] : \"\";
          const beforeC = cl > 0 ? joined[cl - 1] : \"\";
          const afterC = cl + 2 < joined.length ? joined[cl + 2] : \"\";
          const left = !isSpace(afterO) && (!isPunct(afterO) || isSpace(beforeO) || isPunct(beforeO));
          const right = !isSpace(beforeC) && (!isPunct(beforeC) || isSpace(afterC) || isPunct(afterC));
          const excerpt = joined.slice(op, cl + 2).replace(/\n/g, \" \").slice(0, 60);
          if (!left) out.push([\"V\", rel, lineOf(op), \"open\", excerpt].join(\"\t\"));
          if (!right) out.push([\"V\", rel, lineOf(cl), \"close\", excerpt].join(\"\t\"));
        }
        if (delims.length % 2 === 1) {
          const p = delims[delims.length - 1];
          const excerpt = joined.slice(p, p + 60).replace(/\n/g, \" \");
          out.push([\"V\", rel, lineOf(p), \"unclosed\", excerpt].join(\"\t\"));
        }
      }
    }
    out.push([\"C\", files.length, pairs].join(\"\t\"));
    process.stdout.write(out.join(\"\n\"));
  });
")"

fail=0
checked_files=0
checked_pairs=0

while IFS= read -r rline; do
  [ -n "$rline" ] || continue
  kind="${rline%%	*}"
  rest="${rline#*	}"
  if [ "$kind" = 'C' ]; then
    checked_files="${rest%%	*}"
    checked_pairs="${rest#*	}"
    continue
  fi
  [ "$kind" = 'V' ] || continue
  v_path="${rest%%	*}"; rest="${rest#*	}"
  v_line="${rest%%	*}"; rest="${rest#*	}"
  v_kind="${rest%%	*}"; v_excerpt="${rest#*	}"

  case "$v_kind" in
    unclosed)
      echo "ERROR: ${v_path}:${v_line} の '**' が対になっていません（強調が閉じていません）。" >&2
      echo "       → 生の '**' がそのまま表示されます。CI は落ちないため誰も気づけません。" >&2
      echo "         対応する '**' を補ってください: ${v_excerpt}" >&2
      fail=1
      ;;
    close)
      echo "ERROR: ${v_path}:${v_line} の終端 '**' が強調を閉じていません（right-flanking 不成立）。" >&2
      echo "       → 終端 '**' の直前が約物・直後が文字だと GFM は閉じ記号と見なしません。" >&2
      echo "         約物を強調の外へ出してください（'**A（B）**で' → '**A**（B）で'）: ${v_excerpt}" >&2
      fail=1
      ;;
    open)
      echo "ERROR: ${v_path}:${v_line} の開始 '**' が強調を開いていません（left-flanking 不成立）。" >&2
      echo "       → 開始 '**' の直後が約物・直前が文字だと GFM は開き記号と見なしません。" >&2
      echo "         約物を強調の外へ出してください（'く**「A」**で' → 'く「**A**」で'）: ${v_excerpt}" >&2
      fail=1
      ;;
  esac
done <<EOF
$report
EOF

# 空振り防止: 1 件も走査できていなければ、この検証自体が壊れている。
# find の prune 一覧や .claude/skills 除外が広がりすぎた場合、対象ゼロのまま緑になる。
if [ "${checked_files:-0}" -eq 0 ]; then
  echo "ERROR: 走査対象の Markdown を 1 件も検出できませんでした。ガードが空振りしています。" >&2
  echo "       → find の prune 一覧か除外条件が広すぎます。" >&2
  exit 1
fi
if [ "${checked_pairs:-0}" -eq 0 ]; then
  echo "ERROR: 強調（**）を 1 件も検査できませんでした。ガードが空振りしています。" >&2
  echo "       → fence 除外かインラインコード masking が全文を飲み込んでいます。" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "NG: Markdown 強調ガードに違反があります（上記参照）。" >&2
  exit 1
fi

echo "OK: Markdown 強調ガード緑（${checked_files} ファイル / ${checked_pairs} 強調対を検証）。"
exit 0
