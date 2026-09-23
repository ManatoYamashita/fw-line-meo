# Research & Gap Analysis: store-suspension

- **実施日**: 2026-09-23
- **基準**: コードの読解は `d125ad4`（worktree の基点・main 上のコミット）で行った。提出時点の `origin/main` `d1479a5` との差は CI・infra・文書の 10 ファイルで、本 spec が参照するアプリ・DB・Go のコードに差は無い（`deploy.yml` の `workflow_run` による自動デプロイと、migration の手作業適用も変わっていない）
- **読んだもの**: 本 spec の `requirements.md`、steering（`product.md` / `review-gate.md`）、`competitive-daily-summary` / `agency-dashboard` / `line-on-demand-report` / `dashboard-user-edit` の要件・設計・調査、該当コード・migration・grants・不在検査、LINE の一次情報（下記）
- **方法**: コードの読解のみ（DB・本番は読んでいない）

## 1. 要約

- 変更は横断的だが、どれも既存の型に沿う。**難しいのは「実装」ではなく「取り残し」**。確定店舗を選ぶ述語が 8 箇所に分散しており、1 箇所でも漏れると停止中の店舗が一部の面で動き続ける。
- 既存の不在検査（`check_no_optional_capabilities.sh`）は `owners` の列と固定の識別子しか見ず、dashboard-api / dashboard-web / survey-web を走査しない。**現状のまま実装すれば全緑になる**（Req 8.5 で記録すべき事実）。
- DB 権限は TS の 3 ロールに `stores` のテーブル単位 UPDATE を一律に与えている。**オーナー向けの line-webhook も停止状態を書ける権限を持つ**ので、「オーナー自身の停止手段の不在」を名前の検査だけで担保するのは弱い。
- `line-on-demand-report`（#256・実装済み）は、停止状態が先に入る前提で述語の置き場所（`targets.ts:111` / `report-reads.ts:42`）と「店舗が無いとき」の案内（`notices.ts:24`）を用意済みで、本 spec の Req 6 と整合する。
- 要件側に **1 件の欠落と 2 件の文言のずれ**が見つかった（§4）。design の前に requirements を直すことを推奨する。

## 2. 現状の資産（Requirement-to-Asset Map）

| Req | 必要なもの | 既存資産 | ギャップ |
|---|---|---|---|
| 1.1–1.3 停止・再開 | 状態の保持と更新ルート | `POST /invite-codes/:id/disable`（`invite-codes.ts:124-158`）、`POST /dashboard-users/:id/disable\|enable`（`admin.ts:281-360`）が同型。CORS は GET/POST のみ（`app.ts:140`） | **Missing**: `stores` に停止状態が無い。ルートも無い |
| 1.4 範囲外の拒否 | 代理店スコープ | `canAccessStore`（`auth.ts:71-74`）。無効化系は UPDATE の WHERE に代理店条件を含めて 404 で存在を隠す（`invite-codes.ts:106-111`） | **Constraint**: QR ルート（`qr.ts:33-47`）は 404/403 を分けて存在を漏らす。本機能は無効化系の型に揃える必要がある |
| 1.5 冪等 | 同状態への要求を成功扱い | 無効化系はすべて冪等（既に無効なら 200） | なし |
| 1.6 確認 | 確認ダイアログ | **既存画面に確認の型が無い**（`admin/users/page.tsx`・`invite-codes/page.tsx`） | **Missing**: UI 部品の新設（Base UI の Dialog 系） |
| 1.7 データ保持 | 論理状態のみ | 4 階層の FK は `ON DELETE RESTRICT`、`ck_place_confirmed`（`0001:72`） | なし（停止を `place_status` に混ぜないこと） |
| 1.8 / 2.4 失敗表示・即時反映 | エラー処理 | `admin/users/page.tsx:204-229` の型 | なし |
| 2.1–2.3 一覧表示 | 一覧 API と表の列 | `GET /stores`（`stores-list.ts`）、`stores/page.tsx:129-137`（店名／店舗特定／競合設定／担当代理店／QR） | **Missing**: 一覧 API の応答に状態を含める・列と操作ボタン |
| 3.1–3.3 取得除外 | Go の対象抽出 | `ConfirmedStores`（`go/internal/repo/stores.go:21-27`）、`StoresWithoutFixedCompetitors`（`:50-57`、Places を呼ぶ `competitor.ExtractAndFix` を駆動・`run.go:140-146`） | **Missing**: 2 箇所の述語 |
| 3.4 対象店舗数 | `StoresTotal` | `run.go:78-80,138`、`stores_total` ログ（`main.go:68-78`）。全店失敗の終了判定（`main.go:84`）は `StoresTotal>0` 前提なので全店停止でも安全 | 述語の追加で自動的に満たす |
| 3.6 再開後の前日比 | 前日スナップショットのみ参照 | `run.go:382-432`、`summary/compute.go:155-158`（前日が無ければ新着 0・前日比 nil） | なし（既存挙動がそのまま要件を満たす） |
| 4.1–4.2 配信除外 | 配信対象抽出 | `queryDeliveryTargets`（`targets.ts:115-144`・当日の集計がある店舗）。述語の置き場所がコメントで名指し済み（`:111`） | **Missing**: 述語 |
| 4.3 見送り記録なし | 集計なし店舗の抽出 | `queryOwnersDueWithoutSummary`（`targets.ts:165-184`）が `skipped_no_summary` を書く | **Missing**: 述語を足さないと**停止中の全店舗に毎日 1 行溜まる** |
| 4.5 同じ状態を参照 | 言語間契約試験 | `go/internal/batch/crossruntime_test.go`、`ts/apps/delivery-job/test/cross-runtime.e2e.test.ts`（`testdb.Shared`） | **Missing**: 停止店舗のケース |
| 5.1–5.2 アンケート停止 | 店舗の可用判定 | `page-data.ts:37`（`unavailable`）、`responses/handler.ts:76`（404 `STORE_NOT_AVAILABLE`）、`findStoreForSurvey`（`ts/packages/db/src/stores.ts:35`） | **Missing**: 2 箇所の述語。表示は既存の `unavailable` を流用できる |
| 5.3 集計保持 | — | 集計は `store_id`×月（`tallies.ts:53-86`） | なし |
| 6.1 LIFF | オーナーの店舗集合 | `liff-auth.ts:161-174`（0 店舗→404、2 店舗以上→409） | **Missing**: 述語 |
| 6.2–6.3 リッチメニュー | 店舗一覧読み出し | `listReportableStores`（`report-reads.ts:42-53`・述語の置き場所名指し済み）、0 店舗の案内 `notices.ts:24`（line-on-demand-report Req 3.7） | **Missing**: 述語のみ。案内文は既存 |
| 6.4 ブロックで不変 | unfollow 無視 | `dispatch.ts:5-8,81` | なし（現状維持） |
| 7.1–7.4 監査 | action 追加 | `AUDIT_LOG_ACTIONS` 16 値（`ts/packages/db/src/audit-logs.ts:20-39`）、`ck_audit_logs_action`（`0009`）、集合一致テスト（`audit-logs.db.test.ts`）、`target_type` に `store` あり。payload 列は無い | **Missing**: 2 値（停止・再開）と CHECK の作り直し。**Constraint**: 監査は業務書込のコミット後で、失敗は未捕捉の 5xx（#250 未決） |
| 8.1–8.4 不在検査 | 検査の書き換え | 後述 §3.3 | **Missing / Constraint** |
| 8.2 要件改訂 | `competitive-daily-summary` の Out of scope（`requirements.md:48`）と Req 3.10（`:103`） | — | 文書の改訂 |
| 9.1–9.3 本番確認 | migration の適用確認 | #251 の実例、メモリ `prod-gcp-access-recipes` | 手順のみ |

### 確定店舗を選ぶ述語の全量（停止を足す候補）

| # | 場所 | 面 |
|---|---|---|
| 1 | `go/internal/repo/stores.go:25` | 日次取得 |
| 2 | `go/internal/repo/stores.go:54` | 競合の抽出・固定（Places） |
| 3 | `ts/apps/delivery-job/src/targets.ts:141` | 配信対象 |
| 4 | `ts/apps/delivery-job/src/targets.ts:181` | 集計なしの見送り記録 |
| 5 | `ts/packages/db/src/report-reads.ts:49` | リッチメニューの店舗選択 |
| 6 | `ts/apps/store-detail/lib/liff-auth.ts:172` | LIFF |
| 7 | `ts/apps/survey-web/src/app/s/[storeId]/page-data.ts:37`（`findStoreForSurvey` 経由） | アンケート表示 |
| 8 | `ts/apps/survey-web/src/app/api/responses/handler.ts:76` | アンケート送信 |
| — | `ts/apps/dashboard-api/src/qr.ts:33-47` | QR 発行（§4-1 の判断次第） |

## 3. 制約と既存の型

### 3.1 書込境界と権限
- `stores` の書込は TS（`db/write-boundary.md:15`）。ただし表の記述は「店舗特定オンボーディング（Webhook/LIFF）」のみで、dashboard-api の店舗登録（`POST /stores`）も既に書いている。停止の書込主体として dashboard-api を明記する必要がある。
- `infra/sql/grants.sql:62-66` は TS の 3 ロール（line_webhook / survey_web / dashboard_api）に `stores` の INSERT/UPDATE/DELETE を一律に与えている。**停止状態の列を足すと、オーナー向けの line-webhook と客向けの survey-web も DB 上はそれを書ける。**
- Go のバッチロールは `stores` を読むだけ。

### 3.2 migration と監査 action の並行
- 最新は `0011`。本 spec の migration は `0012` 以降。open の PR（#322）は migration に触れていない。
- `ck_audit_logs_action` は #259 が明示名で作り直し済み（`0009:51-72`）。**本 spec は 16 値＋2 値の和集合で作り直す**。`DROP` に `IF EXISTS` を付けない流儀（`0010` の注記）に揃える。

### 3.3 不在検査（`db/test/check_no_optional_capabilities.sh`）の射程
- (A1) `:67-81`: `owners` の列だけを denylist（`delivery_enabled` / `opted_out` など 8 語）と照合。`stores` を見ない。
- (A2) `:84-94`: `(competitor.*(override|request|adjust)|delivery.*(preference|opt))` の表名。
- (B2) `:142-173`: 固定語（`optOut` / `unsubscribe` / `disableDelivery` など）の大小無視 grep。走査は `packages/db` / `delivery-job` / `store-detail`×2 / `line-webhook` の 5 ディレクトリで、**dashboard-api / dashboard-web / survey-web を含まない**（#158）。`suspend` は当たらない。
- (B3) `:175-199`: store-detail の API が読取専用の `/api/detail` だけであること。
- 結論: 現状の検査は、本機能を**どの名前で・どこに**実装しても鳴らない。Req 8.5 の「書き換え前に検出できなかったこと」は、実装を入れた状態で現行検査を流して PASS を確認すれば記録できる。

### 3.4 LINE の一次情報（unfollow を扱わない根拠）
- [Messaging API pricing](https://developers.line.biz/en/docs/messaging-api/pricing/): "If you send a message to a user who blocked your LINE Official Account or a user ID that doesn't exist, the message isn't counted."
- [How message counts are calculated in the Messaging API](https://developers.line.biz/en/tips/2026/05/28/how-to-count-messages/)（2026-05-28）: 同旨。
- スキルの要約（`.claude/skills/messaging-api/references/message-sending.md:22`）と一致。

## 4. 要件側で見つかった欠落・ずれ（design 前の修正を推奨）

1. **欠落: 停止中の店舗への QR 発行**。Req 5 は QR を読んだ客の側しか定めていない。管理画面から停止中の店舗の QR を発行・再ダウンロードできると、止めた店舗の QR が新たに店頭へ出うる。既存の QR ルートは未確定店舗に 409 `PLACE_NOT_CONFIRMED` を返すので、同型で「停止中は発行しない」を足すか、「発行は許す（再開に備える）」を明示するかを決める必要がある。
2. **ずれ: Req 4 の「日次サマリーを送信しない」**。#256 以降、配信は毎朝のカードではなく「変化があった日だけの短い通知」になった（`0010` の注記）。「日次の変化通知」へ言い換えるのが正確。
3. **ずれ: Req 4.3 の射程**。見送りの記録は `skipped_no_summary` 以外に `skipped_no_change` / `skipped_not_comparable` / `skipped_menu_unavailable` がある。集計作成後に停止された店舗（4.2）は当日の集計を持つので、4.3 を「サマリーが無いことによる」に限ると、それ以外の見送り理由の行が残りうる。Req 9.2（配信記録が無いこと）と揃えるなら「停止中の店舗について、いかなる理由の通知記録も作らない」とすべき。

> **反映済み（2026-09-23）**: 上の 3 点は requirements.md へ反映した。1 は「停止中は発行しない」（Req 5.5–5.7）、2 は Req 4 を「日次の変化通知」へ言い換え、3 は Req 4.3 を「いかなる理由の通知記録も残さない」へ広げ Req 9.2 と揃えた。

## 5. 実装アプローチの選択肢

### Option A: 既存の各所へ述語を足す（Extend）
- `stores` に停止状態の列を足し、§2 の 8 箇所それぞれに「停止中でない」を足す。dashboard-api に 2 ルート、dashboard-web の表に列と操作。
- ✅ 変更は小さく、既存の読み出しの形を変えない。`line-on-demand-report` が用意した置き場所をそのまま使える
- ❌ 述語が 2 言語・8 箇所に複製される。将来の新しい読み出しで足し忘れても何も鳴らない（#151 と同型の「足したとき忘れる」余地）

### Option B: 「利用中の店舗」の定義を DB 側に 1 つ持つ（New）
- 「確定済み かつ 停止中でない」を DB のビュー（または同等の単一定義）にし、8 箇所の読み出しをそこへ向ける。
- ✅ 定義が 1 つになり、Go と TS が同じ状態を参照すること（Req 4.5）が構造で担保される
- ❌ 既存クエリの書き換えが増え、ビューへの GRANT・`db/ERD.md`・`make db-verify-docs` の整合を足す必要がある。読み出しごとに JOIN の形が違う（`targets.ts` は当日・前日の集計と結合）ので、全箇所が素直に置き換わるかは要確認

### Option C: 述語は各所に足し、取り残しを機械で強制する（Hybrid）
- Option A の実装に、(1) `place_status = 'confirmed'` を含むのに停止の述語を持たない読み出しを赤にするガード（許可リストつき）と、(2) 停止店舗を各面で除外する言語間契約試験を足す。
- ✅ 変更は A と同じく小さく、「足し忘れ」を CI が検出する
- ❌ 文字列ガードは表記揺れ（`placeStatus !== 'confirmed'` など TS 側の判定）に弱く、ガード自身の空振り対策（自己テスト・変異での赤化確認）が要る

### オーナー自身の停止手段の不在（Req 8）の担保方法（A/B/C と独立に選ぶ）
- **8-a 名前の検査を広げる**: (B2) の走査に dashboard-api / dashboard-web / survey-web を足し、停止関連の識別子を「dashboard-api / dashboard-web にのみ許す」形へ変える。軽いが、名前で避けられる弱さは残る。
- **8-b 権限で担保する**: 停止状態の列の UPDATE を dashboard_api ロールにだけ与え（列単位の GRANT）、line_webhook / survey_web からは書けなくする。不在検査は「その列の UPDATE 権限が dashboard_api 以外に無いこと」を検査する。名前に依存しない。
- **8-c 両方**: 8-b を主にし、8-a で UI・ルートの側も見る。

## 6. 工数とリスク

- **Effort: M（3〜7 日）** — 個々の変更は既存の型の延長だが、DB・Go・TS 5 アプリ・不在検査・言語間試験・要件改訂・本番確認と面が多い。Issue の見積り 4 開発日は、確認ダイアログの新設と不在検査の作り直しを含めると下限寄り。
- **Risk: Medium** — 技術的な未知は少ないが、述語の取り残しがあっても既存テストが緑のまま通る構造で、発見が本番の翌朝まで遅れうる。権限の変更（8-b）は本番の GRANT 適用を伴う。

## 7. design に持ち越す判断と調査項目

- **判断**: 停止状態の表現（真偽・時刻・状態の列挙）。時刻を持てば停止日を一覧に出せるが、監査記録と二重になる
- **判断**: Option A / B / C、および不在の担保 8-a / 8-b / 8-c
- **判断**: §4 の 3 点（QR 発行の扱い・Req 4 の言い換え・4.3 の射程）。requirements へ戻して確定する
- **Research Needed**: 列単位 GRANT（8-b）を既存の `grants.sql` の適用手順と本番のロールでそのまま運用できるか。テーブル単位の UPDATE を持つロールから列だけ外すには、テーブル単位の UPDATE を剥がして列を列挙し直す必要がある
- **Research Needed**: 監査の失敗の扱い（#250）が本 spec の実装前に決まるか。未決なら既存の dashboard-api の挙動（コミット後に書き、失敗は 5xx）に揃え、その旨を design に残す
- **Research Needed**: 停止中のオーナーがオンボーディング・店舗登録で新たに店舗を確定させた場合、その店舗は利用中から始まる（停止は店舗単位のため）。これが運用上問題ないか
- **Research Needed**: 確認ダイアログの部品が `@fw-line-meo/ui` に無い場合の新設範囲と、a11y 監査の面一覧に確認ダイアログの状態が漏れないこと（メモリ `a11y-audit-misses-successor-states`）

---

# Design Discovery & Synthesis（2026-09-23・`/kiro-spec-design`）

## Summary
- **Feature**: store-suspension
- **Discovery Scope**: Extension（既存の 2 言語・6 アプリへの横断的な追加）。light discovery を実施した
- **Key Findings**:
  1. PostgreSQL は、テーブル単位の権限を持つロールから列単位の REVOKE をしても効かない（下記一次情報）。`grants.sql` は TS の 3 ロールへ `stores` のテーブル単位 DML を与えているので、停止の列を書けないようにするには**テーブル単位の INSERT/UPDATE を剥がし、列を列挙して与え直す**必要がある。
  2. `grants.sql` は CI で一度も適用されていない（`check_docs.sh` が文字列として読むだけ）。権限による担保を CI で検証するには、テスト DB にロールを作って `grants.sql` を実際に当て、`has_column_privilege` で問う検査が要る。これは上記 1 の罠（列の REVOKE が無効）そのものを実行で捕まえる。
  3. survey-web の下書き生成（`api/drafts/handler.ts`）は店舗の状態を一切見ていない。回答送信時に発行したセッショントークンだけで再生成できるので、回答後に停止された店舗でも下書き生成が続く。確定店舗の述語を持たないため、述語の網（Option C のガード）にも掛からない。

## Research Log

### 列単位の権限（PostgreSQL）
- **Sources**: [PostgreSQL: REVOKE](https://www.postgresql.org/docs/current/sql-revoke.html) — "On the other hand, if a role has been granted privileges on a table, then revoking the same privileges from individual columns will have no effect."
- **Findings**: 列単位で書込を禁じるには、テーブル単位の INSERT/UPDATE を REVOKE し、許す列だけを `GRANT INSERT (cols), UPDATE (cols)` で与え直す。DELETE と SELECT は列単位の対象外なので、テーブル単位のまま残る。
- **Implications**: `grants.sql` に列の列挙が入るので、`stores` に列を足すたびに列挙へ追記する必要がある。追記を忘れると、line-webhook がその列を書けなくなる（fail-closed）。検査はこの状態を赤にする。

### Base UI の AlertDialog
- **Sources**: `ts/node_modules/.pnpm/@base-ui+react@1.6.0.../@base-ui/react/alert-dialog`（ローカルで実在を確認）。`@fwlm/ui` の依存は `@base-ui/react ^1.6.0`
- **Findings**: 既存の依存に AlertDialog が含まれている。`@fwlm/ui` にはまだ Dialog 系の部品が無い。
- **Implications**: 新しい外部ライブラリを足さずに、確認ダイアログを `@fwlm/ui` の部品として作れる。

### 既存の無効化 API の型
- **Sources**: `ts/apps/dashboard-api/src/invite-codes.ts:103-160`、`admin.ts:279-331`、`app.ts:43-70,207,246`、`index.ts:116,127,194`
- **Findings**: handler は `(deps, req) => Promise<Response>` で、deps の repo 関数は `index.ts` が遅延取得した pool で包んで渡す。無効化系は冪等（既に無効なら 200）で、存在しない id と範囲外の id を同じ 404 にする。監査はコミット後に `deps.auditLog?.(...)` を呼ぶ。
- **Implications**: 停止・再開も同じ型にする。店舗一覧のエラーコードは小文字（`stores-list.ts`）、QR は大文字（`qr.ts`）で揃っていない。新しいルートは小文字（無効化系・一覧と同じ）にする。

### 言語間契約試験の型
- **Sources**: `go/internal/batch/crossruntime_test.go`（固定 UUID `c7…`・固定時刻 2026-07-12・`testdb.Shared`・`CROSS_RUNTIME_SKIP_CLEANUP=1`）、`ts/apps/delivery-job/test/cross-runtime.e2e.test.ts`（`CROSS_RUNTIME_GO_SEEDED=1`）、`db/test/cross_runtime_steps.sh`
- **Implications**: 停止中の店舗を固定 UUID で 1 件足し、Go が集計を作らないことと、TS がその店舗の通知記録を作らないことを、同じ行を見る形で固定できる。

## Architecture Pattern Evaluation

| Option | 説明 | 強み | リスク | 判断 |
|---|---|---|---|---|
| A 各所に述語 | 8 箇所に `suspended_at IS NULL` を足すだけ | 変更が最小 | 次の読み出しで足し忘れても鳴らない | 単独では不採用 |
| B DB のビュー | 「利用中の店舗」をビューに 1 つ置く | 定義が 1 つ | `check_docs.sh`・`30_compliance.sql` が BASE TABLE しか見ない。`grants.sql` の再適用が要る。TS の判定（survey-web・QR・画面）はビューで置き換わらない | 不採用 |
| **C 述語＋機械強制** | A に、確定の判定と停止の判定の数をファイルごとに突き合わせるガードを足す | 変更は A と同じで、足し忘れを CI が検出する | 文字列ガードは表記揺れに弱い → 自己テストで空振りしないことを確かめる | **採用** |

不在の担保は **8-c（権限＋名前の検査）** を採る。権限は名前に依存せず、名前の検査は権限では見えない UI とルートの側を見る。

## Design Decisions

### Decision: 停止状態は `stores.suspended_at timestamptz NULL` で持つ
- **Alternatives**: 真偽の列 / 状態の列挙 / 停止の履歴テーブル
- **Selected**: 時刻の列。NULL が利用中、値ありが停止中
- **Rationale**: 真偽と同じく 1 列で判定でき、停止した日を一覧に出せる。履歴は監査記録が持つので、履歴テーブルは二重になる
- **Trade-offs**: 再開すると停止日時は消える（監査記録には残る）

### Decision: 確定店舗の判定の足し忘れを、ファイル単位の件数照合で検出する
- **Selected**: `scripts/check-store-serviceable-predicate.sh`。本番コード（テスト・コメントを除く）で、ファイルごとに「確定の判定の件数 ≤ 停止の判定の件数」を要求する
- **Rationale**: 定義表への書き写しを持たないので、表と実物が離れて空振りすることが無い（メモリ `guard-detached-from-artifact`）
- **Revision（review gate）**: 現行ツリーを実測すると、文書コメント（`/**` 始まり）の中の述語と、利用可否を決めない表示だけの判定（`page.tsx:149`）が数えられていた。コメントの除外に `/*` を足し、表示だけの判定には理由必須の除外印を設けた。表現を書き換えて件数を避けるのは Issue #252 が禁じる「名前で避ける」と同型なので採らない
- **Trade-offs**: 1 ファイルに 2 つのクエリがあり、片方にだけ停止の判定が 2 回書かれると通ってしまう。件数の一致までは保証するが、どのクエリかまでは見ない。取りこぼしは言語間契約試験と各面の単体試験で補う

### Decision: 下書き生成も店舗の状態を確かめる
- **Selected**: `api/drafts/handler.ts` の再生成でも、店舗が停止中なら 404 `STORE_NOT_AVAILABLE` を返す
- **Rationale**: Req 5.2（停止中は下書き生成に用いない）。回答後に停止された店舗の再生成を止める。ここには確定の判定が無いので、ガードでは検出できない。単体試験で固定する

## Synthesis Outcomes
- **Generalization**: 8 箇所の除外は「利用中の店舗」という 1 つの概念だが、2 言語・読み出しの形の違いから共通のコード（ビュー・関数）にはしない。共通化の代わりに、件数照合のガードで網を張る
- **Build vs Adopt**: 確認ダイアログは既存依存の Base UI AlertDialog を採る。新しい外部ライブラリは足さない
- **Simplification**: 停止・再開は 1 つの handler・1 つの repo 関数で扱い、向きを引数で渡す。オーナー単位・代理店単位の一括停止は作らない

## Risks & Mitigations
- 本番の検証用店舗を停止すると、本番の読み取り確認（`make e2e-prod-checks`）と実機確認が使う店舗が止まる → Req 9 で使う店舗を事前に決め、確認後に再開する手順を tasks に入れる
- `grants.sql` の列挙に新しい列を足し忘れる → 権限検査が「停止の列以外はすべて line-webhook が書ける」ことを要求して赤にする
- 監査記録の書込が失敗すると、停止は成立したまま 500 になる（#250 未決） → 画面は結果によらず一覧を読み直し、実際の状態を表示する

## References
- [PostgreSQL: REVOKE](https://www.postgresql.org/docs/current/sql-revoke.html)
- [Messaging API pricing](https://developers.line.biz/en/docs/messaging-api/pricing/)

## Design Validation（2026-09-23・`/kiro-validate-design`）

判定は GO。次の 3 点を design.md に反映した。

1. **本番の REVOKE が空振りしうる**: [PostgreSQL: REVOKE](https://www.postgresql.org/docs/current/sql-revoke.html) — "A user can only revoke privileges that were granted directly by that user." "…the other forms will issue a warning if grant options for any of the privileges specifically named in the command are not held." 剥がせなくても警告で終わり、`ON_ERROR_STOP=1` では止まらない。CI の PrivilegeCheck は superuser で走るので再現できない。→ 付与者（`role_table_grants.grantor`）を事前に照会して接続ユーザーと揃え、適用後の `has_column_privilege` で「書けない」を確認できるまでデプロイと停止の操作に進まない。
2. **除外の印が抜け道になる**: 理由を書けば誰でもガードを黙らせられた。→ 印の総数（1）と置いてよいファイルをガード本体に直書きし、食い違いを赤にする（メモリ `per-state-declaration-needs-total` と同じ型の対策）。
3. **Req 4.2 の試験が空振りする**: `queryDeliveryTargets` は当日の集計がある店舗しか返さないので、集計の無い停止店舗では述語を消しても結果が変わらない。→ 「集計があり停止中」の店舗と、利用中の対照を置く。述語を消す変異で赤を実測する。

## Task-Graph Sanity Review（2026-09-23・`/kiro-spec-tasks`）

独立レビューで、design の ProductionVerification 手順 1（「マージ後に 0012 を当てる」）が、同じ design の Migration Strategy（「コードより先に当てる」）と、実際のパイプラインの両方に矛盾していることが見つかった。`.github/workflows/deploy.yml` は main の ts-ci 成功で `workflow_run` により自動デプロイし、migration を当てる工程はワークフローに無い（`infra/README.md` §3 の手作業）。マージ後に当てると、述語を含むイメージが先に出て各面が `column does not exist` で落ちる。→ design を「実装 PR のマージ前に適用・照会し、確認できてからマージする」へ直し、tasks の本番適用をマージ前のタスクにした。メモリ `deploy-pipeline-coverage-guards` の「env の追加はイメージより先」と同じ型である。
