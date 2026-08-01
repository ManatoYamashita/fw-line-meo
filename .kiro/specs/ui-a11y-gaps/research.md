# Gap Analysis — ui-a11y-gaps

対象: `.kiro/specs/ui-a11y-gaps/requirements.md`（要件 6 件 / AC 27 件）
実施日: 2026-07-30 / 調査時 HEAD: `aee7b4d`（PR #58 merge 済み）

本書は要件と既存コードベースの差分を示し、design フェーズの判断材料を提供する。**決定は行わず、選択肢とトレードオフを提示する。**

---

## 1. 現状調査（Current State）

### 1.1 対象資産の所在

| 資産 | 場所 | 本 spec との関係 |
|---|---|---|
| 共通部品 13 個 | `ts/packages/ui/src/components/*.tsx` | 変更対象 |
| テーマ・レイヤ定義 | `ts/packages/ui/src/theme.css`（`@theme` / `@theme inline` / `@layer base`） | 変更対象の候補 |
| jsdom 部品テスト | `ts/packages/ui/test/components.test.tsx` | role 出し分けの検証に再利用可 |
| 実コンパイル + AST 検証 | `ts/packages/ui/test/app-integration.test.ts` | 生成 CSS の検証に再利用可 |
| コントラスト検証 | `ts/packages/ui/test/contrast-usage.test.ts` | 非後退（要件 6-3）の既存資産 |
| 実描画 E2E | `ts/apps/survey-web/e2e/ui-foundation.spec.ts` | 動き・タッチ領域の実測に再利用可 |
| E2E 専用検証面 | `ts/apps/survey-web/src/app/ui-check/page.tsx` | **PR #58 で全 13 部品を描画するよう拡張済み** |

### 1.2 既存の作法（踏襲すべき規約）

- **フォーカス指標は `theme.css` の `@layer base` に一本化**し、部品側では宣言しない（#49 の是正）。部品側で個別に a11y 指標を持たせない方針が既に確立している。
- **ガードは「是正前に赤化することを実証してから」導入する**（#48 → PR #56 で踏襲）。要件 5-6 はこの運用の明文化にあたる。
- **検証表と実装は双方向で突き合わせる**（`theme-sync.test.ts` の役割対応表、`contrast-usage.test.ts` の網羅ガード）。未分類を必ず赤化させる（要件 5-4 と同型）。
- **意味論トークン経由のみ**。`scripts/check-design-tokens.sh` が `src` 配下の生 hex をコメント内も含めて検出する。
- jsdom は Tailwind を解決しないため、**視覚状態はクラス・属性の存在で検証し、実描画は E2E で測る**（`components.test.tsx:15-17` に明記）。

### 1.3 実測（2026-07-30・Chromium / Pixel 5 プロファイル）

**動きの棚卸し** — 動きを持つのは `@fwlm/ui` のみ。`ts/apps/*/src` に `animate-*` / `transition-*` / `@keyframes` は **0 件**。

| 部品 | 動きの指定 |
|---|---|
| `spinner.tsx:16` | `animate-spin`（**無限**） |
| `button.tsx:23` / `badge.tsx` | `transition-all` |
| `input.tsx` / `textarea.tsx` / `checkbox.tsx` | `transition-colors` |
| `checkbox.tsx:23`（Indicator） | `transition-none` |
| `button.tsx:23` | `active:not-aria-[haspopup]:translate-y-px` |

生成 CSS 中の `prefers-reduced-motion` 出現数: **0**。

**タッチ領域** — `getBoundingClientRect` と `::after` の実効 inset から算出。

| 部品 | 視覚寸法 | 実効タッチ領域 | 要件 4-1（44px）に対して |
|---|---|---|---|
| Button（`default` / 各 variant） | 高さ 32px | **32px**（`::after` なし） | 高さ 12px 不足 |
| Input | 高さ 32px | **32px**（`::after` なし） | 高さ 12px 不足 |
| Textarea | 高さ 138px | 138px | 充足 |
| Checkbox | 16×16 | **40×32**（※実装時の再実測で **38×30** に訂正。枠線 1px 分の見落とし） | **不足** |
| RadioGroupItem | 16×16 | **40×32**（※同上・**38×30**） | **不足** |

> **Issue #52 の前提の訂正**: Issue は「Checkbox / RadioGroup は `after:-inset-x-3 after:-inset-y-2` でタッチ領域を拡大済み」とし、Button にだけ配慮が無いと述べている。拡大自体は事実だが、**実効値は 40×32 であり 44px には届いていない**。要件 4-6（既に要求寸法以上なら維持）が適用される部品は現状 Textarea のみである。

隣接ボタンの縦間隔（`/ui-check` の `gap-4`）: **16px**。Button を上下 +6px 拡張しても合計 12px で、この配置では重ならない。

---

## 2. 要件充足性の分析（Feasibility）

### 2.1 要件 → 資産マップ

| 要件 | 必要な能力 | 既存資産 | 判定 |
|---|---|---|---|
| 1（動きの抑制） | 動き低減設定下でアニメーション・遷移を止める | Tailwind v4 標準の `motion-safe:` / `motion-reduce:` バリアント、`theme.css` の `@layer base` | **Missing**（実装ゼロ・手段は揃っている） |
| 1-4（到達する見た目の同一性） | 抑制後も最終状態が同じ | — | **Missing**（検証手段の設計が必要） |
| 2（処理中の伝達） | 動きに依存しない処理中表現 | `spinner.tsx` の `role="status"` + 上書き可能な `aria-label` | **Missing**（代替の視覚表現が無い） |
| 3（読み上げ強度） | variant ごとの role 出し分け | `alert.tsx:46` が `role="alert"` 固定。`spinner.tsx` に「既定 + 上書き可」の先例あり | **Missing**（出し分けが無い） |
| 4-1/4-2（操作領域） | 既定寸法 44px / 縮小寸法 24px | `checkbox.tsx` / `radio-group.tsx` の `::after` 拡張作法 | **Missing**（作法はあるが値が不足・Button/Input に未適用） |
| 4-3/4-4（見た目・レイアウト不変） | 拡張が寸法と周囲に影響しない | `::after` + `position: absolute` は既にこの性質を満たす | **充足可**（作法の流用） |
| 4-5（重なり時の挙動） | 意図した部品のみ反応 | — | **Unknown**（検証手段が未確立・後述） |
| 5-1（動きの検証） | 動き低減設定下の実測 | **Playwright 1.61.1 が `reducedMotion` を標準サポート**（`test.use({ reducedMotion: 'reduce' })`） | **充足可** |
| 5-2（role の検証） | variant ごとの属性検証 | `components.test.tsx`（jsdom・属性は検証可能） | **充足可** |
| 5-3/5-4（寸法の検証・未分類の検出） | 実描画での領域測定と分類の網羅 | E2E の `getBoundingClientRect` 実測、`contrast-usage.test.ts` の双方向網羅ガード | **充足可**（前提条件あり・後述） |
| 5-5（新規の動きの混入検出） | ソース走査 + 分類強制 | `contrast-usage.test.ts` の抽出器＋双方向照合の型 | **充足可** |
| 6（非後退） | フォーカス・ARIA・コントラスト・性能 | `app-integration.test.ts`（focus-visible の AST 検証）、`contrast-usage.test.ts`、`perf:budget` | **充足** |

### 2.2 制約（Constraint）

**C1. カスケードレイヤの順序**
`@layer base` に置いた規則は `@layer utilities` の部品側ユーティリティに **詳細度と無関係に負ける**（#49 の根本原因）。`animate-spin` / `transition-*` は utilities に生成されるため、素朴に `@layer base` へ抑制を書いても効かない。

ただし **`!important` 宣言ではレイヤの優先順位が逆転する**（CSS Cascade Layers 仕様）。すなわち `@layer base` 内の `!important` は `@layer utilities` の通常宣言に勝つ。Issue #52 の案1 が動作する根拠はここにあり、**design はこの理由を明示的に記録すべき**である（「なぜ `!important` が必要か」を書かないと、次の担当者が善意で外して無言で壊れる）。

**C2. `<input>` / `<textarea>` に疑似要素が使えない**
Chromium は `<input>` に `::before` / `::after` を生成しない。Checkbox で使っている `::after` 方式は **Button（通常要素）には適用できるが Input には適用できない**。要件 4-1 は「操作可能部品」を対象とするため、Input（高さ 32px）の扱いに別手段が要る。→ **Research Needed（R-3）**

**C3. 検証面のコンテナ幅が壊れている**
`/ui-check` の `main` は `max-w-md` を持つが、実測の `max-width` は **16px**（`main` の実幅 32px）。`theme.css` が `@theme` で定義する `--spacing-md: 1rem` が Tailwind 既定の `--container-md`（28rem）を覆い、`max-w-md` が spacing スケールへ解決されているため。

- **本番影響なし**: リポジトリ全体で `max-w-*` / `min-w-*` の名前付きキー使用は **`/ui-check` の 1 箇所のみ**。客向け 3 面は未使用。
- ただし **タッチ領域の実測は幅 32px のコンテナ上では意味を持たない**（隣接・折り返し・重なりの条件が実際の面と乖離する）。要件 4-5 の検証は正しい幅の面が前提。
- これは **Issue #54（`--radius-lg` が Tailwind 既定の `--radius-xl` と衝突）と同型**の「トークン上書きが既定スケールを覆う」問題であり、#54 のスコープに属する。本 spec としては**前提条件**として扱う（先に直すか、検証面のコンテナを別手段で幅指定するか）。

**C4. 必須ステータスチェックとの整合**
main は ruleset（id `19986074`）で保護されており、必須チェックは `lint-build-test` / `e2e` / `lighthouse` / `docker-build (…)×7` の **10 個を明示列挙**している。本 spec の検証を**新しいジョブ**として足す場合は ruleset の更新が必要（既存ジョブ内のステップとして足す場合は不要）。

**C5. 観測面の限定**
`Spinner` と `Alert` は **アプリの本番導線では未使用**（`/ui-check` のみで描画）。したがって要件 2・3 の変更に後方互換上のリスクはほぼ無い一方、**実利用は #44 以降**に発生する。今のうちに決めておく価値は高いが、実運用でのフィードバックは得られない。

### 2.3 複雑度シグナル

- 要件 1・2・3: 単純な CSS / 属性の変更。アルゴリズムも外部連携も無い。
- 要件 4: 幾何の問題。**実描画でのみ確定**するため検証コストが要件本体より高い。
- 要件 5: 既存ガード群の型を踏襲した追加。パターンは確立済み。

---

## 3. 実装アプローチの選択肢

### Option A: 既存資産の拡張に寄せる

**対象**: `theme.css`（`@layer base` に動き抑制ブロック）／`alert.tsx`（variant → role マップ）／`button.tsx`・`checkbox.tsx`・`radio-group.tsx`（`::after` の inset 値を調整）／既存 3 テストファイルへ追記。

- ✅ 新規ファイルゼロ。#49 で確立した「アプリ DOM を触らず `theme.css` で全面を直す」方針と一貫
- ✅ `::after` 拡張は Checkbox で実績のある作法（見た目・レイアウト不変が保証済み）
- ✅ 動きの抑制が 1 箇所に集約され、将来アプリ側が動きを追加しても自動的に対象になる
- ❌ `theme.css` の `@layer base` が肥大する（現状 `border-color` / 見出し / `isolation` / `:focus-visible` に加えて 5 つ目の責務）
- ❌ `!important` の多用が入る。理由をコメントで固定しないと後続に外される（C1）
- ❌ Input の 44px 問題（C2）は `::after` では解けず、この Option 単独では要件 4-1 を満たせない

### Option B: 新規に切り出す

**対象**: 動き抑制専用の CSS モジュール（`motion.css` 等）を新設し `theme.css` から取り込む／タッチ領域拡張を専用ユーティリティ（`touch-target` 相当）として定義／`a11y.test.ts`・`e2e/ui-a11y.spec.ts` を新設。

- ✅ 責務が明確に分離され、`theme.css` の肥大を避けられる
- ✅ 動き・タッチ領域それぞれの検証が独立したファイルに閉じ、レビューしやすい
- ✅ 「タッチ領域を持つ部品」という概念が明示的な単位になり、要件 5-4（未分類の検出）を素直に書ける
- ❌ ファイルが増え、`@fwlm/ui` の「theme.css 1 枚 + 部品」という現在の単純な構造が崩れる
- ❌ CSS の取り込み順・レイヤ所属を新たに管理する必要があり、C1 の罠を再生産しうる
- ❌ E2E を新規 spec ファイルにすると、`/ui-check` への `page.goto` と巡回ロジックが既存 spec と重複する

### Option C: ハイブリッド（推奨候補）

| 対象 | 方針 |
|---|---|
| 動きの抑制（要件 1） | **A**: `theme.css` の `@layer base` にグローバル抑制（`!important` の理由をコメントで固定） |
| Spinner の代替表現（要件 2） | **B**: 部品側で `motion-reduce:` バリアントによる個別の代替表現を持たせる |
| Alert の role（要件 3） | **A**: `alert.tsx` を variant → role の対応で拡張（`spinner.tsx` の「既定 + 上書き可」の先例に揃える） |
| Button / Checkbox / Radio の領域（要件 4） | **A**: 既存 `::after` 作法の inset 値を要求寸法へ調整し Button へ展開 |
| Input の領域（要件 4） | **Research Needed**（C2）— 別手段の決定が要る |
| 検証（要件 5） | **A + B**: jsdom の role 検証は `components.test.tsx` へ追記、生成 CSS の検証は `app-integration.test.ts` へ追記、**動き・寸法の実測 E2E は既存 `ui-foundation.spec.ts` へ追記**（`/ui-check` への遷移とヘルパを共有できるため新設しない） |

- ✅ 既存の作法・ファイル構成を保ちつつ、責務が明確に異なる部分だけ切り出す
- ✅ 検証は既存 E2E に寄せることで `/ui-check` の遷移・ヘルパ（`readFocusIndicator` / `readRenderedColors`）を再利用できる
- ❌ 「どこに書くか」の判断が項目ごとに分かれるため、design で明文化しないと一貫性を失う

---

## 4. 工数・リスク

| 要件 | 工数 | リスク | 根拠 |
|---|---|---|---|
| 1（動きの抑制） | **S** | **中** | CSS 追加のみだが、C1（レイヤ順と `!important`）を誤ると無言で効かない。実測での確認が必須 |
| 2（処理中の伝達） | **S** | 低 | 部品 1 個の局所変更。代替表現の意匠決定が主 |
| 3（読み上げ強度） | **S** | 低 | 属性の出し分けのみ。先例（`spinner.tsx`）あり。本番未使用のため後方互換リスクも小 |
| 4（タッチ領域） | **M** | **高** | Input への適用手段が未確定（C2）。実測には正しい幅のコンテナが要る（C3）。重なり検証の手段も未確立 |
| 5（自動検証） | **M** | 中 | パターンは確立済みだが、実描画での寸法測定と「未分類の検出」を両立させる設計が要る |
| 6（非後退） | **S** | 低 | 既存ガードがそのまま効く |

**全体: M（3〜7 日）／リスク 中**。要件 4 が単独で全体のリスクを押し上げている。

---

## 5. Research Needed（design フェーズへ持ち越す調査項目）

| ID | 項目 | なぜ必要か |
|---|---|---|
| **R-1** | 動き抑制を `@layer base` の `!important` で行った場合に、`animate-spin` / `transition-*` / `translate-y-px` が実描画で確実に止まるか | C1。仕様上は勝つはずだが、#49 の前例があるため実測で確認する |
| **R-2** | 抑制後も要件 1-4（到達する見た目の同一性）が保たれるか。特に `translate-y-px`（押下時の沈み込み）を止めた場合の押下フィードバックの有無 | 動きを消すと「押した感」が失われ、別の使いやすさを損なう可能性 |
| **R-3** | `<input>` / `<textarea>` の操作領域を、視覚寸法を変えずに拡大する手段の有無 | C2。`::after` が使えない。ラベル側で受ける／`padding` で吸収する／視覚寸法の変更を許容する、等の比較が要る |
| **R-4** | 要件 4-5（重なり時に意図した部品のみ反応）の検証手段 | `document.elementFromPoint` による座標サンプリングが候補。実効性と実行時間を確認する |
| **R-5** | `/ui-check` のコンテナ幅（C3）を本 spec で直すか、#54 へ委ねるか | タッチ領域の実測の前提。#54 は「トークン上書きが既定スケールを覆う」問題群として同型 |
| **R-6** | 縮小寸法（`xs` / `sm` / `icon-xs` / `icon-sm`）が実際に使われる面と、24px 下限の充足状況 | 現状これらを使う面は無い。要件 4-2 の検証対象が空になると空振りガードになる |
| **R-7** | Spinner の代替表現の選択肢（静的アイコン＋文言／極低速化／別表現）と、光過敏への影響 | 点滅は避けるべき。要件 2-1 を満たす最小の表現を決める |

---

## 6. design フェーズへの推奨

1. **Option C（ハイブリッド）を起点に検討する。** 動きの抑制は集約、代替表現と検証は責務ごとに配置、E2E は既存 spec へ追記する形が、既存の作法を壊さず重複も避けられる。
2. **要件 4 を先に決着させる。** R-3（Input の手段）と R-5（検証面の幅）が未確定のまま他を進めると、後から全体の分割をやり直すことになる。要件 1〜3 は互いに独立で後回しにできる。
3. **`!important` の理由を実装に固定する。** C1 は「善意のリファクタで無言で壊れる」典型であり、#49 と同じ轍になる。コメントと、レイヤ所属を AST で検証するテスト（`app-integration.test.ts:115` の `rulesInLayer` と同型）の両方で守る。
4. **Issue #52 の前提の訂正を design に明記する。** Checkbox / Radio は「配慮済み」ではなく 40×32 であり、Button と同様に是正対象である。
5. **検証を新ジョブにしない。** 既存 `lint-build-test` / `e2e` ジョブ内で完結させれば、main の ruleset（C4）の更新が不要になる。

---

# Discovery & Synthesis — design フェーズ（2026-07-30）

## Summary

- **Feature**: `ui-a11y-gaps`
- **Discovery Scope**: Extension（既存 `@fwlm/ui` の拡張。新規外部依存なし）
- **Key Findings**:
  - `@layer base` 内の `!important` は `@layer utilities` の通常宣言に**実測で勝つ**。#49 の是正で問題になったレイヤ順は、`!important` を使う限り障害にならない。
  - 動きの抑制・reduced-motion のテスト・タッチ領域の拡張は、いずれも**既存の資産（プラットフォーム標準／Playwright 標準／リポジトリ内の先例）で賄える**。新規の抽象は不要。
  - `alert.tsx` は `role` を `{...props}` より前に置いているため、**呼び出し側による上書きは既に可能**。variant 別の既定値を与えるだけで要件 3 を満たせる（API 追加なし）。

## Research Log

### `@layer base` + `!important` による動き抑制の実効性（R-1）

- **Context**: Issue #52 の案1（グローバル抑制）は `@layer base` への配置を前提とするが、#49 では「`@layer base` の規則が `@layer utilities` に詳細度と無関係に負ける」ことが実害バグの原因になった。同じ構造で書くため、実効性を推論で済ませられない。
- **Sources Consulted**: Chromium 実測（Playwright 1.61.1 / `browser.newContext({ reducedMotion })`）。`@layer theme, base, components, utilities` の順序と `animate-spin` 相当・`transition-*` 相当を再現した最小ページ。
- **Findings**:

  | `reducedMotion` | `animation-duration` | `animation-iteration-count` | `transition-duration` |
  |---|---|---|---|
  | `no-preference` | `1s` | `infinite` | `0.15s` |
  | `reduce` | `1e-05s` | `1` | `1e-05s` |

- **Implications**: CSS Cascade Layers 仕様どおり、`!important` 宣言ではレイヤの優先順位が逆転し、先行レイヤ（base）が後続レイヤ（utilities）に勝つ。要件 1.1 / 1.2 はグローバル抑制 1 箇所で満たせる。要件 1.3（非後退）も `no-preference` 側の値が不変であることで確認済み。**`!important` は必須であり、外すと無言で機能しなくなる。**

### reduced-motion のテスト手段

- **Context**: 要件 5.1 は動き低減設定下での実測を要求する。
- **Findings**: Playwright 1.61.1 が `reducedMotion?: null | "reduce" | "no-preference"` を context / test オプションとして標準サポート（型定義で確認）。カスタムハーネスは不要。
- **Implications**: 既存 E2E（`ui-foundation.spec.ts`）に `test.use({ reducedMotion: 'reduce' })` のブロックを足すだけで足りる。

### Tailwind バリアントの可用性

- **Findings**: tailwindcss 4.3.3 が `motion-reduce` / `motion-safe` / `not-sr-only` を提供（配布物で確認）。追加依存なし。
- **Implications**: Spinner の代替表現を「動き低減時のみ文言を可視化する」形で実装できる。

### タッチ領域の拡張手段

- **Findings**: `Label` は実 `<label>` 要素（`label.tsx:9`）。ラベルと入力の関連付けにより、ラベル領域のタップで入力へフォーカスが移る。`<input>` に疑似要素が生成できない制約（C2）は、Field 構成を前提とすることで回避できる（要件 4.7 として明文化済み）。
- **Implications**: 新しいタッチ領域用の抽象を作らず、`checkbox.tsx` の `::after` 作法を Button へ展開し、テキスト入力はラベルを含む領域で満たす。

### `alert.tsx` の role 上書き可否

- **Findings**: `role="alert"` は `{...props}` より前に置かれている（`alert.tsx:44-48`）ため、呼び出し側が `role` を渡せば上書きされる。
- **Implications**: 要件 3 は「variant に応じた既定値」を与えるだけで満たせる。props の追加も型の変更も不要。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | 判定 |
|--------|-------------|-----------|---------------------|------|
| A: 既存資産の拡張 | `theme.css` と 3 部品を直接変更し、既存テストへ追記 | 新規ファイルゼロ。#49 で確立した「theme.css で全面を直す」方針と一貫 | `@layer base` が肥大。Input の 44px を単独では解けない | 骨格として採用 |
| B: 新規モジュール分離 | `motion.css` 新設・タッチ領域ユーティリティ新設・テスト新設 | 責務分離が明確 | CSS 取り込み順とレイヤ所属の管理が増え、#49 の罠を再生産しうる。単一実装しかない抽象 | 不採用 |
| C: ハイブリッド | 抑制は集約（A）、Spinner の代替表現のみ部品側（B）、検証は既存ファイルへ追記 | 既存構造を保ちつつ責務の異なる部分だけ分離 | 配置ルールを design で明文化しないと一貫性を失う | **採用** |

## Design Decisions

### Decision: 動きの抑制を `theme.css` の `@layer base` に集約する

- **Context**: 要件 1.1 / 1.2 を全 UI 面へ適用する必要がある。
- **Alternatives Considered**:
  1. 部品ごとに `motion-reduce:` バリアントを付ける — 部品追加のたびに付け忘れが起きる
  2. `@layer base` にグローバル抑制を置く — 1 箇所で全面に効く
- **Selected Approach**: 2。`@media (prefers-reduced-motion: reduce)` 内で `*`, `*::before`, `*::after` に対し `animation-duration` / `animation-iteration-count` / `transition-duration` を `!important` で抑制する。
- **Rationale**: 実測で有効性を確認済み（R-1）。アプリ側が将来動きを追加しても自動的に対象になる。`theme.css` は既に「アプリ DOM を触らず全面を直す」場所として機能している。
- **Trade-offs**: `!important` が入る。理由を実装コメントとレイヤ所属の AST 検証の両方で固定し、善意のリファクタで外されることを防ぐ。
- **Follow-up**: 要件 1.4（到達する見た目の同一性）は押下時の `translate-y-px` に効く。抑制後も押下フィードバックが失われないかを実測で確認する。

### Decision: Spinner は動き低減時に文言を可視化する

- **Context**: 要件 2.1 は動きに依存しない処理中の提示を求める。抑制後の Spinner は静止したアイコンになり、それだけでは処理中と判別できない。
- **Alternatives Considered**:
  1. 点滅などの別の動き — 光過敏への配慮に反する
  2. 極低速回転 — 「止まっている」との区別が曖昧で、抑制の意図にも反する
  3. `sr-only` の文言を `motion-reduce:not-sr-only` で可視化する — 動きゼロで意味が伝わる
- **Selected Approach**: 3。
- **Rationale**: 追加依存なし（Tailwind 4.3.3 が両ユーティリティを提供）。読み上げ用に既にある文言を視覚へ流用するため、二重管理が生じない。
- **Trade-offs**: Spinner の DOM が単一 `<svg>` からラッパ要素へ変わり、`React.ComponentProps<"svg">` を前提とした呼び出しは影響を受ける。現状の利用箇所は `/ui-check` のみのため実害は無いが、**契約変更として再検証トリガに含める**。

### Decision: 検証ファイルを新設せず既存へ追記する

- **Context**: 要件 5 は 3 種類の検証（属性・生成 CSS・実描画）を要求する。
- **Selected Approach**: role は `components.test.tsx`、生成 CSS とレイヤ所属は `app-integration.test.ts`、実描画は `ui-foundation.spec.ts` へ追記する。新規 spec ファイルを作らない。
- **Rationale**: `/ui-check` への遷移・巡回・計測ヘルパを再利用できる。加えて main の ruleset（必須チェック 10 個を明示列挙）は**ジョブ単位**で構成されているため、既存ジョブ内で完結させれば ruleset の更新が不要になる。
- **Trade-offs**: 既存ファイルが長くなる。セクションコメントで責務の切れ目を明示する。

### Decision: 動き・寸法の分類表はテストファイル内に置く（JSON 外出しはしない）

- **Context**: 要件 5.4 / 5.5 は「未分類を赤化させる」双方向ガードを要求する。先例として `color-mix-allowlist.json` は JSON へ外出ししている。
- **Selected Approach**: 分類表はテストファイル内の定数として持つ。
- **Rationale**: JSON 外出しの理由は「ui の静的テストと survey-web の E2E が同じ値を読む」ためだった。本 spec の分類表は単一のテストからしか参照されないため、外出しは不要な間接化になる。
- **Trade-offs**: 将来 E2E 側からも同じ表を参照する必要が生じたら、`color-mix-allowlist.json` と同じ形へ移す。

## Synthesis Outcomes

- **Generalization**: 要件 5 の 4 つのガードは、いずれも「**ソースを走査して抽出 → 分類表と双方向照合 → 未分類を赤化**」という単一の型に収まる（`contrast-usage.test.ts` の網羅ガードと同型）。個別に発明せず、この型を 3 つの主題（動きのユーティリティ／通知の変種／寸法区分）へ適用する。
- **Build vs Adopt**: 動き低減の判定はプラットフォーム標準のメディアクエリ、テストでの再現は Playwright 標準オプション、タッチ領域はリポジトリ内の既存作法、role 上書きは既存の props 順序 —— **本 spec が新規に作るものは無い**。新規の依存もゼロ。
- **Simplification**: Option B（新規 CSS モジュール・タッチ領域ユーティリティ・新規テストファイル）を破棄した。単一実装しか持たない抽象であり、レイヤ管理という新たな失敗経路を増やすだけだった。分類表の JSON 外出しも同じ理由で見送った。

## Risks & Mitigations（追補）

- **`!important` が善意のリファクタで外される** — 実装コメントで理由を固定し、`app-integration.test.ts` でレイヤ所属と `!important` の存在を AST 検証する。
- **押下フィードバックの喪失（要件 1.4）** — 抑制後も押下時の到達状態が同一であることを実測で確認する。差が問題になる場合は `translate-y-px` を抑制対象外にする判断を design 変更として扱う。
- **`/ui-check` のコンテナ幅が 32px** — タッチ領域の実測が成立しない。本 spec では `/ui-check` の幅指定を衝突しない形へ変更し、トークン衝突そのものは #54 のスコープとして申し送る。
- **要件 4.2（縮小寸法 24px）の検証が空振りする** — 縮小寸法を使う面が現状ゼロ。`/ui-check` に縮小寸法の部品を描画して検証対象を実在させる。
