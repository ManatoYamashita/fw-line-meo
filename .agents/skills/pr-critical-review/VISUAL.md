# VISUAL.md — Phase 3（図解 HTML）の手順

`SKILL.md` の Phase 3 から呼ばれる。**着手前にこのファイルを最後まで読む。**

## 1. 位置づけ

マークダウンは「判断の材料」、この HTML は **「その指摘は本当か」を確かめるための資料**である。
だから HTML の主役は指摘ではなく、**トリアージの全体像と、見なくてよいと判断した根拠**になる。

作る前に、Phase 1 の疑いの表が手元にあることを確認する。無いなら図にできない。
表を作らずに HTML から書き始めると、境界図が「それっぽい絵」になって根拠が消える。

読み手は絶対ルール 1・2 のとおり、**経緯もその技術の内部挙動も知らない**。
図の中の語も同じ制約を受ける。固有名詞を図に置くなら、図の外に 1 行の説明を添える。

## 2. 節の構成

この順で並べる。番号は読み手が引用しやすいよう振る。

| 節 | 内容 | 省略可否 |
| --- | --- | --- |
| ヘッダ | PR 番号・タイトル・ブランチ・母数の 4 数字（`SKILL.md` Phase 1-2） | 必須 |
| 0 | このPRの前提（背景を知らない読み手向けの整理） | **必須。埋め終わるまで先へ進まない** |
| 1 | トリアージ結果（人間の判断が要るもの / 見なくてよいもの / 未確認） | 必須 |
| 2 | 影響範囲の境界図（第 4 章） | **必須。`--strict` が欠落をエラーにする** |
| 3 | 指摘の詳細（「ひとことで言うと」＋前提＋コード抜粋） | 指摘 0 件なら省略 |
| 4 | 経緯として確認した範囲（探索の終端） | 必須 |
| 5 | PR 作成者への確認事項 | 埋まらなかった問いがあるときだけ |

母数の 4 数字はヘッダに置く。ページの先頭で「どこまで調べたか」が見えないと、
読み手は結局スクロールしながら自分で数えることになる。

## 3. デザイン

デザインと図解は [共通実行規則](../_shared/runtime.md) の「review3 と図解」に従い、利用可能なスキルを読んでから書く。
**ただし Web フォントは読み込まない**（第 7 章が優先）。

このスキル固有の制約は 3 つだけ。

- **色は根拠の型と対応させる。** 判断が要る＝強い色、見なくてよい＝弱い色、未確認＝輪郭のみ。
  同じ意味に別の色を使わない
- **ライト／ダーク両対応にする。** 色は `:root` にトークンで定義し、
  `@media (prefers-color-scheme: dark)` で再定義する。SVG の中でも `currentColor` か
  CSS 変数を使い、色をハードコードしない
- **横スクロールはコードブロックの中だけに閉じる。** 図が本文をはみ出すなら、
  図を作り直す（`overflow-x: auto` で逃げない）

`build-html.py expand` が出す要素に最低限これを当てる。

```css
.src { margin: 1.5rem 0; }
.src figcaption { font: 12px/1.4 ui-monospace, monospace; opacity: .7; margin-bottom: .4rem; }
.src pre { margin: 0; overflow-x: auto; padding: .8rem 0; border-radius: 6px; background: var(--code-bg); }
.src code { display: block; font: 13px/1.6 ui-monospace, monospace; }
.src .line { display: block; padding: 0 1rem 0 0; white-space: pre; }
.src .line::before { content: attr(data-ln); display: inline-block; width: 3.5em;
  padding-right: 1em; text-align: right; opacity: .45; user-select: none; }
.src .line.hl { background: var(--code-hl); }
```

## 4. 影響範囲の境界図（必須）

**Phase 1 の疑いの表を、そのまま図にしたものである。** 新しく調べ直さない。
この図が答えるのは 1 つだけ ——「**どこから先は見なくてよいか**」。

### 構造

3 層で描く。

1. **中心**: この PR が実際に変えたもの（ファイル・関数・リソース）
2. **外箱**: 触れているが、確認した結果 **変わらない**と判断したもの。
   箱ごとに `SKILL.md` の外箱ラベルを付ける ——
   `テストで担保` / `全数確認` / `一次資料の原文で確認` / `呼び出しが不変` ほか
3. **点線**: 未確認。**閉じるために何を見ればよいか**を図の中に書く

外箱には**必ず件数か `path:line` を添える**（「全数確認（参照 7 件）」）。
ラベルだけの箱は根拠ではなく、絶対ルール 3 に反する。

### 実装

`validate` は **`class` に `boundary` を含む要素**の有無で境界図を検出する。
外側のコンテナに必ず付ける。

```html
<figure class="boundary">
  <svg viewBox="0 0 720 400" role="img" aria-labelledby="b-title">
    <title id="b-title">影響範囲の境界図</title>
    <!-- 中心・外箱・点線 -->
  </svg>
  <figcaption>外箱のラベルは、根拠の型（全数確認 / テストで担保 / 一次資料 / 不変）です。</figcaption>
</figure>
```

SVG が過剰なら、CSS グリッドの入れ子ボックスでよい。**形式より、
外箱にラベルと件数が付いていることが要件**である。

### やってはいけないこと

- 根拠が `R5`（推論のみ）のものを外箱に入れる。**点線側へ置く**
- 「影響なし」とだけ書いた箱を置く。何をどう確認したかが消える
- 変更点をすべて描こうとする。**境界を示す図**であって、変更の一覧図ではない

## 5. コード抜粋 — SRC プレースホルダ

**行番号を手で書かない。** diff のハンク番号は変更後の実ファイルとずれる。

解説の要所にプレースホルダを置く。

```html
<!--SRC internal/order/repo.go 82 96 hi=88-90-->
```

`path start end`（1 始まり・両端含む）と、任意の `hi=`（`12-14,18` 形式）。
展開すると直後に `<figure class="src">` と `<!--/SRC-->` が挿入される。
**再実行しても増えない**ので、行がずれたらプレースホルダの数字を直して `expand` し直す。

```bash
python3 {SKILL_DIR}/scripts/build-html.py expand fragment.html --ref origin/{PRのブランチ}
```

**`--ref` を忘れるとベースブランチ側（＝作業ツリー）のコードが載る。** 必ず付ける。
`--ref` が使えない環境（fetch が通らない等）では、`SKILL.md` Phase 0 の順で
変更後のファイルを手元に置いてから作業ツリーを読ませる。

抜粋は 1 箇所あたり 15 行以内に収める。それ以上必要なら、抜粋ではなく説明が足りていない。

## 6. 「0. このPRの前提」

`SKILL.md` の「『0. このPRの前提』の書き方（必須ゲート）」に従う。6〜8 個の箇条書き、700〜830 字。
**この節が埋まるまで指摘本体を書かない。** 経緯を遡る時間を直接置き換える唯一の節であり、
後回しにすると必ず書かれずに終わる。

書き上げたら、**この節だけを単独で読み返す**。前提を知らない人が、
ここだけ読んで「何の話が始まるか」を言えるなら合格。

## 7. 自己完結

**生成物はネットワーク無しで読めなければならない。** 単体 HTML はメール添付や
共有ドライブ経由で、社内ネットワークの外にいる人へ渡る。読めなければ成果物ではない。

- **Web フォントを読み込まない。** Artifact プラットフォームは Google Fonts を許可するが、
  こちらの制約が優先する。`system-ui, sans-serif` と `ui-monospace, monospace` で足りる
- CDN の JS / CSS を読み込まない。**素の HTML と CSS で描く**
- 画像は使わない。必要なら inline SVG にする
- 外部への `fetch` / リンク先の埋め込みをしない（PR や issue への `<a href>` はよい）

`validate` が `src="http...` / `href="http...` / `url(http...` を検出してエラーにする。

## 8. 公開手順

```bash
S={SKILL_DIR}/scripts/build-html.py
python3 $S expand     fragment.html --ref origin/{PRのブランチ}
python3 $S validate   fragment.html --strict          # exit 1 なら公開しない
# → Artifact 公開ツールが使える場合だけ公開する
python3 $S standalone fragment.html {出力先}/pr-{番号}-explainer.html
```

- `fragment.html` は **`<title>` から書き始める**。`<!doctype>` / `<html>` / `<head>` / `<body>` は書かない
  （Artifact 側が付ける。`validate` がエラーにする）
- `standalone` はその骨格を自前で被せて、ダブルクリックで開けるファイルにする
- 出力先は `SKILL.md` Phase -1-5 で決めた `{出力先}`。**絶対パスを標準出力に出す**

`validate` が warning だけを返した場合も、内容を読んでから公開する。
`--strict` を外して境界図を省くのは、**図解そのものを諦める**ときだけ
（そのときは `--no-visual` で Phase 3 ごと飛ばすほうが正しい）。

スクリプト自体の動作確認は `python3 $S self-check`。
