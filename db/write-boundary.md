# 書き込み境界（Write Boundary）: four-tier-data-model / competitive-daily-summary

同一 Cloud SQL を 2 言語（TypeScript リアルタイム応答層 / Go 日次バッチ層）から触るため、**各テーブルの書き込み責任を厳密に 1 つの層へ割り当てる**。読み取りは原則両層に許容。共有定数はマイグレーション seed を単一情報源（SoT）とし、実行時はどちらの層も書き込まない。

データ源で自然に二分される: Places API 由来 = Go バッチ、LINE/ダッシュボード/アンケート由来 = TS、共有定数 = seed。

## テーブル → 書込責任層

| テーブル | 書込責任層 | データ源・契機 |
|---|---|---|
| `operators` | TS リアルタイム応答層 | 運営テナントの登録（ダッシュボード） |
| `agencies` | TS リアルタイム応答層 | 代理店登録（ダッシュボード） |
| `dashboard_users` | TS リアルタイム応答層 | 運営/代理店アカウント登録（ダッシュボード） |
| `owners` | TS リアルタイム応答層 | LINE オンボーディング（Webhook）。`delivery_hour`（`competitive-daily-summary`・`0004`）は日次サマリー配信時刻設定・TS が postback 経由で更新 |
| `stores` | TS リアルタイム応答層 | 店舗特定オンボーディング（Webhook/LIFF） |
| `survey_rating_tallies` | TS リアルタイム応答層 | 客向けアンケート Web（匿名集計加算） |
| `survey_aspect_tallies` | TS リアルタイム応答層 | 客向けアンケート Web（匿名集計加算） |
| `oauth_tokens` | TS リアルタイム応答層 | 第2フェーズ・GBP OAuth フロー（MVP 非運用） |
| `summary_deliveries` | TS リアルタイム応答層 | `competitive-daily-summary`: TS 配信ジョブによる LINE Push 配信記録・`retry_key` で冪等再送（`0004`） |
| `competitors` | Go 日次バッチ層 | Places API による競合探索・churn 更新 |
| `rating_snapshots` | Go 日次バッチ層 | Places API による毎朝の評価/順位スナップショット |
| `daily_summaries` | Go 日次バッチ層 | `competitive-daily-summary`: Go 日次バッチによる順位/前日比算出・確定「配信素材」生成（`0004`） |
| `categories` | マイグレーション seed | 共有定数 SoT（`0002`）・実行時は両層 read のみ |
| `survey_aspects` | マイグレーション seed | 共有定数 SoT（`0002`）・実行時は両層 read のみ |

> 書込責任層は 1 テーブルにつき厳密に 1 つ。`db/test/check_docs.sh` が実スキーマの全テーブルが本表にちょうど 1 回出現することを機械検証する。

## 規律

- **新テーブル追加時は本表へ必ず書込責任層を追記する**（Req 9.4）。追記が無いテーブルは `check_docs.sh` が検出する。
- 読み取りは両層に許容するが、書き込みは責任層のみ。クロス言語の典型 seam は「Go が `rating_snapshots`/`competitors`/`daily_summaries` を書き、TS が日次サマリー配信（`summary_deliveries` 書込）で `daily_summaries` を read」。
- 共有定数（`categories`・`survey_aspects`）はコード内に列挙を二重定義せず、seed の code 値を参照する（Req 9.3）。
- 将来的に PostgreSQL のテーブル単位 GRANT で物理強制も可能（MVP はアプリ規律＋本表＋機械検証で担保）。
