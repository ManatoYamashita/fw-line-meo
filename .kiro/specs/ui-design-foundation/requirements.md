# Requirements Document

## Project Description (Input)

出典: GitHub Issue #41（親・トラッキング） https://github.com/ManatoYamashita/fw-line-meo/issues/41
関連子 Issue: #42（LINE）/ #43（LIFF store-detail）/ #44（WebApp 客向け survey-web）/ #45（WebApp 管理向け dashboard-web）

### 誰が問題を抱えているか
- **来店客**: QR から survey-web（機能3・本番稼働中）に流入するが、無装飾の素の HTML でありブランド体験・信頼感を欠く（口コミ獲得の転換率に影響）。
- **飲食店オーナー**: LINE（Flex Message・リッチメニュー）と LIFF（store-detail・競合サマリー閲覧）で日々接するが、Flex は色が直書きで散在し、LIFF は無装飾。
- **運営・代理店**: dashboard-web（RBAC 管理画面）を使うが、ナビ・一覧・フォームがブラウザ標準描画のまま。
- **開発チーム**: 共有 UI パッケージもデザイントークンも無く、各アプリが生の HTML 要素を個別にベタ書きしており、一貫性・再利用性が担保できない。

### 現状（2026-07-20 調査）
- リポジトリ全体で `.css` 0件、`tailwind.config.*` / `postcss.config.*` 0件、`className` / インライン style 0件。
- 共有 UI パッケージ・デザイントークン無し（`ts/packages/` は `db` と `store-identification` のみ）。
- 色を持つのは LINE Flex のみだが `#888888` / `#666666` / `#333333` / `#1DB446` / `#F0FBF4` が `ts/apps/line-webhook/src/line/messages.ts` に散在し、共通定数化されていない。
- 良い土台: 各画面ともセマンティック HTML + ARIA 属性（`aria-label` / `aria-pressed` / `role="alert"` / `scope="col"` / `lang="ja"`）は丁寧に付与済み。スタイルを載せる下地は健全。

### 何を変えるべきか（本 spec のスコープ = 基盤の確立）
本 spec は親 Issue #41 の**基盤**（デザインシステムの新設）に対応する。面ごとの実装（#42〜#45）は本基盤の上で各 spec/PR として行う。
- **コンポーネント基盤 = Base UI（`@base-ui/react`）** を採用。Radix / Floating UI / MUI チームによる unstyled・アクセシブルな React プリミティブ。CSS を同梱せず `className` に Tailwind を当て `data-*` 状態属性でスタイル分岐する。既存 ARIA を置換ではなく強化する。
- **スタイリング = Tailwind CSS**（build-time・`next build` 統合・トークンを config で一元管理）。
- **適用範囲の区別**: Base UI + Tailwind は React 3アプリ（store-detail / survey-web / dashboard-web）に適用。**LINE Flex は React ではない**ため Base UI 対象外で、色トークンの抽出・パレット統一のみ。
- **デザイントークンの単一情報源**を設ける（色・タイポ・spacing・radius・shadow）。Tailwind config（theme）が web の source-of-truth。LINE Flex の色も同じトークン値へ揃える（可能なら共有モジュール化）。
- **共有 UI プリミティブの置き場所**（`ts/packages/ui` 新設で Base UI をラップした Button / Card / Field 等を全アプリ共有 か 各アプリ内）を決定。新設時は Dockerfile の workspace 依存3点則（deps の package.json コピー・build の tsc・runner 同梱）を遵守。
- **段階適用**: 基盤 → 各面。1つの巨大 PR にせず面ごとに分割。顧客接点（LINE + survey-web）を優先。

### 制約・前提
- **React 19 / Next.js 16 前提**。Base UI は React 19 対応（element 形式 render prop の既知内部ワークアラウンドあり・最新版で解消）。導入時に最新版・パッケージ名（`@base-ui/react`、旧 `@base-ui-components/react`）を確認。
- `NEXT_PUBLIC_*` は build 時にクライアントバンドルへインライン化される（Cloud Run のランタイム env 不可）。Tailwind 導入が build 経路・Dockerfile の build 段に影響しないこと。dashboard-web / store-detail は既に build-arg 運用。
- **外部依存の扱い**: Base UI・Tailwind は外部依存。CLAUDE.md の原則（外部ライブラリ原則禁止）に対し、UI 整備の速度・一貫性・アクセシビリティ担保のため本件で明示承認（ユーザー指定）。
- **性能予算の維持**: survey-web は ts-ci の `perf:budget`・Lighthouse mobile（LCP 3秒・Req 2.8）がある。基盤導入がこれを割らないこと。
- **アクセシビリティ**: 既存の ARIA / セマンティック HTML を壊さない（スタイルは付加、a11y は Base UI で強化）。
- **対象外**: 第2フェーズ機能（GBP 投稿等）の画面。ブランドカラー・トーンの最終決定（要合意・ロゴ/ブランドガイドがあれば提供）。

## Introduction

本仕様は、fw-line-meo の全 UI 面（客向けアンケート Web = survey-web、LIFF 詳細閲覧 = store-detail、運営・代理店ダッシュボード = dashboard-web、LINE メッセージ = line-webhook）が共有する **UI デザイン基盤** の要件を定義する。現状はリポジトリにスタイル定義が一切存在せず、Web 3面はブラウザ標準描画、LINE メッセージのみが直書きの色を持つ。本基盤は、デザイントークンの単一情報源・共通 UI コンポーネント・各面への最小適用を確立し、面ごとの本格的な画面整備（子 Issue #42〜#45）が一貫した土台の上で行える状態を作る。

## Boundary Context

- **In scope**:
  - デザイントークン（色・タイポグラフィ・余白・角丸・影）の単一情報源の確立
  - 基本 UI 部品（ボタン・入力欄・カード等）の共通コンポーネント化と Web 3面からの利用可能化
  - Web 3面への基盤接続（トークンに基づく基本スタイルの最小適用。ブラウザ標準描画からの脱却）
  - LINE メッセージ配色のトークン統一（直書き色の排除）
  - アクセシビリティ・性能・既存ビルド/デプロイ経路の非後退
- **Out of scope**:
  - 面ごとの本格的な画面リデザイン・情報設計の変更（子 Issue #42〜#45 で実施）
  - リッチメニュー画像の刷新（#42 で要否判断）
  - ダークモード対応
  - 第2フェーズ機能（GBP 投稿等）の画面
  - ブランドカラー・トーンの最終決定（初期パレットは既存 LINE メッセージのブランドグリーン `#1DB446` 系を基調として出発し、ブランドガイド確定時はトークン差し替えのみで追従する）
- **Adjacent expectations**:
  - 採用技術（Base UI + Tailwind CSS）はユーザー決定済みの制約であり（親 Issue #41）、具体的な構成・配置は design フェーズで Boundary Commitments として確定する
  - 子 Issue #42〜#45 の面ごと実装は本基盤のトークン・共通部品を利用することを前提とする
  - 既存の CI・デプロイガード（デプロイカバレッジ検証・PR 段階 docker build 検証・placeholder 検出）は本基盤導入後も全て緑であることを前提とする

## Requirements

### Requirement 1: デザイントークンの単一情報源

**Objective:** As a 開発チーム, I want 色・タイポグラフィ・余白・角丸・影のデザイントークンを単一情報源で管理したい, so that 全 UI 面の見た目が一貫し、変更が一箇所の修正で全面に反映できる

#### Acceptance Criteria

1. The UI デザイン基盤 shall 色・タイポグラフィ（フォントファミリ・サイズ階層）・余白・角丸・影のデザイントークンを単一の定義箇所で管理する
2. When トークンの値が変更されたとき, the UI デザイン基盤 shall 再ビルドのみで Web 3面（survey-web / store-detail / dashboard-web）のスタイルへ変更を一括反映する
3. The UI デザイン基盤 shall 同一の意味役割（本文色・補足色・ブランド基調色・背景色など）に対して1つのトークンを対応付け、同一役割への複数値の併存を排除する
4. If トークン定義を経由しない直書きの色指定が Web 3面のスタイルへ混入した場合, the 継続的検証 shall その混入を検出して失敗する

### Requirement 2: 共通 UI コンポーネント

**Objective:** As a 開発チーム, I want 基本 UI 部品を共通コンポーネントとして一度だけ実装し全 Web 面で再利用したい, so that 同じ部品が画面ごとに別実装・別デザインになる事態を防げる

#### Acceptance Criteria

1. The UI デザイン基盤 shall ボタン・テキスト入力・チェックボックス・カード・見出し・通知（成功/エラー表示）を含む基本部品を共通コンポーネントとして提供する
2. The 共通コンポーネント shall Web 3面（survey-web / store-detail / dashboard-web）のいずれからも追加実装なしで利用できる
3. While 異なる Web 面に同一種類の共通コンポーネントが表示されているとき, the 共通コンポーネント shall 同一の見た目と状態表現（hover / focus / disabled / エラー）を提示する
4. The 共通コンポーネント shall キーボードのみで操作を完結でき、支援技術に対して役割と状態を通知する

### Requirement 3: Web 3面への基盤接続（最小適用）

**Objective:** As a 来店客・オーナー・運営/代理店, I want 各 Web 画面がブラウザ標準の素の描画ではなく読みやすい基本スタイルで表示されてほしい, so that サービスへの信頼感を持って操作できる

#### Acceptance Criteria

1. When 基盤導入後に survey-web / store-detail / dashboard-web の任意の画面を表示したとき, the 各アプリ shall トークンに基づくフォント・文字色・背景・余白を適用した状態で描画する
2. The 基盤接続 shall 各画面の既存の機能挙動（フォーム送信・API 呼び出し・画面遷移・認証・導線）を変更しない
3. While モバイル端末で survey-web または store-detail を表示しているとき, the 画面 shall 横スクロールを発生させずに閲覧・操作できる
4. The 基盤接続 shall 面ごとの情報設計・画面構成の変更を含まない（本格リデザインは子 Issue #42〜#45 の責務）

### Requirement 4: LINE メッセージ配色のトークン統一

**Objective:** As a 飲食店オーナー, I want LINE で受け取るメッセージの配色が Web 面と同じブランドパレットに統一されてほしい, so that どの接点でも一貫したサービス体験を得られる

#### Acceptance Criteria

1. The LINE メッセージ（Flex Message） shall デザイントークンで定義された配色と同一の値のみを使用し、トークン外の直書き色を持たない
2. When 配色トークンの値が変更されたとき, the LINE メッセージの配色 shall 単一の定義箇所の修正のみで更新される
3. The 配色統一 shall 既存メッセージ種別（候補カルーセル・確認・完了・既登録エラー・テキスト案内）の文言と情報構造を変更しない
4. If トークン定義を経由しない直書きの色指定が LINE メッセージ定義へ混入した場合, the 継続的検証 shall その混入を検出して失敗する

### Requirement 5: アクセシビリティの非後退と強化

**Objective:** As a 来店客（支援技術利用者を含む）, I want スタイル導入後も支援技術・キーボードで従来どおり操作できてほしい, so that 誰でも口コミ投稿・情報閲覧を完了できる

#### Acceptance Criteria

1. The 基盤適用後の各画面 shall 既存のセマンティック HTML 構造と支援技術向けの役割・状態通知を後退させない
2. The 基盤適用後のテキストと背景の組み合わせ shall WCAG 2.1 AA 相当のコントラスト比（通常文字 4.5:1 以上）を満たす
3. When 操作可能要素にキーボードフォーカスが当たったとき, the 画面 shall 視認可能なフォーカス表示を提示する

### Requirement 6: 性能・品質・出荷経路の非後退

**Objective:** As a 運営, I want 基盤導入が既存の性能予算・自動検証・本番出荷経路を一切劣化させないでほしい, so that 稼働中のサービス（特に本番運用中の survey-web）の品質を維持したまま UI 整備を進められる

#### Acceptance Criteria

1. The survey-web shall 基盤導入後も既存の性能予算（モバイル表示での LCP 3秒以内・既定のクライアント配布サイズ予算）を満たす
2. When 基盤導入の変更が取り込まれるとき, the 既存の自動検証（静的検査・ビルド・単体/統合テスト・E2E・性能計測） shall すべて成功している
3. The 基盤導入 shall 全7コンテナイメージのビルドおよび既存の本番反映経路を成功したままに維持する
4. If 基盤導入により客向け画面の初回表示が体感可能に遅延した場合, the 開発チーム shall 出荷前に性能予算内へ是正する

## 今後の判断事項（design フェーズへの引き継ぎ）

- 共通コンポーネントの配置（`ts/packages/ui` 新設 か 各アプリ内共有）— 新設時は Dockerfile の workspace 依存3点則を遵守
- トークンの Web / LINE 間の共有方式（共有モジュール参照 か 生成同期 か 手動同期＋機械検証）
- 初期パレットの具体値（ブランドグリーン `#1DB446` 基調からの展開）
