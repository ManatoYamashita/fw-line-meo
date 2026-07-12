# ER 図: four-tier-data-model / competitive-daily-summary

fw-line-meo の 4 階層データモデル（PostgreSQL）の正本 ER 図。スキーマ本体は `db/migrations/0001_four_tier_baseline.sql`、`competitive-daily-summary`（日次サマリー・配信記録）は `db/migrations/0004_competitive_daily_summary.sql`、書き込み境界は `db/write-boundary.md` を参照。

4 階層: **運営(Operator) → 代理店(Agency) → 飲食店オーナー(Owner) → 来店客(Customer・匿名)**。
Store（店舗）は Owner が所有する独立エンティティ（1 オーナー:N 店舗）。来店客は匿名集計のみで、識別エンティティを持たない。

```mermaid
erDiagram
    operators ||--o{ agencies : owns
    agencies ||--o{ owners : owns
    owners ||--o{ stores : owns
    operators ||--o{ dashboard_users : "operator-role scope"
    agencies ||--o{ dashboard_users : "agency-role scope"
    categories ||--o{ stores : classifies
    stores ||--o{ competitors : tracks
    stores ||--o{ rating_snapshots : "context of"
    competitors ||--o{ rating_snapshots : "measured by"
    stores ||--o{ survey_rating_tallies : aggregates
    stores ||--o{ survey_aspect_tallies : aggregates
    survey_aspects ||--o{ survey_aspect_tallies : classifies
    stores ||--o{ oauth_tokens : "future authorizes"
    stores ||--o{ daily_summaries : "summarized as"
    stores ||--o{ summary_deliveries : "delivered to"
    agencies ||--o{ agency_invite_codes : issues
    owners ||--o{ onboarding_sessions : "progress of"
```

## エンティティ一覧（PK / 自然キー / 主な FK）

| エンティティ | PK | 自然キー・一意 | 主な FK | 役割 |
|---|---|---|---|---|
| operators | id (uuid) | — | — | 運営（apex テナント・第1層） |
| agencies | id (uuid) | — | operator_id → operators | 代理店（第2層） |
| owners | id (uuid) | line_user_id (unique) | agency_id → agencies | 飲食店オーナー（第3層・LINE ユーザ） |
| stores | id (uuid) | place_id (確定時のみ部分一意) | owner_id → owners, category_code → categories | 店舗（Owner 所有・1:N） |
| dashboard_users | id (uuid) | auth_subject (unique) | operator_id → operators, agency_id → agencies | ダッシュボード認証主体（運営/代理店・RBAC） |
| categories | code (text) | — | — | 店舗ジャンル（共有定数・seed SoT） |
| competitors | id (uuid) | (store_id, place_id) unique | store_id → stores | 競合プレイス（active で churn 表現） |
| rating_snapshots | id (uuid) | 部分一意（自店/競合×日） | store_id → stores, competitor_id → competitors | 評価・順位の追記型時系列（自店+競合） |
| survey_aspects | code (text) | — | — | アンケート観点（共有定数・seed SoT） |
| survey_rating_tallies | id (uuid) | (store_id, period_month, star) unique | store_id → stores | 星評価の匿名集計カウンタ |
| survey_aspect_tallies | id (uuid) | (store_id, period_month, aspect_code) unique | store_id → stores, aspect_code → survey_aspects | 観点別の匿名集計カウンタ |
| oauth_tokens | id (uuid) | (store_id, provider) unique | store_id → stores | 将来の GBP OAuth トークン格納枠（店舗単位・第2フェーズ） |
| daily_summaries | id (bigint identity) | (store_id, summary_date) unique | store_id → stores | 日次サマリー（店舗×日付で一意の確定「配信素材」・生成後は不変・再実行時は全置換・Go 書込） |
| summary_deliveries | id (bigint identity) | (store_id, summary_date) unique | store_id → stores | 配信記録（店舗×日付で一意の「配信事実」・`retry_key` で冪等再送・TS 書込） |
| agency_invite_codes | id (uuid) | code (unique) | agency_id → agencies | 代理店招待コード（共有・disabled_at で失効。Req 2.5） |
| onboarding_sessions | line_user_id (text) | — | owner_id → owners | LINE オンボーディング会話の進捗（owner 誕生前から存在） |
| line_webhook_events | webhook_event_id (text) | — | — | Webhook イベント重複排除（Req 5.4） |

## 凡例・補足

- 全階層 FK（agencies.operator_id / owners.agency_id / stores.owner_id）は **NOT NULL・ON DELETE RESTRICT**。親欠落の子は作成不可、誤削除は拒否。
- リネージ（テナント分離の根拠）: `stores → owners.agency_id → agencies → operators`。RBAC は運営=全体 / 代理店=担当 agency 配下のみ。
- **来店客(Customer)・個別回答を表現するエンティティは存在しない**（匿名性の構造保証）。集計は `survey_*_tallies` のカウンタのみ。
- `rating_snapshots` は追記専用（更新/削除しない）。`subject_kind` で自店/競合を区別し、`place_id` を非正規化保持して競合 churn 後も歴史を自立保持。
- 共有定数 `categories`・`survey_aspects` は seed（`0002`）が唯一の定義（SoT）。
- **複合 FK による境界強制**: `dashboard_users(operator_id, agency_id) → agencies(operator_id, id)` で agency が当該 operator 配下であることを、`rating_snapshots(store_id, competitor_id) → competitors(store_id, id)` で競合が当該店舗のものであることを保証（NULL を含む行＝operator/self は MATCH SIMPLE で非適用）。
- `stores`: `confirmed ⇔ place_id present`（`ck_place_confirmed`）。pending は place_id 未確定（NULL）。
- `daily_summaries`（Go 書込）と `summary_deliveries`（TS 書込）は `competitive-daily-summary` spec で追加。両テーブルとも `stores` に対する `(store_id, summary_date)` 一意制約を持ち、日次バッチ（Go）→ 配信ジョブ（TS）のパイプラインで `daily_summaries` を TS が read → `summary_deliveries` へ結果を書込む、というクロス言語 seam を構成する（`db/write-boundary.md` 参照）。
- `owners.delivery_hour`（`competitive-daily-summary`・`0004`）: 日次サマリー配信時刻（時単位・デフォルト 7・0-23）。`owners` は既存 TS 境界のため書込責任は変わらず TS。
- `onboarding_sessions`: `stage='await_invite_code' ⇔ owner_id IS NULL`（`ck_session_owner_stage`）。owner 誕生前の LINE ユーザー状態も本表が唯一保持する。
- `agency_invite_codes`: `code` は代理店ごとに共有・使い回し可能（`disabled_at` が無効化するまで複数オーナーが同一コードで登録できる。Req 2.5）。
