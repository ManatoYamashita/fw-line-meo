# デザイン言語（fw-line-meo 写像版）

このプロジェクトの意匠が「何を、なぜ、どの値で」決めているかを 1 箇所にまとめた文書である。
面を実装する人とエージェントが実際に読むのはこの文書であり、参照デザインシステムの逐語コピー
（`docs/design/upstream/`）ではない。原典と我々の設計は 10 点以上で意図的に乖離している。

本文の数値は `ts/packages/ui/test/design-language-doc.test.ts` が実装値と両方向で照合する。
文書と実装がずれたまま CI が緑になることはない。

---

## 1. この文書の位置づけ

正典は 3 層に分かれている。食い違いを見つけたら、上の層が正しい。

| 層 | 実体 | 役割 |
|---|---|---|
| 値の正典 | `ts/packages/design-tokens/src/` と `ts/packages/ui/src/theme.css`、およびそれを守るテスト | 唯一の真 |
| 読む面 | 本文書 | 人間とエージェントが読む |
| 判断の記録 | `.kiro/specs/ui-airbnb-foundation/design.md` の D1〜D8 | なぜそう決めたかの審議 |

本文書に無いもの。原典の逐語コピー（`docs/design/upstream/airbnb-DESIGN.md` にある）、
面ごとの画面設計（後続 spec `ui-airbnb-surfaces` が扱う）、LINE Flex Message の配色
（LINE アプリ自身の配色の中で成立させるため現行を維持し、意匠差し替えの対象外とした）。

---

## 2. 色

### 2.1 役割と値

役割名は `@fwlm/design-tokens` の `ColorTokens` のキーである。`対白` は白背景に対する
WCAG 相対輝度によるコントラスト比で、`ts/packages/design-tokens/src/contrast.ts` の実装で
再計算した値を小数第 3 位まで書く。

| 役割 | 値 | 対白 | 出典の色 | 用途と制約 |
|---|---|---|---|---|
| `brand` | `#FF385C` | 3.516 | `primary`（Rausch） | 装飾・アイコン・大テキスト専用。文字にも、文字を載せる面にも使わない |
| `primary` | `#E00B41` | 4.891 | `primary-active` | アクション面。これ以上明るい色をアクション面に置けない下限 |
| `primaryHover` | `#B30934` | 6.987 | 原典になし | `primary` の各成分を 0.8 倍した確定値。hover は暗くする方向で作る |
| `primaryForeground` | `#FFFFFF` | 1.000 | `on-primary` | アクション面に載る文字と印 |
| `text` | `#222222` | 15.910 | `ink` | 本文・見出し・フォーカス輪郭。純黒を使わないのは原典の方針をそのまま採った |
| `textBody` | `#3F3F3F` | 10.531 | `body` | 長文でインクが重すぎる場面 |
| `textMuted` | `#6A6A6A` | 5.409 | `muted` | 補足・説明文。淡い面の上でも AA を保つ |
| `background` | `#FFFFFF` | 1.000 | `canvas` | ページとカードの既定の面 |
| `surfaceSoft` | `#F7F7F7` | 1.071 | `surface-soft` | 無効な記入欄・ミュート面 |
| `surfaceStrong` | `#F2F2F2` | 1.119 | `surface-strong` | 副次ボタン・円形アイコンボタンの面 |
| `success` | `#15803D` | 5.016 | 原典になし | 成功通知。原典に対応色が無い唯一の役割で、意匠差し替え前のアクション色を横滑りさせた |
| `destructive` | `#B32505` | 6.596 | `primary-error-text-hover` | 危険通知。原典のエラー族の暗い方を採った |
| `destructiveForeground` | `#FFFFFF` | 1.000 | `on-primary` | 危険色の面に載る文字 |
| `border` | `#DDDDDD` | 1.358 | `hairline` | 区切り線・カード罫線。純装飾であり SC 1.4.11 の対象外 |
| `borderInteractive` | `#767676` | 4.542 | 原典になし | 記入欄と対話的部品の輪郭。SC 1.4.11 の 3:1 対象 |

LINE Flex Message 用の色集合（`lineColors`）は本表に含めない。非 Web コンテンツであり
WCAG の検証対象外で、値は現行の実装と同一に保つことが要件だからである。

### 2.2 アルファ合成後の実効コントラスト

コントラストは色単体ではなくペアの性質である。淡い面の上に同色の文字を載せる表現では、
判定すべきは単体の対白比ではなく合成後の実効色に対する比になる。

`判定` は 3 語のいずれかを取る。`AA` は SC 1.4.3 の 4.5:1 を満たすこと、`非テキスト` は
SC 1.4.11 の 3:1 を満たすこと、`既知の限界` は 4.5:1 を満たさないことを意味し、
いずれも検証が値から機械的に確かめる。

| 前景 | 前景 α | 面 | 面 α | 面の下 | 面の実効色 | 前景の実効色 | 比 | 判定 | 出典 |
|---|---|---|---|---|---|---|---|---|---|
| `destructive` | 1 | `destructive` | 0.1 | `background` | `#F7E9E6` | `#B32505` | 5.576 | AA | 危険通知の淡い面に載る同色の文字 |
| `destructive` | 1 | `destructive` | 0.2 | `background` | `#F0D3CD` | `#B32505` | 4.682 | AA | 同じ表現の重畳時 |
| `destructive` | 1 | `destructive` | 0.2 | `surfaceSoft` | `#E9CDC7` | `#B32505` | 4.404 | 既知の限界 | 淡い面の上に危険通知を重ねた場合。現状 3 面のページ背景は白なので発生しない |
| `destructive` | 0.6 | `background` | 1 | `background` | `#FFFFFF` | `#D17C69` | 3.089 | 非テキスト | 選択済みの面をアクション色で塗る部品のエラーリング |
| `destructive` | 1 | `primary` | 1 | `background` | `#E00B41` | `#B32505` | 1.349 | 既知の限界 | アクション色の面と危険色の枠。色では区別できない（§10） |
| `textMuted` | 1 | `surfaceSoft` | 1 | `background` | `#F7F7F7` | `#6A6A6A` | 5.049 | AA | 淡い面の上の説明文 |
| `textMuted` | 1 | `surfaceStrong` | 1 | `background` | `#F2F2F2` | `#6A6A6A` | 4.831 | AA | 副次面の上の説明文 |
| `success` | 1 | `surfaceStrong` | 1 | `background` | `#F2F2F2` | `#15803D` | 4.480 | 既知の限界 | 副次面の上の成功文言。現行部品では到達しない（§10） |
| `primary` | 1 | `surfaceStrong` | 1 | `background` | `#F2F2F2` | `#E00B41` | 4.369 | 既知の限界 | 副次面の上のリンク。現行部品では到達しない（§10） |

### 2.3 採らなかった原典の色

いずれも閾値に届かないという理由で落としている。`測定条件` が `素` の行は白背景に対する比、
`` `/20` 面上 `` の行はその色を不透明度 0.2 で白へ合成した面の上に同色の文字を置いた比である。

| 原典の色 | 値 | 測定条件 | 実測 | 閾値 | 不採用の理由 |
|---|---|---|---|---|---|
| muted-soft | `#929292` | 素 | 3.112 | 4.5 | 無効リンク色という役割が現行に無く、無効表現は不透明度が担う |
| legal-link | `#428BFF` | 素 | 3.297 | 4.5 | リンク色はアクション色へ一本化する |
| border-strong | `#C1C1C1` | 素 | 1.800 | 3 | SC 1.4.11 の 3:1 に届かない。現行の識別用の枠色を維持する |
| primary-disabled | `#FFD1DA` | 素 | 1.365 | 4.5 | 無効化は WCAG の対象外であり、現行の不透明度で足りる |
| primary-error-text | `#C13515` | `/20` 面上 | 4.077 | 4.5 | 淡い面の上に同色の文字を載せる表現で AA を割る。エラー族の暗い方を採った |
| hairline-soft | `#EBEBEB` | 素 | 1.192 | 3 | 第 2 の罫線役割が現行に無い |

閾値では落とせないが採らなかった色もある。`luxe` と `plus` はサブブランドの色であり、
`scrim` は覆い面の色でモーダルを導入していない現状には対応する役割が無い。
これらは数値ではなく役割の不在で落としているので、上の表には入れない。

### 2.4 色の構造規律

**ブランド色とアクション色を分ける。** ブランド色は白文字と 3.516:1 で AA に届かないため、
装飾・アイコン・大テキスト専用に降格してある。アクション面と文字にはアクション色を使う。

**hover は暗くする方向で作る。** `/80` のようなアルファ合成は白背景では合成後が明るくなり、
ホバーしたときにだけ AA を割る。各成分を定数倍した確定値をトークンとして持つ。

**成功色をアクション色と共有しない。** 共有していると、アクション色を暖色へ変えた瞬間に
成功通知が危険通知と同系色になる。これは色相の変化であって輝度の変化ではないため、
コントラスト比を見るどのガードにも掛からず CI が全緑のまま通る。

**フォーカス輪郭はアクション色を参照しない。** 輪郭の色は本文色であり、白面に対して 15.910:1 を持つ。
`outline-offset` を 0 にすると「隣接色は親の背景である」という推論が成立しなくなるため、
0 にする変更は輪郭の色の再検証を伴う。

---

## 3. 余白

原典の 9 段はいずれも Tailwind の数値スケール（基数 0.25rem）で余りなく表現できる。
これが「`@theme` に余白の名前付きキーを宣言しない」という規約を守ったまま原典の余白律を採れる根拠である。

| 出典の段 | 値 | 倍率 | クラス例 | px |
|---|---|---|---|---|
| `xxs` | `0.125rem` | ×0.5 | `p-0.5` | 2 |
| `xs` | `0.25rem` | ×1 | `p-1` | 4 |
| `sm` | `0.5rem` | ×2 | `p-2` | 8 |
| `md` | `0.75rem` | ×3 | `p-3` | 12 |
| `base` | `1rem` | ×4 | `p-4` | 16 |
| `lg` | `1.5rem` | ×6 | `p-6` | 24 |
| `xl` | `2rem` | ×8 | `p-8` | 32 |
| `xxl` | `3rem` | ×12 | `p-12` | 48 |
| `section` | `4rem` | ×16 | `p-16` | 64 |

**`@theme` へは宣言しない。** 名前付きキーを宣言すると、幅・最大幅・最小幅・フレックス基準幅の
解決先が既定のコンテナ寸法スケールから余白スケールへ覆われ、画面が壊れたままビルドが通る。
CSS では数値スケールで指定し、上の表は LINE Flex Message など CSS を経由しない消費先へ値を提供する。

意匠差し替えに伴い `md` の意味が `1rem` から `0.75rem` へ移り、`1rem` は新しいキー `base` になった。

---

## 4. 角丸

**スケールの段そのものを上書きしない。** 原典の形は既存の段への役割割当だけで表す。
一部の段だけを独自値へ上書きすると、上書きしなかった隣の段と同値になるか順序が逆転する。
重複の検出は同値しか見ないため、逆転は検出されないまま画面へ出る。

| 段 | 値 | クラス | 使用部品 | 出典の段 |
|---|---|---|---|---|
| `sm` | `0.25rem` | `rounded-sm` | （なし） | xs（4px・一致） |
| `md` | `0.375rem` | `rounded-md` | `button.tsx` | 対応段なし |
| `lg` | `0.5rem` | `rounded-lg` | `alert.tsx`, `button.tsx`, `field.tsx`, `input.tsx`, `textarea.tsx` | sm（8px・一致） |
| `xl` | `0.75rem` | `rounded-xl` | `card.tsx` | md（14px・2px の差を受容） |
| `4xl` | `2rem` | `rounded-4xl` | `badge.tsx` | xl（32px・一致） |
| `full` | `9999px` | `rounded-full` | `radio-group.tsx` | full（一致） |

原典の lg（20px）に対応する段は置いていない。消費する部品が 1 つも無いためである。

---

## 5. 影

| 段 | 値 | 用途 |
|---|---|---|
| `raised` | `0 0 0 1px #00000005, 0 2px 6px 0 #0000000A, 0 4px 8px 0 #0000001A` | 浮いた面。原典が持つ唯一の影の定義をそのまま採った |

**面の分離は影ではなく輪郭と余白が担う。** 原典は影を 1 つしか持たず、深さは写真と角丸の
クリッピングで表現する。この設計思想に倣い、カード相当の面は `ring-1` の輪郭で分離する。

名前を無印にしないのは、無印が Tailwind 既定のユーティリティ名と同名になり、
上書きすると既定クラスの意味が静かに変わるためである。名前付きの段は加算的で曖昧さがない。

---

## 6. 見出し階層

素のタグに与える既定と、共通部品 `Heading` の既定は同じ段を指していなければならない。
同じ見出しレベルが、素のタグで書いたか部品で書いたかによって別の大きさで描かれるのを防ぐためである。

| タグ | サイズ段 | 実寸 | 太さ | 行間 | Heading の既定 |
|---|---|---|---|---|---|
| `h1` | `2xl` | `1.5rem` | 700 | 1.25 | `2xl` |
| `h2` | `xl` | `1.25rem` | 600 | 1.25 | `xl` |
| `h3` | `lg` | `1.125rem` | 600 | 1.375 | `lg` |
| `h4` | `base` | `1rem` | 600 | 1.375 | `base` |
| `h5` | `sm` | `0.875rem` | 600 | 1.5 | `sm` |
| `h6` | `xs` | `0.75rem` | 600 | 1.5 | `xs` |

行間の値は Tailwind の `leading-tight` / `leading-snug` / `leading-normal` と厳密に一致させてある。
原典の行間（1.18〜1.20）まで詰めないのは、日本語の全角字形が上下の余りを持たず、
折り返したときに窮屈になるためである。

文字サイズの段は次のとおりで、原典の 8px / 11px / 13px の段は採っていない（日本語字形で判読性に難がある）。

| 段 | 値 | クラス | px |
|---|---|---|---|
| `xs` | `0.75rem` | `text-xs` | 12 |
| `sm` | `0.875rem` | `text-sm` | 14 |
| `base` | `1rem` | `text-base` | 16 |
| `lg` | `1.125rem` | `text-lg` | 18 |
| `xl` | `1.25rem` | `text-xl` | 20 |
| `2xl` | `1.5rem` | `text-2xl` | 24 |

フォントはシステム日本語スタックを使う。原典のフォントは商用ライセンスであり、
原典が代替として挙げる書体は日本語字形を持たない。

```
system-ui, -apple-system, "Segoe UI", Roboto, "Hiragino Kaku Gothic ProN", "Hiragino Sans", Meiryo, sans-serif
```

---

## 7. 面適用で共有する 7 つの設計判断

**本節が 7 判断の正典である。** 後続 spec `ui-airbnb-surfaces` が作られたら、その design.md は
本節へリンクし、結論も数値も転記しない。転記は必ず古びる。由来欄が Issue を指している項目は、
spec 側に審議の記録ができた時点で由来欄だけを差し替え、結論の本文はここから動かさない。

### 7.1 星は ink で描く

**星評価は本文色で描く。** 原典が星をインクで描き黄色や琥珀を使わないのはブランド判断であり、
黄色い星は旅行文脈で安っぽく見えるという理由が原典自身に明記されている。加えて、
意匠差し替え後のアクション色は赤であり、満足度評価が赤い星になる。琥珀色は生パレット色クラスとして
`scripts/check-design-tokens.sh` が落とす。未選択は罫線色、選択済みは本文色で追加トークンはゼロ。
アフォーダンスはタップ領域と字形差と必須表示で補償する。
由来: [#41](https://github.com/ManatoYamashita/fw-line-meo/issues/41)

### 7.2 テーブルは表のまま装飾する

**行・列・セルの支援技術上の役割を保ったまま意匠を適用し、カードリスト化しない。**
容器の側がカード化を担い、面の分離は輪郭で表す。セル余白は原典の 16px、見出し行はやや詰める。
行区切りは 1px の罫線のみで、縞模様は使わない（原典は一切使わない）。
行の重畳時の面塗りは付けない。行自体が押せないため、誤った可動感を与えるからである。
由来: [#41](https://github.com/ManatoYamashita/fw-line-meo/issues/41)

### 7.3 巨大表示はプロダクト全体で 1 箇所

**64px の巨大な数値表示は store-detail の順位数値ただ 1 箇所に限る。**
原典が「システム唯一の大声」と呼ぶものを、プロダクト全体を通して守る。
客向けアンケートでは集計値を見せる対象が無いため、この段は使わない。
由来: [#41](https://github.com/ManatoYamashita/fw-line-meo/issues/41)

### 7.4 ブランド色は 1 画面 1〜2 箇所まで

**ブランド色の使用は top-nav と login のワードマークに限る。**
原典の構成は「白 90% とインク、そこへアクセントを 1〜2 箇所」であり、原典自身もワードマークだけが
ブランド色である。装飾専用トークンの唯一の正しい使い所がここになる。
由来: [#41](https://github.com/ManatoYamashita/fw-line-meo/issues/41)

### 7.5 overlay 系を新規ベンダリングしない

**Dialog / Popover / Select / Tooltip / Tabs / Toast は 4 面すべてで使わない。**
結果として基盤ライブラリの新規ベンダリングはゼロになり、バンドル予算への影響もゼロになる。
4 面それぞれの理由（QR の行直下パネル方式・選択部品の操作方法・store-detail の構造契約）は
`.kiro/specs/ui-airbnb-foundation/design.md` の D6 にある。
由来: 同 D6

### 7.6 写真前提の意匠は採らない

**写真プレートを前提にしたカードは真似しない。** 店舗検索の応答に写真は含まれず、
写真前提のカードを写真なしで真似ると空の灰色矩形が並ぶだけで劣化する。
借りるのは「タイトル・補足・右端の指示子」というメタの積み方だけにする。
由来: [#41](https://github.com/ManatoYamashita/fw-line-meo/issues/41)

### 7.7 前日比は色ではなく矢印

**増減は上下の矢印で示し、色で示さない。** 緑を上昇・赤を下降に割り当てると新しいトークンを
要求することになり、暖色一色のパレットとも衝突する。
由来: [#41](https://github.com/ManatoYamashita/fw-line-meo/issues/41)

---

## 8. 面を組む前に読む構造契約

ここに並ぶのは意匠ではなく制約である。**正典はテストそのもの**であり、下の表はその所在を示す索引にすぎない。
行番号は書かない。次のコミットで腐るうえ、腐ったことを誰も検出できないからである。

| 契約 | 出典（テストファイル） |
|---|---|
| store-detail は記入欄・押しボタン・選択のいずれも描画しない | `ts/apps/store-detail/test/store-page.test.tsx` |
| store-detail の複数店舗表示でリンクがちょうど 1 件 | `ts/apps/store-detail/test/store-page.test.tsx` |
| store-detail の第 1 見出しは店名の完全一致 | `ts/apps/store-detail/test/store-page.test.tsx` |
| ダッシュボードの選択はプログラムによる値変更で操作される | `ts/apps/dashboard-web/test/admin-users-page.test.tsx` |
| 一覧はセル役割と行要素で掴まれるため、カード化できない | `ts/apps/dashboard-web/test/admin-users-page.test.tsx`, `ts/apps/dashboard-web/test/stores-page.test.tsx` |
| 星は押しボタン役割と押下状態で掴まれる | `ts/apps/survey-web/test/survey-form.test.tsx` |
| LINE のメッセージ組立は本文要素の添字で検証される | `ts/apps/line-webhook/test/line/messages.test.ts` |
| Flex の構造はスナップショットが固定する | `ts/apps/delivery-job/test/flex.test.ts` |
| 部品固有のユーティリティをアプリ層に literal で書くと別パッケージのテストが落ちる | `ts/packages/ui/test/app-integration.test.ts` |

---

## 9. 部品

`@fwlm/ui` が提供する部品と、その公開名。部品を追加したときは
`ts/apps/survey-web/src/app/ui-check/page.tsx` にも追加する。この面が部品ソースの唯一のコンパイル経路である。

| ファイル | export | 役割 |
|---|---|---|
| `alert.tsx` | `Alert`, `AlertAction`, `AlertDescription`, `AlertTitle` | 通知（既定・成功・危険） |
| `badge.tsx` | `Badge`, `badgeVariants` | 状態ラベル |
| `button.tsx` | `Button`, `buttonVariants` | 押しボタン |
| `card.tsx` | `Card`, `CardAction`, `CardContent`, `CardDescription`, `CardFooter`, `CardHeader`, `CardTitle` | 情報の容器 |
| `checkbox.tsx` | `Checkbox` | 複数選択 |
| `field.tsx` | `Field`, `FieldContent`, `FieldDescription`, `FieldError`, `FieldGroup`, `FieldLabel`, `FieldLegend`, `FieldSeparator`, `FieldSet`, `FieldTitle` | フォームの構造と検証状態 |
| `heading.tsx` | `DEFAULT_SIZE_BY_LEVEL`, `Heading`, `headingVariants` | 見出し階層 |
| `input.tsx` | `Input` | 単一行入力 |
| `label.tsx` | `Label` | 記入欄の見出し |
| `radio-group.tsx` | `RadioGroup`, `RadioGroupItem` | 単一選択 |
| `separator.tsx` | `Separator` | 区切り線 |
| `spinner.tsx` | `Spinner` | 処理中の表示 |
| `textarea.tsx` | `Textarea` | 複数行入力 |

---

## 10. Known Gaps

**原典の「display の太さを控えめに保つ」は再現できない。** システム日本語フォントは実質 400 と 700 の
2 段しか持たず、中間の太さは近い方へスナップする。意匠として再現不能であり、
Web フォントを採るなら唯一の実質的な動機になる。

**アクション色と危険色は色では区別できない。** 原典のパレットは暖色一色であり、両者の色相差は
約 14 度、相互コントラストは §2.2 の表のとおり 1.349 しかない。差し替え前の緑と赤の組でも
相互比は近い値だったので、両者を分けていたのは輝度ではなく色相であり、その色相差が失われた。
成功色に入れた色相分離の不変条件はここへ適用できない（危険色を暖色から外すと危険に読まれなくなる）。
実害が出るのは選択済みの面をアクション色で塗る部品だけで、面が透明な部品はエラー時に枠色が
中立の灰から赤へ変わるため枠が信号を運べる。前者では枠が運べないため、エラーリングの不透明度を
SC 1.4.11 を満たす段まで引き上げてある。

**副次面の上のアクション色と成功色は AA に届かない。** §2.2 の該当 2 行が示すとおり
4.5:1 を下回る。現行の部品にこの組み合わせは存在しないが、副次面の上に文字色として
これらを置く構成を採るなら再検証が要る。

**淡い面の上の危険通知は AA を割る。** §2.2 の該当行のとおりで、現状 3 面のページ背景は
いずれも白なのでこの重なりは発生しない。

**文字サイズには「トークンから生成 CSS へ」の突き合わせが存在しない。** 名前空間の網羅ガードは
theme.css の宣言側しか見ないため、アプリ層がトークンに無い段を使っても赤くならない。
唯一の例外は `@layer base` の見出しが使う段で、これはトークン参照であることと実寸があることの
両方を要求される。

---

## 11. 関連ドキュメント

| 文書 | 役割 |
|---|---|
| `docs/design/upstream/README.md` | 原典の取得記録とライセンス、採らなかったものの要約 |
| `.kiro/specs/ui-airbnb-foundation/design.md` | 判断の審議（D1〜D8）・Known Gaps・Revalidation Triggers |
| `.kiro/steering/design-tokens.md` | 忘れると壊れる規律だけを抜いた常時参照用の要約 |
| `docs/architecture.md` | サービス構成とフローの俯瞰 |

### 各行を守っているガード

本文書の値は次の検証が守っている。`アンカー` はそのファイル内の describe または it の
タイトルに含まれる語で、検査が改名または削除されたときに赤くなる。

| 守る対象 | ガード | アンカー |
|---|---|---|
| 色役割・不採用色・余白・角丸・影・タイポ・見出し・実効コントラスト・部品 | `ts/packages/ui/test/design-language-doc.test.ts` | 抽出器の自己検証 |
| theme.css と意味役割の厳密一致 | `ts/packages/ui/test/theme-sync.test.ts` | 意味役割 ↔ @theme 変数の厳密一致 |
| 部品が使う色の実効コントラスト | `ts/packages/ui/test/contrast-usage.test.ts` | アルファ合成後の実効コントラスト |
| 選択済みの面をアクション色で塗る部品のエラー指標 | `ts/packages/ui/test/contrast-usage.test.ts` | 選択済みの面をアクション色で塗る部品のエラー指標 |
| フォーカス輪郭の隣接コントラスト | `ts/packages/ui/test/contrast-usage.test.ts` | フォーカス指標の色の隣接コントラスト |
| 名前付き余白キーの不在と角丸の段の重複 | `ts/packages/ui/test/token-scales.test.ts` | 角丸の段差とトークン対応 |
| 見出しの実コンパイル結果の一致 | `ts/packages/ui/test/app-integration.test.ts` | 見出しのサイズ階層 |
| 色の役割分離とコントラストの下限 | `ts/packages/design-tokens/test/colors.test.ts` | 成功と危険の識別 |
| 直書き hex と生パレット色クラスの混入 | `scripts/check-design-tokens.sh` | （シェルガード） |
