# Research & Design Decisions — competitive-daily-summary

## Summary
- **Feature**: `competitive-daily-summary`
- **Discovery Scope**: Extension（確立済みスキーマ・インフラの上に Go バッチ層を新設＋TS 配信/閲覧コンポーネントを追加）
- **Key Findings**:
  - 本機能に必要な中核テーブル（`competitors`・`rating_snapshots`）と順位定義（星評価降順・同率はクチコミ総数降順）は `four-tier-data-model` で確立済み。スキーマの根幹変更は不要
  - `gcp-infra-foundation` により Cloud Run Job `daily-batch`（06:00 JST 起動・専用 SA・Places API キー accessor）が構築・検証済み。Go バッチの受け皿は存在する
  - ギャップ3点: (1) 配信時刻設定の保存先が無い、(2) 新着クチコミ本文の保持構造が無い、(3) `line-channel-access-token` の accessor が webhook SA のみで配信主体に未付与
  - **Places API (New) 一択**（Legacy は 2025-03 で凍結・新規プロジェクト利用不可）。フィールドマスクの SKU 分離（競合=Enterprise / 自店のみ reviews 込み Enterprise+Atmosphere）で約3割のコスト削減
  - **Places コンテンツのキャッシュは place_id を除き原則禁止**（一時キャッシュは最大30日の許容規定）。rating 時系列の無期限永続化は規約リスク → 30日ローリング保持を MVP 方針とする
  - **LIFF は LINE Login チャネル登録**が必要で、Messaging API チャネルと**同一プロバイダー配下でなければ userId が突合できない**（運用上の必須制約）

## Research Log

### 既存スキーマ・書込境界（コードベース調査）
- **Context**: 本機能が書く/読むテーブルと境界の確認
- **Sources Consulted**: `db/migrations/0001_four_tier_baseline.sql`, `db/write-boundary.md`, `db/ERD.md`, `.kiro/specs/four-tier-data-model/design.md`
- **Findings**:
  - `competitors`（Go 書込）: `UNIQUE(store_id, place_id)`、churn は `active=false`（ハード削除しない）、5店上限はモデルで強制せず投入処理の責務
  - `rating_snapshots`（Go 書込）: 追記専用、部分一意 index で 1日1行を強制（自店/競合別）、`place_id` 非正規化で churn 後も履歴自立。**新着クチコミ本文カラムは無い**
  - `owners.line_user_id`（TS 書込）が配信宛先キー。`stores.place_status='confirmed'`＋`ck_place_confirmed` が配信ゲート
  - rank 定義は four-tier design で確定: 比較集合 {自店＋当日 active 競合}、星評価降順→同率 review_count 降順、point-in-time 固定、算出は Go の責務
  - **write-boundary.md が「日次サマリー配信での rating_snapshots/competitors の read は TS」と既に規定** → 配信（Flex 組立・push）は TS 層で確定
- **Implications**: Go=取得・計算・記録、TS=配信・閲覧の縦割りが既存規律から一意に決まる

### TS ワークスペース・インフラの実体（コードベース調査）
- **Context**: 新規コンポーネントの置き場所と再利用可能資産の確認
- **Sources Consulted**: `ts/`（pnpm workspace）、`infra/modules/`、`.kiro/specs/gcp-infra-foundation/design.md`、`.kiro/specs/review-acquisition/design.md`
- **Findings**:
  - `ts/` は pnpm workspace（`apps/*`, `packages/*`）。`packages/db`（Cloud SQL Connector + pg Pool・IAM DB 認証・行型定義）が確立済み。apps: `dashboard-api`（Hono）, `survey-web`（Next.js）
  - **Go 層（`go.mod`）は未存在** — 本 spec が Go ツリーを新設する
  - infra modules: `batch-job`（Cloud Run Job `daily-batch`・max_retries=1・timeout 30分・SA co-locate・Scheduler 06:00 JST）、`secrets`（`places-api-key`→daily-batch SA 付与済み、`line-channel-access-token`→webhook SA のみ）、`guardrails`（アラート・Places クォータ上限・**Billing budget 月¥10,000**）
- **Implications**: バッチ実行系は流用。追加インフラは「TS 配信ジョブ＋毎時 Scheduler」「LINE token accessor 付与」「LIFF 詳細画面サービス」の3点に限定される

### 並行作業（Issue #6 LINE基盤）との競合回避
- **Context**: 別セッションが LINE Webhook・オンボーディングを実装中。ファイル・責務の衝突を避ける必要がある
- **Findings**: 本 spec は `go/`（新設）・`ts/apps/` 配下の新規アプリ・`db/migrations/0003_*.sql`・infra の新モジュールのみに書く。webhook アプリ本体・リッチメニューには触れない
- **Implications**: 配信時刻変更の LINE 上 UI（R3.3）は webhook 経由になるため、本 spec は「設定の保存構造＋更新関数（`packages/db`）＋postback データ契約」までを所有し、webhook への配線は LINE 基盤完成後の統合ポイントとして分離する

### LINE Messaging API — Push・Flex・LIFF（skill references ＋公式ドキュメント）
- **Context**: 配信・詳細閲覧の実装契約の確定（LINE API は記憶で答えない規律）
- **Sources Consulted**: `.claude/skills/messaging-api/references/`（message-sending.md, flex-message.md, api-common.md, channel-token.md, url-schemes.md, user.md, webhook-events.md）＋ developers.line.biz（LIFF 登録・ID トークン検証）
- **Findings**:
  - Push: `POST /v2/bot/message/push`、1リクエスト最大5メッセージ・2MB、レート 2,000 req/s。**店舗ごとに内容が異なるため Multicast 不可・Push 一択**（課金は同じ受信者数基準）
  - 冪等性: **`X-Line-Retry-Key`**（UUID・初回から付与・24h 有効・内容完全一致）。重複時 409。**再送は 500/タイムアウトのみ**（200/409/他4xx は再送しない）
  - **ブロック済みユーザーへの Push は 200 で静かに不達**（課金なし）。検知は unfollow webhook（LINE 基盤側の責務）
  - トークン: Stateless channel access token（約15分・発行数無制限）が日次バッチに最適
  - Flex: Bubble 30KB / altText 400字必須 / 送信前検証 `POST /v2/bot/message/validate/push`
  - LIFF: LINE Login チャネルに登録（エンドポイントは HTTPS）。Flex Button の URI アクションで `https://liff.line.me/{liffId}/...` を開く。**`liff.getProfile()` の userId をそのまま認可に使うのは禁止** → `liff.getIDToken()` → サーバーで `/oauth2/v2.1/verify` → `sub` を信頼。**Messaging API チャネルと同一プロバイダー必須**（userId 共通化の条件）
  - `X-Line-Request-Id` を必ずログ保存（LINE 側はログを提供しない）
- **Implications**: 配信の冪等設計は「summary_deliveries に retry_key を永続化し再実行時に再利用」で成立。LIFF 認可はサーバーサイド ID トークン検証で自店のみ閲覧を強制

### Google Places API (New) — 取得契約・料金・ToS（公式ドキュメント）
- **Context**: 競合抽出・日次取得の API 契約とコスト・規約適合の確定
- **Sources Consulted**: developers.google.com（nearby-search, place-details, place-types, pricing, sku-details, policies, place-id, web-services-best-practices）
- **Findings**:
  - Legacy Places API は 2025-03 で凍結・新規プロジェクト利用不可 → **Places API (New) 一択**
  - Nearby Search (New): `POST places:searchNearby`、`locationRestriction.circle(radius=1000)`＋`includedPrimaryTypes`（主カテゴリ一致、`ramen_restaurant` 等の細粒度 Table A タイプ）＋`rankPreference: "DISTANCE"`。**自店除外パラメータは無い** → `maxResultCount: 6` で取得し自店 place_id をクライアント側で除外して上位5件採用
  - Place Details (New): `GET places/{place_id}`、フィールドマスク必須。`rating`/`userRatingCount`=Enterprise SKU、`reviews`=Enterprise+Atmosphere SKU（課金は最上位 SKU に一本化）
  - **reviews は最大5件・関連度順固定**（newest ソート不可）→ 新着検出は `publishTime` 差分方式、**関連度上位5件に入らない新着は取りこぼし得る**（新着「件数」は review_count 差分が正）
  - `businessStatus`: OPERATIONAL / CLOSED_TEMPORARILY / CLOSED_PERMANENTLY / FUTURE_OPENING。place_id 廃止時は **NOT_FOUND**（12か月超の place_id は `fields=id` の無料リフレッシュ推奨）
  - 料金（0-10万コール帯・無料枠は SKU 別/月）: Details Enterprise $20/1,000（無料1,000）、Details Enterprise+Atmosphere $25/1,000（無料1,000）、Nearby Search Pro $32/1,000（無料5,000）。**50店試算: 競合5件=Enterprise・自店のみ Atmosphere に分離で ≈$142.5/月**（全件 reviews 付だと $200/月）
  - クォータはメソッド単位 QPM（既定値非公開・Console で確認）。指数バックオフ＋**起動時刻ジッター**（毎時ちょうどの一斉リクエスト禁止）＋ワーカープール推奨
  - 公式 Go クライアント `cloud.google.com/go/maps/places/apiv1` は **beta**・フィールドマスクの指定に癖 → plain REST も妥当
  - **ToS**: place_id のみキャッシュ制限の適用除外（無期限保存可）。**その他コンテンツ（rating・userRatingCount・reviews）の保存は原則禁止・一時キャッシュ最大30日の許容規定**。帰属表示（Google Maps ロゴ/テキスト、クチコミは投稿者名・アバター必須）が UI に適用される
- **Implications**: (1) 時系列保持は 30日ローリングを MVP 方針とし規約適合（前日比・直近推移には十分）。(2) フィールドマスク2種分離をバッチ契約に組込み。(3) Flex/LIFF に Google 帰属表示を組込む。(4) Billing budget 月¥10,000 は 50店規模で不足 → スケール時の予算改定を運用ノートに明記

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| A: Go が取得〜配信まで全担 | Go バッチが Flex 組立・LINE push も行う | 単一ランタイム・#6 と完全無衝突 | tech.md の役割分担（Flex 組立=TS）と write-boundary.md の既定（配信 read=TS）に違反 | 不採用 |
| B: Go=計算・記録 / TS=配信・閲覧（採用） | Go が日次素材を確定し、TS が Flex 組立・push・LIFF 閲覧 | 既存規律に完全準拠。言語間契約が「テーブル」に閉じる | 2 ランタイム間の受け渡し構造（配信素材）が必要 | `daily_summaries` テーブルを契約面とする |
| C: TS が rating_snapshots から都度計算して配信 | 新テーブル無しで TS が前日比・順位差分を再計算 | スキーマ追加最小 | 順位・前日比ロジックが 2 言語に重複（rank は Go 責務と確定済み）。新着クチコミ本文の置き場が無い | 不採用 |

## Design Decisions

### Decision: 言語間契約としての `daily_summaries` テーブル新設
- **Context**: Go の計算結果（順位・前日比・新着抜粋・競合一覧）を TS 配信層へ渡す構造が必要。`rating_snapshots` は追記専用の生指標であり、配信素材（表示用の派生値・クチコミ抜粋）を持たない
- **Alternatives Considered**:
  1. rating_snapshots へのカラム追加 — four-tier spec の Revalidation Trigger を踏み、追記専用の純度を汚す
  2. TS が生指標から再計算 — rank ロジックの二重化（言語間ロジック二重化は tech.md が明示するリスク）
- **Selected Approach**: Go 書込の `daily_summaries`（store_id × summary_date 一意）に配信素材を確定保存。TS は読むだけ
- **Rationale**: 書込境界が単純（Go のみ書く）、二刀流間の契約が SQL スキーマという機械検証可能な面に閉じる
- **Trade-offs**: テーブル1枚増、write-boundary.md / ERD.md の更新（`make db-verify-docs` 対象）が必要

### Decision: Places データの保持は 30日ローリング
- **Context**: Places ToS はコンテンツの保存を原則禁止（place_id を除く）。一時キャッシュは最大30日の許容規定。一方 R2.3 は「少なくとも前日比較が可能な期間」の時系列保持を要求
- **Alternatives Considered**:
  1. 無期限保存 — 規約リスク（グレー〜違反）
  2. 2日分のみ — 詳細画面の推移表示（R4.1）が貧弱化
- **Selected Approach**: `rating_snapshots`・`daily_summaries` とも **30日超の行を日次バッチ末尾で削除**（30日ローリングウィンドウ）。詳細画面の推移も直近30日に限定
- **Rationale**: 要件（前日比＋直近推移）を満たしつつ許容規定の範囲内に収まる
- **Trade-offs**: 長期トレンド分析は不可（第2フェーズの詳細分析で必要になれば法務確認/書面許諾を経て延長）
- **Follow-up**: Service Specific Terms の30日規定原文の確認（調査時にページ全文未取得）。確認までは30日を上限とする

### Decision: Places API 呼び出しはフィールドマスク2種に分離、plain REST で実装
- **Context**: `reviews` を含めると Enterprise+Atmosphere SKU（$25/1,000）に跳ねる。公式 Go クライアントは beta
- **Selected Approach**: 自店= `rating,userRatingCount,businessStatus,reviews`（Atmosphere）、競合= `rating,userRatingCount,businessStatus,displayName`（Enterprise）の2マスク。HTTP クライアントは標準ライブラリ＋指数バックオフ＋ワーカープール（beta 依存を持たない）
- **Rationale**: 50店規模で約3割のコスト削減（$200→$142.5/月）。外部ライブラリ最小方針（steering）とも整合
- **Trade-offs**: SDK の型恩恵を放棄（レスポンス構造体は自前定義。必要フィールドは少数で管理可能）

### Decision: 配信時刻はオーナー単位・時単位（0-23・default 7）、毎時トリガーで該当者に配信
- **Context**: デフォルト 7:00・オーナー変更可（R3.2, 3.3）。現スキーマに保存先が無い
- **Alternatives Considered**: 分単位の自由設定（MVP に過剰）／全員 7:00 固定（R3.3 違反）
- **Selected Approach**: `owners.delivery_hour smallint`（TS 書込で整合）。毎時の Cloud Scheduler が TS 配信ジョブを起動し、当該時刻のオーナー分のみ配信。設定変更の postback データ契約と更新関数は本 spec が提供、webhook への配線は LINE 基盤（#6）完成後の統合ポイント
- **Trade-offs**: 時単位の粒度制限（飲食店の朝の確認用途には十分）

### Decision: 競合抽出は日次バッチ内で「競合未固定の確定済み店舗」に対して実行（自己修復型）
- **Context**: R1.1 のトリガー（店舗特定完了）は TS 層のイベントだが、`competitors` は Go 書込境界
- **Alternatives Considered**: TS から Go ジョブを即時起動（イベント駆動・インフラ過剰）／TS が抽出実行（書込境界違反）
- **Selected Approach**: 毎朝の Go バッチ冒頭で「place 確定済みかつ競合未固定」の店舗を検出して Nearby Search（maxResultCount=6・自店 place_id 除外・上位5件）で抽出・固定。初回サマリーは特定翌朝に届く
- **Rationale**: 書込境界を守り、追加インフラゼロ。日次サマリーは本質的に翌朝配信の機能であり遅延は許容範囲

### Decision: Push の冪等性は summary_deliveries × X-Line-Retry-Key で担保
- **Context**: R3.9（同日重複配信禁止）とジョブ再実行・部分失敗からの回復
- **Selected Approach**: 配信前に `summary_deliveries(store_id, summary_date)` 一意行を retry_key（UUID）付きで確保。Push には常に `X-Line-Retry-Key` を付与。500/タイムアウトのみ同一キーで再送、409 は送信済みとして成功扱い。`X-Line-Request-Id` を行に記録
- **Rationale**: DB 一意制約（アプリ内の重複防止）と LINE 側冪等キー（API 境界の重複防止）の二重防御

## Risks & Mitigations
- **Places ToS（保持・帰属）**: 30日ローリング保持＋Flex/LIFF への Google 帰属表示（テキスト「Google Maps」＋クチコミ投稿者名）で適合させる。30日規定の原文確認を実装前 Follow-up とする
- **Billing budget 超過**: 50店規模で ≈$142.5/月（Places のみ）は guardrails の月¥10,000 予算を超える。MVP 初期（少店舗）は枠内。スケール時に budget 改定が必要な旨を runbook に明記
- **新着クチコミの取りこぼし**: reviews は関連度順固定・最大5件のため、新着「件数」は review_count 差分を正とし、本文抜粋はベストエフォットと設計書に明記
- **並行実装（#6）との統合**: 設定 UI 配線・unfollow 処理・LIFF チャネル作成（同一プロバイダー必須）は統合ポイントとして契約のみ固定し、実装タスクを分離
- **06:00 バッチ未完了時の 07:00 配信**: `daily_summaries` の当日行存在を配信前提条件とし、欠損時はスキップ＋記録（R5 の可観測性でカバー）

## References
- `db/write-boundary.md` — 書込境界の機械検証対象定義
- `.kiro/specs/four-tier-data-model/design.md` — rank 定義・スキーマ不変条件
- `.kiro/specs/gcp-infra-foundation/design.md` — batch-job/Scheduler/secrets 構成
- `.claude/skills/messaging-api/references/` — Push・Flex・Retry-Key・トークン種別
- [Nearby Search (New)](https://developers.google.com/maps/documentation/places/web-service/nearby-search) — 競合抽出契約
- [Place Details (New)](https://developers.google.com/maps/documentation/places/web-service/place-details) — 日次取得契約・reviews 上限
- [Places pricing](https://developers.google.com/maps/billing-and-pricing/pricing) / [SKU details](https://developers.google.com/maps/billing-and-pricing/sku-details) — SKU 分離の根拠
- [Places policies](https://developers.google.com/maps/documentation/places/web-service/policies) — キャッシュ・帰属要件
- [LIFF registering](https://developers.line.biz/en/docs/liff/registering-liff-apps/) / [Verify ID token](https://developers.line.biz/en/reference/line-login/#verify-id-token) — LIFF 認可契約
