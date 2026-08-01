# Gap Analysis — form-non-text-contrast

_実施日: 2026-08-01 ／ 対象: `.kiro/specs/form-non-text-contrast/requirements.md`（6 要件・受入基準 31 件）_

本書は要件と既存コードベースの断層を記録する。**決定は行わず**、選択肢とトレードオフ・確定した実測値・design フェーズへ持ち越す未確定事項を提示する。

---

## 0. 調査サマリ

- **是正対象は当初想定より小さく、かつ正確に確定した**。ガード抽出器を拡張したとき新たに検出される色ユーティリティは **20 件**、そのうち正しい判定軸で要求未達となるのは **3 件のみ**（`border-input` / `border-border` / `bg-border`、いずれも `#DDDDDD` = 1.36:1）。既知の `border-primary/30`（1.52:1）を加えて **計 4 件**。
- **Issue #57 の記載値に有意な誤りがあり、同じ誤りがコードのコメントにも焼き付いている**。`border-primary/30` は Issue・コード双方が「1.96:1 / `#B8D4C3`」と記すが、実測は **1.52:1 / `#B9D9C5`**。Issue が掲載した検証スクリプトを逐語実行しても 1.52 が出る（第 2 節）。
- **抽出器拡張の判別機構は既存資産で足りる**。`resolveSemanticColor()` が色として解決できない語で throw するため、`text-sm` / `border-0` / `ring-3` / `bg-transparent` 等 **17 件の非色トークンは自動的に除外される**。新しい判別ロジックを書く必要がない。
- **最大の難所は色ではなく検証経路**。要件 3（エラー×チェック済み）には、(a) 組み合わせテストの不在、(b) `/ui-check` に該当状態が一切描画されていない、(c) 抽出器のキー衝突で variant 文脈が失われる、という 3 つのギャップが重なる。
- **要件 2（選択状態）が最大の意匠リスク**。3:1 に到達するには `border-primary/30` → **`/75` 以上**が必要で、見た目の変化幅が大きい。

---

## 1. 現状調査（Current State）

### 1.1 資産の所在と責務

| 資産 | 所在 | 責務 | 配布形態 |
|---|---|---|---|
| 値の単一情報源 | `ts/packages/design-tokens/src/colors.ts` | `ColorTokens` interface ＋ `colors` オブジェクト（11 役割） | `build` script あり・**dist 配布** |
| CSS トークン | `ts/packages/ui/src/theme.css`（196 行） | `@theme`（素の hex）→ `:root`（shadcn 意味論名・`var()` 参照のみ）→ `@theme inline`（Tailwind 名前空間へ公開）→ `@layer base` | — |
| UI 部品 | `ts/packages/ui/src/components/*.tsx`（13 部品） | shadcn(base=Base UI) ベンダリング部品 | `build` script **なし**・**ソース直配布** |
| 実描画検証面 | `ts/apps/survey-web/src/app/ui-check/page.tsx`（109 行） | 全 13 部品を import する唯一の面（E2E 専用・noindex） | — |

### 1.2 ガードの 4 系統

| ガード | 所在 | 検証内容 |
|---|---|---|
| 使用箇所のコントラスト | `ts/packages/ui/test/contrast-usage.test.ts`（555 行・4 層構造） | ①数値検証（`USAGE_PAIRS`）②網羅ガード（未分類ゼロ・stale ゼロ・理由必須）③子孫指定の色 ④`color-mix` の実測値照合 |
| 役割対応の厳密一致 | `ts/packages/ui/test/theme-sync.test.ts` | `COLOR_ROLE_TO_CSS_VARIABLE` が `ColorTokens` の全キーと**両方向で網羅一致**（`Object.keys(...).sort()` 同士の `toEqual`） |
| トークン段の AA | `ts/packages/design-tokens/test/colors.test.ts` | `AA_TEXT_PAIRS` 5 組が 4.5:1 以上＋**全役割が `AA_TEXT_PAIRS` か `NON_TEXT_ROLES` に分類済み**であることの網羅ガード |
| 直書き・同値照合 | `scripts/check-design-tokens.sh` | ①直書き hex ②生パレット色クラス（`bg-red-500` 等）③theme.css の全 hex ⊆ design-tokens |

### 1.3 CI の実行順序（`.github/workflows/ts-ci.yml`）

```
job lint-build-test:
  check-next-public-buildargs.sh → check-design-tokens.sh → check-deploy-image-coverage.sh
  → check-typecheck-coverage.sh → install → lint → build → typecheck → migrations → test → perf:budget
job e2e:
  install → build → migrations+seed → playwright install chromium → playwright test
```

ガードスクリプトは **install より前**に走る（依存なしの grep 検証）。ユニットテストは `pnpm -C ts -r test`。**Playwright は `e2e` ジョブのみ**で走る。

### 1.4 支配的な規約（本 spec が従うべきもの）

- 色の hex 直書きが許されるのは `design-tokens/src` と `theme.css` **のみ**。`theme.css` の値は design-tokens の値集合に含まれていなければならない。
- `:root` は hex を二重に持たず `var()` 参照のみ。
- ガードは「集合包含」でなく **役割対応の厳密一致＋両方向網羅**（`ui-design-foundation` の事後レビューで確立した規律）。
- 除外は **20 文字超の理由必須**。理由なし除外は空振りガードと同じとみなす。
- ダークモードは Non-Goal。`@custom-variant dark (&:is(.dark *));`（theme.css:66）で `dark:` を無効化しており、`.dark` を付与する箇所はリポジトリに存在しない。

---

## 2. Issue #57 の記載に対する事実訂正

要件段階でも 2 件訂正したが、本調査でさらに重大な誤りを確定した。**design フェーズはこの訂正後の値を使うこと。**

| # | Issue #57 の記載 | 実測（正典 `@fwlm/design-tokens` ヘルパ） | 影響 |
|---|---|---|---|
| 1 | `border-primary/30` の実効色 **`#B8D4C3`** ／ **1.96:1** | **`#B9D9C5`** ／ **1.522:1** | **有意な誤り**。同じ「1.96:1」が `contrast-usage.test.ts:190` の除外理由にも記載されている。是正時に**コード側のコメントも訂正**が必要 |
| 2 | `border-input #DDDDDD` **1.35:1** | **1.358:1**（四捨五入 1.36） | 誤差レベル。方向は変わらない |
| 3 | 「区切り線・**Card 枠**・フォーム枠が同じトークンを共有」 | **Card 外枠は `ring-foreground/10`**（`card.tsx:17`）で `--border` から**独立**。共有していない | 案1（一律変更）の代償評価が過大だった |
| 4 | 案1の欠点「**テーブル罫線**まで一律に濃くなる」 | 罫線ユーティリティは**リポジトリに 0 件**。`<table>` は 5 箇所あるがすべて className なしの素 HTML | 同上 |
| 5 | （言及なし） | **`--input` は既に別変数として存在**（`theme.css:95` `--input: var(--color-border)`）。値を分岐させるだけで役割分離が成立する | 案2 の導入コストが想定より低い |

### 2.1 訂正 #1 の裏取り

Issue #57 が掲載した検証スクリプトを**逐語実行**した結果:

```
border-input #DDDDDD on 白        : 1.36
border-primary/30 on 白           : 1.52     ← Issue の表は 1.96 と記載
```

Issue の表が主張する `#B8D4C3` を `#15803D` からの単純アルファ合成として逆算すると、必要な alpha がチャンネルごとに **R 0.3034 / G 0.3386 / B 0.3093** と一致しない。すなわち `#B8D4C3` は `primary` の単純合成では生成されえない値であり、別経路で得られた（あるいは手入力された）値である。

正典ヘルパによる確定値:

```
colors.border = #DDDDDD  対白 1.358:1
primary/30    = #B9D9C5  対白 1.522:1
primary/5 面  = #F3F9F5  対白 1.067:1
枠 vs 面塗り  = 1.427:1
選択枠が 3:1 に達する最小不透明度 = primary/75 (#50A06E, 3.184:1)
```

---

## 3. 要件 ↔ 資産マップ（ギャップ分類）

分類凡例: **Missing**（資産が無い）／ **Constraint**（既存構造からの制約）／ **Unknown**（design で要調査）／ **充足済み**

| 要件 | 既存資産 | ギャップ | 分類 |
|---|---|---|---|
| **R1** 既定枠 3:1 | `--input`（theme.css:95・別変数として既存）／`border-input` を使う 4 部品 | `--input` が `--color-border` と同値。分岐先の色役割が無い | **Missing** |
| R1.3 無効化は対象外 | `bg-input/50` が理由付きで `EXEMPT_UTILITIES` に登録済み | なし | 充足済み |
| **R2** 選択状態 3:1 | `field.tsx:109` `has-data-checked:border-primary/30`／`EXEMPT` に登録済み | 3:1 到達には **`/75` 以上**が必要（実測）。`/30 → /75` は意匠の変化幅が大きい。加えて記録値 1.96:1 の訂正が必要 | **Constraint** |
| **R3** エラー×チェック済み | `checkbox.tsx:16`／`radio-group.tsx:25` の `aria-invalid:aria-checked:border-primary`／`FieldError`(`role="alert"`)／`components.test.tsx:168` の単独 aria-invalid テスト | ①「チェック済み × aria-invalid」の**組み合わせテストが存在しない** ②`/ui-check` に `aria-invalid`・チェック済み checkbox・`disabled` が**一件も描画されていない** ③抽出器のキー衝突（下記 3.1） | **Missing**（検証経路そのもの） |
| **R4** 識別用／装飾用の分離 | `--border` と `--input` が既に別変数 | ①bare `border`（`alert.tsx:9`／`field.tsx:109`）は `@layer base` の `border-color: var(--border)` 由来で**ユーティリティ抽出に掛からない** ②button/badge の outline 枠は装飾用 `border-border` を使うが、R4.5 により識別用へ移す必要がある | **Constraint** |
| **R5** ガード拡張 | `extractAlphaUtilities` ＋ `ALPHA_UTILITY_PATTERN` ＋ 網羅ガード 3 種 ＋ **`resolveSemanticColor`（色/非色の判別に流用できる既存機構）** | ①`/\d{1,3}` 必須のため不透明度なしを拾わない ②`kind: 'non-text'` のエントリが**現在ゼロ**＝`AA_NON_TEXT_RATIO` の分岐は一度も実行されていない未検証経路 ③bare `border` は `^(?:bg\|text\|border\|…)-` のハイフン必須により前方一致しない | **Constraint** |
| **R6** SSOT 保全・副作用抑止 | 3 系統のガード（分類網羅・役割対応・同値照合） | ①新役割追加は **5 箇所同時更新**（下記 3.2） ②`colors.test.ts` に**非テキスト 3:1 の検証段が存在しない**（`NON_TEXT_ROLES` は「AA 対象外」であり 3:1 を課さない） ③`--input` の値変更で `disabled:bg-input/50` の合成後が **`#EEEEEE` → `#BBBBBB`**（`#767676` 採用時）へ変化 | **Constraint** |

### 3.1 抽出器のキー衝突（R3 の構造的障害）

`extractAlphaUtilities`（`contrast-usage.test.ts:268`）は `rawToken.slice(rawToken.lastIndexOf(':') + 1)` で variant 連鎖を捨てる。その結果:

```
data-checked:border-primary               → border-primary
aria-invalid:aria-checked:border-primary  → border-primary   ← 同一キーに潰れる
```

`UsagePair.utility` は表の突き合わせキーであり **1 ユーティリティ 1 エントリ**しか持てない。したがって「チェック済みの枠（5.02:1・正常）」と「エラー×チェック済みの枠（要件違反）」を contrast-usage の表では**区別できない**。

R3 は本質的にコントラスト値の問題ではなく **どの variant が勝つか**の問題であり、別の検証機構が要る（第 5 節 論点3）。

### 3.2 新しい色役割を追加する場合の同時更新箇所

ガードが両方向網羅で固めているため、以下 **5 箇所を同時に**更新しないと CI が赤くなる（＝更新漏れは検出される。落とし穴ではなく安全機構）。

1. `ts/packages/design-tokens/src/colors.ts` — `ColorTokens` interface ＋ `colors` オブジェクト
2. `ts/packages/design-tokens/test/colors.test.ts` — `AA_TEXT_PAIRS` か `NON_TEXT_ROLES` へ分類（網羅ガード:90-99）
3. `ts/packages/ui/src/theme.css` — `@theme` に `--color-*` を追加
4. `ts/packages/ui/test/theme-sync.test.ts` — `COLOR_ROLE_TO_CSS_VARIABLE` へ追記
5. `ts/packages/ui/src/theme.css` — `:root` の `--input` を新役割へ向け直す／部品の className を差し替え

---

## 4. ガード拡張時の検出内容（事前確定）

design フェーズのリスクを潰すため、`ALPHA_UTILITY_PATTERN` から `/\d{1,3}` を外した場合に何が検出されるかを**実測で確定した**。

### 4.1 自動的に除外される非色トークン（17 件）

`resolveSemanticColor()` が `--color-<name>` を解決できず throw するため、**追加の判別ロジックなしで**除外される:

```
bg-clip-padding, bg-transparent, border-0, border-t, border-transparent,
ring-1, ring-3, text-2xl, text-balance, text-base, text-current, text-left,
text-lg, text-pretty, text-sm, text-xl, text-xs
```

### 4.2 新たに検出される色ユーティリティ（20 件）と正しい判定軸での結果

「対白比」は正しい判定軸ではない（白い面塗りや白文字は白の上には載らない）。各エントリに `surface`（何に隣接／何の上に載るか）を与えて算出した:

| utility | kind | 前景 → 下地 | 比 | 判定 |
|---|---|---|---|---|
| **`border-input`** | non-text | `#DDDDDD` on background | **1.36** | ★NG（要求 3） |
| **`border-border`** | non-text | `#DDDDDD` on background | **1.36** | ★NG（要求 3） |
| **`bg-border`** | non-text | `#DDDDDD` on background | **1.36** | ★NG（要求 3） |
| `border-destructive` | non-text | `#B91C1C` on background | 6.47 | OK |
| `border-primary` | non-text | `#15803D` on background | 5.02 | OK |
| `bg-primary` | non-text | `#15803D` on background | 5.02 | OK |
| `bg-primary-foreground` | non-text | `#FFFFFF` on primary | 5.02 | OK |
| `text-foreground` | text | `#333333` on background | 12.63 | OK |
| `text-card-foreground` | text | `#333333` on card | 12.63 | OK |
| `text-muted-foreground` | text | `#666666` on background | 5.74 | OK |
| `text-destructive` | text | `#B91C1C` on background | 6.47 | OK |
| `text-success` | text | `#15803D` on card | 5.02 | OK |
| `text-primary` | text | `#15803D` on background | 5.02 | OK |
| `text-primary-foreground` | text | `#FFFFFF` on primary | 5.02 | OK |
| `text-secondary-foreground` | text | `#333333` on secondary | 11.92 | OK |
| `bg-background` | text | foreground on `#FFFFFF` | 12.63 | OK |
| `bg-card` | text | card-foreground on `#FFFFFF` | 12.63 | OK |
| `bg-muted` | text | muted-foreground on `#F0FBF4` | 5.42 | OK |
| `bg-secondary` | text | secondary-foreground on `#F0FBF4` | 11.92 | OK |
| `bg-primary-hover` | text | `#FFFFFF` on `#166534` | 7.13 | OK |

> 上表の `surface` 割当は本調査の**分類案**であり確定ではない。design フェーズで一件ずつ確認すること。

### 4.3 是正が必要な全項目（確定）

| # | utility | 出典 | 現状 | 要件 | 想定される扱い |
|---|---|---|---|---|---|
| 1 | `border-input` | input / textarea / checkbox / radio の既定枠 | 1.36:1 | **R1** | 識別用の色へ是正 |
| 2 | `border-border` | button / badge の outline 枠 | 1.36:1 | **R4.5**（対話的部品の輪郭は識別用） | 識別用の色へ是正 |
| 3 | `bg-border` | Separator の区切り線 | 1.36:1 | **R4.2**（装飾は現状維持） | 理由付きで除外 |
| 4 | `border-primary/30` | FieldLabel の選択状態 | 1.52:1 | **R2** | 是正（手段は未確定） |

**表の総エントリ数は現在 9 件（`USAGE_PAIRS` 5 ＋ `EXEMPT` 4）から 29 件へ増える。** 追加 20 件のうち人手判断が要るのは `surface` の割当のみで、うち 17 件は既に余裕をもって通過する。

---

## 5. 実装アプローチの選択肢

### 論点 1: 識別用の色をどう持たせるか

#### Option A-1: design-tokens に新しい色役割を追加する

`ColorTokens` へ識別用の枠色役割（例 `borderInteractive`）を追加し、`--input` をそこへ向ける。

- ✅ 意味役割が宣言として残り、`theme-sync` の対応表と `colors.test.ts` の分類網羅ガードが「テキストか非テキストか」の判断を**強制**する
- ✅ 3.2 の 5 箇所更新は全てガードが漏れを検出するため、静かに壊れない
- ✅ R4.1（識別用と装飾用を別の意味役割として区別する）に直接対応する
- ❌ 更新箇所が 5 つ。トークンが 1 つ増える
- ❌ `colors.test.ts` の `NON_TEXT_ROLES` へ入れるとトークン段では**無検証**になる（3:1 の段が存在しない）。非テキスト検証段の新設を伴わせるか、usage 段の検証に委ねるかの判断が要る

#### Option A-2: 既存の色役割を流用する（`--input: var(--color-text-muted)`）

- ✅ 更新は `theme.css:95` の 1 行のみ。新しい hex を持ち込まないため `check-design-tokens.sh` の同値照合を素通りする
- ✅ `#666666` は対白 **5.74:1** で要求に対し余裕がある
- ❌ **テキスト用役割を枠に流用**＝意味役割の混線。`COLOR_ROLE_TO_CSS_VARIABLE` は `@theme` 変数しか見ず `:root` の `--input` は対象外のため、**ガードが効かない領域**で意味が崩れる
- ❌ 将来テキスト色を変更すると枠色が巻き添えになる（先行 spec 要件 1.3 の趣旨に反する）

#### Option A-3: 背景差で識別させる（Issue #57 の案3）

- ❌ **実測で現パレットでは不成立**。`brand-subtle #F0FBF4` は対白 **1.067:1**。3:1 を満たす面塗りには `#949494` 相当以上の濃さが必要で、入力欄が灰色に塗りつぶされた見た目になる
- ❌ 結局新しい色役割が要る（A-1 と同コスト）うえ、意匠の変更幅が最大で #43〜#45 と一体判断になる

**トレードオフ要約**: A-1 は「ガードが意味役割の宣言を強制する」既存構造と噛み合う。A-2 は最小変更だがガードの死角に意味の破れを作る。A-3 は実測により単独では成立しない。

#### 枠色の候補値（対白コントラスト・実測）

| 値 | 比 | 備考 |
|---|---|---|
| `#949494` | 3.03:1 | 要求ギリギリ。丸め誤差で割る危険 |
| `#8A8A8A` | 3.45:1 | 非テキスト要求に余裕 |
| `#767676` | 4.54:1 | ブラウザ既定の入力枠に近い濃さ |
| `#6E6E6E` | 5.10:1 | |
| `#666666` | 5.74:1 | 既存 `text-muted` と同値 |

---

### 論点 2: 抽出器の拡張範囲

#### Option B-1: 非テキスト用途のプレフィックスに限定（`border-` / `ring-` / `outline-`）

- ✅ 表への追加が 4〜5 件で済む
- ❌ `bg-border`（Separator）や `bg-primary`（チェック済みの面塗り）は**非テキスト識別なのに漏れる**
- ❌ 「プレフィックスで用途を決める」は近似にすぎない。`bg-` はテキスト下地にも識別面塗りにも使われる

#### Option B-2: 色として解決できる全ユーティリティへ拡張

- ✅ 要件 5.1（不透明度の指定有無に関わらず検出）に忠実。分類漏れが原理的に消える
- ✅ **判別機構が既存**（`resolveSemanticColor` の throw）。新規ロジック不要
- ✅ **第 4 節の事前確定により不確実性が解消済み**: 検出 20 件・失敗 3 件・自動除外 17 件
- ❌ 表が 9 → 29 件へ増える（追加 20 件・約 120 行）
- ❌ 一部は `surface` の割当に文脈判断が要る（`text-foreground` は card 上か background 上か等）

#### Option B-3: 段階導入（B-1 を本 spec、B-2 を別 Issue）

- ✅ 本 spec のリスクを最小化
- ❌ 「不透明度なしの text 系」が素通りし続ける。`ui-design-foundation` の事後レビューで「緑＝正しいが成立しない構造」を潰した経緯に逆行する

**トレードオフ要約**: 事前確定により B-2 の主要リスク（分類件数の不確実性）は消えた。B-1 は工数が小さいが、要件 5.1 の文言（不透明度の指定有無に関わらず）を満たさない。

#### いずれの選択肢でも残る穴

bare `border` / `border-t`（`alert.tsx:9`・`field.tsx:109`・`card.tsx:89`）は `@layer base` の `border-color: var(--border)` から色を得ており、**ユーティリティ名に色を含まないためどの拡張案でも検出されない**。検証対象に含めるなら別の検出規則（幅のみの border クラスを `--border` に帰属させる）が要る。R4.2 により装飾扱いで現状維持とするなら実害はないが、**判断として記録する必要がある**。

---

### 論点 3: エラー×チェック済み（R3）の検証経路

#### Option C-1: `components.test.tsx` にクラス集合の assert を追加

- ✅ 既存の流儀（`classesOf` ＋ `toContain` / `not.toMatch`）にそのまま乗る。jsdom で高速
- ✅ 既に `Checkbox — エラー状態は aria-invalid で通知され、同じ属性が視覚状態も分岐させる`（:168）がある。その隣に組み合わせケースを足すだけ
- ❌ クラスの**存在**しか見ない。Tailwind の生成順序で実際にどちらの枠色が勝つかは検証できない

#### Option C-2: `/ui-check` に該当状態を追加し E2E で実描画色を測る

- ✅ 決定的。`readRenderedColors`（`ui-foundation.spec.ts:69-90`。canvas 経由で sRGB 実測）が既にある
- ✅ `disabled` 状態も同時に描画すれば **R6.3（無効化面塗りの巻き添え）の検証にも使える**
- ❌ `/ui-check` の拡張が必要（現在 `aria-invalid`・チェック済み checkbox・`disabled` が**一件も無い**）
- ❌ `e2e` ジョブは build 込みで重い

#### Option C-3: `app-integration.test.ts` の実 Tailwind コンパイルで規則順序を検証

- ✅ ブラウザ不要で詳細度・レイヤ順を検証できる（`.outline-none` 非生成の検証で実績あり）
- ❌ 「どのセレクタが勝つか」の判定を自前で書く必要がある

**トレードオフ要約**: C-1 は安いが「クラス集合は緑のまま実描画が壊れる」既知の失敗様式（`AlertDescription` の子孫指定・PR #56）を防げない。C-2 はその失敗様式に対する唯一の実証手段。両者は排他ではない。

---

## 6. Effort と Risk

| 作業 | Effort | Risk | 根拠 |
|---|---|---|---|
| 識別用トークンの分離（論点1） | **S** | **Low** | 既存パターンの踏襲。5 箇所更新だが全てガードが漏れを検出する |
| 抽出器の拡張と表の充填（論点2） | **M** | **Low** | 事前確定により件数・失敗箇所が既知。判別機構も既存 |
| エラー×チェック済みの検証経路（論点3） | **M** | **Medium** | `/ui-check` の拡張と E2E 追加が要る。既存ヘルパは流用可 |
| 選択状態（R2）の是正 | **S** | **High** | 実装は容易だが **`/30` → `/75` 以上**は意匠の変化幅が大きく、代替手段の比較が要る |
| 無効化面塗りの巻き添え対処（R6.3） | **S** | **Medium** | `#EEEEEE → #BBBBBB` の変化。対処方針が未確定 |
| **全体** | **M〜L** | **Medium** | 色の是正自体は 4 件と小さい。工数の主体は検証経路の整備 |

---

## 7. design フェーズへの推奨

### 7.1 先に決めるべき事項（依存順）

1. **識別用の色をどう持たせるか**（論点1）— これが決まらないと他が動かない。`colors.test.ts` に非テキスト 3:1 の検証段を新設するかも同時に決める
2. **選択状態（R2）の是正手段** — `/75` 以上へ濃くするか、識別用トークンを枠に使うか、枠以外（太さ・形状）で補うか。**意匠リスクが最も高い**
3. **無効化面塗り（R6.3）の対処** — 別トークンへ分離するか、不透明度を調整するか、意図的変更として記録するか
4. **抽出器の拡張範囲**（論点2）と、bare `border` を検証対象に含めるかの判断
5. **エラー×チェック済みの検証経路**（論点3）と、`/ui-check` に追加する状態の一覧

### 7.2 ガード先行（R5.6）の実行順序

要件が「検証表へ移して失敗を確認したのち是正へ着手」を課しているため、赤化の実証は次の順で自然に得られる:

```
1. border-primary/30 を EXEMPT → USAGE_PAIRS(kind:'non-text') へ移動  → 赤（1.52 < 3）
2. 抽出器から /\d{1,3} を外す                                        → 赤（未分類 20 件）
3. 20 件を分類（border-input / border-border を non-text で登録）     → 赤（1.36 < 3）
4. bg-border を理由付きで EXEMPT へ                                   → 3 の赤のみ残る
5. トークンを是正                                                     → 緑
```

**注意**: `kind: 'non-text'` のエントリは現在ゼロで、`AA_NON_TEXT_RATIO` の分岐（`contrast-usage.test.ts:230`）は**一度も実行されていない**。手順 1 が最初の実行となるため、閾値分岐そのものが正しく働くことを併せて確認すること。

### 7.3 Research Needed（design フェーズで解消する未確定事項）

| # | 項目 | なぜ未確定か |
|---|---|---|
| 1 | 選択状態を 3:1 にする手段の意匠比較 | `/75` 以上は見た目の変化が大きい。枠以外で補う案との優劣が数値だけでは決まらない |
| 2 | bare `border`（base 層由来）を検証対象に含めるか | 検出には別機構が要る。R4.2 で装飾扱いなら不要だが、判断の記録が必要 |
| 3 | `colors.test.ts` に非テキスト 3:1 の検証段を設けるか | `NON_TEXT_ROLES` は AA 対象外を意味するだけで 3:1 を課さない。トークン段と usage 段のどちらで担保するかの設計判断 |
| 4 | `/ui-check` へ追加する状態の一覧と E2E 実行時間への影響 | 状態を増やすほど Tab 巡回テスト（`MAX_TAB_STEPS = 24`）の前提にも影響しうる |
| 5 | `border-border` を識別用へ移す範囲 | badge は非対話。button outline は対話的。R4.5 の適用境界を部品ごとに確定する必要がある |

### 7.4 併せて是正すべき記録の誤り

- `ts/packages/ui/test/contrast-usage.test.ts:190` の除外理由に記載された **「1.96:1」を「1.52:1」へ訂正**する（第 2 節）。当該エントリは本 spec で `USAGE_PAIRS` へ移動するため、移動時に理由文ごと消えるが、**移動前に誤りだったことを design.md に記録**しておくこと。
- Issue #57 のコメントで、表の値 3 件（`#B8D4C3` / 1.96:1、Card 枠の共有、テーブル罫線）が事実と異なることを報告する。

---

# Design Synthesis — 2026-08-01

`design.md` を書く前に適用した 3 つのレンズの結果。設計上の決定 D1〜D8 の根拠となる。

## 1. Generalization（一般化）

要件 1・2・4 は表層的には別々の欠陥として起票されているが、**根は一つ**である。

> 色使用が「部品の識別に必要か、純装飾か」という**意味役割を宣言していない**。

この一般形を解けば 3 要件が同時に落ちる:

| 要件 | 表層の症状 | 一般形での説明 |
|---|---|---|
| 1 | フォーム部品の既定枠が薄い | 識別用の枠が装飾用の値を使っている |
| 4 | 装飾まで濃くしたくない | 識別用と装飾用が同一トークンに潰れている |
| 2 | 選択状態が薄い | 選択という識別情報に装飾的な不透明度を掛けている |

したがって設計が導入する新概念は **1 つだけ**——「識別用の枠色役割」——であり、要件 5 はそれを機械的に強制する仕組み、要件 6 は既存の単一情報源規律を壊さないための制約、要件 3 は詳細度の問題として独立に解く。

**インタフェースだけを一般化し実装は広げない**方針に従い、`ColorTokens` へ役割を 1 つ足すに留めた。「識別用の面塗り」「識別用のリング」といった将来ありうる役割は、現要件が要求していないため作らない。

## 2. Build vs. Adopt（既存解の採用）

| 課題 | 判断 | 根拠 |
|---|---|---|
| WCAG コントラスト計算 | **採用**（`@fwlm/design-tokens` の既存実装） | 依存ゼロで実装済み。相対輝度・合成・比の全てが自己検証付きで存在する。書き直す理由がない |
| 色ユーティリティと非色ユーティリティの判別 | **採用**（既存 `resolveSemanticColor` の throw を流用） | 実測により 17 件の非色トークンが追加ロジックなしで除外されることを確認済み。ホワイトリストを自作すればトークン追加のたびに二重更新が要る |
| エラー状態の優先順位付け | **採用**（CSS 詳細度） | 2 連 variant のコンパウンドセレクタが属性 1 個の variant に確定的に勝つ。JS による制御や `!important` を持ち込む必要がない |
| 実描画色の測定 | **採用**（既存 `readRenderedColors` の canvas 実測方式） | 書式非依存で sRGB を取り出す実装が既にある。枠色への拡張のみ行い、新しい計測手法は導入しない |
| 識別用トークンのユーティリティ名 | **採用**（既存 `border-input`） | `--input` と `@theme inline` の公開が既に存在する。新しい名前を足すと同一値に 2 名が付く |

**結論: 新規の外部依存ゼロ・新規ファイルゼロ。** 本仕様はすべて既存機構の延長で成立する。

## 3. Simplification（単純化）

導入を検討したが**不要と判断して削った**もの:

| 削った案 | 理由 |
|---|---|
| `colors.test.ts` への非テキスト 3:1 検証段の新設 | コントラストは**ペアの性質**であり、トークン単体は隣接色を知らない。使用箇所側の `USAGE_PAIRS` が唯一の正しい位置。2 箇所で同じ 3:1 を主張すると片方の変更が他方に伝わらない二重管理になる（D7） |
| 幅のみを指定する枠（`border` / `border-t`）の検出機構 | 色ユーティリティではないため要件 5.1 の対象外。要件 4.2 により装飾として現状維持するため、検出しても取るべき行動がない |
| 無効化面塗り専用の色役割の追加 | WCAG が無効化部品を対象外としており、実描画は要素の `opacity-50` との二重合成でさらに淡くなる。トークンを 1 つ増やす価値がない（D8） |
| 静的 Badge と `<a>` Badge で枠色を分岐させる案 | 同一クラスに 2 色を持たせる複雑さが、静的 Badge の枠がわずかに濃くなる代償に見合わない。要件 4.4 の安全側規定に従い一律で識別用とする（D5） |
| `border-primary/75`（3:1 の最小到達点）の採用 | 3:1 に近く余裕がないうえ、`/75` という根拠の薄い数値が残る。不透明度を撤去して `border-primary`（5.016:1）にすればアルファユーティリティが 1 つ減り、チェックボックス・ラジオと語彙も揃う（D3） |

**残った設計の規模**: 新規ファイル 0・新規依存 0・変更ファイル 13・新規トークン 1。要件を満たす最小形であり、かつインタフェース（意味役割の宣言）のレベルで拡張可能性を保っている。
