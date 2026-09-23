# 書き込み境界（Write Boundary）: four-tier-data-model / competitive-daily-summary / review-acquisition

同一 Cloud SQL を 2 言語（TypeScript リアルタイム応答層 / Go 日次バッチ層）から触るため、**各テーブルの書き込み責任を厳密に 1 つの層へ割り当てる**。読み取りは原則両層に許容。共有定数はマイグレーション seed を単一情報源（SoT）とし、実行時はどちらの層も書き込まない。

データ源で自然に二分される: Places API 由来 = Go バッチ、LINE/ダッシュボード/アンケート由来 = TS、共有定数 = seed。

## テーブル → 書込責任層

| テーブル | 書込責任層 | データ源・契機 |
|---|---|---|
| `operators` | TS リアルタイム応答層 | 運営テナントの登録（ダッシュボード） |
| `agencies` | TS リアルタイム応答層 | 代理店登録（ダッシュボード） |
| `dashboard_users` | TS リアルタイム応答層 | 運営/代理店アカウント登録（ダッシュボード） |
| `owners` | TS リアルタイム応答層 | LINE オンボーディング（Webhook）。`delivery_hour`（`competitive-daily-summary`・`0004`）は通知を送る時刻。LINE 上で変える手段は提供しない（`line-on-demand-report`・#256）ので、既定の 7 時のまま運用する |
| `stores` | TS リアルタイム応答層 | 店舗特定オンボーディング（Webhook/LIFF）。`suspended_at`（`store-suspension`・`0012`・Issue #252）は利用停止の時刻（NULL = 利用中）で、書くのは dashboard-api の停止・再開の操作（運営・代理店）だけ。LINE 応答・客向け Web・Go 日次バッチは読むだけで書かない |
| `survey_rating_tallies` | TS リアルタイム応答層 | 客向けアンケート Web（匿名集計加算） |
| `survey_aspect_tallies` | TS リアルタイム応答層 | 客向けアンケート Web（匿名集計加算） |
| `survey_concern_tallies` | TS リアルタイム応答層 | 客向けアンケート Web（気になった点の匿名集計加算・`0008`） |
| `survey_material_tallies` | TS リアルタイム応答層 | 客向けアンケート Web（素材の厚み＝良かった点の選択数・気になった点の選択数・一言の有無の匿名集計加算・`0006`／`0008`） |
| `oauth_tokens` | TS リアルタイム応答層 | 第2フェーズ・GBP OAuth フロー（MVP 非運用） |
| `summary_deliveries` | TS リアルタイム応答層 | `competitive-daily-summary`／`line-on-demand-report`: TS 配信ジョブの通知記録。店舗×日の 1 行に、送った結果だけでなく送らなかった理由（`skipped_*`）も記録する・`retry_key` で冪等再送（`0004`・status の 7 値は `0010`） |
| `agency_invite_codes` | TS リアルタイム応答層 | 代理店招待コード（運営が事前発行・LINE オンボーディングが検証） |
| `onboarding_sessions` | TS リアルタイム応答層 | LINE オンボーディング会話の進捗保持（Webhook） |
| `line_webhook_events` | TS リアルタイム応答層 | LINE Webhook イベント重複排除（Webhook） |
| `audit_logs` | TS リアルタイム応答層 | 運営・代理店・オーナーによる業務書込操作の追記型監査記録。`customer` は主体にしない |
| `competitors` | Go 日次バッチ層 | Places API による競合探索・churn 更新 |
| `rating_snapshots` | Go 日次バッチ層 | Places API による毎朝の評価/順位スナップショット |
| `daily_summaries` | Go 日次バッチ層 | `competitive-daily-summary`: Go 日次バッチによる順位/前日比算出・確定「配信素材」生成（`0004`） |
| `categories` | マイグレーション seed | 共有定数 SoT（`0002`）・実行時は両層 read のみ |
| `survey_aspects` | マイグレーション seed | 共有定数 SoT（`0002`）・実行時は両層 read のみ |

> 書込責任層は 1 テーブルにつき厳密に 1 つ。`db/test/check_docs.sh` が実スキーマの全テーブルが本表にちょうど 1 回出現することを機械検証する。

## 規律

- **新テーブル追加時は本表へ必ず書込責任層を追記する**（Req 9.4）。追記が無いテーブルは `check_docs.sh` が検出する。
- 読み取りは両層に許容するが、書き込みは責任層のみ。クロス言語の典型 seam は「Go が `rating_snapshots`/`competitors`/`daily_summaries` を書き、TS が日次サマリー配信（`summary_deliveries` 書込）で `daily_summaries` を read」。
- `summary_deliveries` は「その店舗のその日に通知を送ったか、送らなかったならなぜか」を 1 行で表す。送らない判定も予約（`UNIQUE (store_id, summary_date)` の `ON CONFLICT DO NOTHING`）してから理由つきで記録するので、同じ日の再実行は同じ店舗を判定し直さない。status の意味は `db/ERD.md` の凡例を正典とし、TS の型 `SummaryDeliveryStatus`（`ts/packages/db/src/types.ts`）はその 7 値と一致させる。
- 共有定数（`categories`・`survey_aspects`）はコード内に列挙を二重定義せず、seed の code 値を参照する（Req 9.3）。
- 将来的に PostgreSQL のテーブル単位 GRANT で物理強制も可能（MVP はアプリ規律＋本表＋機械検証で担保）。
- `audit_logs` の `actor_id` は、`actor_type` が `operator` / `agency` の場合は `dashboard_users.id`、
  `owner` の場合は `owners.id`。多相参照のため単一の FK は張らず、actor type は ENUM で 3 種に限定する。
  顧客操作は記録対象外で、`line_user_id` や認証 subject を監査列へコピーしない。
