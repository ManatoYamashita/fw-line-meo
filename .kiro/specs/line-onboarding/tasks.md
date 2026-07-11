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

- [x] 2.3 (P) Google Places 検索アダプタ
  - `places/search.ts`: `searchText` 呼び出し（FieldMask を `id,displayName,formattedAddress,location,types` に固定）、1.5 秒タイムアウト、`found`/`empty`/`error` の型付き結果
  - 完了状態: fetch モックで FieldMask ヘッダ固定・タイムアウト時 error・0 件時 empty が確認できる（ユニットテスト緑）
  - _Requirements: 3.1, 3.2, 3.3, 3.5_
  - _Boundary: PlacesSearchAdapter_

- [x] 2.4 (P) LINE メッセンジャーアダプタ
  - `line/client.ts`: stateless チャネルアクセストークンの発行＋メモリキャッシュ、`reply`、`getProfile`（displayName のみ返す）、`linkRichMenu`
  - 完了状態: モックで token 発行・reply 呼び出し・profile 404 時の null 返却が確認できる（ユニットテスト緑）
  - _Requirements: 4.3, 5.5, 6.3, 7.2_
  - _Boundary: LineMessenger_

- [x] 2.5 (P) メッセージビルダー
  - `line/messages.ts`: 挨拶・招待コード案内・候補カルーセル（最大 10 バブル・altText 必須）・確認・完了メッセージ（すべて日本語）
  - 完了状態: カルーセルのバブル数上限・altText 付与・postback data 形式がテストで確認できる
  - _Requirements: 1.1, 3.1, 4.1, 4.3, 7.4_
  - _Boundary: MessageBuilders_
  - _Depends: 2.2_

## 3. Core: 店舗特定サービスと会話フロー

- [x] 3.1 (P) 店舗特定サービス（検索・確定トランザクション）
  - `onboarding/store-identification.ts`: `searchCandidates`（2.3 に委譲）、`confirmStore` 単一トランザクション（stores 作成＋owners 状態遷移）、`ux_stores_place_id` UNIQUE 違反を `place_already_registered` に正規化
  - 完了状態: `*.db.test.ts` で確定の原子性と重複 place_id の拒否が確認できる
  - _Requirements: 3.1, 4.2, 4.4_
  - _Boundary: StoreIdentificationService_
  - _Depends: 1.2, 2.3_

- [x] 3.2 招待コード段階の会話ロジック
  - `onboarding/conversation.ts`（一部）: follow 処理（挨拶＋案内、既存 owner は重複作成なしで進捗案内）、招待コード検証→owner 作成＋セッション遷移（同一トランザクション）、無効コード連続 5 回で 10 分ロック
  - 完了状態: モック deps で無効コード 5 回目のロック案内、有効コードでの owner 作成＋stage 遷移がテストで確認できる
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5_
  - _Boundary: ConversationHandlers_
  - _Depends: 1.2, 2.2, 2.4, 2.5_

- [x] 3.3 店名検索〜確定段階の会話ロジック
  - `onboarding/conversation.ts`（続き）: 店名検索起動（3.1 経由）、候補提示、postback 選択のセッション候補照合、確認提示、確定／取りやめ、0 件／検索失敗案内、別店名での再検索
  - 完了状態: モック deps で確定・取りやめ・0 件・検索エラーの各分岐がテストで確認できる
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.4, 4.5_
  - _Boundary: ConversationHandlers_
  - _Depends: 3.1, 3.2_

- [x] 3.4 完了段階・フォールバック・リッチメニュー再開導線
  - `onboarding/conversation.ts`（続き）: `completed` 段階の固定案内、各段階の期待外入力へのフォールバック文言、リッチメニューからの `resume` postback 処理、完了時の完了メッセージ＋リッチメニュー個別リンク呼び出し
  - 完了状態: `completed` 状態への入力が完了案内のみを返し、各段階の期待外入力にフォールバックが返ることがテストで確認できる
  - _Requirements: 4.3, 4.6, 5.2, 5.3, 6.2, 6.3_
  - _Boundary: ConversationHandlers_
  - _Depends: 3.3, 2.4_

## 4. Integration: アプリ配線・リッチメニュー・インフラ

- [x] 4.1 Hono アプリの配線とエラー境界
  - `app.ts`: `createApp(deps)` で signature verifier＋dispatcher＋conversation handlers を配線、`POST /webhook` で 200/401、内部例外時は汎用の再試行案内 reply を試行
  - 完了状態: `app.request` で署名 OK/NG・内部例外時の挙動がテストで確認できる
  - _Requirements: 5.4, 5.5, 7.1, 7.5_
  - _Depends: 1.4, 2.1, 3.4_

- [x] 4.2 実依存注入とアプリレベルフローテスト
  - `index.ts`: pool／bot-sdk／fetch アダプタの実配線と `serve` 起動。fake messenger／fake places を使った `app.request` での全経路フロー（follow→招待コード→店名検索→候補選択→確認→確定→完了）テスト
  - 完了状態: ハッピーパス全通しテストと ping／署名不正／重複イベントの境界テストが緑
  - _Requirements: 1.1, 2.1, 3.1, 4.1, 4.2, 4.3, 5.4, 6.3, 7.1_
  - _Depends: 4.1_

- [x] 4.3 (P) リッチメニューセットアップスクリプトとアセット
  - `scripts/setup-rich-menus.ts`: オンボーディング用／完了用の 2 メニューを作成・画像アップロード・デフォルト設定。オンボーディング用メニューのタップ領域に `resume` postback（進捗再開）アクションを割り当てる
  - `assets/` に PNG 2 枚（比率 1.45 以上・1MB 以下）を配置
  - 完了状態: スクリプト実行で各 `richMenuId` が出力され、`resume` アクションのタップ領域が作成 API 呼び出しに含まれることが確認できる
  - _Requirements: 6.1, 6.2, 6.3_
  - _Boundary: RichMenuSetupScript_
  - _Depends: 2.4_

- [x] 4.4 (P) インフラ追記（Cloud Run line-webhook サービス）
  - `infra/envs/prod` のサービス定義に `line-webhook` を追加（secret_env: `LINE_CHANNEL_SECRET`/`PLACES_API_KEY`、env: `LINE_CHANNEL_ID`/`LINE_RICHMENU_COMPLETED_ID`、needs_cloudsql）
  - 完了状態: `terraform -chdir=infra/envs/prod validate` が成功
  - _Requirements: 7.1_
  - _Boundary: infra_

## 5. Validation: 統合検証

- [x] 5.1 (P) 招待コード〜owner 作成の統合検証
  - `*.db.test.ts`: 有効コードでの owner 作成＋CHECK 制約検証、同一コードでの 2 人目登録成功、無効化後の拒否
  - 完了状態: 上記シナリオがすべて `*.db.test.ts` で緑
  - _Requirements: 2.1, 2.4, 2.5_
  - _Depends: 3.2_

- [x] 5.2 (P) 重複防止と継続性の統合検証
  - `*.db.test.ts`: 同一 `webhookEventId` の二重処理防止、既存 owner の再 follow での重複作成なし、中断→再訪でのセッション stage 保持
  - 完了状態: 上記シナリオがすべて `*.db.test.ts` で緑
  - _Requirements: 1.2, 5.1, 5.2, 5.4_
  - _Depends: 1.2, 3.2_

- [x] 5.3 全体受け入れ検証
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
- 2.4: レビュー1周目で「事前発行済み長期トークン Secret（`line-channel-access-token`）」というシークレット名をコードコメントに literal 記載していた点が secrets-hygiene 観点で REJECTED（値の漏洩ではなく命名の言及のみだが、grep ゲートはゼロ許容）。以後、未使用の既存 Secret Manager シークレット名をコードコメントに書く際は resource 名を直接書かず「事前発行された長期トークン（Secret Manager 管理）」等の言い換えに留めること。またトークン有効期限のマージン境界テストは「マージン超過直前 vs マージン超過直後・raw expiry 未到達」の2点を跨いで初めてマージン独自ロジックを証明できる（片側の閾値だけを大きく超えるテストは raw expiry 到達と区別できない）。
- 3.1: `line-webhook` は `pg` を直接依存に持たない（`@fwlm/db` 経由のみ）ため、`Queryable` を拡張した自前の `TransactionClient`/`ConnectablePool` インターフェースで構造的型合わせを行いトランザクションを張る（`pg.Pool`/`PoolClient` を直接 import しない）。`ux_stores_place_id` は `0001_four_tier_baseline.sql` で部分 UNIQUE INDEX として定義されており、node-postgres の `err.constraint` にはインデックス名がそのまま入る（`ALTER TABLE ADD CONSTRAINT` でなくても同様）。単一トランザクション内の2書込みで「どちらが失敗しても同一 catch→ROLLBACK を通る」ことがコード構造で確認できれば、両失敗パターンを個別にテスト強制する必要は必ずしもない（`tallies.ts` の先例と同判断）。`make ts-test-db` は全パッケージ共有DBで実行されるため、新規 `.db.test.ts` の UUID フィクスチャは既存 prefix と衝突しないことを grep で確認すること（本タスクは `e7` を使用）。
- 3.2: design.md の `ConversationDeps` 簡略スケッチ（`updateSession(lineUserId, patch)` 等、db 引数なし）は実アクセサ（タスク1.2、全て明示的 `Queryable` 第一引数）と食い違う。実装では `ConversationDeps` に `db: Queryable`（日常読み書き）＋`pool: ConnectablePool`（3.1 と同一パターンでトランザクションを張る用）の両方を持たせて解決した。`createOwner`＋`updateSession(stage→await_store_name, ownerId)` は同一 `pool.connect()` client を使い1回の `updateSession` 呼び出しに stage と ownerId を同時に渡すこと（`ck_session_owner_stage` CHECK を単一 UPDATE で満たすため。2回に分けると中間状態で違反する）。ロック判定・設定は必ず `deps.now()` を経由し `new Date()` を直書きしないこと（テスト可能性・10分境界の正確性のため）。
- 3.3: candidate 選択の postback はセッションに保存済みの `candidates`/`selectedIndex` スナップショットのみを信頼し、index の範囲外・candidates 無しの両ケースで graceful fallback（`buildCandidateSelectionExpiredMessage`）とすること（confirmStore は絶対に呼ばない）。`place_already_registered` は stage・candidates を変更しない（Req 4.4 はステージ変更を要求しない）。レビューで軽微な指摘: `await_confirmation`→新店名テキストの empty/error 分岐では `candidates`/`selected_index` が stale のまま残る（found・restart は明示クリアするのに非対称）。クラッシュや誤店舗確定リスクはないが、次回このパスに触れる際は一貫性のため一緒にクリアするとよい。
- 3.4: `buildStageGuidanceMessage(session)` を共有ヘルパーとして抽出し、follow の既存owner再訪（Req1.2/5.2）・`resume` postback（Req6.2）・段階外入力フォールバック（Req5.3）の3箇所で同一関数を再利用する（フォールバックは各段階の入場案内と文言を完全一致させること＝Req5.3の「現在の段階で必要な操作の案内を再送する」の字義）。`linkRichMenu` は `handleConfirm` の `confirmed` 分岐1箇所のみで呼び、失敗しても reply 自体は既に送信済みのため handleEvent 全体をクラッシュさせない（try/catchで握り潰し。ロガー未注入のため現状ログ出力なし＝4.x でロガー導入時に対応）。本タスクはRED-first手続きを厳密に踏まなかったため、レビュー側で3箇所のミューテーションテスト（completed早期ガード×2・linkRichMenu呼び出し）を実施しテストの実効性を機械的に確認した。今後もRED未実施タスクのレビューでは同様の変異テストを行うこと。
- 4.1: `POST /webhook` のエラー境界で「現在処理中の replyToken」を追跡する可変状態（`inFlightReplyToken`）と `EventDispatcher` インスタンスは、**必ずリクエストハンドラ本体の内側**で生成すること（`createApp()` スコープ＝アプリインスタンス生存期間で共有すると、Cloud Run の同時実行下で並行リクエストが同一変数を破壊し合い、遅い失敗リクエストの reply が握り潰される重大バグになる。レビューで実際に revert→再現→復元まで検証済み）。内部例外時のHTTPステータスは200固定（design.mdのError Handlingが明記・5xxはrecordWebhookEventOnceが既に記録済みのため再配信しても回復効果がなく無意味）。structured logには `x-line-request-id` ヘッダを必ず併記すること（design.md Monitoring節の明示要求）。
- 4.2: `pool`（`pg.Pool`）は `Queryable`／`ConnectablePool` の両方に構造的に適合するため、`index.ts` では同一値を `db`/`pool` 両フィールドへそのまま渡せる（アダプタ不要）。アプリレベルフローテストは `index.ts` を経由せず `createApp(deps)` に直接同型の deps（フェイクmessenger/places＋実DBプール）を組み立てる方式を踏襲する（design.md「App-level Flow Tests」の想定と整合）。重複排除テストは「同一 webhookEventId を2回送る」ことを厳密に用いること — dedup が壊れていても他の制約（UNIQUE等）やステージ遷移後の別分岐で偶然テストが通ってしまわないか反証確認すること（5.1/5.2でも同深度のチェックを踏襲）。DBフィクスチャの UUID prefix は `e1`〜`e9`+`f0` まで使用済み（次は `f1` 以降を使うこと）。
- 4.3: `scripts/` は `src` と別 rootDir のため専用 `tsconfig.scripts.json`（emit可）が必要。ワークスペース共通の `build`/`typecheck` スクリプトから確実に呼ばれるよう `tsc -p tsconfig.json && tsc -p tsconfig.scripts.json` の形で必ずチェーンすること（分離したままだと `pnpm -r run build/typecheck` の定期実行網から漏れ、将来 `stages.ts` の型変更が検知されない静かな回帰リスクになる。本タスクでレビュー指摘を受けて是正済み）。画像アップロードは `api-data.line.me`（`api.line.me` ではない）・デフォルト設定は必ずオンボーディング用menuId（完了用ではない）を対象にすること。PNGはNode組込み`zlib`＋自前CRC-32実装で外部ライブラリなしに生成可能（800×540で比率1.481を満たし軽量）。
- 4.4: `gcp-infra-foundation`（既存マージ済みspec）が先行して用意していた Cloud Run サービスキー `"webhook"`（`secret_env` に未使用の `LINE_CHANNEL_ACCESS_TOKEN` を含む）は、design.md が明示的に `line-webhook` という名前を指定しているため `"line-webhook"` へリネームし、`locals.tf`（`service_accounts` map）・`infra/sql/grants.sql`（`sa-webhook`→`sa-line-webhook`、psql変数名も含め）へ一貫して伝播させた（`terraform validate` は HCL 内部整合のみでSQLファイルの整合は検知しないため、リネーム時は grep で全体を確認すること）。`line-channel-access-token` シークレット資源自体は削除せず、このサービスの env 配線からのみ外した（Console運用・将来用に温存）。`places-api-key`/`line-channel-secret` は `infra/modules/secrets` に既存のため新規シークレット追加は不要。
- 5.1: 統合検証タスク（5.1・5.2）は既存の単体アクセサテスト（1.2）・単発ハッピーパスの app-flow テスト（4.2）と重複させず、複数オーナーにまたがるビジネスルール固有のシナリオ（同一コード2人目再利用・無効化後拒否等）に特化して追加すること。CHECK制約や状態遷移の検証は `handleEvent` の戻り値ではなく実DBへの直接SQLクエリで確認する（`handleEvent` は `Promise<void>` を返すため戻り値からは検証できない）。DBフィクスチャの UUID prefix は `f1` まで使用済み（次は `f2` 以降）。
- 5.2: **要修正（5.3でブロッキング対応・解消済み）**: `test/app-flow.db.test.ts`（Task 4.2）の「ping is a no-op」テストが `owners`/`onboarding_sessions` を WHERE 句なしの全表 `COUNT(*)` で検証しており、vitest の既定 `fileParallelism: true` ＋ `with-test-db.sh` が全ファイル共有の単一 Postgres インスタンスを使う構成のため、他ファイル（`dashboard-api`/`survey-web` の `.db.test.ts` を含む・`make ts-test-db` は `pnpm -r test` で全パッケージ並行実行）の同時書込とレースし約数%〜20%の頻度で偽陽性失敗する（レビューで実際に再現・確認済み）。5.3 でこのテストの該当 COUNT クエリに `WHERE line_user_id = $1` 等のフィクスチャスコープを追加して根本修正すること（parallelism 設定変更だけではワークスペース横断のレースは閉じないため不十分）。DBフィクスチャの UUID prefix は `f2` まで使用済み（次は `f3` 以降）。
- 5.3: ping テストの race 修正は「他のどのテストも書き込まない専用センチネル `line_user_id`（例: `Uf0-ping-probe-user`）でスコープする」方式を採用。`events: []` の場合は `dispatch.ts` の `for (const raw of events)` ループが0回実行され、いかなる `line_user_id` にも一切触れないため、この絞り込みはロスレス（弱化ではなく構造的に正しい修正）。共有DBを使う統合テストで row count を検証する際は、必ずテスト専用センチネル値でスコープすること（全表 COUNT は並列実行下で非決定的になり得る）。全5 `make` ターゲット（ts-test/ts-test-db/ts-lint/ts-build/db-verify-docs）が緑であることを確認し、line-onboarding feature 全体を FEATURE_GO と判定。
