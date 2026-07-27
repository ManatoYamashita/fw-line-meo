# Gap Analysis: ui-design-foundation

実施日: 2026-07-20 ／ 対象要件: `requirements.md`（Requirement 1〜6）
調査手段: コードベース全数調査（workspace 配線・ビルド経路・ガード雛形・性能予算・LINE 色使用箇所）＋外部依存調査（Tailwind v4 / Base UI / Next.js 16 standalone、出典付き）

## 1. 現状調査（Current State）

### 資産の全体像
- **スタイル資産はゼロ**: リポジトリ全体で `.css` 0件・`tailwind.config.*` / `postcss.config.*` 0件・`className` / インライン style 0件。Tailwind / PostCSS / Base UI は未導入（lockfile の postcss は Next 推移依存のみ）。
- **セマンティック HTML + ARIA は良質**: `aria-label` / `aria-pressed` / `role="alert"` / `scope="col"` / `lang="ja"` が全面に付与済み。スタイルを載せる土台は健全（R5 の非後退基準線）。

### workspace 配線（新パッケージの雛形）
- `ts/pnpm-workspace.yaml` = `packages/*` + `apps/*`。devDeps はルート集約（eslint ^9 / typescript ^5 / vitest ^3）。`packageManager: pnpm@10.33.2`。
- 既存パッケージ雛形（`@fwlm/db` / `@fwlm/store-identification` 同型）: `main: ./dist/index.js`・`exports {types, default}`・`build: tsc -p`・`test/` ディレクトリ分離・`vitest run --passWithNoTests`。
- `ts/tsconfig.base.json` は `lib:[ES2022]`・`types:[node]`・NodeNext・strict フル。**jsx / DOM lib が無い**ため、tsx を含む UI パッケージは tsconfig 拡張が必要。
- テスト規約: `test/*.test.ts(x)`・jsdom はファイル先頭 `// @vitest-environment jsdom`・React テストは `@testing-library/react ^16` + `jsdom ^25`（各アプリ devDep と同版）。

### Next.js アプリ 3面
- 3アプリとも `next ^16` / `react ^19`・App Router・`output:'standalone'`・`turbopack.root`＝`outputFileTracingRoot`＝`ts/`。**`transpilePackages` 未使用**。
- survey-web は `src/app`、store-detail は `app/` 直下（src 無し）、dashboard-web は `src/app`。dashboard-web のみ workspace パッケージ非依存（Dockerfile も packages/* を一切 COPY しない前提でコメント明記）。

### ビルド・出荷経路
- 新 workspace パッケージ追加時の Dockerfile 3点則（既知・メモリ済み）: deps 段の package.json COPY・build 段の tsc・runner 同梱。ただし **Next standalone 型はトレースが依存を自動同梱するため runner 変更は不要**（delivery-job 型のみ 3点目が効く）。
- **dashboard-web の Dockerfile は packages/* の COPY が初追加になる**（現在ゼロ）。
- 出荷ガードは整備済み: PR 段階 docker build 検証（ts-ci `docker-build` matrix・#40）・デプロイカバレッジ検証・placeholder 検出。**Tailwind/Base UI 導入によるビルド破損は PR 段階で機械検出される**（R6 の追い風）。

### ガード雛形・性能予算
- 直書き色ガード（R1.4 / R4.4）は `scripts/check-next-public-buildargs.sh` の形式（root `scripts/`・bash 3.2 互換・grep・fail-fast・ts-ci 冒頭実行）を踏襲可能。
- 性能予算（R6）: survey-web のみ `perf/bundle-budget.mjs`（**全 chunks gzip 合計 300KB 上限**）+ `perf/lighthouserc.json`（**LCP 3000ms error assert**・mobile・3回）。store-detail / dashboard-web に perf 基盤は無い。

### LINE 色の使用実態（R4 の対象）
`ts/apps/line-webhook/src/line/messages.ts` に色リテラル 8箇所・実質 5色:
| 色 | 箇所 | 意味役割 |
|---|---|---|
| `#1DB446` | L295, L325 | ブランド緑（完了見出し・primary ボタン） |
| `#888888` | L117, L231, L311 | 補足・住所テキスト |
| `#666666` | L383 | 説明テキスト |
| `#333333` | L302 | 本文テキスト |
| `#F0FBF4` | L281 | 淡緑背景 |

line-webhook に色/テーマ定数ファイルは無い（`src/config.ts` は env 系のみ）。**line-webhook は Node 実行（React/DOM 無し）のため、共有トークンはフレームワーク非依存の素の TS 定数である必要がある**。

## 2. 外部依存調査（2026-07 時点・出典付き）

### Tailwind CSS v4（現行 v4.3.2・2026-06-26）
- **CSS-first 設定**: `tailwind.config.js` レス。CSS 内 `@theme { --color-*: ... }` でトークン定義 → ユーティリティ自動生成＋全トークンが `:root` の CSS 変数として出力。**Issue #41 の「Tailwind config (theme) が source-of-truth」は v4 では「共有 theme.css の `@theme` ブロック」と読み替える**。
- 導入: `tailwindcss` + `@tailwindcss/postcss`、`postcss.config.mjs` にプラグイン1つ、globals.css 先頭に `@import "tailwindcss";`。autoprefixer 不要。
- **モノレポ共有の正道**: 共有パッケージに `theme.css`（`@theme`）を置き `exports` で CSS 公開 → 各アプリが `@import "@fwlm/ui/theme.css";`（Turborepo 公式ガイドと同構成）。旧 JS preset は後方互換専用で新規採用しない。
- **最重要の落とし穴**: v4 の自動コンテンツ検出は `node_modules` と `.gitignore` 記載物を走査しない → **workspace UI パッケージ内の className は各アプリの CSS に `@source "../../../packages/ui/src";` を明示しないと拾われない**。
- Next 16（Turbopack 既定）互換: 動作するが既知問題あり（HMR がソース変更を拾わないケース→`@source` 明示で回避、`.next` キャッシュへの CSS エラー固着、arbitrary value 不生成の報告）。**最新パッチ維持・`@source` 明示・問題時 `.next` 削除**が対策。PR docker-build ゲートが本番前に破損を検出する。
- ランタイム JS **ゼロ**（増分は生成 CSS のみ・使用クラス比例）。
- 出典: tailwindcss.com/blog/tailwindcss-v4・github.com/tailwindlabs/tailwindcss/releases・context7 `/tailwindlabs/tailwindcss.com`・vercel/next.js Discussion #88443 / Issue #90563・tailwindcss Issue #19825・turborepo.dev/docs/guides/tools/tailwind

### Base UI（現行 `@base-ui/react` 1.6.0・2026-06-17）
- 1.0 安定版 2025-12-11（35 コンポーネント）。**旧 `@base-ui-components/react` から改名済み・旧名は停止**。
- React 19 / App Router: SSR＋ハイドレーション対応・RSC 不可。**利用側ファイルに `'use client'` 明記が公式ドキュメント準拠**。Dialog / Popover / Menu 等は Portal 描画。
- **公式必須セットアップ**: ルート要素に `isolation: isolate;`（Portal の z-index 競合防止）＋ **iOS 26+ Safari 対策で `body { position: relative; }`**。
- バンドル: per-component サブパス import（`@base-ui/react/dialog` 等）で tree-shaking 可。1コンポーネント概ね **2〜7 KB (gzip)**（測定条件依存・mui/base-ui Issue #3688 で肥大議論あり。目安として扱う）。
- 出典: base-ui.com/react/overview/quick-start・npmjs.com/package/@base-ui/react・context7 `/mui/base-ui`・infoq.com/news/2026/02/baseui-v1-accessible/

### Next.js standalone × workspace パッケージ
- **Next 16 + Turbopack は workspace パッケージを自動トランスパイル**（公式 v16.2.10 ドキュメント明記）→ TSX ソース直配布なら `transpilePackages` 不要。
- **内部 UI パッケージはソース直配布（exports が .tsx を指す）が現行推奨**: ビルドステップ不要・Tailwind `@source` がソースを直接走査できて className 検出と好相性。dist 配布は className 検出が複雑化し内部パッケージには過剰。
- standalone 注意: Next 15.5.0+ で `server.js` が `.next/standalone/<相対パス>/server.js` に出る（Issue #84257）— **既存 Dockerfile は既に `apps/<name>/server.js` を CMD にしておりこのレイアウトを織り込み済み**。
- 出典: nextjs.org/docs/app/api-reference/config/next-config-js/transpilePackages・vercel/next.js Issue #84257

## 3. Requirement-to-Asset マップ

| 要件 | 既存資産 | ギャップ（タグ） |
|---|---|---|
| R1 トークン単一情報源 | 無し（色は LINE に直書き5色のみ） | **Missing**: トークン定義。**Constraint**: 消費者が「Web の CSS（@theme）」と「LINE の TS 定数」の2形態 → 単一情報源の形式選択が設計の焦点 |
| R1.4/R4.4 直書き色ガード | `check-next-public-buildargs.sh` の雛形・ts-ci 冒頭実行枠 | **Missing**: ガード本体（雛形踏襲で S 工数） |
| R2 共通コンポーネント | packages/* の雛形（db/store-identification）・テスト規約 | **Missing**: `@fwlm/ui` パッケージ。**Constraint**: tsx 用 tsconfig 拡張・ソース直配布は既存 dist 型雛形から意図的に逸脱 |
| R3 3面への基盤接続 | 3アプリとも App Router・standalone・`turbopack.root` 設定済み | **Missing**: postcss.config / globals.css / layout への読込。**Constraint**: dashboard-web Dockerfile への packages COPY 初追加・store-detail は `app/` 直下で構成が微差 |
| R4 LINE 配色統一 | 対象 8箇所・5色を全数特定済み | **Missing**: トークン参照化。**Constraint**: line-webhook は Node 実行 → React 非依存トークンが前提 |
| R5 a11y 非後退 | 良質な ARIA/セマンティクス・Base UI が強化方向 | **Unknown**: パレットのコントラスト AA 充足（下記 Research Needed） |
| R6 性能・出荷非後退 | gzip 300KB 予算・LCP 3000ms assert・PR docker-build ゲート・デプロイガード群 | ギャップ小。**Constraint**: Base UI 追加分（コンポーネント×2〜7KB）を予算内に収める設計 |

## 4. 実装アプローチ選択肢

### Option A: 各アプリ内で完結（共有パッケージ無し）
各アプリに Tailwind を個別導入し、theme.css とコンポーネントをアプリ内にコピー共有。
- ✅ Dockerfile 変更が最小（deps COPY 追加不要）・最速
- ❌ **R2.2（3面から追加実装なしで利用）を満たせない**（コピーは「別実装」）・トークンも3重複で R1 の単一情報源に反する
- **評価: 要件と構造的に矛盾。不採用推奨**

### Option B: `@fwlm/ui` 新設（トークン＋コンポーネントを一元化）
`ts/packages/ui` に (1) `theme.css`（@theme・web の source-of-truth）、(2) `tokens.ts`（React 非依存の色定数・LINE 用）、(3) Base UI をラップした共通コンポーネント（tsx ソース直配布）を集約。各アプリは `@import "@fwlm/ui/theme.css"` + `@source` + コンポーネント import。
- ✅ R1/R2 を素直に充足・Turbopack 自動トランスパイルで `transpilePackages` 不要・LINE も `tokens.ts` を import 可能
- ✅ ガードは「theme.css/tokens.ts 以外での hex リテラル検出」として単純化できる
- ❌ 既存 packages 雛形（dist 配布）からの逸脱（ソース直配布）を規約として明文化する必要
- ❌ Dockerfile 3面＋（LINE が tokens.ts を使うなら）line-webhook の deps COPY 追加が必要
- **評価: 要件適合が最も高い。推奨**

### Option C: 段階ハイブリッド（B を2段階に分割）
第1段: `@fwlm/ui` は theme.css + tokens.ts のみ（トークン基盤）＋3面の Tailwind 接続＋LINE トークン化＋ガード。第2段: Base UI 導入と共通コンポーネントを同パッケージに追加。
- ✅ PR を小さく保てる（トークン PR → コンポーネント PR）・第1段だけで R1/R3/R4 が完了し子 Issue #42〜#45 の着手可能点が早い
- ✅ Tailwind×Turbopack の既知問題を第1段で先に洗い出せる
- ❌ R2 の完了が第2段までずれる（spec 全体の完了は B と同じ）
- **評価: 実体は B の実行順序の工夫。B を採用した上でタスク分割として C を適用するのが最良**

## 5. 工数・リスク評価

- **工数: M（3〜7日）** — 新パターン（Tailwind v4 CSS-first・Base UI・ソース直配布）はあるが、雛形・ガード・出荷ゲートが全て整備済みで統合面の未知が少ない。
- **リスク: Medium** — Tailwind v4 × Next 16 Turbopack の既知問題（HMR/`@source`/キャッシュ）と Base UI のバンドル影響が主因。いずれも PR docker-build ゲート・perf:budget・Lighthouse assert が本番前に検出する構造があり High には至らない。

## 6. 設計フェーズへの推奨と Research Needed

### 推奨（design で Boundary Commitments 化すべき事項）
1. **Option B（`@fwlm/ui` 新設）を C の2段階順序で実施**。
2. **単一情報源の形式**: `tokens.ts`（素の TS 定数）を根とし、`theme.css` の `@theme` は同値を保持。両者の一致は直書き色ガードの拡張（tokens.ts と theme.css の値照合）で機械保証する案を第一候補に（代替: theme.css を根に codegen）。
3. **ソース直配布の規約明文化**: `@fwlm/ui` は exports が tsx ソースを指す（build script 無し）。Dockerfile は deps 段 COPY のみ追加・build 段 tsc 不要（standalone トレースが同梱）。
4. **各アプリ globals.css の3点セット**: `@import "tailwindcss";` → `@import "@fwlm/ui/theme.css";` → `@source "<相対>/packages/ui/src";`＋ Base UI 必須セットアップ（root `isolation: isolate`・`body { position: relative }`）。
5. ガード: `scripts/check-design-tokens.sh`（仮）— `ts/apps/**` と `packages/ui` 定義ファイル以外での `#[0-9a-fA-F]{3,8}` 検出＋ tokens.ts↔theme.css 値照合。ts-ci 冒頭に追加。

### Research Needed（design で解決）
- **パレットのコントラスト検証**: ブランド緑 `#1DB446` は白背景の通常文字で WCAG AA（4.5:1）を**満たさない可能性が高い**。テキスト用途には濃色変種（例: green-700 相当）の定義が必要 → R5.2 を満たすパレット展開（背景/テキスト/アクセントの役割別トーン）を design で確定。
- Tailwind v4.3.x × Next 16 現行パッチの実ビルド確認（最初の PR の docker-build ゲートで実証される）。
- store-detail の `app/` 直下構成（src 無し）での `@source` 相対パスと globals.css 配置。
- dashboard-web の Firebase 初期化と `'use client'` 境界に Base UI を挟む際の既存 auth-guard/top-nav の扱い。
- 300KB gzip 予算に対する現在値の実測（`perf:budget` のローカル実行で基準線を記録してから導入差分を測る）。

---

# Design Synthesis 記録（/kiro-spec-design・2026-07-20）

## 一般化（Generalization）
- R1.4（Web 直書き色検出）と R4.4（LINE 直書き色検出）は同一問題の変種 → 単一ガード `scripts/check-design-tokens.sh` に統合（対象パスの違いのみ）。
- 「トークンの2消費形態（Web CSS / LINE TS）」は将来の第3消費者（例: OGP 画像生成・メール）にも一般化するため、SSOT を**フレームワーク非依存 TS 定数**に置く判断を採用。

## Build vs Adopt
- **採用: shadcn CLI（base=Base UI）によるコンポーネントのソースベンダリング**。理由: (1) shadcn は Base UI をベースライブラリとして正式サポート（`base` フィールド・`base-nova` プリセット・モノレポ init）、(2) ソースコード取込方式がギャップ分析の「ソース直配布」推奨と一致、(3) 意味論的トークン変数（`--primary` 等）と Field 規約（`data-invalid`+`aria-invalid` 同期）が要件 2.3/2.4/5.1 と直結、(4) #43〜#45 の面実装が加速。手書き Base UI ラッパー案は棄却（車輪の再発明・a11y 規律の自前保証が重い）。
- shadcn CLI は dev-time のみの依存。ランタイム依存は Base UI + Tailwind に還元される。
- modern-web-guidance `accessible-error-announcement` の「視覚状態と aria-invalid の同期」原則は shadcn Field 規約がそのまま満たす（部品契約として design.md に明記）。

## 単純化（Simplification）
- **theme.css ↔ design-tokens の同期は codegen を作らず「手動同期＋機械検証（theme-sync テスト＋ガード）」**。生成パイプラインは値の変更頻度に対して過剰（YAGNI）。破綻したら段階的に codegen 化可能。
- `@fwlm/ui` に build script を持たせない（ソース直配布・Turbopack 自動トランスパイル）→ Dockerfile の build 段変更が不要になり出荷面の複雑性を削減。
- ダークモード・Storybook・ビジュアルリグレッションは導入しない（要件外）。
- フォントは基盤段階でシステム JP スタックに固定（LINE Seed JP は #44 で Lighthouse 実測とともに判断）— LCP 予算保護を優先。

## 追加の設計判断（requirements からの導出）
- **`@fwlm/design-tokens` と `@fwlm/ui` の2パッケージ分割**: line-webhook は tsc（NodeNext）ビルドのため tsx ソース直配布パッケージを import 不可。R4.2（単一定義箇所更新）を厳密に満たすには dist 配布の値パッケージが必要。
- **brand / primary の分離**: `#1DB446` は白文字と約 2.2:1 で AA 不適合 → 装飾用 `brand` とアクション用 `primary`（AA 機械検証付き）を別トークン化。LINE 用 `lineColors` は現行5色を意味役割化し段階1では見た目不変。
- **段階1/段階2 の2 PR 構成**（ギャップ分析 Option B を C の順序で実施）。

## 参照スキル（ユーザー指定4スキルの反映点）
- `/shadcn`: base=base 対応・ソース取込・Field/意味論クラス規約 → コンポーネント調達判断の根拠
- `/next-best-practices`: standalone/self-hosting・'use client' 境界・CSS import 規律 → 接続点設計
- `/frontend-design`: トークンに意図あるパレット（brand green 基調・意味役割分離）を要求 → brand/primary 分離とフォント Open Question
- `/modern-web-guidance`: `accessible-error-announcement`（:user-invalid ↔ aria-invalid 同期）→ Field 部品契約
