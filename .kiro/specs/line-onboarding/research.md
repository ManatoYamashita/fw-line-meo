# Research & Design Decisions: line-onboarding

## Summary

- **Feature**: `line-onboarding`
- **Discovery Scope**: New Feature（新規 Cloud Run サービス＋外部 API 2 系統の統合。full discovery 実施）
- **Key Findings**:
  - LINE Webhook は「2 秒以内に 2xx」を要求し、replyToken は 1 回限り・受信後約 1 分有効。再配信イベントの replyToken も有効なため、`webhookEventId` 重複排除と再配信有効化の組合せで at-least-once 処理を安全化できる
  - Places API は New（`places.googleapis.com/v1/places:searchText`）一択（レガシーは新規有効化不可）。FieldMask を `id, displayName, formattedAddress, location, types` に固定すると Pro SKU・月 5,000 コール無料枠に収まる
  - DB スキーマ（`owners.onboarding_status`・`stores.place_status`・CHECK 制約）と write-boundary（owners/stores = TS Webhook）は four-tier-data-model で本機能を予見済み。新規テーブル 3 つの追加のみで成立する

## Research Log

### LINE Messaging API 仕様（`.claude/skills/messaging-api/references/` を一次情報源として精査）

- **Context**: Webhook 基盤・会話フロー・リッチメニューの設計に必要な制約の確定
- **Sources Consulted**: 同スキル references（webhook-events / message-sending / action-objects / rich-menu / flex-message / api-common / user / channel-token / message-objects）
- **Findings**:
  - 署名検証: `x-line-signature` ヘッダ・HMAC-SHA256（raw body・key=Channel Secret）・base64。パース前に raw body で検証必須
  - follow / message(text) / postback イベントはいずれも `replyToken` あり。unfollow は無し。全イベントに `webhookEventId`（ULID）と `deliveryContext.isRedelivery`
  - 接続確認で `events: []` が届く（200 を返すだけでよい）。ユーザー未同意時は `source.userId` が欠落しうる
  - Reply は無料・レート 2,000 req/sec・`X-Line-Retry-Key` 非対応。Push は課金対象。1 リクエスト最大 5 メッセージ
  - postback `data` は最大 300 文字・タップでそのまま webhook に往復
  - Flex カルーセルは最大 12 バブル・50KB・altText 必須（最大 400 字）。テキストメッセージ最大 5,000 字（UTF-16）・Quick Reply 最大 13 項目
  - リッチメニュー: 作成→画像アップロード（JPEG/PNG・最大 1MB・幅 800–2500px・アスペクト比≥1.45）→デフォルト設定 or ユーザー個別リンク。個別リンクは即時反映・デフォルトより優先。作成/削除は 100 req/hr
  - チャネルアクセストークン: long-lived は開発専用。short-lived(30日・リフレッシュ不可)/v2.1(JWT)/stateless(~15分・発行無制限) から選択
- **Implications**: 同期処理でも reply は 1 分窓内で間に合う。重複排除テーブルが必須。リッチメニューは「デフォルト＋完了時の個別リンク」の 2 枚構成で要件を満たせる

### Google Places API (New) Text Search

- **Context**: 店名検索の実現手段・コスト・レガシー廃止状況の確認（discovery viability check で Web 調査済み）
- **Sources Consulted**: Google Maps Platform 公式（Text Search (New)・Usage and Billing・2025年3月改定）
- **Findings**: `POST https://places.googleapis.com/v1/places:searchText`・`X-Goog-Api-Key`＋`X-Goog-FieldMask` ヘッダ必須・API キー方式可。レガシー Places API は新規プロジェクトで有効化不可。`id` のみ=Essentials（月 10,000 無料）、`displayName/formattedAddress/location/types` 込み=Pro（$32/1,000・月 5,000 無料）。`rating` 等を混ぜると Enterprise へ昇格
- **Implications**: FieldMask 固定を設計で明文化（コスト規律）。低ボリュームのオンボーディング用途は無料枠内

### @line/bot-sdk v11 / Hono / Node ランタイム

- **Context**: SDK の保守状況と Hono での署名検証可否（discovery viability check）
- **Findings**: v11.0.0（活発に保守・Apache-2.0・依存は実質 @types/node のみ）。Hono では `await c.req.text()` で raw body を取得し `validateSignature()` → 手動 JSON parse のパターンが確立。v11 タグの engines は >=20 だが master は >=22（次メジャーで Node 22 必須の公算大）
- **Implications**: line-webhook は Node 22 ランタイムで開始。Express middleware は使わない

### 既存コードベース・インフラ資産

- **Context**: 踏襲すべきパターンと再利用可能な資産の確認
- **Findings**: dashboard-api（Hono）の「loadConfig / 依存注入 / thin route / multi-stage Dockerfile」パターン、`@fwlm/db` のアクセサ＋`*.db.test.ts`＋`with-test-db.sh` テスト基盤、TF `run-services` モジュール（`var.services` 追記のみで SA・secret・Cloud SQL ロール自動配線）、Secret Manager 枠 `line-channel-secret`・`line-channel-access-token`・`places-api-key` が既存。`db/write-boundary.md` は owners/stores の書込責任を既に「TS（Webhook）」と宣言済み
- **Implications**: 新規性は Webhook 処理と会話状態機械のみ。周辺は全て既存パターンの複製で済む

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| チャット完結＋拡張縫（採用） | 会話 handler と店舗特定サービス関数を分離した単一 Cloud Run サービス | MVP 最速・CI 検証容易・LIFF/#5 代行が後から同じ関数を呼べる | チャット UX の表現力に上限 | discovery でユーザー選択済み |
| LIFF 検索画面型 | リッチメニューから LIFF ページで検索・選択 | 検索 UX がリッチ | LIFF 登録・ID トークン検証・別 Web サーフェスで規模増・CI で E2E 困難 | 却下（第2フェーズ拡張点として温存） |
| 200 先行返却＋非同期処理 | Webhook で即 200・裏で reply | 2 秒制約に絶対安全 | Cloud Run の CPU スロットリング対策（instance-based billing）が必要 | 却下 → Design Decision 1 |

## Design Decisions

### Decision 1: Webhook 応答戦略 = 予算付き同期処理＋再配信・重複排除で保全

- **Context**: LINE は 2 秒以内の 2xx を要求。Places 検索（200–800ms）を挟む処理を同一リクエストで行うか
- **Alternatives Considered**: (1) 200 先行返却＋バックグラウンド reply（CPU always-allocated 必須） (2) 同期処理（reply 完了後に 200）
- **Selected Approach**: (2) 同期処理。Places 呼び出しに 1.5 秒タイムアウトを課し、handler 全体を replyToken の 1 分窓内で完結させる。LINE 側の Webhook 再配信を有効化し、`webhookEventId` の重複排除テーブルで at-least-once を冪等化
- **Rationale**: 低ボリューム MVP では tail latency 超過が稀で、超過時も再配信＋重複排除で救済される。ゼロスケール（コスト原則）を維持できる
- **Trade-offs**: コールドスタートと重なると 2 秒を超え「配信失敗→再配信」が起きうる（機能的には無害・冪等）。将来ボリューム増時は (1) へ移行
- **Follow-up**: デプロイ後 smoke で応答時間を実測。LINE Developers Console で再配信を有効化する運用手順を runbook に記載

### Decision 2: チャネルアクセストークン = stateless トークンの実行時発行＋メモリキャッシュ

- **Context**: long-lived は公式に開発専用。short-lived(30日) はリフレッシュ不可で定期再発行の運用負担、v2.1 は JWT 鍵ペア管理が MVP に過剰
- **Selected Approach**: stateless channel access token（有効 ~15 分・発行無制限）を LINE_CHANNEL_ID＋LINE_CHANNEL_SECRET で実行時発行し、有効期限内はメモリキャッシュ。発行 API 詳細は実装時に channel-token.md を参照
- **Rationale**: 静的トークンの保管・ローテーション運用が消滅する。ゼロスケールのインスタンス再起動とも相性が良い
- **Trade-offs**: 初回リクエストにトークン発行 1 往復が加算される（キャッシュで償却）
- **Follow-up**: 既存 Secret Manager 枠 `line-channel-access-token` は line-webhook では**未配線**（Console 運用・将来用に温存）。誤って配線しないこと

### Decision 3: リッチメニュー = 2 枚構成（デフォルト＋完了時の個別リンク）

- **Context**: Req 6 は「オンボーディング中の導線」と「完了後の切替」を要求
- **Selected Approach**: セットアップスクリプト（運用ワンショット）が「オンボーディング用」「完了後用」の 2 メニューを作成し、前者をデフォルト設定。店舗特定完了時に完了後メニューをユーザー個別リンク（即時反映・デフォルトより優先）。richmenuswitch（タブ切替）は不使用
- **Rationale**: 個別リンクは 2,000 req/sec でレート懸念なし。作成系 100 req/hr の制約はセットアップ時のみ
- **Trade-offs**: 完了後メニューの richMenuId を env（`LINE_RICHMENU_COMPLETED_ID`）で配る運用手順が 1 つ増える
- **Follow-up**: メニュー画像 2 枚（PNG・アスペクト比≥1.45）を静的アセットとしてリポジトリに置く

### Decision 4: 会話状態 = `onboarding_sessions` テーブル（owner と分離）

- **Context**: 招待コード検証前の LINE ユーザーには owner レコードが存在できない（`owners.agency_id` NOT NULL）
- **Selected Approach**: `line_user_id` を PK とするセッションテーブルに stage・候補スナップショット・失敗カウンタを永続化。owner レコードは有効な招待コード検証時に作成
- **Rationale**: 4 階層モデルの不変条件（代理店未確定オーナーの不存在＝Req 2.4）を CHECK 制約 `(stage = 'await_invite_code') = (owner_id IS NULL)` で構造的に保証できる
- **Trade-offs**: セッションと owner の 2 箇所に状態が分かれる（stage は会話の位置、onboarding_status は業務状態と役割を分離）

### Decision 5: 候補選択 = インデックス方式 postback＋セッション照合

- **Context**: postback data は最大 300 文字。place_id 直載せも可能だが、古いカルーセルからの操作や偽造 data の混入を防ぎたい
- **Selected Approach**: セッションに提示済み候補（最大 10 件）を jsonb で保存し、postback data には `a=select&i=<index>` のみを載せ、受信時にセッションの候補と照合する
- **Rationale**: 検証がセッション内で完結し、選択操作の有効性（3.4 の再検索で候補が入れ替わった場合の古い postback 無効化）を自然に保証

### Decision 6: 外部ライブラリ最小方針の適用

- **Build vs Adopt**: LINE SDK = adopt（@line/bot-sdk v11・公式・Apache-2.0）／Places = fetch 直叩き（公式 SDK 不採用・エンドポイント 1 本に SDK は過剰）／状態機械 = 手書き（4 状態に XState 等は過剰）／HTTP = Hono（dashboard-api と統一）
- **Simplification**: Push 送信は本 spec のスコープでは不要（全応答が reply で完結）のため LineMessenger 契約から除外。機能1（Issue #4）が push を追加する際の拡張点として契約に余地を残す

## Risks & Mitigations

- コールドスタート＋Places tail で 2 秒超過 → 再配信有効化＋`webhookEventId` 冪等化で機能被害ゼロ。頻発時は CPU always-allocated へ移行（Decision 1 Follow-up）
- リッチメニュー画像アセットの準備（デザイン作業） → MVP はテキスト主体のシンプル PNG 2 枚をリポジトリ同梱。差し替えは新メニュー作成で対応（画像更新不可のため）
- Places 検索の精度（同名店・チェーン店の混同） → 候補に住所を併記（Req 3.1）し、確認ステップ（Req 4.1）で誤選択を防ぐ
- 招待コードの秘匿性 → 総当たり 5 回で一時停止（Req 2.3・lockout 10 分）。コードは十分な空間（英大文字＋数字 8 桁級）で発行する運用
- LINE はログを提供しない → 自前 structured logging（`X-Line-Request-Id` 記録）。オーナーの自由入力テキストはログ非出力（survey-web と同規律）

## References

- `.claude/skills/messaging-api/references/`（webhook-events / message-sending / action-objects / rich-menu / flex-message / api-common / user / channel-token / message-objects）— LINE API 一次情報源（実装時も必ず再参照）
- [Text Search (New) | Places API](https://developers.google.com/maps/documentation/places/web-service/text-search) — searchText 仕様
- [Places API Usage and Billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing) — SKU/無料枠
- [@line/bot-sdk (npm)](https://www.npmjs.com/package/@line/bot-sdk) / [Releases](https://github.com/line/line-bot-sdk-nodejs/releases) — v11・保守状況
- `db/write-boundary.md`・`db/ERD.md` — 書込境界 SoT（本 spec で 3 テーブル追記）
- `.kiro/specs/line-onboarding/brief.md` — discovery 成果（スコープ・境界の合意）
