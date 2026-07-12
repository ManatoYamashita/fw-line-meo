# Brief: line-onboarding

## Problem

飲食店オーナーがサービスに到達する入口が存在しない。機能3（review-acquisition）は完成したが、実オーナーが LINE 友だち追加から店舗特定（Place ID 確定）に至る経路がなく、seed した架空店舗以外にサービスを提供できない。また、全 LINE 系機能（機能1 の Flex 配信・将来の機能2）が乗る Webhook 基盤自体が未構築である。

## Current State

- 実装済み: 4階層 DB スキーマ／GCP インフラ（Terraform）／機能3（survey-web・dashboard-api）
- `owners` テーブルは `line_user_id`（UNIQUE NOT NULL）・`onboarding_status`（ENUM: `pending → store_identified → active`）を備え、`stores` は `place_id`／`place_status`（`pending`/`confirmed`・CHECK 制約 `confirmed ⇔ place_id IS NOT NULL`）を備える — オンボーディング状態はスキーマで既に設計済み
- Secret Manager に `line-channel-secret`・`line-channel-access-token`・`places-api-key` の枠が既存（値は out-of-band 投入）
- Cloud Run の TF モジュール `run-services` は `var.services` への追記のみで新サービスを展開可能
- `@fwlm/db` に owners 用アクセサは未実装（新規追加が必要）
- LINE Webhook 受信・署名検証・イベント dispatch・会話状態管理・Places 連携はすべて未実装

## Desired Outcome

Issue #6 の完了条件「**友だち追加 → 店舗特定 → 機能1 配信対象として登録される流れが動作**」。具体的には:

1. オーナーが単一 LINE 公式アカウントに友だち追加（follow イベント）
2. 代理店ごとの招待コードをチャット入力 → 該当 agency に紐付いた owner レコード作成
3. 店名をチャット入力 → Places Text Search → Flex カルーセルで候補提示 → postback で選択・確認
4. store 作成＋`place_status='confirmed'`＋`onboarding_status='store_identified'` へ遷移
5. 完了メッセージで機能1 の先行体験を案内（配信自体は Issue #4 の領分）

## Approach

**チャット完結＋拡張縫（extension seam）設計**（discovery で 3 案比較の上ユーザー選択）:

- 新規 Cloud Run サービス `ts/apps/line-webhook`（Hono・既存 dashboard-api のパターン踏襲: loadConfig / 依存注入 / thin route / multi-stage Dockerfile）
- 署名検証は `await c.req.text()` で raw body を取得し `@line/bot-sdk` v11 の `validateSignature()` → 検証後に JSON parse（Express middleware は使わない）
- 会話状態機械（招待コード待ち／店名待ち／候補確認待ち）は Postgres に永続化
- **店舗特定ロジックは会話 handler から分離したサービス関数**とし、将来 LIFF・代理店ダッシュボード（#5 代行経路）が同じ関数を呼べる境界にする
- Places API (New) Text Search（`POST places.googleapis.com/v1/places:searchText`・API キー方式・FieldMask は `id, displayName, formattedAddress, location, types` の 5 フィールド固定 = Pro SKU・月 5,000 コール無料枠内）

**viability check 済み（ショーストッパーなし）**。設計フェーズで明示すべき調整点:
- (a) **Webhook 応答戦略**: LINE は 2 秒以内の 2xx を要求・replyToken は 1 回限り約 1 分有効。「処理予算付き同期（Places タイムアウト設定込みで reply 完了後 200）」か「200 先行返却＋replyToken 窓内バックグラウンド reply（Cloud Run の CPU 割当方式に依存）」かを設計で確定する。低ボリューム MVP は前者でも成立
- (b) **Node 22 ランタイム採用**（@line/bot-sdk v11 の engines は >=20 だが master は >=22。次メジャーで必須化の公算大）
- (c) `webhookEventId` による**重複イベント排除は必須実装**（再配信 `deliveryContext.isRedelivery` 対応）

## Scope

- **In**:
  - LINE Webhook 受信基盤（署名検証・イベント dispatch・重複排除）
  - `@line/bot-sdk` v11 による reply/push クライアント配線
  - 段階的オンボーディング会話フロー（follow → 招待コード → 店名検索 → 候補選択 → 確定）
  - 代理店ごとの招待コード機構（**新テーブル追加 = スキーマ変更・書込責任 TS**。コード発行はまず運営手動 SQL、ダッシュボード発行 UI は #5）
  - Places Text Search 連携（リアルタイム・TS 側）
  - `@fwlm/db` への owners アクセサ追加（`findOwnerByLineUserId` / 作成 / 状態遷移）と store 作成・place 確定の共有サービス関数
  - リッチメニュー最小形（オンボーディング導線・状態に応じた案内）
  - infra への line-webhook サービス追加（additive・`run-services` モジュール再利用）
- **Out**:
  - LIFF 設定 UI（配信時刻等）→ 機能1 spec（Issue #4）へ
  - 機能1 の Flex 配信・競合自動提案（半径1km・上位5店）→ Issue #4
  - 代理店ダッシュボードでの代行登録 UI・招待コード発行 UI → Issue #5
  - Google OAuth・機能2 → 第2フェーズ
  - 客向け機能への変更（機能3 は LINE 非経由のまま）

## Boundary Candidates

- **Webhook 基盤**（署名検証・dispatch・重複排除・SDK 配線）↔ **オンボーディング業務フロー**（会話状態機械）— 単一 spec 内の明示的コンポーネント境界として設計
- **店舗特定サービス関数**（Places 検索・store 作成・place 確定・状態遷移）↔ 会話 handler — 将来 LIFF／#5 代行が再利用する縫い目
- **招待コード機構**（発行・検証）— 検証は本 spec、発行 UI は #5

## Out of Boundary

- 機能1 の配信ロジック・配信時刻設定（本 spec は「配信対象として登録された状態」を作るまで）
- 代理店ダッシュボードの画面・API（#5）
- 競合5店の自動提案・微調整（要件 §4 手順2 = Issue #4 の領分）

## Upstream / Downstream

- **Upstream**: four-tier-data-model（owners/stores スキーマ・ENUM）、gcp-infra-foundation（Cloud Run/Secret Manager/TF モジュール）、`@fwlm/db`（pool・アクセサパターン）
- **Downstream**: 機能1（Issue #4・配信対象の owner/store 集合と push 送信基盤を利用）、代理店ダッシュボード（Issue #5・店舗特定サービス関数と招待コード発行を利用）、機能2（第2フェーズ・Webhook 基盤を利用）

## Existing Spec Touchpoints

- **Extends**: なし（新規境界）。ただし `@fwlm/db`（review-acquisition が確立）へのアクセサ追加、infra（gcp-infra-foundation）への additive なサービス追加を行う
- **Adjacent**: review-acquisition（dashboard-api の Hono パターンを踏襲・変更はしない）

## Constraints

- **LINE API は記憶で書かない**: `.claude/skills/messaging-api/` の references を必ず参照（署名検証・webhook-events・flex-message・rich-menu・message-sending）
- **Webhook 2 秒制約**: 2xx を 2 秒以内に返す。replyToken は 1 回限り・約 1 分有効。reply は無料・push は課金カウント — replyToken を優先活用
- **書き込み境界**: owners / stores / 会話状態 / 招待コードテーブルの書込責任は TS（line-webhook）。新テーブル追加時は db/docs の write-boundary に明記し `make db-verify-docs` を通す
- **4階層モデル不可侵**: `owners.agency_id` NOT NULL — 招待コード経由で必ず agency が確定してから owner を作成する
- **スクレイピング禁止**: 店舗検索は Places API (New) のみ。FieldMask を 5 フィールドに固定し Enterprise SKU 昇格（rating 等）を混入させない
- **個人情報**: オーナーの `line_user_id`・表示名は取得するが（オーナーは契約主体・客ではない）、来店客の情報は本 spec に登場しない
- **マルチテナント**: 単一 LINE 公式アカウント。チャネルは運営保有・secret は既存の Secret Manager 枠を使用
- **Node 22** を line-webhook のランタイムに採用（既存アプリは Node 20 のまま・モノレポ内共存の扱いは設計で確定）
- Markdown 成果物は日本語（`spec.json.language = ja`）
