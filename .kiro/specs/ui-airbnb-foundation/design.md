# Technical Design Document

## Overview

**Purpose**: 本 spec は fw-line-meo のデザイン基盤に**意匠の方向**を与える。参照するのは
[VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md)（MIT）の Airbnb DESIGN.md であり、
その色・形・余白・階層をトークン層（`@fwlm/design-tokens` と `@fwlm/ui/theme.css`）へ写像し、
各面が共通で必要とする 5 部品を `@fwlm/ui` へ追加する。

**Users**: Web 3 面（survey-web / store-detail / dashboard-web）の利用者が意匠の適用された画面を見る。
各面を実装する開発者（#42 / #43 / #44 / #45 の担当）が、色・形・余白・部品を判断せずに使える状態を得る。

**Impact**: `ui-design-foundation` が確立した 4 層（design-tokens → theme.css → `@fwlm/ui` → apps）のうち、
**本 spec は第 1・2・3 層にしか触らない。第 4 層（アプリの画面）は 1 行も変更しない。**
新しい層も新しい外部依存も追加しない。

### Goals

- Web 3 面のアクセントが Airbnb Rausch 系になり、CTA の文字と背景が WCAG AA を満たす
- 成功通知とフォーカス指標が、アクセント色から独立した意味役割を持つ
- 見出しの階層が、共通部品を使っても素のタグを使っても同一に描画される
- 影が 1 段になり、面の分離は 1px の輪郭が担う
- 各面が共通で必要とする 5 部品が `@fwlm/ui` から使える
- 上記が失われたときに CI が失敗する。**是正前の実装に対して赤化することを実証してから導入する**

### Non-Goals

- **各面の画面デザイン** — 後続 spec `ui-airbnb-surfaces` が扱う
- **LINE Flex Message の色** — 変更しないことが決定事項
- **Web フォントの導入** — `typography.ts` が既に「導入判断は #44」と分界を宣言している
- **暗色パレットの定義** — `ui-design-foundation` の Non-Goals を継承
- **視覚回帰・axe・jsx-a11y・生成 CSS のサイズ予算** — #53 が扱う
- **overlay 系部品のベンダリング** — 4 面いずれも必要としない（後述 D6）

## Boundary Commitments

### This Spec Owns

- `ColorTokens` の役割集合と値、およびそれぞれの実効コントラスト
- `theme.css` の `@theme` 宣言、`:root` の意味論変数への割当、`@layer base` の見出し既定
- 余白・角丸・影の各スケールが CSS へ出るか出ないか、および出る場合の値
- `@fwlm/ui` が公開する部品の集合（既存 13 + 新規 5）
- 参照した DESIGN.md の来歴・ライセンス表示

### Out of Boundary

- `lineColors` の値（**1 バイトも触らない**）
- `ts/apps/**` のいかなるファイル（例外は `ui-check` ページへの部品追加のみ。これは部品のコンパイル経路であり画面デザインではない）
- ベンダリング部品のうち、本 spec の変更に伴わない箇所（差分を増やすと次回の `shadcn add` で巻き戻る）
- `docs/design/design-language.md` と steering（#175）

### Allowed Dependencies

- 既存の `@base-ui/react` / `class-variance-authority` / `clsx` / `tailwind-merge` / `lucide-react`
- **新規の外部依存は追加しない**

### Revalidation Triggers

以下が起きたら、後続 spec `ui-airbnb-surfaces` と各面の実装は統合を再確認すること。

- `ColorTokens` の役割名の増減、または既存役割の意味の変更
- `@theme` に新しい名前空間（`--text-*` / `--radius-*` / `--shadow-*` 以外）を追加したとき
- 角丸スケールへの段の追加（`RADIUS_PROBES` の追随が強制される）
- `@fwlm/ui` の公開部品の増減
- `:focus-visible` の輪郭の宣言位置または `outline-offset` の変更

## Architecture

### Existing Architecture Analysis

`ui-design-foundation` が確立した 4 層は維持する。

```mermaid
flowchart TD
  DT["@fwlm/design-tokens<br/>値の SSOT・依存ゼロ・dist 配布"]
  TC["@fwlm/ui/theme.css<br/>@theme + :root 意味論 + @layer base"]
  UI["@fwlm/ui/components<br/>shadcn(base=Base UI) 部品"]
  WEB["ts/apps/{survey-web,store-detail,dashboard-web}<br/>本 spec は触らない"]
  LINE["ts/apps/{line-webhook,delivery-job}<br/>lineColors のみ消費・本 spec は触らない"]

  DT -->|手動同期 + 機械照合| TC
  DT -->|値として import| LINE
  TC -->|@import + @source| WEB
  UI -->|named export| WEB
  TC -.->|意味論変数を提供| UI
```

**なぜ `@fwlm/ui` から LINE へ矢印が無いか**: `line-webhook` / `delivery-job` は tsc ビルドであり、
ソース直配布（exports が `.tsx`）の `@fwlm/ui` を import できない。値だけ dist 配布の
`design-tokens` から取る。この分離が LINE と Web で色を一元化する鍵であり、
**本 spec が Web の色だけを差し替えても LINE が動かない構造的な理由**でもある。

### 本 spec が守る既存の制約（すべて過去の実害から来ている）

| ID | 制約 | 由来 |
|---|---|---|
| C-A | `@theme` に余白の名前付きキーを宣言しない | #54。宣言するとサイズ系ユーティリティの解決先が覆われ `max-w-md` が 1rem に潰れる |
| C-B | 角丸スケールの段を上書きしない | #54。一部の段だけ上書きすると隣段と同値になるか**追い越して逆転**する。逆転は既存ガードが検出しない |
| C-C | フォーカス指標は `@layer base` に一本化し、部品側で輪郭を打ち消さない | #49。カスケードレイヤにより base 層が詳細度と無関係に負ける |
| C-D | hover は暗くする方向で表現する | #50。アルファ合成は白背景で明るくなり AA を割る |
| C-E | `color-mix` は `in oklab` を使う | 無彩色は oklch の hue が powerless で、合成結果が hue 0（赤）へ解決される |
| C-F | 撤去したクラス名・実測 hex をコメントに literal で書かない | Tailwind v4 はソースをプレーンテキスト走査するため、コメント内の記述までユーティリティ生成とガード検出の対象になる |
| C-G | 動き低減の `!important` は装飾ではなく動作条件 | `!important` に限りレイヤ優先順位が逆転する。外すと画面は正常に見えたまま実害が出る |

## 意匠の写像（Airbnb DESIGN.md → 本プロジェクト）

### D1. 色

**採用方針**: 参照デザインシステムの色を**そのまま持ち込まない**。既存の
「装飾専用の `brand`（AA 非保証）と、アクション用の `primary`（AA 準拠）を分離する」手口を踏襲する。
これは `#1DB446`（2.74:1）で既に一度採った手口であり、Rausch（3.516:1）はまったく同型の問題である。

| 役割 | 値 | 原典 | 対白 | 備考 |
|---|---|---|---|---|
| `brand` | `#FF385C` | primary（Rausch） | 3.516 | **装飾専用**。文字にも、文字を載せる面にも使わない |
| `primary` | `#E00B41` | primary-active | **4.891** | CTA 面。白文字と 4.891。**これ以上明るくできない下限** |
| `primaryHover` | `#B30934` | 新規（`#E00B41` の各成分 ×0.8） | **6.987** | 暗色側。C-D を満たす |
| `primaryForeground` | `#FFFFFF` | on-primary | — | |
| `text` | `#222222` | ink | 15.910 | 本文 |
| `textBody` | `#3F3F3F` | body | 10.531 | 長文用（新規・第 4 層で使う） |
| `textMuted` | `#6A6A6A` | muted | 5.409 | 補足。`surfaceSoft` 上 5.049 / `surfaceStrong` 上 4.831 |
| `background` | `#FFFFFF` | canvas | — | |
| `surfaceSoft` | `#F7F7F7` | surface-soft | — | 淡い面（新規） |
| `surfaceStrong` | `#F2F2F2` | surface-strong | — | やや濃い面（新規） |
| `success` | `#15803D` | **原典に対応色なし** | **5.016** | 現行 `primary` の値を転用（新規・D2 参照） |
| `destructive` | `#B32505` | primary-error-text-hover | **6.596** | D3 参照 |
| `destructiveForeground` | `#FFFFFF` | — | — | |
| `border` | `#DDDDDD` | hairline | — | **現行と同値。変更なし** |
| `borderInteractive` | `#767676` | 原典を採らない | 4.542 | **現行維持**（D4 参照） |

削除: `brandSubtle`（`#F0FBF4`）。`--secondary` / `--muted` / `--accent` が中立面へ移り役割が消える。
値そのものは `lineColors.successBackground` に残るため、design-tokens の値集合からは消えない
（`theme.css` の hex ⊆ design-tokens 値集合という既存の包含ガードには影響しない）。

**採らなかった原典の色**（いずれも閾値に届かない。要件 1.4 の具体化）:

| 原典 | 実測 | 判断 |
|---|---|---|
| `#929292` muted-soft | 対白 3.112 | 不採用。現行に「無効リンク色」の役割が無く、無効表現は不透明度が担う |
| `#428BFF` legal-link | 対白 3.297 | 不採用。リンク色は `primary`（4.891）へ一本化 |
| `#C1C1C1` border-strong | 対白 1.800 | 不採用。SC 1.4.11 の 3:1 に届かない |
| `#FFD1DA` disabled tint | 対白 1.365 | 不採用。無効化は WCAG 対象外であり現行の不透明度で足りる |
| `#460479` luxe / `#92174D` plus | — | 不採用（サブブランド） |
| `#EBEBEB` hairline-soft | — | 不採用（第 2 の罫線役割が現行に無い） |
| `#000000` scrim | — | 不採用（モーダル未導入。導入時に役割を追加する） |

### D2. `--success` と `--ring` をアクセント色から切り離す（本 spec で最も重要な変更）

現行の `theme.css` は次の 2 行を持つ。

```
:107   --success: var(--color-primary);
:119   --ring:    var(--color-primary);
```

`--color-primary` を Rausch 系へ替えると、**成功通知が危険通知と同系色になり**、
**フォーカスの輪郭がアクセント色になって、アクセント色で塗ったボタンの周囲で見えなくなる**。

**どちらもコントラスト比では検出できない。** 成功が赤になっても輝度比は変わらないため、
既存の `colors.test.ts` も `contrast-usage.test.ts` も緑のまま通る。
本リポジトリが繰り返してきた「画面は正常に見えたまま無言で壊れる」型（#48 / #49 / #52）と同じである。

したがって:

- `success` を専用トークンとして新設し、`--success: var(--color-success)` とする。
  値は現行 `primary` の緑 `#15803D`（対白 5.016 / `surfaceSoft` 上 4.682）をそのまま横滑りさせる。
  原典に対応色が無いため、**この 1 色だけは原典由来ではない**ことを明記する
- `--ring: var(--color-text)`（ink `#222222`）とする。根拠は 3 つ:
  1. 対白 15.910（現行の緑は 5.016）
  2. 原典自身のフォーカス表現が「枠が 2px ink へ太る」である
  3. アクセント色で塗った面の周囲に同色の輪郭が出る状態を構造的に排除できる
- `--color-success` は `@theme` の実 hex 宣言へ移し、`@theme inline` からは削除する
  （既存の循環参照防止の規律。`@theme` で定義済みの名前を `@theme inline` で再定義しない）

**輪郭の隣接色について**: `:focus-visible` は `outline-offset: 2px` を伴う。輪郭は要素の境界ボックスの
2px 外側に描かれ、その 2px の隙間には**親の背景**が見える。したがって輪郭の隣接色は要素の面色ではなく
親の背景であり、判定は `background` / `card` / `muted` / `secondary` / `popover` に対して行う
（ink はいずれに対しても 14.2 以上）。**要素の面色に対する比（例: `destructive` 面に対し 2.412）は
輪郭が接しないため判定対象にしない。** この推論は `outline-offset` の値に依存するため、
`outline-offset` を 0 にする変更は Revalidation Trigger に含める。

### D3. `destructive` に原典のエラー色をそのまま採らない理由

shadcn の destructive 表現は、同じ色を `bg-destructive/10` および `/20` の淡い面に載せたうえで、
その面の上に**同色の文字**を置く。したがって判定すべきは単体の対白比ではなく**合成後の実効色に対する比**である。

| 候補 | 対白 | `/10` 面上 | `/20` 面上 | 判定 |
|---|---|---|---|---|
| `#C13515`（原典 error） | 5.544 | — | **4.077** | 面上で AA 非準拠 |
| `#B32505`（原典 error-hover） | 6.596 | 5.576 | **4.682** | 全て AA 準拠 |

原典のエラー族の**暗い方**を採ることで、1 値の選択で 3 箇所が同時に AA を満たす。
現行の `#B91C1C` は #50 で同じ理由から選ばれており、置換後も同じ性質を保つ。

**既知の限界（記録）**: `bg-destructive/20` が `surfaceSoft`（`#F7F7F7`）の上に重なると
実効色は `#E9CDC7` となり比は **4.404** で AA を割る。現状 3 面のページ背景はいずれも白であり
この重なりは発生しないが、**第 4 層で淡い面の上に危険通知を置く構成を採るなら再検証が要る。**
後続 spec への申し送りとして Revalidation Triggers に準ずる扱いとする。

### D4. `borderInteractive` に原典 border-strong を採らない理由

原典の `#C1C1C1` は対白 1.800 で、SC 1.4.11 が要求する 3:1 に届かない。
現行の `#767676`（4.542）を維持する。1px の細線はサブピクセルのアンチエイリアスで実効コントラストが
落ちるため、3:1 ちょうどの灰では余裕が無いという既存の判断（`form-non-text-contrast`）をそのまま継承する。
この維持により、E2E が持つ無効化時の実効枠色の記録（現行値に従属）も不変となる。

### D5. 形・影・余白

**角丸: スケールの段を上書きしない（C-B）。役割割当だけを原典に合わせる。**

照合すると 6 段中 4 段が既に完全一致している。

| 原典 | px | Tailwind 段 | px | 差 | 現行の使用 |
|---|---|---|---|---|---|
| xs | 4 | `rounded-sm` | 4 | 0 | 未使用 |
| sm（ボタン） | 8 | `rounded-lg` | 8 | 0 | Button base ✅ 既に一致 |
| md（カード） | 14 | `rounded-xl` / `rounded-2xl` | 12 / 16 | ±2 | Card（現 `rounded-xl`） |
| lg | 20 | （対応段なし） | — | — | **消費者ゼロ** |
| xl（帯） | 32 | `rounded-4xl` | 32 | 0 | Badge ✅ 既に一致 |
| full | 9999 | `rounded-full` | 9999 | 0 | Checkbox / Radio ✅ |

実質の論点は「Card を 12px のままにするか 16px にするか」だけに縮退する。
**Card は `rounded-2xl`（16px）へ寄せる。** 12px のままでは現行の見た目と変わらず「適用した」と言えない。

**全段を原典値へずらす案は却下する。** `--radius-md` を 14px にすると Button の最小サイズが使う
`rounded-[min(var(--radius-md),10px)]` が 10px へ変わり、隣段 `rounded-lg`（8px）を**追い越して逆転**する。
既存の重複検出は同値しか見ないため**逆転は検出されない**。#54 と同型の症状が、ガード緑のまま戻る。

**影: 3 段 → 1 段。**

原典の唯一の影を 8 桁アルファ hex へ変換する（既存の「rgba を使わず 8 桁 hex で表す」規約に従う）。

```
rgba(0,0,0,0.02) → #00000005   (α 5/255  = 0.0196)
rgba(0,0,0,0.04) → #0000000A   (α 10/255 = 0.0392)
rgba(0,0,0,0.1)  → #0000001A   (α 26/255 = 0.1020・既存 shadow.md/lg と同値)

--shadow-raised: 0 0 0 1px #00000005, 0 2px 6px 0 #0000000A, 0 4px 8px 0 #0000001A;
```

撤去に画面リスクは無い。`shadow-sm` / `shadow-md` / `shadow-lg` は `ts/apps` と `ts/packages/ui/src` の
どこからも使われておらず（出現は宣言 3 行のみ）、Tailwind は未参照変数を出力しないため、
**3 段は今日すでに描画に現れていない**。

`--shadow`（無印）は上書きしない。上書きすると Tailwind 既定の `shadow` クラスの意味が静かに変わる。
名前付きの段 `raised` は加算的で曖昧さがない。

**余白: `@theme` には宣言しない（C-A）。トークンは 9 段へ拡張する。**

原典の 9 段はすべて Tailwind の数値スケール（基数 0.25rem）で余りなく表現できる。
これが C-A を守ったまま原典の余白律を採れる根拠である。

| 原典 | px | 倍率 | rem | クラス |
|---|---|---|---|---|
| xxs | 2 | ×0.5 | 0.125 | `p-0.5` |
| xs | 4 | ×1 | 0.25 | `p-1` |
| sm | 8 | ×2 | 0.5 | `p-2` |
| md | 12 | ×3 | 0.75 | `p-3` |
| base | 16 | ×4 | 1 | `p-4` |
| lg | 24 | ×6 | 1.5 | `p-6` |
| xl | 32 | ×8 | 2 | `p-8` |
| xxl | 48 | ×12 | 3 | `p-12` |
| section | 64 | ×16 | 4 | `py-16` |

**`md` の意味が 1rem から 0.75rem へ移り、1rem は新キー `base` になる。**
`spacing` の実消費者は現時点でトークン整合テストのみであり（LINE 層は `lineColors` しか import しない）、
今なら意味の移動を無痛で行える。

### D6. 部品を「作る／作らない」の判断

**作る 5 点。** 各面が共通で必要とし、かつアプリ側では書けないか、書くと必ず重複するもの。

| 部品 | 回収先 | アプリ側で書けない理由 |
|---|---|---|
| `Table` 系 | dashboard 4 面 + store-detail の 1 面 = **5 箇所** | カード化に `bg-card` が要る。この語を `ts/apps/**` に literal で書くと**別パッケージ**の帰属プローブが落ちる |
| `PageShell` | 全 10 ページ | 重複そのもの（同一クラス文字列が既に複数箇所） |
| `PageHeader` | dashboard 7 + LIFF 1 | 同上 |
| `EmptyState` | **6 箇所** | 同上 |
| `Select` | dashboard 4 箇所 | 枠色・高さ・角丸を `Input` と揃えるため |

**作らない。**

- **`Stack`**: `flex flex-col gap-*` で足り、実在する重複を 1 つも消さない。新部品は検証面への追加・
  部品テストの追加・角丸トークン整合（C-B）のコストを毎回払う。**払う価値がない**
- **overlay 系（Dialog / Popover / Select / Tooltip / Tabs / Toast）は 4 面すべてで不要**
  - dashboard の QR は行直下パネル方式で Dialog を回避済み。焦点管理・資源ライフサイクルまで
    作り込まれた**唯一の完成形であり、Dialog へ退行させてはならない**
  - dashboard の選択はプログラムによる値変更でテストされており、ブラウザ標準の選択要素を維持する必要がある
  - store-detail は操作要素ゼロが構造契約として固定されている
  - 結果として **`@base-ui/react` の新規ベンダリングはゼロ**。バンドル予算への影響もゼロ

**`Select` はブラウザ標準の `<select>` のラッパとする。** Base UI の Select ではない。
既存テストがプログラムによる値変更で操作しており、置換すると複数ファイルが落ちる。
ポータルもフォーカストラップも不要になるという副次的な利点もある。

### D7. 見出し階層の一貫化

現状、見出しの階層は **2 箇所が別々に持ち、両者の一致を検証するガードが 1 本も無い**。

| レベル | `@layer base`（現行） | `heading.tsx` の既定（現行） | 新しい共通値 |
|---|---|---|---|
| h1 | 2xl / 700 / **1.3** | 2xl / bold / `leading-tight` = **1.25** | 2xl / 700 / **1.25** |
| h2 | xl / **700** / **1.35** | xl / semibold / `leading-tight` = **1.25** | xl / **600** / **1.25** |
| h3 | lg / 600 / **1.4** | lg / semibold / `leading-snug` = **1.375** | lg / 600 / **1.375** |
| h4 | base / 600 / **1.5** | base / semibold / `leading-snug` = **1.375** | base / 600 / **1.375** |
| h5 | sm / 600 / 1.5 | sm / semibold / `leading-normal` = 1.5 | 変更なし |
| h6 | xs / 600 / 1.5 | xs / semibold / `leading-normal` = 1.5 | 変更なし |

**新しい共通値は `heading.tsx` 側に揃える。** 理由は 2 つ。
(a) `1.25` / `1.375` / `1.5` は Tailwind の `leading-tight` / `leading-snug` / `leading-normal` と厳密に一致し、
部品側がユーティリティで表現できる。(b) 原典の display 階層（1.18〜1.20）よりは緩いが、
**日本語の全角字形は上下の余りを持たないため 1.18 では折り返し時に窮屈になる**。

**行間を原典どおりにしない件と同様に、原典の「display を weight 500/600 に留める」も採れない。**
システム日本語フォント（Meiryo / Yu Gothic）は実質 400 と 700 の 2 段しか持たず、
500 は 400 へ、600 は 700 へスナップする。これは**意匠として再現不能**であり、
Web フォントを採るなら唯一の実質的な動機である。#44 の判断材料として Known Gaps に記録する。

### D8. フォントとサイズ階層を変えない

- 原典のフォントは商用ライセンスであり使用できない。原典自身が代替に挙げる書体は**日本語字形を持たない**ため、
  字形の大半がシステム日本語へ落ち、メトリクスの異なる 2 書体が同一行に混在する。
  これをネットワーク取得コストを払って買うことになる
- 日本語をカバーする代替は MB 級であり、survey-web の LCP 予算と client JS 予算に直結する
- 原典の 8px / 11px / 13px は日本語字形で判読性に難がある。28px は Tailwind 既定 30px との
  **同名上書き**になり、対の行間変数が既定のまま残って片肺で割れる

## File Structure Plan

### 新規ファイル

```
docs/design/upstream/                      # 原典の逐語コピー（作成済み）
├── airbnb-DESIGN.md                       # 無改変
├── README.md                              # 出典・取得時点・ライセンス表示・採らなかったものの要約
└── LICENSE-awesome-design-md              # MIT 全文

ts/packages/ui/src/components/
├── table.tsx                              # Table 系 7 export
├── page-shell.tsx                         # 幅 2 段（sm / lg）
├── page-header.tsx                        # 見出し + 説明 + アクションスロット + 下罫線
├── empty-state.tsx                        # 空状態
└── select.tsx                             # ブラウザ標準 select のラッパ
```

> `docs/design/vendor/` ではなく `upstream/` なのは、`.gitignore:30` の `vendor/`（Go 用）が
> パス位置を問わず一致して追跡対象から外すため。名前を戻すなら否定規則が要る。

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `ts/packages/design-tokens/src/colors.ts` | `ColorTokens` を 15 役割へ。`brandSubtle` 削除、`textBody` / `surfaceSoft` / `surfaceStrong` / `success` 追加、値を D1 の表へ |
| `ts/packages/design-tokens/src/spacing.ts` | 5 キー → 9 キー（D5） |
| `ts/packages/design-tokens/src/radius.ts` | `2xl` を追加（Tailwind 既定と恒等） |
| `ts/packages/design-tokens/src/shadow.ts` | 3 キー → `raised` 1 キー |
| `ts/packages/design-tokens/src/typography.ts` | **値は変更なし。** D8 の判断をコメントとして記録 |
| `ts/packages/ui/src/theme.css` | `@theme` の色・影、`:root` の意味論割当（D2）、`@theme inline` からの `--color-success` 削除、`@layer base` の h1〜h4（D7） |
| `ts/packages/ui/src/components/heading.tsx` | h2 の既定サイズが `xl` のとき weight を `@layer base` と一致させる |
| `ts/packages/ui/src/components/card.tsx` | `rounded-xl` 系 → `rounded-2xl` 系（D5） |
| `ts/apps/survey-web/src/app/ui-check/page.tsx` | 新規 5 部品を**末尾に**追加（部品の唯一のコンパイル経路） |
| `Makefile` | `ts-dev-dashboard` / `ts-dev-store-detail` を追加 |

### 変更しないファイル（明示）

- `ts/apps/**` の画面（`ui-check` を除く）
- `ts/apps/line-webhook/**` / `ts/apps/delivery-job/**`
- `.gitignore`（`vendor/` 規則は Go のもの。触らない）

## Requirements Traceability

| Requirement | 実現する設計要素 |
|---|---|
| 1.1〜1.6 | D1（色の役割と値）／ `colors.ts` ／ `theme.css` の `@theme` |
| 2.1〜2.5 | D2（`--success` / `--ring` の独立）／ 新ガード N3・N4 |
| 3.1〜3.7 | D1 中立色 ／ D5（形・影・余白） |
| 4.1〜4.3 | D7（見出し階層の一貫化）／ 新ガード N2 |
| 5.1〜5.7 | D6（部品の作る／作らない）／ `ui-check` への追加 |
| 6.1〜6.4 | `docs/design/upstream/` の 3 ファイル |
| 7.1〜7.7 | 新ガード N1〜N4 ／ 既存ガードの改訂 ／ 実ブラウザでの合成色採録 |

## Testing Strategy

### 新規ガード（**是正前に赤化することを実証してから導入する**）

| ID | 何を固定するか | なぜ既存では守れないか |
|---|---|---|
| **N1** | ポインタ重畳時の色が静止時より**暗い**（相対輝度が減少する） | C-D は今日コメントにしか存在しない。明色へ変える変異で赤化を実証する |
| **N2** | `heading.tsx` の既定と `@layer base` の h1〜h6 が寸法・太さ・行間で一致する | ガードが 1 本も無い。**現行 origin/main は既に食い違っているので、導入時点で赤 → D7 の是正で緑**という順序が取れる |
| **N3** | 成功色と、アクセント色・危険色とが色相の異なる側にある | 輝度比では「成功が赤くなった」を検出できない。R と G の大小関係を代理指標として用いる（プロキシであることを明記する） |
| **N4** | `--ring` が輪郭の隣接になりうる面（background / card / muted / secondary / popover）に対し 3:1 以上 | `:focus-visible` の輪郭はユーティリティではないため、現行の網羅ガードの走査対象外であり `--ring` の値を誰も検証していない |

**赤化実証の作法**（#60 の規律を継承）: 注入位置を最低 2 通り試す。抽出器には自己検証を付ける。
CSS の機械検証は構文木で行い、宣言を正規表現で拾わない。

### 既存ガードの改訂

- **正しい赤**（期待値を追随させる）: 役割キー集合、`brand` の値、余白・角丸・影のキー集合、
  役割対応表、余白の倍率表、影の名前空間プローブ
- **主張そのものを書き換える**: 「成功色はアクセント色を参照する」→
  「成功色は専用の役割を参照し、アクセント色・装飾色・危険色のいずれも参照しない」
- **リテラルの自己検証の更新**: 現行ブランド色の非準拠を記録している自己検証は、リテラル引数のため
  **緑のまま通るが記述が嘘になる**。新しいブランド色の値へ差し替え、自己検証としての意味を回復させる
- **緑のまま（確認済み）**: `lineColors` の同値検証／`theme.css` の hex ⊆ design-tokens 値集合／
  直書き hex・生パレット色クラスの検出／操作領域 44px／動き低減／横スクロール

### 再測定（実ブラウザ）

`color-mix` の実測記録は、式が参照する両方の変数が動くため再採録が要る。
**offline の oklab 計算では `#E6E6E6` と予測**した。この計算器は既存の記録値
（`color-mix(in oklab, #F0FBF4, #333333 5%)` = `#E6F0E9`）を完全に再現することで自己検証済みである。
ただし記録側の規律に従い、**採録は実ブラウザの描画結果から行う**。式（`in oklab`）は変えない（C-E）。
合成後の文字コントラストは `#222222` on `#E6E6E6` = 12.75:1。

### 手動確認（本 spec の PR で必ず行う）

- 検証面でアクセント色と危険色が並んだとき、CTA が「危険」に読まれないか
  （両者は色相差 15 度・明度差 8pt と近接する。構造的な緩衝は「アクセントは不透明ベタ塗り＋白文字／
  危険は淡面＋濃文字」という描画形状の差にある）
- 成功通知が**緑のまま**であること（D2 が効いている証拠）
- 輪郭が ink で、アクセント色で塗ったボタンの周囲でも視認できること
- 見出し 1〜4 の階層が本文と区別できること（N2 の是正が効いている証拠）

## Known Gaps

1. **原典の「display を weight 500/600 に留める」は再現できない。** システム日本語フォントは実質 400 と 700 の
   2 段しか持たない。Web フォントを採るなら唯一の実質的動機であり、#44 の判断材料である
2. **`bg-destructive/20` が淡い面の上に重なると 4.404 で AA を割る。** 現状 3 面のページ背景は白であり
   発生しないが、第 4 層で淡い面の上に危険通知を置く構成を採るなら再検証が要る
3. **原典の逐語コピーは現状の文書規約検査を無改変で通る**（実測）。したがって除外規則は**入れない**。
   発火ゼロの除外はガードを弱めるだけで、守っている証拠にならない。上流の更新で通らなくなったときに
   初めて除外を足し、その時点で対照ケースを対にすること
4. **`--text` 名前空間に段を足していない。後続 spec は既定スケールの大きい段をそのまま使える**
   （調査で確認済み）。文字サイズには「トークン → 生成 CSS」の突き合わせが存在せず、
   名前空間の網羅ガードは theme.css の宣言側しか見ないため、アプリ層が
   トークンに無い段を使っても赤くならない。実証: 既存の `survey-web` の回答フォームが
   トークンに無い段を既に使っており、現行 CI は緑である。
   **唯一の例外は `@layer base` の h1〜h6 が使う段**で、これはトークン参照であることと
   `@theme` に実寸があることの両方を要求される
