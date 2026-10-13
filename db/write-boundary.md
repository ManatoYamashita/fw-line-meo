# 書き込み境界（Write Boundary）: four-tier-data-model / competitive-daily-summary / review-acquisition / gbp-post-review-reply

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
| `survey_review_link_tallies` | TS リアルタイム応答層 | 客向けアンケート Web（投稿導線の押下件数の匿名集計加算。下書き画面の押下のうち sessionToken で検証できたものだけ・`0014`・Issue #401）。読むのは dashboard-api の QR パネルの実績だけ |
| `survey_structured_material_tallies` | TS リアルタイム応答層 | 客向けアンケート Web（structured survey の素材の厚み＝極性ごとのグループ数・Target を指すグループ数・facet 数・一言の有無の匿名集計加算・`0015`・Issue #436）。legacy の `survey_material_tallies` を読み替えない。星は `survey_rating_tallies` を共通に使う。**DML は客向けアンケート Web の SA（`sa-survey-web`）の INSERT（書く列だけ）と count 列の UPDATE だけ**（既存 tallies の 3 SA 一律付与を写さない・`db/test/check_structured_survey_privileges.sh`） |
| `store_survey_configs` | TS リアルタイム応答層 | structured survey の店舗別設定のルート（`0015`・Issue #436）。行なし・`structured_enabled = false` は legacy survey。`revision` は設定の変更と同じトランザクションで +1 する。**書くのは店舗オーナーの LIFF 面（store-detail の SA）だけ**（#437）。DML は行の作成（`store_id` だけ）と版の加算（`revision`・`updated_at`）に列を絞り、`structured_enabled` は書けない。客向けアンケート Web は read のみ |
| `store_survey_category_settings` | TS リアルタイム応答層 | カテゴリの表示 / 非表示・並び順の店舗別 override（`0015`・Issue #436）。行なしは `survey_categories` の既定。**書くのは store-detail の SA だけ**（#437）で、行の作成と `enabled` の更新に列を絞る（並び順は書き換えない）。客向けアンケート Web は read のみ |
| `store_survey_targets` | TS リアルタイム応答層 | 店舗自身が登録する料理名・ドリンク名（`0015`・Issue #436）。identity は UUID、非表示は `active = false` の soft delete。客の回答から自動登録しない。**書くのは store-detail の SA だけ**（#437）で、行の作成と名前・表示・並び順の更新に列を絞る（`store_id`・`category_code` は書き換えない・DELETE なし）。非表示の同名を追加すると、その行を再表示して UUID を引き継ぐ。客向けアンケート Web は read のみ |
| `oauth_tokens` | TS リアルタイム応答層 | 第2フェーズ・GBP OAuth フロー（MVP 非運用） |
| `summary_deliveries` | TS リアルタイム応答層 | `competitive-daily-summary`／`line-on-demand-report`: TS 配信ジョブの通知記録。店舗×日の 1 行に、送った結果だけでなく送らなかった理由（`skipped_*`）も記録する・`retry_key` で冪等再送（`0004`・status の 7 値は `0010`） |
| `agency_invite_codes` | TS リアルタイム応答層 | 代理店招待コード（運営が事前発行・LINE オンボーディングが検証） |
| `onboarding_sessions` | TS リアルタイム応答層 | LINE オンボーディング会話の進捗保持（Webhook） |
| `line_webhook_events` | TS リアルタイム応答層 | LINE Webhook イベント重複排除（Webhook） |
| `audit_logs` | TS リアルタイム応答層 | 運営・代理店・オーナーによる業務書込操作の追記型監査記録。`customer` は主体にしない |
| `gbp_locations` | TS リアルタイム応答層 | `gbp-post-review-reply`: OAuth 連携成立時の GBP 身元（account/location・placeId 突合結果）保存・解除時削除（`0013`） |
| `gbp_sessions` | TS リアルタイム応答層 | `gbp-post-review-reply`: GBP 会話フロー（connect/post/reply）の期限付きセッション状態（Webhook・`0013`） |
| `competitors` | Go 日次バッチ層 | Places API による競合探索・churn 更新 |
| `rating_snapshots` | Go 日次バッチ層 | Places API による毎朝の評価/順位スナップショット |
| `daily_summaries` | Go 日次バッチ層 | `competitive-daily-summary`: Go 日次バッチによる順位/前日比算出・確定「配信素材」生成（`0004`） |
| `categories` | マイグレーション seed | 共有定数 SoT（`0002`）・実行時は両層 read のみ |
| `survey_aspects` | マイグレーション seed | 共有定数 SoT（`0002`）・実行時は両層 read のみ。legacy survey の観点で、店舗固有の料理名・ドリンク名を入れない（structured survey は別の表・Issue #436） |
| `survey_categories` | マイグレーション seed | structured survey の大カテゴリ（`0015`・Issue #436）。共有定数 SoT・実行時は両層 read のみ |
| `survey_facets` | マイグレーション seed | structured survey の評価ポイント（`0015`・Issue #436）。共有定数 SoT・実行時は両層 read のみ |
| `survey_category_facets` | マイグレーション seed | structured survey の Category × Facet × scope（category / target）の許可関係（`0015`・Issue #436）。共有定数 SoT・実行時は両層 read のみ |

> 書込責任層は 1 テーブルにつき厳密に 1 つ。`db/test/check_docs.sh` が実スキーマの全テーブルが本表にちょうど 1 回出現することを機械検証する。

## 規律

- **新テーブル追加時は本表へ必ず書込責任層を追記する**（Req 9.4）。追記が無いテーブルは `check_docs.sh` が検出する。
- 読み取りは両層に許容するが、書き込みは責任層のみ。クロス言語の典型 seam は「Go が `rating_snapshots`/`competitors`/`daily_summaries` を書き、TS が日次サマリー配信（`summary_deliveries` 書込）で `daily_summaries` を read」。
- `summary_deliveries` は「その店舗のその日に通知を送ったか、送らなかったならなぜか」を 1 行で表す。送らない判定も予約（`UNIQUE (store_id, summary_date)` の `ON CONFLICT DO NOTHING`）してから理由つきで記録するので、同じ日の再実行は同じ店舗を判定し直さない。status の意味は `db/ERD.md` の凡例を正典とし、TS の型 `SummaryDeliveryStatus`（`ts/packages/db/src/types.ts`）はその 7 値と一致させる。
- 共有定数（`categories`・`survey_aspects`・`survey_categories`・`survey_facets`・`survey_category_facets`）はコード内に列挙を二重定義せず、seed の code 値を参照する（Req 9.3）。structured survey の客向けの定義は `@fwlm/db` の `readStoreSurveyDefinition` が 1 文で読む。
- 書込責任層を宣言したが書込面（どの SA に書かせるか）を後続の Issue で決めるテーブルは、`db/test/check_docs.sh` の `PENDING_WRITE_GRANTS` に Issue 番号つきで宣言し、本表の行でその Issue を名指す。宣言中はどの SA にも DML を付与してはならない（付与が在ると赤）。付与するときは宣言から外す。現在は structured survey の店舗設定 3 表（#437）。
- 将来的に PostgreSQL のテーブル単位 GRANT で物理強制も可能（MVP はアプリ規律＋本表＋機械検証で担保）。
- `audit_logs` の `actor_id` は、`actor_type` が `operator` / `agency` の場合は `dashboard_users.id`、
  `owner` の場合は `owners.id`。多相参照のため単一の FK は張らず、actor type は ENUM で 3 種に限定する。
  顧客操作は記録対象外で、`line_user_id` や認証 subject を監査列へコピーしない。
- `audit_logs` の書込は業務の書込を確定した**後**に行い、**失敗しても業務の書込を巻き戻さず、応答も
  業務の結果どおりに返す**（Issue #250 で案 A に決定）。失敗は警告として構造化ログへ残す
  （dashboard-api は `dashboard-api.audit_log_failed`・`ts/apps/dashboard-api/src/audit.ts`、line-webhook は
  `line-webhook.audit_log_failed`・`ts/apps/line-webhook/src/owner/completed-menu.ts`、store-detail は
  `store-detail.audit_log_failed`・`ts/apps/store-detail/lib/survey-settings-api.ts`）。
  - store-detail（Issue #437）が書くのは、店舗オーナーが自店のアンケート設定を変えた操作だけである
    （`survey_target_*`・`survey_targets_reordered`・`survey_category_visibility_updated`、対象は店舗）。
    **料理名・ドリンク名は監査記録へ写さない**（`audit_logs` に payload の列は無く、変化の種類を action の名前に持たせる）。
  - 理由: 業務の書込は別の接続で確定済みなので、エラーを返すと「書込は成功・監査は欠ける・応答はエラー」になり、
    押し直した利用者が代理店や招待コードを重複して作る（`agencies` に名前の一意制約は無く、招待コードは発行のたびに
    別のコードになる）。2 つの実行面の規則も揃う。
  - 払うもの: その操作の監査記録が欠ける。欠けた記録を人手で補えるよう、dashboard-api の警告は action と対象の
    識別子を持つ。警告は Cloud Logging の保持期間（30 日）で消える。
  - 採らなかった案: 業務の書込と同じトランザクションで書く（案 B）。監査の欠落は起きないが、DAL の書込関数が
    トランザクションを受け取る形へ変わり、line-webhook と共有する `confirmStore` や衝突で再試行する招待コードの
    発行まで作り直しになる。監査の表の障害（例: migration の未適用）で管理操作が全部止まる。
