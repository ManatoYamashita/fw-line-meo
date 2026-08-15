# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
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

# 約物の定義を cmark-gfm（CommonMark 0.29）へ固定する。この 2 ケースは対（ペア）である。
# `\p{P}\p{S}` を使うと S カテゴリを約物と誤認し、下の「見逃し」が緑・「誤検出」が赤へ同時に反転する。
# 判定を CommonMark 0.31 の定義へ寄せる変更は、必ずこの 2 件を同時に壊す。
t_begin 'check-markdown-emphasis: 全角記号（S カテゴリ）は約物ではない — 開始側の見逃しを検出する'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  # 直前の ＋（U+FF0B・Sm）は cmark-gfm では約物ではないため、直後が約物 `/` の開始 `**` は
  # 開けない。GitHub 上では生の ** が表示される（/markdown API で実測・research.md:33 の実例）。
  fx_write docs/broken.md <<'EOF'
- 2.2 UI 判定＋**/me に `id` が無い**（MeUser への追加が前提）。
EOF
  fx_run check-markdown-emphasis
  expect_red "の開始 '**' が強調を開いていません"
fi
t_end

# ---------------------------------------------------------------------------
# 対照。これらが赤くなると、正当な文書を直せと迫るガードになる。

t_begin 'check-markdown-emphasis: 対照 — 全角記号が隣接する正当な強調は緑（誤検出しない）'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  # → （U+2192）や ● （U+25CF）は S カテゴリ。cmark-gfm は約物と扱わないため、
  # 終端 `**` の直前に来ても right-flanking は成立し、GitHub は正しく強調を描画する。
  fx_write docs/symbols.md <<'EOF'
- 設定は**反映→**する。
- 状態は**確定●**である。
EOF
  fx_run check-markdown-emphasis
  expect_green
fi
t_end

t_begin 'check-markdown-emphasis: 対照 — インデントコードブロックは本文ではない'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  # 4 スペースインデントは fenced でなくてもコードブロックである（CommonMark）。
  # 中の JSDoc `/** ... */` は強調ではない。除外しないと 1 個の `**` が対にならず誤検出する。
  fx_write docs/indented.md <<'EOF'
インデントされたコード例:

    /** JSDoc のアスタリスクは強調ではない。 */
    const y = 2;

段落へ戻る。
EOF
  fx_run check-markdown-emphasis
  expect_green
fi
t_end

t_begin 'check-markdown-emphasis: 対照 — リスト内のインデント段落は本文として検査する'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  # リスト項目の 2 段落目もインデントされる。これをコードとして飛ばすと、
  # 本文中の破綻を見逃す（インデントコード除外が広がりすぎた状態の検出）。
  fx_write docs/listpara.md <<'EOF'
- 項目:

    本文が続く。**強調（かっこ）**である。
EOF
  fx_run check-markdown-emphasis
  expect_red "の終端 '**' が強調を閉じていません"
fi
t_end

t_begin 'check-markdown-emphasis: 対照 — 入れ子 fence（4 バックティック）の中は本文ではない'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  # 4 バックティックで開いた fence は 3 バックティックでは閉じない（CommonMark）。
  # 開始 fence より短い fence 行で閉じたと誤認すると、以降の中身が本文として解析される。
  fx_write docs/nested.md <<'EOF'
Markdown の書き方を Markdown で示す例:

````md
```js
/** 入れ子 fence の中のアスタリスクは強調ではない。 */
```
````

段落へ戻る。
EOF
  fx_run check-markdown-emphasis
  expect_green
fi
t_end

t_begin 'check-markdown-emphasis: 対照 — fence を挟んでもリスト内のインデント段落は本文として検査する'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  # 上の listpara.md が固定した不変量は、リスト項目が fenced code block を含んだ瞬間に
  # 消えてはならない。fence 開始行でリスト文脈を落とすと、直後のインデント継続段落が
  # インデントコードと誤認されて飛ばされ、GitHub が本文として描画する破綻を見逃す
  # （/markdown API で <p>本文が続く。**強調（かっこ）**である。</p> と描画されることを実測）。
  fx_write docs/listfence.md <<'EOF'
- 項目:

  ```js
  const x = 1;
  ```

    本文が続く。**強調（かっこ）**である。
EOF
  fx_run check-markdown-emphasis
  expect_red "の終端 '**' が強調を閉じていません"
fi
t_end

t_begin 'check-markdown-emphasis: 対照 — リスト内の 4 スペース fence はコードとして除外する'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  # 上のケースの裏。インデントコード除外を「字下げ 3 以下だけ fence と見なす」形で実装すると、
  # リスト項目内の 4 スペース fence が本文へ落ちて JSDoc を誤検出する。除外の判定は
  # 字下げ量ではなくリスト文脈で切り分けること。
  fx_write docs/listfence-ok.md <<'EOF'
- 項目:

    ```js
    /** JSDoc のアスタリスクは強調ではない。 */
    ```
EOF
  fx_run check-markdown-emphasis
  expect_green
fi
t_end

t_begin 'check-markdown-emphasis: インデントコード内の fence 行は fence 状態を変えない'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  # fence 判定をインデントコード判定より先に走らせると、インデントコードの中身が
  # fence の開閉として解釈される。長さが揃わない（4 個で開き 3 個で閉じようとする）形では
  # 閉じられないまま fence 状態がファイル末尾まで残り、以降が丸ごと解析対象外になる。
  # 単純トグルだった旧実装は次の fence 行で自己回復していたため、これは長さ判定の導入で
  # 新たに開いた穴である。
  fx_write docs/indented-fence.md <<'EOF'
インデントされたコード例:

    ````
    text
    ```

後続。**強調（かっこ）**である。
EOF
  fx_run check-markdown-emphasis
  expect_red "の終端 '**' が強調を閉じていません"
fi
t_end

# 名前を「prune 対象」から改めてある。列挙は git 管理下由来になり prune 一覧は無い（Issue #82）。
# ここが緑になる理由は「除外リストに載っているから」ではなく「.gitignore 済みで追跡されないから」
# であり、根拠が変わっている。ケース名を旧機構のまま残すと、次に読む者が存在しない一覧を探す。
t_begin 'check-markdown-emphasis: 対照 — 追跡されない生成物ディレクトリ配下は走査しない'
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

# ---------------------------------------------------------------------------
# Issue #82: Markdown ガードも作業ツリー列挙では未追跡の第三者文書で誤爆した。
# 実測: main worktree の未追跡 .md 246 件のうち 2 件が違反として報告された（.agents/ 配下の
# 外部製スキル文書）。我々が書いたものでも直せるものでもなく、CI では緑のままだった。

t_begin 'check-markdown-emphasis: 未追跡の .md で誤爆しない（#82）'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  fx_track_now   # ここまでを追跡させる
  # 以降は未追跡。開発者が置いた外部由来の文書を模す。
  fx_write .agents/skills/vendored/SKILL.md <<'EOF'
これは外部由来の文書であり**我々の管理外（vendor）**である。
EOF
  fx_run check-markdown-emphasis
  expect_green
fi
t_end

t_begin 'check-markdown-emphasis: 対照 — 同じ文書が追跡されていれば検出する（見逃しでない）'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  # fx_track_now を呼ばない。fx_run が全ファイルを追跡させるため、この .md も対象になる。
  fx_write docs/tracked-vendor.md <<'EOF'
これは追跡された文書であり**我々の管理下（tracked）**である。
EOF
  fx_run check-markdown-emphasis
  expect_red 'tracked-vendor.md'
fi
t_end

t_begin 'check-markdown-emphasis: git work tree でなければ緑を返さない'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  # .git を作らずに直接起動する（fx_run の自動 git 化を迂回する）。
  # shellcheck disable=SC2034 # OUT / RC は run.sh の expect_* が読むハーネス側のグローバル
  OUT="$(cd "$FX" && bash scripts/check-markdown-emphasis.sh 2>&1)" && RC=0 || RC=$?
  expect_red 'git work tree ではありません'
fi
t_end

# ---------------------------------------------------------------------------
# 列挙を git へ寄せたことの残差。情報源を替えると「対象の集合」だけでなく
# **対象の表現**まで替わる。以下 3 件はいずれもその表現差・出力経路の差で生じる。

t_begin 'check-markdown-emphasis: 非 ASCII ファイル名の .md も走査する'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  # git ls-files は core.quotePath 既定 true のもとで非 ASCII パスを
  # `"docs/\346\227\245..."` の形（引用符 + 8 進エスケープ）で返す。find は生バイトを
  # 返していたため、これは列挙を git へ寄せた時点で生じる退行である。
  # 引用形式のまま node へ渡すと readFileSync が投げ、判定本体の catch で**黙って
  # 読み飛ばされる**。にもかかわらず checked_files には計上されるため、空振り防止の
  # カウンタごと欺かれて緑になる（本ガードが最も嫌う形である）。
  # 対照は同じ fixture の docs/normal.md（ASCII 名）で、そちらは常に走査される。
  fx_write 'docs/日本語ファイル名.md' <<'EOF'
本仕様が定めるのは**構造・整合性・境界の制約（WHAT）**であり、物理設計は design で扱う。
EOF
  fx_run check-markdown-emphasis
  expect_red "の終端 '**' が強調を閉じていません"
  # 8 進エスケープのまま報告されると、指摘された側がファイルへ辿り着けない。
  expect_output_matches '日本語ファイル名\.md'
fi
t_end

t_begin 'check-markdown-emphasis: 未追跡が大量でも中断しない'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  mde_fixture
  fx_track_now   # ここまでを追跡させる
  # 未追跡一覧の**バイト数**が pipe buffer（64KB）を超えると、先頭数件へ絞る consumer が
  # 先にパイプを閉じ、上流が SIGPIPE で落ちる。set -e × pipefail によりガード自体が
  # exit 141 で中断し、OK も NG も出ないまま赤になる。入力サイズ依存で赤にも緑にも
  # 転ぶという点で、本スクリプトが grep -q を避けているのと同じ罠である。
  # 件数は「1 行 185 バイト前後 × 1200 件 ≒ 216KB」を狙って選んである。上流が書き込める
  # 上限（consumer の入力 buffer 2 杯分 ＝ 128KB 前後）に対し 1.7 倍の余裕を取り、
  # BSD / GNU の buffer 幅の差でケースが緑へ転ばないようにする。
  fx_flood 1200 docs .md '**強調**である。'
  fx_run check-markdown-emphasis
  expect_green
  # 警告そのものが出ていることまで見る（出力を丸ごと落として緑にしても通らないように）。
  expect_output_matches 'WARNING: 未追跡の Markdown が 1200 件'
fi
t_end

t_begin 'check-markdown-emphasis: 追跡漏れによる空振りでは未追跡件数を示す'
if ! fx_has_node; then
  t_skip 'node コマンドが無い'
else
  fx_guard check-markdown-emphasis
  fx_write docs/placeholder.txt <<'EOF'
markdown ではないファイル
EOF
  fx_track_now   # .md が 1 件も無い状態で追跡させる
  fx_write docs/untracked.md <<'EOF'
**強調**である。
EOF
  fx_run check-markdown-emphasis
  expect_red '1 件も検出できませんでした'
  # 真因（追跡漏れ）を示す唯一の材料が、空振りで打ち切る**前に**出ていること。
  # 後ろに置くと、この経路でだけ原因が見えないまま終わる。
  expect_output_matches 'WARNING: 未追跡の Markdown が 1 件'
  # 撤去済みの機構（find の prune 一覧）の調査へ誘導しないこと。
  expect_absent 'prune'
fi
t_end
