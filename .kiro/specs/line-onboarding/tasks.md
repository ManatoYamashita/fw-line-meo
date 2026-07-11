# Implementation Plan: line-onboarding

## 1. Foundation: DB スキーマとアプリ雛形

- [x] 1.1 (P) DB スキーマ拡張（招待コード・会話セッション・イベント重複排除）
  - migration `0003_line_onboarding.sql`: `onboarding_stage` ENUM、`agency_invite_codes`、`onboarding_sessions`（CHECK `ck_session_owner_stage`）、`line_webhook_events` を追加
  - `db/write-boundary.md`・`db/ERD.md` に新3表の書込責任（TS リアルタイム応答層）を追記
  - 完了状態: `make db-migrate && make db-test && make db-verify-docs` が緑
  - _Requirements: 2.4, 2.5, 5.1, 5.4_

- [x] 1.2 DB アクセサ追加（owners/invite-codes/sessions/webhook-events）
  - `@fwlm/db` に `owners.ts`（findOwnerByLineUserId/createOwner/markOwnerStoreIdentified）、`invite-codes.ts`、`onboarding-sessions.ts`、`webhook-events.ts` を追加。`stores.ts` に `findStoreByPlaceId`/`createConfirmedStore` を追加
  - アクセサは owners/stores/invite-codes/sessions/webhook-events のみを対象とし、来店客（customer）系テーブルへの参照を一切持たない
  - 完了状態: 各アクセサの基本 `*.db.test.ts` が実 postgres で緑
  - _Requirements: 2.1, 2.4, 2.5, 4.2, 4.4, 5.1, 5.4, 7.3_

- [x] 1.3 (P) line-webhook アプリ雛形（Hono・Node22・config検証）
  - `package.json`/`tsconfig.json`/`Dockerfile`（node:22-slim）、`config.ts`（`LINE_CHANNEL_ID`/`LINE_CHANNEL_SECRET`/`PLACES_API_KEY`/`LINE_RICHMENU_COMPLETED_ID`/`PORT` の必須検証）、`index.ts` skeleton、`GET /healthz`
  - 完了状態: `app.request('/healthz')` が 200、必須 env 欠落で config が明示エラーを投げる（ユニットテスト緑）
  - _Requirements: 7.1_

- [x] 1.4 Webhook 署名検証
  - `webhook/signature.ts`: raw body の HMAC-SHA256 検証（`@line/bot-sdk` の `validateSignature` を使用。パース前の raw body に適用）
  - 完了状態: 正しい署名は true、改竄 body やヘッダ欠落は false（ユニットテスト緑）
  - _Requirements: 7.1_

## 2. Core: 外部統合・会話基盤コンポーネント

- [x] 2.1 (P) イベント正規化・重複排除ディスパッチャ
  - `webhook/dispatch.ts`: `events: []` 接続確認への 200 対応、follow/message(text)/postback の正規化、`source.userId` 欠落・未知イベント型の無視、`webhookEventId` による冪等化
  - 完了状態: 同一 `webhookEventId` の 2 回目の処理がスキップされる（ユニットテスト緑）
  - _Requirements: 1.1, 5.4_
  - _Boundary: EventDispatcher_

- [x] 2.2 (P) オンボーディング状態機械の型と postback 符号化
  - `onboarding/stages.ts`: `OnboardingStage` 型、`PostbackAction` 判別 union、`encodePostback`/`decodePostback`（300 字以内保証）
  - 完了状態: 全遷移の符号化/復号往復テストと、不正 data で null が返るテストが緑
  - _Requirements: 1.3, 4.5, 4.6_
  - _Boundary: OnboardingStages_

- [ ] 2.3 (P) Google Places 検索アダプタ
  - `places/search.ts`: `searchText` 呼び出し（FieldMask を `id,displayName,formattedAddress,location,types` に固定）、1.5 秒タイムアウト、`found`/`empty`/`error` の型付き結果
  - 完了状態: fetch モックで FieldMask ヘッダ固定・タイムアウト時 error・0 件時 empty が確認できる（ユニットテスト緑）
  - _Requirements: 3.1, 3.2, 3.3, 3.5_
  - _Boundary: PlacesSearchAdapter_

- [ ] 2.4 (P) LINE メッセンジャーアダプタ
  - `line/client.ts`: stateless チャネルアクセストークンの発行＋メモリキャッシュ、`reply`、`getProfile`（displayName のみ返す）、`linkRichMenu`
  - 完了状態: モックで token 発行・reply 呼び出し・profile 404 時の null 返却が確認できる（ユニットテスト緑）
  - _Requirements: 4.3, 5.5, 6.3, 7.2_
  - _Boundary: LineMessenger_

- [ ] 2.5 (P) メッセージビルダー
  - `line/messages.ts`: 挨拶・招待コード案内・候補カルーセル（最大 10 バブル・altText 必須）・確認・完了メッセージ（すべて日本語）
  - 完了状態: カルーセルのバブル数上限・altText 付与・postback data 形式がテストで確認できる
  - _Requirements: 1.1, 3.1, 4.1, 4.3, 7.4_
  - _Boundary: MessageBuilders_
  - _Depends: 2.2_

## 3. Core: 店舗特定サービスと会話フロー

- [ ] 3.1 (P) 店舗特定サービス（検索・確定トランザクション）
  - `onboarding/store-identification.ts`: `searchCandidates`（2.3 に委譲）、`confirmStore` 単一トランザクション（stores 作成＋owners 状態遷移）、`ux_stores_place_id` UNIQUE 違反を `place_already_registered` に正規化
  - 完了状態: `*.db.test.ts` で確定の原子性と重複 place_id の拒否が確認できる
  - _Requirements: 3.1, 4.2, 4.4_
  - _Boundary: StoreIdentificationService_
  - _Depends: 1.2, 2.3_

- [ ] 3.2 招待コード段階の会話ロジック
  - `onboarding/conversation.ts`（一部）: follow 処理（挨拶＋案内、既存 owner は重複作成なしで進捗案内）、招待コード検証→owner 作成＋セッション遷移（同一トランザクション）、無効コード連続 5 回で 10 分ロック
  - 完了状態: モック deps で無効コード 5 回目のロック案内、有効コードでの owner 作成＋stage 遷移がテストで確認できる
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5_
  - _Boundary: ConversationHandlers_
  - _Depends: 1.2, 2.2, 2.4, 2.5_

- [ ] 3.3 店名検索〜確定段階の会話ロジック
  - `onboarding/conversation.ts`（続き）: 店名検索起動（3.1 経由）、候補提示、postback 選択のセッション候補照合、確認提示、確定／取りやめ、0 件／検索失敗案内、別店名での再検索
  - 完了状態: モック deps で確定・取りやめ・0 件・検索エラーの各分岐がテストで確認できる
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.4, 4.5_
  - _Boundary: ConversationHandlers_
  - _Depends: 3.1, 3.2_

- [ ] 3.4 完了段階・フォールバック・リッチメニュー再開導線
  - `onboarding/conversation.ts`（続き）: `completed` 段階の固定案内、各段階の期待外入力へのフォールバック文言、リッチメニューからの `resume` postback 処理、完了時の完了メッセージ＋リッチメニュー個別リンク呼び出し
  - 完了状態: `completed` 状態への入力が完了案内のみを返し、各段階の期待外入力にフォールバックが返ることがテストで確認できる
  - _Requirements: 4.3, 4.6, 5.2, 5.3, 6.2, 6.3_
  - _Boundary: ConversationHandlers_
  - _Depends: 3.3, 2.4_

## 4. Integration: アプリ配線・リッチメニュー・インフラ

- [ ] 4.1 Hono アプリの配線とエラー境界
  - `app.ts`: `createApp(deps)` で signature verifier＋dispatcher＋conversation handlers を配線、`POST /webhook` で 200/401、内部例外時は汎用の再試行案内 reply を試行
  - 完了状態: `app.request` で署名 OK/NG・内部例外時の挙動がテストで確認できる
  - _Requirements: 5.4, 5.5, 7.1, 7.5_
  - _Depends: 1.4, 2.1, 3.4_

- [ ] 4.2 実依存注入とアプリレベルフローテスト
  - `index.ts`: pool／bot-sdk／fetch アダプタの実配線と `serve` 起動。fake messenger／fake places を使った `app.request` での全経路フロー（follow→招待コード→店名検索→候補選択→確認→確定→完了）テスト
  - 完了状態: ハッピーパス全通しテストと ping／署名不正／重複イベントの境界テストが緑
  - _Requirements: 1.1, 2.1, 3.1, 4.1, 4.2, 4.3, 5.4, 6.3, 7.1_
  - _Depends: 4.1_

- [ ] 4.3 (P) リッチメニューセットアップスクリプトとアセット
  - `scripts/setup-rich-menus.ts`: オンボーディング用／完了用の 2 メニューを作成・画像アップロード・デフォルト設定。オンボーディング用メニューのタップ領域に `resume` postback（進捗再開）アクションを割り当てる
  - `assets/` に PNG 2 枚（比率 1.45 以上・1MB 以下）を配置
  - 完了状態: スクリプト実行で各 `richMenuId` が出力され、`resume` アクションのタップ領域が作成 API 呼び出しに含まれることが確認できる
  - _Requirements: 6.1, 6.2, 6.3_
  - _Boundary: RichMenuSetupScript_
  - _Depends: 2.4_

- [ ] 4.4 (P) インフラ追記（Cloud Run line-webhook サービス）
  - `infra/envs/prod` のサービス定義に `line-webhook` を追加（secret_env: `LINE_CHANNEL_SECRET`/`PLACES_API_KEY`、env: `LINE_CHANNEL_ID`/`LINE_RICHMENU_COMPLETED_ID`、needs_cloudsql）
  - 完了状態: `terraform -chdir=infra/envs/prod validate` が成功
  - _Requirements: 7.1_
  - _Boundary: infra_

## 5. Validation: 統合検証

- [ ] 5.1 (P) 招待コード〜owner 作成の統合検証
  - `*.db.test.ts`: 有効コードでの owner 作成＋CHECK 制約検証、同一コードでの 2 人目登録成功、無効化後の拒否
  - 完了状態: 上記シナリオがすべて `*.db.test.ts` で緑
  - _Requirements: 2.1, 2.4, 2.5_
  - _Depends: 3.2_

- [ ] 5.2 (P) 重複防止と継続性の統合検証
  - `*.db.test.ts`: 同一 `webhookEventId` の二重処理防止、既存 owner の再 follow での重複作成なし、中断→再訪でのセッション stage 保持
  - 完了状態: 上記シナリオがすべて `*.db.test.ts` で緑
  - _Requirements: 1.2, 5.1, 5.2, 5.4_
  - _Depends: 1.2, 3.2_

- [ ] 5.3 全体受け入れ検証
  - 応答時間（5 秒以内）の軽量計測アサーションをアプリレベルテストに追加
  - `make ts-test`／`make ts-test-db`／`make ts-lint`／`make ts-build`／`make db-verify-docs` を実行し全緑を確認
  - 完了状態: 上記コマンドがすべて終了コード 0
  - _Requirements: 5.5_
  - _Depends: 4.2, 4.3, 4.4, 5.1, 5.2_

## Implementation Notes
<!-- 実装中に得られた横断的な知見をここに追記する -->
- 1.1: サンドボックスに docker/apple-container が存在しないため `make db-migrate`/`db-test`/`db-verify-docs` は直接実行不可。native Homebrew postgres（`initdb`＋カスタムソケットdir）で `db/migrations/*.sql`→`db/test/assertions/*.sql`→`db/test/check_docs.sh`（`MANAGE_CONTAINER=0 PSQL_EXEC=psql`）を代替実行し GREEN 確認済み（実装者・レビュアー双方が独立再現）。以降の DB 系タスク（1.2・5.1・5.2）も同じ代替手順を踏襲する。
- 1.2: 本 feature の実装は専用 worktree `/Users/manatoy_mba/Desktop/dev/fw-line-meo-line-onboarding`（ブランチ `feat/line-onboarding`）で行う（root worktree は `main` を維持）。`ts/scripts/with-test-db.sh` は docker/container 不要で native postgres を自前起動するため `ts-test-db` はそのまま利用可能。webhook イベント重複排除は `INSERT ... ON CONFLICT DO NOTHING` + rowCount 判定でアトミックに実装（read-then-write は不可）。confirmStore 系のトランザクション所有は 3.1（StoreIdentificationService）に意図的に委譲。
- 2.2: postback 符号化スキームは `a=select&i=<index>`（+ `a=confirm`/`a=restart`/`a=resume`）を採用（research.md Decision 5 準拠）。design.md 本文中の例示（`a=sel&i=<0-9>`）と表記が異なる箇所があるが、research.md を正としたドキュメント間の軽微な不整合であり実装への影響なし。2.5（メッセージビルダー）・4.3（リッチメニュー resume postback）は `a=select`/`a=confirm`/`a=restart`/`a=resume` の実表記に合わせること。
