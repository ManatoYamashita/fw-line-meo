# Implementation Plan

- [ ] 1. Foundation: デザイントークン単一情報源の確立
- [x] 1.1 デザイントークンパッケージを新設し全トークン値を単一定義する
  - 既存パッケージ雛形（dist 配布・tsc ビルド・test 分離）を踏襲し、フレームワーク非依存（依存ゼロ）のトークンパッケージを作る
  - 色は brand（装飾用 #1DB446）と primary（アクション用・AA 準拠の暗色化緑）を分離し、text/textMuted/background/destructive/border 等の意味役割で定義する
  - LINE 用セットは現行 5 色を意味役割名（headline/body/description/caption/successBackground/action）で保持し、値は現行と同一にする
  - タイポ（fontSans・サイズ階層）・spacing・radius・shadow のトークンも定義する
  - 完了条件: ワークスペース全体の build/typecheck が緑で、他パッケージからトークンを import して値を参照できる
  - _Requirements: 1.1, 1.3_

- [x] 1.2 WCAG AA コントラストの機械検証テストを追加する
  - Web 意味役割の前景/背景ペア全てについてコントラスト比を数値計算し 4.5:1 以上を assert する（LINE 用セットは対象外）
  - primary の具体 hex はこのテストを通る値として確定する
  - 完了条件: テストが緑で、意図的に AA 割れの値へ変えるとテストが赤になることを確認済み
  - _Requirements: 5.2_

- [x] 1.3 (P) 性能予算の基準線を記録する
  - 変更を加える前の survey-web バンドル予算計測を実行し、現在値（gzip KB）を実装ノートに記録する
  - 完了条件: 導入前の基準値が記録され、後続タスクの差分比較に使える状態
  - _Requirements: 6.1_
  - _Boundary: 性能計測_

- [x] 2. テーマ CSS と UI パッケージの器を作成する
  - UI パッケージをソース直配布（build script なし・exports がソースを指す）で新設する
  - theme.css に Tailwind v4 の @theme トークン（デザイントークンと同値）と shadcn 規約の意味論的 CSS 変数を定義する
  - Base UI 必須ベーススタイル（ルート isolation・body の position・グローバル focus-visible 既定）を theme.css に含める
  - theme.css の全 hex がデザイントークンの値集合と一致することを検証するテスト（theme-sync）を追加する
  - 完了条件: theme-sync テストが緑で、theme.css に意図的な未定義色を足すとテストが赤になる
  - _Requirements: 1.1, 1.2, 5.3_

- [ ] 3. Web 3 面への基盤接続（最小適用）
- [x] 3.1 (P) survey-web に Tailwind を接続し基本スタイルを適用する
  - PostCSS 設定・globals.css（tailwindcss import → theme.css import → UI パッケージソースへの @source）・layout への読込を配線する
  - トークンに基づくフォント・文字色・背景・余白が全画面に適用され、ブラウザ標準描画から脱却する
  - DOM 構造・情報設計・機能挙動（フォーム送信・API・導線）は変更しない
  - 注記: 3.x と 4 は依存追加で lockfile を共有更新するため、並列実施時は lockfile 変更を単一コミットに集約して競合を避ける
  - 完了条件: 既存の unit/E2E テストが全緑のまま、モバイルビューポートで横スクロールが発生しない
  - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - _Boundary: survey-web 接続点_

- [x] 3.2 (P) store-detail に Tailwind を接続し基本スタイルを適用する
  - 3.1 と同一の配線（app 直下構成のため globals.css の位置と @source の相対深度が異なる点に注意）
  - 注記: lockfile 共有更新の集約は 3.1 の注記に同じ
  - 完了条件: 既存テストが全緑のまま、LIFF 想定のモバイル幅で横スクロールが発生しない
  - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - _Boundary: store-detail 接続点_

- [x] 3.3 (P) dashboard-web に Tailwind を接続し基本スタイルを適用する
  - 3.1 と同一の配線。認証ガード・Firebase 初期化等の既存クライアント境界に触れない
  - 注記: lockfile 共有更新の集約は 3.1 の注記に同じ
  - 完了条件: 既存テストが全緑のまま、ログイン画面と一覧画面がトークンベースの基本スタイルで描画される
  - _Requirements: 3.1, 3.2, 3.4_
  - _Boundary: dashboard-web 接続点_

- [x] 4. (P) LINE メッセージ配色をトークン参照に統一する
  - Flex メッセージの直書き色 8 箇所をデザイントークンの LINE 用セット参照へ置換する（値は現行と同一のため見た目は不変）
  - 文言・Flex 構造・メッセージ種別は変更しない（既存テストの構造アサーションで保証）
  - 注記: lockfile 共有更新の集約は 3.1 の注記に同じ
  - 完了条件: 対象ソースに hex リテラルが残存せず、既存の LINE メッセージテストが全緑
  - _Requirements: 4.1, 4.2, 4.3_
  - _Depends: 1.1_
  - _Boundary: LINE メッセージ色置換_

- [ ] 5. ガードと出荷経路の整合
- [x] 5.1 (P) 直書き色ガードを新設し CI に組み込む
  - アプリ層と UI コンポーネント層での hex 色リテラル混入を検出して fail する（許可箇所はトークン定義と theme.css のみ・既存ガードと同形式の read-only 検証）
  - theme.css の全 hex がトークン定義の値集合に含まれることも同時に照合する
  - CI の検証列（checkout 直後・fail-fast）へ追加する
  - 完了条件: 現状態で緑・意図的違反を注入したコピーで exit 1 になることを否定系テストで実証済み
  - _Requirements: 1.4, 4.4_
  - _Depends: 2, 4_
  - _Boundary: ガードスクリプト_

- [x] 5.2 (P) コンテナビルド経路を新パッケージ構成に整合させる
  - Web 3 面のビルド定義に新パッケージ 2 つのマニフェストコピーを追加する（ソース直配布のためビルド段の追加は不要）
  - LINE 面は dist 配布パッケージの 3 点則（deps コピー・ビルド・runner 同梱）に従って追加する
  - 完了条件: PR 段階の 7 イメージ docker build 検証が全緑
  - _Requirements: 6.3_
  - _Depends: 3.1, 3.2, 3.3, 4_
  - _Boundary: Dockerfile 4 面_

- [ ] 6. 共通コンポーネント基盤（段階 2）
- [x] 6.1 共通コンポーネントの基盤セットをベンダリングする
  - shadcn（base=Base UI・registry は @shadcn）で Button/Card/Badge/Alert/Spinner/Field/Input/Textarea/Checkbox/RadioGroup/Separator を UI パッケージへソース取込する
  - CLI 設定（components.json）・cn ユーティリティ・Base UI ランタイム依存の追加は本タスクが所有する
  - 取込後、意味論クラスのみ使用（生 hex・生色クラス禁止）・use client 明記・エイリアス解決を確認して所有コードとして整える
  - 完了条件: UI パッケージの lint/typecheck が緑で、全部品が named export として公開されている
  - _Requirements: 2.1_

- [x] 6.2 コンポーネントの a11y・状態表現スモークテストを追加する
  - 代表部品（Button/Checkbox/Field）の role・キーボード操作・視覚状態と aria-invalid の同期を jsdom で検証する
  - 状態表現（hover/focus/disabled/エラー）が variant/data 属性規約で表現されることを確認する
  - 完了条件: コンポーネントテストが緑（キーボードのみでの操作完結を含む）
  - _Requirements: 2.3, 2.4, 5.1_

- [x] 6.3 (P) 3 面からの利用可能性を実証する
  - 各アプリから代表部品を import してビルドし、生成 CSS に部品のユーティリティクラスが含まれる（@source 検出が機能している）ことを確認する
  - 検証は生成 CSS の検査と import ビルド確認のみで行い、画面への恒久的な部品配置・情報設計の変更は行わない
  - 画面の情報設計は変更しない（本格置換は面ごとの子 Issue の責務）
  - 完了条件: 3 アプリすべてでビルド緑かつ生成 CSS にクラス存在を確認済み
  - _Requirements: 2.2_
  - _Depends: 6.1_
  - _Boundary: 3 アプリのビルド検証_

- [ ] 7. Validation: 非後退の総合実証
- [x] 7.1 E2E にフォーカス可視・横スクロール検証を追加する
  - survey-web の既存 E2E にキーボードフォーカスの可視確認とモバイルビューポートでの横スクロール不在 assert を追加する
  - 完了条件: 追加 assert を含む E2E が全緑
  - _Requirements: 5.3, 3.3_

- [ ] 7.2 性能・品質・出荷経路の全緑を実証し差分を記録する
  - バンドル予算を再計測し 1.3 の基準線との差分を記録、300KB gzip 予算内であることを確認する
  - Lighthouse（LCP 3000ms assert）・全自動検証（lint/build/unit/E2E）・7 イメージビルドの全緑を確認する
  - 体感遅延・予算超過があれば出荷前に是正する（是正内容も記録）
  - 完了条件: 全 CI ジョブ緑＋差分記録が実装ノートに残っている
  - _Requirements: 6.1, 6.2, 6.4_
  - _Depends: 1.3_

## Implementation Notes

- 1.1: shadow トークンは rgba を避け 8 桁アルファ hex（#0000000D 等）で表現 → タスク 2 の theme-sync 照合とタスク 5.1 のガード regex は 8 桁 hex を考慮すること
- 1.1: colors.ts 冒頭コメントの「#1DB446 は白文字と約 2.2:1」は実計算 2.74:1（結論の AA 非準拠は不変）→ タスク 1.2 でコメント数値を修正
- 1.1: primary は #15803D で仮確定（白文字と 5.016:1・レビュアーが独立計算で確認済み）。1.2 の網羅テストで最終確定
- 1.1: workspace ビルドが store-detail/next-env.d.ts を自動書き換えする（Next の副産物・タスクと無関係なら revert する）
- 1.3: 性能予算の基準線（Tailwind + Base UI 導入前）= survey-web client JS **182.8 KB gzip / 300 KB 予算**（余地 117.2 KB）。タスク 7.2 でこの値との差分を確認する
- 2: `@fwlm/ui` はソース直配布（build script なし・exports が src を直接指す・dist なし）。theme-sync テストの hex 抽出は `#[0-9a-fA-F]{3,8}`（8桁アルファ影対応）。shadcn 意味論変数は全て `var(--color-*)` 参照で新規 hex を持ち込まない。cn は依存ゼロ簡易実装（6.1 で shadcn 標準の clsx/tailwind-merge へ整合予定）。package.json の `./components/*` exports は 6.1 向けの前方宣言（実体は未存在）
- 3.1: **@source 相対深度はアプリ構成で異なる**（`path.relative` と実ビルドで実証）: survey-web/dashboard-web（`src/app/`）は4階層 `../../../../packages/ui/src`、store-detail（`app/` 直下）は3階層 `../../../packages/ui/src`。design.md:154 の5階層は誤記だったため修正済み。globals.css 3点セット順 = `@import "tailwindcss"` → `@import "@fwlm/ui/theme.css"` → `@source`。Tailwind v4 はランタイム JS ゼロで perf 増分0（182.8KB 据え置き）。body は意味論クラス（text-foreground 等）を使用。横スクロール対策は globals.css の `overflow-x: clip`
- 3.1: survey-web の Dockerfile は 5.2 まで未変更 → **5.2 完了までコンテナ build（PR docker-build ゲート）は survey-web が赤**（ローカルは workspace リンクで緑・タスク分解上の想定）。PR は 5.2 完了後に作成すること
- 3.3: dashboard-web は本タスクで**初の workspace 依存（@fwlm/ui）**を得た。現行 Dockerfile は packages/* を COPY しない前提のコメント付き → 5.2 で design-tokens + ui のマニフェスト COPY 追加が必須（3面とも 5.2 で対応）。AuthProvider のクライアント境界は不変
- 4: messages.ts の hex 8箇所を lineColors 参照へ置換（残存ゼロ）。**同値 #1DB446 は役割で使い分け**（完了見出し=headline / primary ボタン=action）。値は全て現行と同一のため見た目不変。既存139テスト全緑が Flex 構造・文言不変の証拠。line-webhook は dist 配布の design-tokens のみ依存（ソース直配布の @fwlm/ui は tsc 解決不可のため依存禁止）
- 6.1: shadcn 4.x の components.json は `base` 独立フィールドではなく **`style: "base-nova"` で Base UI を指定**。CLI 出力は `'use client'` 欠落・React import 欠落・JSX 整形崩れを含むため**取込後に自前で整える3点**（use client / React import / import 経路）が必須。import は `@fwlm/ui/*` エイリアスではなく**相対パス**に統一（pnpm は自己リンクを作らないため）。tsconfig は `moduleResolution: bundler`（ソース直配布＝バンドラ消費）
- 6.1: theme.css に2行追加（**shadcn 部品の無改変動作契約に必要**・レビュアーが対照コンパイルで実証）: `@custom-variant dark (&:is(.dark *));`（無いと Tailwind v4 既定の `prefers-color-scheme` で OS ダーク端末に部品の `dark:*` が暴発。ダークモードは Non-Goals）と `*,::after,::before,… { border-color: var(--border) }`（v4 preflight の `border: 0 solid` により幅のみ指定の枠線が currentColor になるのを防ぐ）
- 6.1 → 6.2 への申し送り: **requirements 2.1 の「通知（成功/エラー表示）」のうち成功側が未実現**（alert.tsx の variant は default/destructive のみ）。6.2 で success 変種を追加すること（brand 系は AA 非準拠のため文字色は primary 相当を使う）。`spinner.tsx` の `aria-label="Loading"` の日本語化も 6.2 で判断
- 6.1: ts-ci は typecheck を実行していない（lint/build/test のみ）→ アプリが部品を import するまで .tsx の型エラーが CI をすり抜ける。6.3 で import ビルド検証を行う際に留意
- 6.2: **jsdom 25 に PointerEvent が無く** Base UI の Checkbox/Radio の Space 起動が落ちる（`ownerWindow(...).PointerEvent is not a constructor`）→ テスト内に MouseEvent 継承の最小互換実装が必要。面ごと Issue（#43〜#45）で同部品をテストする際も同じ壁に当たる
- 6.2: requirements 2.1 の成功通知を Alert `success` 変種で解消。theme.css に `--success: var(--color-primary)`（**AA 準拠の #15803D 系。brand #1DB446 は 2.74:1 で不可**）と `@theme inline` の `--color-success` を追加し、この対応付け自体を theme-sync テストで固定（brand を指すと赤）。**`@theme inline` への公開を忘れるとユーティリティが静かに生成されない**
- 6.2: Spinner の aria-label を「読み込み中」へ日本語化（呼び出し側で上書き可）。jsdom は Tailwind を解決しないため視覚状態はクラス／data 属性の存在で検証（実描画は 6.3 の生成 CSS 検査と 7.1 の E2E が担う）
- 6.3: 3面の利用可能性は `packages/ui/test/app-integration.test.ts`（61テスト）で**恒久ガード化**。4層検証（依存／exports 解決／3点セット配線／実 Tailwind コンパイルでの生成）。**@source は文字列比較でなく realpath 解決一致で検証**するため 4階層/3階層の構成差に追従しつつ深度誤りは検出する。破壊2形態（深度誤り・行削除）で赤化することを実証済み
- 6.3: **部品を実 import した状態の実測は 196.1 KB gzip（+13.3 KB）**・予算 300KB に対し余地 103.9 KB（面ごと実装 #43〜#45 の判断材料）。部品未使用の現状は 182.8 KB（増分ゼロ）
- 6.3: Next.js の private folder 規約（`_` 始まりはルーティング対象外）に注意 — 一時検証ルートを `__name` にするとビルドされず検証が空振りする
- 7.1: **`overflow-x: clip` は scrollWidth 検査を空振りさせる**（clip により scrollWidth == clientWidth になるため、幅超過要素があっても緑になる）→ 横スクロール検証は**要素の実測右端 <= 端末幅**で行う必要がある（注入実験で実証）。端末幅は `window.innerWidth` ではなく `page.viewportSize()` を正とする（innerWidth はオーバーフロー時に自動拡大する）
- 7.1: フォーカス可視の検証はクラス名でなく `getComputedStyle` + `:focus-visible` 一致で判定（実描画ベース）。走査末尾で送信ボタン到達を assert して空振り緑を防ぐ。E2E はローカル完走可（homebrew postgres 16 + migrations + seed.sql + mock-gemini.mjs・6/6 緑）
- 5.2: 対象は**5面**（design 記載の4面＋スコープ拡張の delivery-job）。Next standalone 型3面（survey-web/store-detail/dashboard-web）は deps 段のマニフェスト COPY のみ（`@fwlm/ui` はソース直配布のため build 段の tsc 不要・standalone トレースが同梱）。delivery-job 型2面（line-webhook/delivery-job）は3点則（deps COPY・`pnpm -C packages/design-tokens run build`・runner 同梱）。ローカルに docker が無いため実ビルド検証は PR の docker-build ゲート（7イメージ matrix）に委ねる
- 4（スコープ拡張・ユーザー承認済み）: **spec の色調査漏れを発見** — `delivery-job/src/flex.ts`（機能1 日次サマリー配信の LINE Flex）にも直書き色7箇所（#666666×2・#aaaaaa×5）が存在。要件 4.1 は全 LINE Flex が対象のため同時にトークン化した。`lineColors.muted: '#AAAAAA'` を新役割として追加。**Flex の色指定は大小非区別のため描画は現行と同一**だが snapshot は byte 比較のため 25 行更新（差分が `#aaaaaa`→`#AAAAAA` のみであることを機械検証済み）。delivery-job も design-tokens 依存を得たため **5.2 の Dockerfile 対応は 4面→5面**（delivery-job は delivery-job 型＝3点則が必要）
