# Research & Design Decisions — ui-token-collision

## Summary

- **Feature**: `ui-token-collision`
- **Discovery Scope**: Extension（既存の `@fwlm/ui` / `@fwlm/design-tokens` への是正とガード追加。新規サブシステムなし）
- **Key Findings**:
  1. **「差分コンパイル」で越境衝突だけを誤検出ゼロで検出できる**ことを実測で確認した。素の Tailwind とプロジェクトの theme.css を同一ツールチェーンでコンパイルし、各ユーティリティが読む**テーマ変数名**を比較すると、`max-w-*` 等の越境衝突だけが差分として現れ、意図した同名上書き（`--text-*` / `--radius-*` / `--font-*` / `--shadow-*`）は一切差分にならない。
  2. **`--radius-sm/md/lg` の上書きを外すと、角丸階層が要件どおりに復活する**（sm 0.25 / md 0.375 / lg 0.5 / xl 0.75rem・全段が相異なる）。`:root { --radius: var(--radius-md) }` と Button の `rounded-[min(var(--radius-md),10px)]` は上書きを外しても `--radius-md` が生成 CSS に出力されるため壊れない（実測確認済み）。
  3. **`design-tokens` の `spacing` / `radius` には実行時の消費者が 1 つも無い。** LINE Flex（`delivery-job/src/flex.ts`）が消費しているのは `lineColors` のみで、余白は LINE 独自のキーワード（`'md'` / `'sm'`）を使っており `cornerRadius` の指定も無い。要件 2.3 により `spacing` の定義は維持するが、本 spec 完了後の**唯一の機械的な錨は同期ガードそのもの**になる。

## Research Log

### 1. 越境衝突の現況再実測（2026-08-02・作業ツリー `d088b46`）

- **Context**: Issue #54 の実測は `max-w-md` のみを示していた。要件を書くには影響範囲の確定が要る。
- **手段**: `@tailwindcss/postcss@4.3.3` + `postcss@8.5.16` で `apps/survey-web/src/app/globals.css` をコンパイルし、`@source inline(...)` で任意クラスを強制生成して解決先を読む。
- **Findings**:
  - 潰れるのは `max-w-*` だけではない。**`min-w-*` / `w-*` / `basis-*` も同様**に `--container-*` ではなく `--spacing-*` へ解決される（`max-w-sm` / `max-w-xl` でも再現）。
  - `p-4` / `gap-6` などの数値スケールは `calc(var(--spacing) * N)` で解決され、`--spacing`（0.25rem・Tailwind 既定）に依存する。名前付きキーの有無に影響されない。
  - `--radius-lg`（0.75rem・上書き）と `--radius-xl`（0.75rem・Tailwind 既定のまま）が同値。
- **Implications**: 要件 1.1 の対象を 4 種のサイズ系ユーティリティに拡張した。

### 2. 「差分コンパイル」方式の成立確認

- **Context**: 要件 5.1 は「あるスケールへ追加した定義が、別のスケールを参照して解決されるはずのユーティリティの解決先を覆ったとき」の検出を求める。名前空間の一般規則を人手で表に起こすと、Tailwind の更新で腐る。
- **手段**: 同一プローブ集合を 3 条件でコンパイルして、各ユーティリティが読む変数名を比較した。
  - `baseline` = 素の Tailwind（`@import "tailwindcss"` のみ）
  - `current` = 現状
  - `fixed` = `--spacing-*` と `--radius-sm/md/lg` を除去した状態
- **Findings**（抜粋・実測値）:

  | class | baseline | current | fixed |
  |---|---|---|---|
  | `max-w-md` | `--container-md` | **`--spacing-md`** | `--container-md` |
  | `min-w-md` / `w-md` / `basis-md` | `--container-md` | **`--spacing-md`** | `--container-md` |
  | `p-4` / `gap-6` | `--spacing` | `--spacing` | `--spacing` |
  | `rounded-sm` / `md` / `lg` / `xl` | `--radius-*`（同名） | `--radius-*`（同名） | `--radius-*`（同名） |
  | `text-xs` / `text-2xl` / `font-sans` | 同名 | 同名 | 同名 |
  | `p-md` | （未生成） | `--spacing-md` | （未生成） |
  | `bg-primary` | （未生成） | `--color-primary` | `--color-primary` |
  | `rounded-full` | `calc(infinity * 1px)`（リテラル） | `--radius-full` | `--radius-full` |

- **Implications**: 判定規則を次のとおり確定できる。

  > **越境衝突** ⟺ baseline でテーマ変数 A を読み、current でテーマ変数 B を読み、かつ A ≠ B。

  - baseline で未生成（`p-md` / `bg-primary`）＝**トークン追加による新規ユーティリティ**であり衝突ではない → 誤検出しない。
  - baseline がリテラル（`rounded-full`）＝**同一ユーティリティの値上書き**であり越境ではない → 誤検出しない。
  - 同名上書き（`text-xs` 等）は変数名が変わらない → 誤検出しない。

  **許可リストを一切必要としない**点が重要である。許可リストは時間とともに実害を隠す。

### 3. 基準線の作り方（theme.css への正規表現手術を避ける）

- **Context**: 当初は theme.css の `@theme` ブロックを正規表現で除去して基準線を作ったが、theme.css の構造変更で静かに壊れる。
- **Findings**: アプリ自身が解決する `@tailwindcss/postcss` を `base: <アプリディレクトリ>` で起動すれば、`@import "tailwindcss";` だけの CSS も**そのまま素の基準線としてコンパイルできる**（実測成功）。既定値は `--container-md: 28rem` / `--spacing: 0.25rem` / `--radius-lg: 0.5rem` / `--radius-xl: 0.75rem`。
  - 当初の失敗はプラグインを生パスで import し `from` をアプリ外に置いたことが原因で、方式の問題ではなかった。
  - `--radius-sm` / `--radius-md` は**使われないと出力されない**。プローブ集合に `rounded-sm` / `rounded-md` を含めて出力を強制する必要がある。
- **Implications**: 基準線は「素の Tailwind」で作る。theme.css には触れない。

### 4. 角丸を既定へ寄せた場合の影響（`fixed` 条件の実測）

- **Findings**:
  - `--radius-sm` 0.25rem / `--radius-md` 0.375rem / `--radius-lg` 0.5rem / `--radius-xl` 0.75rem。**全段が相異なる**。
  - Button（`rounded-lg`）0.5rem < Card（`rounded-xl`）0.75rem → 視覚階層が復活する。
  - `:root { --radius: var(--radius-md) }` は `fixed` でも `var(--radius-md)` として出力され、`--radius-md` も 0.375rem として出力される。**Button の `rounded-[min(var(--radius-md),10px)]` は壊れない**（到達値は 8px → 6px へ変化）。
  - 生成 CSS の raw サイズ: current 47,096 B → fixed 47,043 B（−53 B）。実質不変。
  - **プローブを一切足さない条件（＝ `next build` と同じ入力）で再確認したところ、`--radius-md` は 0.375rem として出力される**（`:root { --radius: var(--radius-md) }` と Button の `min(var(--radius-md), 10px)` が依存元）。上書き除去による破損は無い。
  - **同条件で `--radius-sm` は出力されない。** どの部品も `rounded-sm` を使わないためである。Tailwind は使われていないテーマ変数を出力しない。
- **Implications**: `--radius-sm/md/lg` の上書きは単純に除去できる。`--radius-full` の扱いは別途決定（Decision 3）。
  **役割対応照合はプローブで出力を強制したコンパイル結果に対して行う必要がある。** 本番と同じ入力の生成 CSS へ照合を当てると `sm` が欠測になり、「欠測は検証対象外」と直した瞬間にガードが空洞化する。これは本 spec が塞ごうとしている失敗様式そのものであり、`resolvedValue: null` は違反として扱う。

### 5. `--spacing-*` 除去の安全性

- **Findings**:
  - `var(--spacing-xs)` 〜 `var(--spacing-xl)` を直接参照する箇所は**リポジトリ全体で 0 件**。
  - 名前付き余白ユーティリティ（`p-md` / `gap-lg` / `w-sm` 等）の使用も 0 件（要件フェーズで確認済み）。
  - Card の `[--card-spacing:--spacing(4)]` は `--spacing`（基数）に依存し、名前付きキーとは無関係。
- **Implications**: 除去は後方互換の問題を生まない。

### 6. design-tokens の実消費者

- **Findings**:
  - `@fwlm/design-tokens` を実行時に import しているのは `apps/delivery-job/src/flex.ts`（`lineColors` のみ）と、テスト内の `contrastRatio` / `compositeOver` だけ。
  - `spacing` / `radius` / `typography` / `shadow` の各シンボルは **`design-tokens` 自身の `tokens.test.ts` 以外から参照されていない**。
  - LINE Flex は余白を独自キーワード（`spacing: 'md'` / `margin: 'md'`）で指定しており、rem 値を消費しない。`cornerRadius` の指定も現状無い。
- **Implications**: 要件 2.3 により `spacing` は維持するが、**その正しさを担保する唯一の機構は本 spec が新設する同期ガードになる**。design.md にこの事実を明記し、将来 Flex 側で `cornerRadius` を使う際の接続点として `radius` を残す。

### 7. 既存の検証資産と CI

- **Findings**:
  - `ts/packages/ui/test/app-integration.test.ts` に `compileWithAppToolchain(app, cssSource)`（`base` をアプリディレクトリへ固定して `next build` と同条件を再現）と 3 面の `APPS` 定義がある。いずれも**同ファイル内のローカル定義**で共有されていない。
  - `theme-sync.test.ts` と `scripts/check-design-tokens.sh` は **hex 色しか照合しない**（余白・角丸の同期を守る機構は存在しない）。
  - `ts-ci` は `pnpm -C ts -r test` を実行するため `@fwlm/ui` の vitest は CI で走る。`pnpm -C ts run typecheck` も実行され、`scripts/check-typecheck-coverage.sh` がカバレッジを強制する（Issue #51 は解消済み）。
  - `apps/survey-web/e2e/ui-foundation.spec.ts:435` の `expectVerificationSurfaceSane` が `/ui-check` の `main` 実幅 ≥ 端末幅 80% を検証済み（要件 5.10 は既存資産で満たせる）。
- **Implications**: 新設ガードは vitest（`@fwlm/ui`）に置けば CI で必ず走る。コンパイル harness は共有モジュールへ切り出す。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| 差分コンパイル（採用） | 素の Tailwind と現行を同条件でコンパイルし、ユーティリティが読むテーマ変数名を比較 | 許可リスト不要・Tailwind 更新に自動追従・誤検出ゼロを実測で確認 | コンパイル 2 回分のコスト。プローブ集合の網羅は人手 | 実測で成立を確認（Research Log 2） |
| 名前空間対応表の静的保持 | 「このユーティリティはこの名前空間を読む」を表で持ち、theme.css の宣言と突き合わせる | コンパイル不要で高速 | Tailwind の更新で表が腐り、腐っても緑のまま。表の正しさを誰も検証できない | 却下 |
| 生成 CSS の値だけを検査 | `max-w-md` の解決値が 28rem であることを直接 assert | 実装が単純 | 期待値を人手で書くため、Tailwind 既定が変わると誤って赤くなる／変数名の取り違えを検出できない | 部分的に採用（角丸の段差検査のみ） |
| ESLint / stylelint プラグイン | 静的解析でトークン宣言を検査 | 既存 lint に載る | CSS の**解決結果**を見られない。本件は解決結果の問題であり原理的に届かない | 却下 |

## Design Decisions

### Decision 1: 越境衝突の検出を「差分コンパイル」で行う

- **Context**: 要件 5.1 は越境衝突の一般的な検出を求める。要件 5.6 は「実際に生成された CSS の解決結果に対して判定し、定義元の字面の一致では代替しない」を課す。
- **Alternatives Considered**: 上表のとおり（静的対応表 / 値の直接 assert / lint プラグイン）。
- **Selected Approach**: 素の Tailwind を基準線としてコンパイルし、プローブ集合の各クラスが読むテーマ変数名を現行と比較する。A ≠ B かつ双方がテーマ変数のときのみ違反とする。
- **Rationale**: 許可リストを持たずに誤検出ゼロを達成できることを実測で確認した。許可リストは「意図した例外」の名目で実害を隠す構造を生む（本リポジトリは #49 / #52 で同型の失敗を経験している）。
- **Trade-offs**: アプリ 1 面あたりコンパイル 2 回。3 面で 6 回。テスト時間は増えるが、`app-integration.test.ts` が既に同種のコンパイルを複数回行っており許容範囲。
- **Follow-up**: プローブ集合の網羅性は人手管理になる。実装時にプローブが 1 件も生成されない事故を防ぐ自己検証を必ず入れる（要件 5.7）。

### Decision 2: 角丸は上書きを外し、`design-tokens` の値を Tailwind 既定へ改める

- **Context**: 要件 3.3 は「デザイントークンの角丸定義と役割ごとに対応付けられた実寸を与え、対応の無い値を描画に用いない」を課す。利用者判断で「Tailwind 既定へ寄せる」が確定している。
- **Alternatives Considered**:
  1. `theme.css` の上書きを外し、`design-tokens.radius` を既定値へ改める（**採用**）
  2. `design-tokens.radius` を現状のまま残し、Tailwind の段と対応表で結ぶ
- **Selected Approach**: `theme.css` から `--radius-sm/md/lg` を除去する。`design-tokens.radius` を `sm: 0.25rem` / `md: 0.375rem` / `lg: 0.5rem` / `xl: 0.75rem` / `full: 9999px` へ改める（`xl` を追加）。対応は恒等写像になる。
- **Rationale**: 対応表を介した写像は「lg が 0.75rem なのに `rounded-lg` は 0.5rem」という読み手を必ず誤らせる状態を恒久化する。`design-tokens.radius` に実消費者が無い（Research Log 6）ため、値の変更による波及もない。
- **Trade-offs**: `design-tokens.radius` の値が「Tailwind 既定の写し」になり独自性を失う。ただしその独自性こそが本件の欠陥の源であった。
- **Follow-up**: `design-tokens/test/tokens.test.ts` の `radius` キー集合 assert（現在 sm/md/lg/full）を更新する。

### Decision 3: `--radius-full` の上書きは維持する

- **Context**: Tailwind 既定の `rounded-full` は `calc(infinity * 1px)` というリテラルで、テーマ変数を読まない。`--radius-full: 9999px` を宣言している現状ではテーマ変数を読む。
- **Selected Approach**: `--radius-full: 9999px` を維持する。
- **Rationale**: 除去すると `rounded-full` が描く値に対応するトークンが消え、要件 3.3 の「対応の無い値を描画に用いない」を破る。維持すれば `radius.full` と恒等対応する。差分コンパイル判定では baseline がリテラルであるため越境衝突として検出されない（Research Log 2）。描画結果は 9999px と `calc(infinity * 1px)` で実質同一（いずれもピル形状）。
- **Trade-offs**: 「既定へ寄せる」方針にわずかな例外を作る。design.md に理由を明記して隠さない。

### Decision 4: `design-tokens.spacing` は値を変えずに維持し、数値スケールとの対応をガードで固定する

- **Context**: 要件 2.3 が維持を課す一方、実消費者は存在しない（Research Log 6）。
- **Selected Approach**: 値（xs 0.25 / sm 0.5 / md 1 / lg 1.5 / xl 2 rem）を変えずに残し、`xs→1 / sm→2 / md→4 / lg→6 / xl→8` の対応表を持ち、`spacing[k] === --spacing × n_k` を生成 CSS の実値に対して照合する。
- **Rationale**: 対応表がなければ「維持している」ことに意味が無い。トークンが数値スケールで表現できない値へ変わった瞬間に赤くする（要件 5.5）ことで、はじめて維持が保証になる。
- **Trade-offs**: 消費者のいないトークンにガードを 1 本かける。将来 LINE Flex が `cornerRadius` や rem 余白を使う際の接続点として正当化される。
- **Follow-up**: design.md に「現在の唯一の消費者はガードである」ことを明記し、将来の再検討点として残す。

### Decision 5: 赤化実証（要件 5.9）を**恒久テスト**として実装する

- **Context**: 要件 5.9 は「是正前の実装に対して失敗することが実証された状態で導入される」を課す。一度手で確認するだけでは、後日ガードが空振りへ退化しても誰も気づけない。
- **Selected Approach**: 是正前の状態を**注入して再現**し、ガードの判定関数がそれを違反として報告することを assert する対照テストを常設する。注入は 2 系統（`--spacing-md` の再導入による越境衝突／`--radius-lg` を `--radius-xl` と同値にする段の重複）。
- **Rationale**: 「赤化を実証してから直す」という規律（[[guard-before-fix-discipline]] 相当）を、人手の手順ではなくスイートの構造として固定する。抽出器の自己検証（要件 5.7）と合わせ、空振りの緑を二重に塞ぐ。
- **Trade-offs**: テストコードが増える。判定ロジックを純関数として切り出す必要がある（テスト内から注入条件で呼べる形）。
- **Follow-up**: 判定関数はコンパイル済み CSS を入力に取り、違反の一覧を返す純関数として設計する。

### Decision 6: コンパイル harness を共有モジュールへ切り出す

- **Context**: `compileWithAppToolchain` と `APPS` は `app-integration.test.ts` のローカル定義。新ガードも同じ条件（`base` をアプリディレクトリへ固定）を必要とする。
- **Selected Approach**: `ts/packages/ui/test/support/compile-app-css.ts` へ切り出し、既存テストと新ガードの双方が import する。
- **Rationale**: 複製すると `base` の固定という**最も間違えやすい条件**が二重管理になる（[[ui-design-foundation-facts]] の「base をアプリディレクトリに固定する」）。
- **Trade-offs**: 既存テストの改変を伴う。挙動は不変であることを既存スイートの緑で確認する。

## Risks & Mitigations

- **プローブ集合の取りこぼし** — 網羅は人手管理になる。緩和: 抽出結果が空でないことの自己検証（要件 5.7）に加え、`theme.css` の `@theme` が宣言する**全キーの名前空間**を列挙し、その名前空間を読むユーティリティが 1 つ以上プローブ集合に含まれることを assert する（宣言側からの網羅・要件 5.6 の「両方向」の片側）。
- **Tailwind の更新で既定値が変わる** — `design-tokens.radius` が既定の写しになるため、更新時にガードが赤くなる。緩和: これは意図した挙動（乖離の検出）。赤くなったら既定へ追随するか意図的に上書きするかを明示的に決める。
- **テスト時間の増加** — コンパイル回数が増える。緩和: 基準線は 3 面で共有せず面ごとに取るが、プローブ集合は 1 つに統一し `beforeAll` で 1 回だけコンパイルする。
- **Button 小寸法の見た目変化** — `min(var(--radius-md), 10px)` が 8px → 6px。緩和: 実装時に `/ui-check` 上で目視確認し、tasks の Implementation Notes に実測を記録する。要件 6.2 の非後退対象（見出し・フォーカス・動き低減）には含まれない範囲の変化である。
- **`@theme` ブロックの構造変化** — 宣言キーの列挙を実装する際、正規表現で `--x: y;` を拾うと `@layer` 内の宣言まで拾う。緩和: 要件 5.6 のとおり postcss の構文木で `@theme` at-rule の直下宣言のみを対象にする（[[ui-design-foundation-facts]] の「postcss AST で祖先 at-rule を辿る」と同じ手法）。

## References

- 実測スクリプト（本セッションで使用・成果物ではない）: 素の Tailwind 基準線は アプリ自身が解決する `@tailwindcss/postcss` を `base: <appDir>` で起動し、`@import "tailwindcss"; @source inline("<probes>");` をコンパイルする。
- `ts/packages/ui/test/app-integration.test.ts` — `compileWithAppToolchain` / `APPS` の既存定義（切り出し元）。
- `ts/packages/ui/test/theme-sync.test.ts` — 役割対応表による厳密一致＋両方向網羅の既存実装（色）。本 spec の余白・角丸ガードはこの設計を踏襲する。
- `.kiro/specs/ui-design-foundation/design.md` / `tasks.md` — 要件 7 が是正対象とする記録のドリフト元。
- GitHub Issue [#54](https://github.com/ManatoYamashita/fw-line-meo/issues/54) — 起票根拠。[#60](https://github.com/ManatoYamashita/fw-line-meo/issues/60) — 抽出器の自己検証の規律。[#53](https://github.com/ManatoYamashita/fw-line-meo/issues/53) — 生成 CSS サイズ予算（本 spec の対象外）。
