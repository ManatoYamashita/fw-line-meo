# scripts/check-markdown-emphasis.sh の自己テスト（Issue #89 / #90）。
#
# 本ガードは「壊れても CI は落ちず、見た目だけが黙って壊れる」形を検出する。誤検出は逆に CI を
# 止めるため、正当な記法（fence 内の JSDoc・インラインコードの glob・複数行 bold・引用内の
# 複数行 bold）が緑のままであることを対照として固定する。いずれも実測で踏んだ誤検出源である。

# 緑になる最小の合成ツリー。誤検出源をすべて含んだうえで緑であることを要求する。
mde_fixture() {
  fx_guard check-markdown-emphasis

  fx_write docs/normal.md <<'EOF'
# 見出し

**正しい強調**である。約物は強調の外に出してある。**基盤**（デザインシステム）に対応する。

複数行にまたがる bold も正当である。**どの言語がどのテーブルを書くか
（書き込み境界）** を厳格に定義している。

> **引用の中の強調**である。
> 引用内で複数行にまたがる bold も**分断してはならない
> もの**であり、正当な記法である。

- リスト項目の**強調**は項目ごとに閉じる。
- 次の項目も**独立**して閉じる。

インラインコードの glob は強調ではない: `ts/apps/**` と `packages/**`。

```js
/** JSDoc のアスタリスクは強調ではない。 */
const x = 1;
```
EOF
}

t_begin 'check-markdown-emphasis: 正当な記法のみなら緑（件数まで照合）'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  fx_run check-markdown-emphasis
  expect_green
  # 0 件のまま緑になる経路と区別するため、走査件数を照合する。
  expect_output_matches '1 ファイル / [1-9][0-9]* 強調対'
fi
t_end

t_begin 'check-markdown-emphasis: 対にならない ** を検出する'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  fx_write docs/broken.md <<'EOF'
- **[Task 1 レビュー] 閉じ忘れた強調。
- **[Task 2 実装知見] こちらは閉じている**: 正常。
EOF
  fx_run check-markdown-emphasis
  expect_red "の '**' が対になっていません"
fi
t_end

t_begin 'check-markdown-emphasis: 終端側の flanking 違反を検出する'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  fx_write docs/broken.md <<'EOF'
本仕様が定めるのは**構造・整合性・境界の制約（WHAT）**であり、物理設計は design で扱う。
EOF
  fx_run check-markdown-emphasis
  expect_red "の終端 '**' が強調を閉じていません"
fi
t_end

t_begin 'check-markdown-emphasis: 開始側の flanking 違反を検出する'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  fx_write docs/broken.md <<'EOF'
対照実験は「宣言を消す」ではなく**「既定の定義で後勝ちに上書きする」**で作れる。
EOF
  fx_run check-markdown-emphasis
  expect_red "の開始 '**' が強調を開いていません"
fi
t_end

# ---------------------------------------------------------------------------
# 対照。これらが赤くなると、正当な文書を直せと迫るガードになる。

t_begin 'check-markdown-emphasis: 対照 — prune 対象の配下は走査しない'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  fx_write ts/node_modules/pkg/README.md <<'EOF'
これは依存パッケージの文書であり**我々の管理外（vendor）**である。
EOF
  fx_run check-markdown-emphasis
  expect_green
fi
t_end

t_begin 'check-markdown-emphasis: 対照 — .claude/skills 配下（vendored）は走査しない'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  fx_write .claude/skills/vendored/reference.md <<'EOF'
第三者から verbatim で複製した文書であり**我々が直せない（Apache-2.0）**である。
EOF
  fx_run check-markdown-emphasis
  expect_green
fi
t_end

# ---------------------------------------------------------------------------

t_begin 'check-markdown-emphasis: Markdown を 1 件も拾えないとき緑を返さない（空振り防止）'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  fx_guard check-markdown-emphasis
  # .md を一切置かない
  fx_write docs/placeholder.txt <<'EOF'
markdown ではないファイル
EOF
  fx_run check-markdown-emphasis
  expect_red '1 件も検出できませんでした'
fi
t_end

t_begin 'check-markdown-emphasis: 強調を 1 件も検査できないとき緑を返さない（空振り防止）'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  fx_guard check-markdown-emphasis
  # .md はあるが強調が 1 つも無い（fence 除外や masking が全文を飲み込んだ状態と同じ）
  fx_write docs/plain.md <<'EOF'
# 見出し

強調を含まない本文だけの文書。
EOF
  fx_run check-markdown-emphasis
  expect_red '1 件も検査できませんでした'
fi
t_end
