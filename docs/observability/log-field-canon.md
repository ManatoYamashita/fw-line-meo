# 記録の正典（項目名と事象名）

対応 Issue: #228（親 #227）／ spec: `.kiro/specs/structured-logging-foundation/`

本書は、6 実行面が出す記録について **「ある意味の情報が、どの実行面でどの名前になるか」と「その名前を変えられるか」** を定める唯一の正典である。実装と本書の乖離は `scripts/check-log-field-canon.sh` と `scripts/check-log-field-binding.sh` が機械検証する。

## 読み方と守るべき規律

- **全実行面で同一の文字列へ統一することはできない。** 本番の集計指標が参照する表記（camelCase）と、既存 spec が要求仕様として名指しする表記（snake_case）が、それぞれ別の流儀で固定されている。したがって本書は「意味 → 各実行面での名前」の対応として定める
- **由来が `既存` の行は、備考に挙げた下流が壊れるため変更してはならない。**
- **由来が `新規` の行は、全実行面で同一の名前を用いる**（要件 4.5）。既存の分岐は固定したまま、前方だけ統一する
- **該当がない欄は空にせず `該当なし` と書く。** 空欄を許すと、棚卸しの漏れが「行が無い」という不可視の形になる
- **「応答層」「日次バッチ層」の列は、実装のコード上で使う名前である。** 出力時に別の名前へ写す項目（集約基盤の特別項目）は、写し先を備考に書く。列に写し先を書くと、実装との突き合わせ（`check-log-field-binding.sh`）が食い違う
- 出典は移送後の位置を書く。移送が完了するまで `check-log-field-binding.sh` は赤であり、その赤が移送すべき対象の一覧になる
- **どの欄にも縦棒（`|`）を書かない。** 表の列として解釈され、列数の検査に落ちる（エスケープしても同じ）。型の候補を並べたいときは読点で区切るか、備考を短く保って詳細は spec 側へ置く
- **本書の値が本番の集計指標と揃っているかは、どの検査も見ていない。** 正典と実装を協調して改名すれば検査は両方とも緑のまま通る。`既存` の行を触るときは `infra/modules/guardrails/main.tf` の参照先を人手で確かめること

### 新しく事象名を作るときの規約

面の接頭辞をドットで付ける（`<面>.<事象>`）。既存の `store-detail.*` / `delivery-job.*` がこの形であり、新設分はこれに揃える。`survey-web` の 6 事象は接頭辞を持たないが、うち 2 つを本番の集計指標が参照しているため改名できない（下表の備考を参照）。

---

## 1. 項目名

### 1.1 すべての記録が持つ項目

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 重大度 | `severity` | `severity` | 新規 | `ts/packages/observability/src/sink.ts` ／ `go/internal/logging/logging.go` | 集約基盤が重大度として解釈する特別項目。標準ライブラリが既定で出す `level` という名前では解釈されない（移送前の本番実測）。値は集約基盤の列挙に従い `DEBUG` / `INFO` / `WARNING` / `ERROR` を用いる。**警告は `WARNING` であって `WARN` ではない**（標準ライブラリは `WARN` を返すため写し替えが要る） |
| 事象名 | `event` | 該当なし | 既存 | `ts/packages/observability/src/sink.ts` | 日次バッチ層は `msg` 文字列で識別する。事象名の付与は本 spec の範囲外（#232 が必要とした時点で別課題） |
| 相関識別子 | `correlationId` | 該当なし | 新規 | `ts/packages/observability/src/sink.ts` | **出力時は集約基盤が解釈する `logging.googleapis.com/trace` へ写す**（同一値の記録が 1 本に束ねられる）。**値の供給は #229**。本 spec では常に未設定であり、未設定なら項目ごと出力しない |

### 1.2 面をまたいで使う項目

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 店舗の識別子 | `storeId` | `store_id` | 既存 | `ts/packages/observability/src/fields.ts` ／ `go/internal/batch/run.go` | **変更禁止**: 本番の集計指標が `EXTRACT(jsonPayload.storeId)` で参照している（`infra/modules/guardrails/main.tf` の `survey_funnel`） |
| 例外の種別 | `errorKind` | 該当なし | 既存 | `ts/packages/observability/src/fields.ts` | 有限集合の識別子として使う（例外の型名など）。**例外の本文は記録しない**（要件 2.5）。**型は `string` であり、自由文を弾かない**——規律であって強制ではない。厳格化は追跡課題 |
| 外部呼び出しの状態コード | `status` | 該当なし | 既存 | `ts/packages/observability/src/fields.ts` | |
| 例外の内容（自由文） | 該当なし | `error` | 既存 | `go/internal/batch/run.go` | 日次バッチ層は現行のまま。応答層は種別と状態コードへ置き換える（要件 2.5）。**日次バッチ層の是正は本 spec の範囲外** |

### 1.3 外部プラットフォーム由来の識別子

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 外部プラットフォームのリクエスト識別子 | `lineRequestId` | 該当なし | 既存 | `ts/apps/line-webhook/src/app.ts` | 現行の名前は `requestId`。相関識別子と紛らわしいため移送時に改名する（下流の参照は無い。テストのみ）。外部プラットフォームへの問い合わせに使う業務上の識別子であり、**利用者を一意に識別する値ではない** |

**現時点で記録から追えないもの**: データベースの失敗は `errorKind` に潰れ、状態コード（SQLSTATE のような有限集合の識別子）を持つ枠がまだ無い。「表が存在しない」と「接続を拒否された」が同じ記録になる。必要になった時点で項目を足すこと。

**記録してはならない値**: 来店客の入力（自由記述・生成された下書き本文・生成指示）、オーナーを外部プラットフォーム上で一意に識別する値、来店客を複数の記録にまたがって同一人物と判定できる値。これらは型として持たない（要件 2.3 / 2.4 / 2.6）。

### 1.4 アンケート面に固有の項目

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 事後検証で残った未選択観点 | `violatedAspects` | 該当なし | 既存 | `ts/apps/survey-web/src/lib/structured-log.ts` | 観点の識別子のみ。下書き本文・一言・生成指示は載せない |

### 1.5 店舗詳細面に固有の項目

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 店舗ヒントを無視した理由 | `reason` | 該当なし | 既存 | `ts/apps/store-detail/app/api/detail/route.ts` | 有限集合の識別子 |
| 認可済み店舗の件数 | `authorizedCount` | 該当なし | 既存 | `ts/apps/store-detail/app/api/detail/route.ts` | |

### 1.6 配信ジョブに固有の項目

実行サマリーの業務項目。**既存のテストが関数の返り値を項目ごとに検証している**ため、削除・改名はテストを壊す（追加は壊さない）。

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 実行時点の時刻区分 | `currentJstHour` | 該当なし | 既存 | `ts/apps/delivery-job/src/index.ts` | |
| 対象のサマリー日付 | `summaryDate` | 該当なし | 既存 | `ts/apps/delivery-job/src/index.ts` | |
| 配信対象の総数 | `targetsTotal` | 該当なし | 既存 | `ts/apps/delivery-job/src/index.ts` | |
| 配信できた件数 | `delivered` | 該当なし | 既存 | `ts/apps/delivery-job/src/index.ts` | |
| 配信に失敗した件数 | `failed` | 該当なし | 既存 | `ts/apps/delivery-job/src/index.ts` | |
| 対象外として飛ばした件数 | `skipped` | 該当なし | 既存 | `ts/apps/delivery-job/src/index.ts` | |
| 上限超過で送れなかった件数 | `quotaExceeded` | 該当なし | 既存 | `ts/apps/delivery-job/src/index.ts` | |
| 上限超過で処理を打ち切ったか | `quotaExceededStopped` | 該当なし | 既存 | `ts/apps/delivery-job/src/index.ts` | |
| プロセスの終了コード | `exitCode` | 該当なし | 既存 | `ts/apps/delivery-job/src/index.ts` | |
| 終了時に残っていた資源の種別 | `activeResources` | 該当なし | 既存 | `ts/apps/delivery-job/src/index.ts` | 配列。閉じ忘れの検知に使う（#151 の再発防止） |
| 失敗の要約 | `detail` | 該当なし | 新規 | `ts/apps/delivery-job/src/index.ts` | 移送前の名前は `message`（集約基盤が本文として吸い項目検索から消えるため改名した）。**リテラルのみを載せる**。例外の本文や利用者の入力を入れてはならない。型は `string` であり弾かないため、規律で守る |
| 欠落した設定の識別子 | `configKey` | 該当なし | 新規 | `ts/packages/observability/src/fields.ts` | 起動時に必須設定が欠けた場合の識別子。**自由文ではなく有限集合**（環境変数名）であり、例外の本文を載せずに原因を特定できる |

### 1.7 日次バッチ層に固有の項目

**変更禁止**: `competitive-daily-summary` の設計文書が要求仕様として名指しし、steering `tech.md` が判定式として参照している。

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 対象店舗の総数 | 該当なし | `stores_total` | 既存 | `go/cmd/daily-batch/main.go` | 変更禁止（設計文書が名指し） |
| 競合抽出を実行したか | 該当なし | `extract_ran` | 既存 | `go/cmd/daily-batch/main.go` | 同上 |
| 自店指標の取得に成功した件数 | 該当なし | `fetch_ok` | 既存 | `go/cmd/daily-batch/main.go` | 同上。steering `tech.md` が非ゼロ終了の判定式として参照 |
| 自店指標の取得に失敗した件数 | 該当なし | `fetch_failed` | 既存 | `go/cmd/daily-batch/main.go` | 同上 |
| 書き込んだサマリーの件数 | 該当なし | `summaries_written` | 既存 | `go/cmd/daily-batch/main.go` | 同上 |
| 掃除したスナップショットの件数 | 該当なし | `snapshots_purged` | 既存 | `go/cmd/daily-batch/main.go` | |
| 掃除したサマリーの件数 | 該当なし | `summaries_purged` | 既存 | `go/cmd/daily-batch/main.go` | |
| 掃除した合計件数 | 該当なし | `purged` | 既存 | `go/cmd/daily-batch/main.go` | |
| 場所の識別子 | 該当なし | `place_id` | 既存 | `go/internal/batch/run.go` | |
| 競合の識別子 | 該当なし | `competitor_id` | 既存 | `go/internal/batch/run.go` | |
| 場所が見つからなかったか | 該当なし | `not_found` | 既存 | `go/internal/batch/run.go` | |
| パニックの内容 | 該当なし | `panic` | 既存 | `go/internal/batch/run.go` | |

### 1.8 ダッシュボード API に固有の項目

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| 代理店の識別子 | `agencyId` | 該当なし | 新規 | `ts/packages/observability/src/fields.ts` | 招待コード発行の失敗記録で、どの代理店の操作が失敗したかを特定する。現行は識別子を 1 つも残しておらず対象を判定できない |

### 1.9 LINE Webhook 面に固有の項目

レポート要求（spec: `.kiro/specs/line-on-demand-report/`）の応答の記録に使う。どちらも有限集合の識別子であり、店舗 ID と LINE ユーザー ID の代わりにはならない（載せない）。

| 意味 | 応答層 | 日次バッチ層 | 由来 | 出典 | 備考 |
|---|---|---|---|---|---|
| レポートの種類 | `reportKind` | 該当なし | 新規 | `ts/apps/line-webhook/src/report/handler.ts` | 値は `new_reviews`、`comparison`、`trend` のいずれか（`@fwlm/line-report` の ReportKind） |
| レポート要求への応答の区分 | `reportOutcome` | 該当なし | 新規 | `ts/apps/line-webhook/src/report/handler.ts` | 値は `report`、`store_choice`、`no_store`、`preparing`、`fetch_failed` のいずれか。`fetch_failed` は最新の日次集計が取得失敗だった応答で、推移のレポート（失敗日を示した表と注記）もここに数える |

---

## 2. 事象名

事象名は面ごとに固有であり、応答層と日次バッチ層で対応づく性質のものではない。**日次バッチ層は事象名を持たない**（`msg` 文字列で識別する。本 spec の範囲外）。

| 事象名 | 実行面 | 由来 | 出典 | 備考 |
|---|---|---|---|---|
| `survey_page_viewed` | survey-web | 既存 | `ts/apps/survey-web/src/lib/structured-log.ts` | **変更禁止**: 本番の集計指標がこの文字列で絞り込む（`infra/modules/guardrails/main.tf` の `survey_funnel`） |
| `survey_response_submitted` | survey-web | 既存 | `ts/apps/survey-web/src/lib/structured-log.ts` | **変更禁止**: 同上 |
| `survey_review_link_opened` | survey-web | 新規 | `ts/apps/survey-web/src/lib/structured-log.ts` | **変更禁止**: 同上。投稿導線の押下（Issue #137）。token を検証できた押下だけを記録する |
| `generation_failed` | survey-web | 既存 | `ts/apps/survey-web/src/lib/structured-log.ts` | 本番障害の調査で参照された実績がある（#62） |
| `generation_safety_blocked` | survey-web | 既存 | `ts/apps/survey-web/src/lib/structured-log.ts` | |
| `factuality_residual` | survey-web | 既存 | `ts/apps/survey-web/src/lib/structured-log.ts` | |
| `tally_failed` | survey-web | 既存 | `ts/apps/survey-web/src/app/api/responses/handler.ts` | 集計の失敗は客へ転嫁しない（要件 5.4 の思想）。記録だけ残す |
| `store-detail.config_error` | store-detail | 既存 | `ts/apps/store-detail/app/api/detail/route.ts` | |
| `store-detail.pool_error` | store-detail | 既存 | `ts/apps/store-detail/app/api/detail/route.ts` | |
| `store-detail.query_error` | store-detail | 既存 | `ts/apps/store-detail/app/api/detail/route.ts` | |
| `store-detail.store_hint_ignored` | store-detail | 既存 | `ts/apps/store-detail/app/api/detail/route.ts` | |
| `delivery-job.run` | delivery-job | 既存 | `ts/apps/delivery-job/src/index.ts` | 実行サマリー。テストが返り値を項目ごとに検証している |
| `delivery-job.fatal` | delivery-job | 既存 | `ts/apps/delivery-job/src/index.ts` | |
| `delivery-job.isolated_error` | delivery-job | 既存 | `ts/apps/delivery-job/src/index.ts` | 1 店舗の失敗を他店から隔離したときの記録 |
| `delivery-job.exit` | delivery-job | 既存 | `ts/apps/delivery-job/src/index.ts` | 資源の閉じ忘れ検知（#151） |
| `line-webhook.dispatch_failed` | line-webhook | 新規 | `ts/apps/line-webhook/src/app.ts` | イベント処理の失敗。**再試行案内の返信を試みた**場合。移送前はメッセージ文字列で識別していた。レポートの対象店舗を決めた後の失敗（`StoreScopedReportError`・line-on-demand-report）は店舗名つきの再試行案内を返し、`errorKind` は包む前の元の例外（`cause`）の種別を載せる。店舗名は載せない |
| `line-webhook.dispatch_failed_before_reply_token` | line-webhook | 新規 | `ts/apps/line-webhook/src/app.ts` | イベント処理の失敗のうち、**replyToken が判明する前**に起きたもの。返信は試みていない。前者と分けるのは、運用者が「オーナーに案内が届いたか」を判定できるようにするため |
| `line-webhook.retry_reply_failed` | line-webhook | 新規 | `ts/apps/line-webhook/src/app.ts` | 再試行案内の返信自体に失敗した場合 |
| `line-webhook.reply_failed` | line-webhook | 新規 | `ts/apps/line-webhook/src/line/client.ts` | |
| `line-webhook.richmenu_linked` | line-webhook | 新規 | `ts/apps/line-webhook/src/owner/completed-menu.ts` | 補助的処理の**成功**。失敗のみを記録すると「記録が無い」が成功と未実行のどちらか判定できない（要件 3.4）。オンボーディング完了時のリンク（`onboarding/conversation.ts`）と、店舗特定済みオーナーの振り分け口のメニュー照合（`owner/router.ts`・line-on-demand-report）の両方が、この出典の同じ関数を呼んで出す |
| `line-webhook.richmenu_link_failed` | line-webhook | 新規 | `ts/apps/line-webhook/src/owner/completed-menu.ts` | 補助的処理の**失敗**。リンクの失敗は例外にせず、記録だけを残す（出典のコメントが明記）。振り分け口の照合では、応答は済んでいて会話の段階を変えない（次の操作で再び張る） |
| `line-webhook.audit_log_failed` | line-webhook | 既存 | `ts/apps/line-webhook/src/owner/completed-menu.ts` | 監査記録（`audit_logs`）の書込の失敗。会話の監査記録（オーナーの作成・オンボーディングの完了）も、出典の同じ関数で書く。業務処理は巻き戻さない。項目は `errorKind` だけである |
| `line-webhook.session_stage_update_failed` | line-webhook | 新規 | `ts/apps/line-webhook/src/owner/router.ts` | 振り分け口が完了後メニューを張れた後、会話の段階を completed に揃える更新に失敗した場合。応答は済んでいるので例外にしない。段階が completed でないままなので、次の操作で再び張って揃え直す。項目は `errorKind` だけである |
| `line-webhook.report_replied` | line-webhook | 新規 | `ts/apps/line-webhook/src/report/handler.ts` | レポート要求への応答。Reply を送った後に、応答ごとに 1 件出す。項目は `reportKind` と `reportOutcome` だけである。例外で終わった要求は出さない（`line-webhook.dispatch_failed` が記録する） |
| `line-webhook.report_store_hint_ignored` | line-webhook | 新規 | `ts/apps/line-webhook/src/report/handler.ts` | オーナーの確定店舗の集合の外にある店舗が指定され、選択肢を再提示した場合。指定された店舗 ID は載せない（集合外の値は攻撃者に由来しうる。`store-detail.store_hint_ignored` と同じ考え方）。他のオーナーに実在する ID と存在しない ID で記録を変えない |
| `dashboard-api.category_followup_failed` | dashboard-api | 新規 | `ts/apps/dashboard-api/src/index.ts` | 現行は事象名を持たない |
| `dashboard-api.invite_code_issue_failed` | dashboard-api | 新規 | `ts/apps/dashboard-api/src/index.ts` | 現行は事象名も識別子も持たず、どの対象の失敗か判定できない |

---

## 3. 記録を出さない実行面

| 実行面 | 状態 | 備考 |
|---|---|---|
| dashboard-web | 記録なし | ソース全体に出力が 1 件も無い（実測）。本 spec は記録を追加しない |

---

_一次情報源: `.kiro/specs/structured-logging-foundation/`（requirements / design / research）_
_更新時は `bash scripts/check-log-field-canon.sh` と `bash scripts/check-log-field-binding.sh` を通すこと_
