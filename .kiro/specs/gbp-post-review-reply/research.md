# Research & Design Decisions: gbp-post-review-reply

## Summary
- **Feature**: `gbp-post-review-reply`
- **Discovery Scope**: Extension + Complex Integration（外部 API 調査はギャップ分析で完了済み・設計フェーズは light discovery）
- **Key Findings**:
  - GBP 投稿・返信は legacy v4 surface が唯一の手段（googleapis npm に v4 なし → 薄い自前 REST 層が必要）
  - 返信に必須の reviewId は Places API から取得不能 → GBP `reviews.list` オンデマンド取得で Go 層無変更を維持
  - OAuth は `business.manage` 単一スコープ・Testing ステータスは refresh token 7 日失効・アプリ検証と利用審査は前倒し運用タスク

## Design Decisions（design 生成時・2026-07-18）

### Decision: token_ref の実体 = AES-256-GCM アプリ層暗号化
- **Context**: four-tier design は `token_ref` を「参照」とだけ定め、方式を第2フェーズへ繰延べ（Research Needed 1）
- **Alternatives Considered**:
  1. store ごとの Secret Manager secret をランタイム生成 — 「secret 枠は TF 宣言・値は out-of-band」の既存規律を破り、project レベルの secret 作成権限と解除時のクリーンアップが必要
  2. Cloud KMS envelope encryption — 健全だが新 API 導入と呼び出しごとのレイテンシが増える
  3. AES-256-GCM（Node crypto）+ 鍵は Secret Manager から env 注入 — 既存 secret パターンそのまま
- **Selected Approach**: 3。`token_ref` = `v1:<iv>:<tag>:<ciphertext>`（版数プレフィックスでローテーション余地）
- **Rationale**: 新規インフラパターンゼロ・削除 = 行削除で完結（Req 2.4）・平文禁止（Req 2.1）を満たす最小構成
- **Trade-offs**: 鍵ローテーションは全行再暗号化スクリプトが必要（MVP 規模では許容）
- **Follow-up**: 鍵は 32byte base64 で out-of-band 投入。ログ redact の実装確認

### Decision: OAuth state は DB 裏付け（gbp_sessions に nonce）
- **Alternatives**: HMAC 署名付き stateless state（鍵分離のため HKDF 導出が必要になり複雑化）
- **Selected**: flow=connect のセッション行に crypto random nonce を保存し、callback で照合・消費
- **Rationale**: リプレイ耐性が構造的に得られ、店舗選択状態（pendingStoreId）と同居できる

### Decision: 返信対象クチコミはオンデマンド取得（同期テーブルなし）
- **Context**: Research Needed 5（書込境界を TS/Go どちらに置くか）
- **Selected**: 返信フロー開始時に TS が `reviews.list` を呼び、セッション payload にスナップショット。永続同期テーブルは作らない
- **Rationale**: Go 層無変更・書込境界の新たな交差なし・300 QPM で十分・常に最新（返信済み状態も正確）
- **Trade-offs**: 一覧表示に 1–3 秒のレイテンシ（LINE のローディング表示で緩和）

### Decision: サマリーのアクションボタンは無条件表示
- **Context**: Req 5.1/5.2 の出し分けを delivery-job に置くか webhook に置くか
- **Selected**: delivery-job は常にボタンを付け、連携状態分岐は webhook の postback ハンドラに集約
- **Rationale**: delivery-job の DB 参照増を回避し、未連携タップ→連携誘導（Req 5.2）が段階的連携の誘導機構そのものになる

### Decision: packages/gemini 抽出 + GBP クライアントは自前 REST 層
- **Context**: 「共有化は 2 個目の消費者出現時」（review-acquisition/research.md）の履行判断・Build vs Adopt
- **Selected**: 実行核のみ `packages/gemini` へ抽出（公開 API 形状維持・survey-web は import 差し替え）。GBP は googleapis npm に v4 が存在しないため fetch ベースの薄いクライアントを build（google-auth-library のみ adopt）
- **Rationale**: googleapis 本体の採用は v1 の 2 エンドポイントのために巨大依存を持ち込むことになり、steering のライブラリ最小方針に反する
- **Follow-up**: survey-web の既存テスト全通過を抽出タスクの完了条件にする

### Decision: store 識別は LINE 会話内 postback 選択で解決
- **Context**: Research Needed 4（LIFF の AMBIGUOUS_STORE / per-store 署名トークン繰延べ問題との関係）
- **Selected**: 本 spec の全フローは `await_store` ステージの postback 選択（onboarding `select_candidate` パターン踏襲）で store を明示解決。LIFF 再設計は持ち込まない（competitive spec 所有のまま）
- **Rationale**: LINE 会話内で完結する本機能に LIFF トークン再設計は不要。スコープ膨張を防ぐ

### スコープ確定（Research Needed の決着）
- **ReviewReplyState 監視（項目 7）**: Non-Goal 化。Req 4.4 は updateReply の即時成否で充足
- **set_delivery_hour 同時配線（項目 8）**: 見送り（competitive spec 所有。本 spec の Out of Boundary に明記）
- **business.manage の sensitive 分類実測（項目 2）／GBP 利用審査の前提充足（項目 6）**: 設計では解決不能な運用タスク。実装と並行して前倒し実施

---

# Gap Analysis: gbp-post-review-reply

実施日: 2026-07-18／フェーズ: requirements-generated 後・design 前
調査手段: コードベース統合ポイント調査（subagent）＋ GBP API 外部依存調査（subagent・Web 一次情報）

## 1. 現状調査サマリー（既存資産）

### 再利用できる確立済み資産
- **TS モノレポ（pnpm）**: apps = `line-webhook`（Hono・`createApp` にルート増設可能・public ingress）／`delivery-job`（Cloud Run Job・毎時）／`survey-web`・`store-detail`（Next.js）／`dashboard-api`（Hono）。packages = `db` のみ。
- **`oauth_tokens` テーブル（物理枠のみ）**: `db/migrations/0001_four_tier_baseline.sql:172-181`。store 単位・`UNIQUE(store_id, provider)`・`token_ref text`（平文でなく「参照」設計、four-tier design.md L303 で暗号化/Secret Manager 連携は第2フェーズ繰延べ）。書込責任 = TS 層（`db/write-boundary.md`）。**アクセサは未実装**（`ts/packages/db/src/` に無し）。
- **Gemini 実行核**: `ts/apps/survey-web/src/lib/draft/generator.ts` の `GenAiClient`／`DraftGenerator`／`createDefaultDraftGenerator`（safetySettings・構造化出力・リトライ・出力検証内包）。実行核は survey 非依存だが、素材型 `DraftMaterial` とプロンプトは口コミ特化で密結合。`@google/genai` 依存は survey-web のみ。**本 spec が「2個目の消費者」＝共有パッケージ化の契機**（review-acquisition/research.md の既定方針）。
- **postback 基盤**: `encodePostback`/`decodePostback`（URLSearchParams・300字上限・安全側フォールバック）。`PostbackAction` union は現状オンボーディング専用 4 値。
- **会話状態管理**: `onboarding_sessions` テーブル＋`conversation.ts`（DI・トランザクション作法・段階別再案内パターン）。**汎用会話フローエンジンは無い**。completed 段階は全入力を固定案内で握り潰すため、新フロー起動には明示分岐が必要。
- **Flex/配信**: `delivery-job/src/flex.ts` `buildFooter`（拡張点明確・30KB 検証内蔵）。ただしアクション型は `uri` のみで **postback アクション型が未定義**。`set_delivery_hour` は DB アクセサ・契約のみ存在し webhook 完全未配線。
- **リッチメニュー**: 2 種・各 1 領域のみ（最大 20 領域まで追加余地大）。
- **シークレット**: env 注入方式（`infra/modules/run-services` の `secret_env`＋accessor IAM co-locate、値は out-of-band 投入）。追加は `secrets/main.tf` の `secret_ids` 追記＋service 配線のみ。
- **LIFF 認可核**: `verifyLiffIdToken`（IDトークン検証→sub）と sub→owner 突合は流用可。

### 既知の構造的制約
- **store 識別問題（既知繰延べ）**: `resolveOwnerStore(pool, sub)` は storeId を受けず、複数店舗オーナーで `AMBIGUOUS_STORE`。per-store 署名トークンは competitive-daily-summary design.md L358/L493 で「第2フェーズで設計」と明記。OAuth・投稿・返信は全て store 単位のため、本機能は全操作で store の明示解決が必須（Req 1.3 が直撃）。
- **新着クチコミデータの不足（最重要ギャップ）**: Go バッチは Places API から自店レビュー最大 5 件（関連度順・newest 不可）を取得し `daily_summaries.new_reviews` に `{authorName, publishTime, rating, textExcerpt}` を保存。**返信に必須の GBP reviewId／リソース名が無く、Places API からは取得不可能**（相互変換不可）。機能1-b の返信対象一覧（Req 4.1）に既存データは不十分。

## 2. 外部依存調査サマリー（GBP API・2026年7月時点）

| 項目 | 事実 | 設計への含意 |
|---|---|---|
| 投稿 API | legacy v4 `accounts.locations.localPosts` が現役唯一の surface（後継なし・2026-04 も機能追加あり・ただし「support will be limited」） | 投稿層は抽象化して将来の federate に備える |
| 投稿制約 | topicType: STANDARD/EVENT/OFFER/ALERT。summary 上限 1500 字（プロダクト仕様）。media 任意 | MVP-of-phase2 は STANDARD 中心・1500 字アプリ側検証・先頭約100字が SERP 表示 |
| 返信 API | v4 `accounts.locations.reviews.updateReply`（**upsert**・上書き可・削除可・verified location のみ）。`comment` 上限 **4096 バイト**（UTF-8 日本語 約1365字） | Req 4.6 の上書き確認と整合。バイト長検証が必要 |
| 返信モデレーション | 2026 年追加の `ReviewReplyState`（PENDING/REJECTED/APPROVED）＋`PolicyViolation` | AI 生成返信の却下検知フローを設計可能（スコープ判断は design で） |
| OAuth | スコープは `business.manage` 単一（sensitive 相当→アプリ検証が必要）。**Testing ステータスは refresh token 7 日失効**。Published は無期限（6ヶ月未使用・取消等で失効） | 早期 Published 化必須。失効時挙動は Req 2.3 で要件化済み |
| 利用審査 | contact form 申請。**60 日以上 verified/active な GBP 管理が前提**・所要期間非公開。承認で 300 QPM | 運用側で前提充足を確認し**着手前に前倒し申請**（スケジュール上の最大外部リスク） |
| location 列挙 | v1 Account Management `accounts.list` ＋ v1 Business Information `accounts.locations.list`（readMask 必須）。`Location.metadata.placeId`（output only）で Places の place_id と突合 | placeId 逆引き API は無し → 全列挙→突合→`gbp_locations` **対応表（place_id ↔ location ↔ account）の永続化**が定石 |
| name 形式差 | v4 は `accounts/{a}/locations/{l}`、v1 は `locations/{l}` | 変換関数を単一箇所に置く |
| capability | `metadata.canOperateLocalPost` 等で投稿可否を事前判定可 | 連携時の権限不足検知（Req 1.6）に利用可 |

出典は調査時に確認した Google 公式リファレンス（`developers.google.com/my-business` 配下: prereqs / limits / sunset-dates / latest-updates / posts-data / review-data / OAuth2 各ページ）。

## 3. Requirement-to-Asset Map

| Req | 既存資産 | ギャップ（Missing=未存在／Unknown=要調査／Constraint=制約） |
|---|---|---|
| 1 連携誘導・認可 | line-webhook ルート増設可・postback 符号化・`select_candidate` 選択パターン・`oauth_tokens` 枠 | **Missing**: OAuth 開始/コールバックルート・state(CSRF)管理・accounts/locations 列挙→placeId 突合・`gbp_locations` 対応表・店舗選択フロー。**Constraint**: OAuth アプリ検証・store 識別問題 |
| 2 認可情報保管 | `oauth_tokens` DDL（TS 書込境界）・secrets env パターン | **Missing**: oauth-tokens アクセサ・失効判定。**Unknown**: `token_ref` の実体方式（Secret Manager 参照 vs KMS/アプリ暗号化）。**Constraint**: 平文禁止・Testing 7日失効 |
| 3 機能2 投稿 | Gemini 実行核・会話 DI/トランザクション作法 | **Missing**: 投稿会話フロー状態管理・GBP v4 localPosts クライアント・投稿用素材型/プロンプト・1500字検証。**Constraint**: 汎用会話エンジン不在・completed 段階の分岐解放 |
| 4 機能1-b 返信 | `new_reviews` 抜粋（きっかけ提示まで） | **Missing**: reviewId 付き一覧取得（v4 reviews.list）・返信会話フロー・4096B 検証・既返信検知。**Constraint**: Places データでは返信不可能（相互変換不可）＝取得層新設が必須 |
| 5 アクション導線 | `buildFooter` 拡張点・30KB 検証・リッチメニュー領域余地・両言語 read 可の DB | **Missing**: Flex postback アクション型・連携状態による出し分け（delivery-job が `oauth_tokens` を read）・リッチメニュー多領域化・常設導線配線 |
| 6 ガードレール | 既存プロンプト規律（事実性・語彙多様性・節度）・safetySettings | **Missing**: 投稿用/返信用プロンプト新設。**Unknown**: `ReviewReplyState` 却下検知をスコープに含めるか |

## 4. 実装アプローチオプション

### Option A: line-webhook へ全増設（Extend）
OAuth ルート・会話フロー・GBP クライアント・Gemini 呼び出しを全て `line-webhook` app 内に実装（Gemini は survey-web からコピー）。
- ✅ 新規デプロイ対象なし・最速立ち上げ
- ❌ `conversation.ts`（既に454行）のさらなる肥大。Gemini 実装の二重化は steering の「共有定数・二重化リスク管理」規律に真っ向から反する
- ❌ GBP クライアントが LINE 文脈に埋没し、将来のダッシュボード拡張から再利用不能

### Option B: 共有パッケージ分離（New）
`packages/gemini`（実行核を survey-web から抽出）＋ `packages/gbp`（v4/v1 クライアント・name 形式変換の単一所有）を新設。会話フロー・OAuth ルートは line-webhook、oauth-tokens/gbp_locations アクセサは `packages/db` へ。
- ✅ 責務分離・書込境界/二重化規律に整合・「2個目の消費者で共有化」の既定方針どおり
- ✅ v4 surface の将来 federate に対する抽象化を構造で担保
- ❌ 初期工数増・survey-web の抽出リファクタにリグレッションリスク

### Option C: 段階ハイブリッド（Hybrid・推奨候補）
共有化は `packages/gemini` 抽出のみ先行し、GBP クライアントは line-webhook 内 `lib/gbp/` から開始（2個目の消費者出現時に package 昇格）。機能は依存順に 3 段階で実装:
1. **OAuth 基盤**（ルート・アクセサ・`gbp_locations`・連携/解除/状態確認フロー）＝ Req 1・2
2. **機能1-b 返信**（reviews 取得層含む）＝ Req 4・6
3. **機能2 投稿＋アクション解禁**＝ Req 3・5
- ✅ 外部審査待ちと並行して段階的に価値を出せる・リスク分散・各段階が独立検証可能
- ❌ 計画がやや複雑・GBP クライアントの置き場所を後で昇格する手戻り余地

## 5. 工数・リスク評価

| 単位 | 工数 | リスク | 根拠 |
|---|---|---|---|
| 全体 | **XL**（2週間超） | **High** | 新外部 API surface×3（v4 posts/reviews・v1 account/business-info）＋OAuth 検証＋新会話フロー×2＋外部審査 |
| OAuth 基盤（Req 1・2） | L | High | アプリ検証・審査は外部依存で期間不定。token_ref 方式が未決 |
| 機能1-b（Req 4） | M | Medium | reviews 取得層は新設だが API は単純。会話フローは既存パターン踏襲 |
| 機能2（Req 3） | M | Medium | localPosts は単純 CRUD。会話フロー（要点入力→承認）が主工数 |
| アクション解禁（Req 5） | S | Low | 既存拡張点への追記が中心 |
| Gemini 共有化 | S–M | Medium | 実行核は疎だが survey-web のリグレッション検証が必要 |

**最大のスケジュールリスクはコードでなく外部手続き**: GBP API 利用審査（60日稼働プロファイル前提・期間非公開）と OAuth アプリ検証。実装と独立に**即時着手すべき運用タスク**。

## 6. Research Needed（設計フェーズへ持ち越し）

1. **`token_ref` の実体方式**: store ごと Secret Manager secret（数・コスト・レイテンシ）vs Cloud KMS 等によるアプリレイヤ暗号化＋DB 保存。four-tier design は「参照」を示唆。
2. **`business.manage` の sensitive 分類の実測**（自プロジェクトの Cloud Console）と OAuth 検証の具体要件（scope justification・デモ動画）。
3. **会話状態の持ち方**: `onboarding_sessions` の stage 拡張 vs 汎用 `conversation_states` 新設 vs フロー別テーブル。completed 段階の分岐解放方法を含む。
4. **store 明示解決の方式**: postback による店舗選択（`select_candidate` 流用）vs per-store 署名トークン（competitive 繰延べ問題との統合解決の是非）。
5. **返信対象クチコミの取得方式**: オンデマンド `reviews.list`（TS・都度）vs 日次同期テーブル（書込境界を TS/Go どちらに置くか。既存規律では GBP OAuth を使う層= TS が自然だが、日次同期は Go の領分と衝突し得る）。
6. **GBP API 利用審査の前提充足**（運営の 60 日稼働 verified プロファイル）と申請時期 — 運用タスク・最優先前倒し。
7. **`ReviewReplyState` 却下検知**（2026 年新機能）をスコープに含めるか（Req 4.4 の「結果通知」の解像度）。
8. **Flex postback アクション型の追加**と 30KB 制限内でのボタン配置・`set_delivery_hour` 未配線の同時解消の是非。
