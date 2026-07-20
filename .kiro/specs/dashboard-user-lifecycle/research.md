# Research & Analysis — dashboard-user-lifecycle

## Gap Analysis（/kiro-validate-gap・2026-07-19）

### 1. 現状調査（Current State）

対象は `agency-dashboard` spec が実装した利用者管理の縫い目。関連資産と規約:

| 資産 | 場所 | 状態 |
|---|---|---|
| 無効化 DAL | `ts/packages/db/src/dashboard-users.ts:158` `disableDashboardUser`（`SET disabled_at = now() WHERE id AND operator_id`・RETURNING・0行→null） | 拡張のベース。**ガードなし** |
| 無効化ハンドラ | `ts/apps/dashboard-api/src/admin.ts:193` `handleDashboardUserDisable`（`requireOperatorUser` 前置・UUID 事前ガード・null→404） | 鏡写しで enable を作る雛形 |
| ルート配線 | `ts/apps/dashboard-api/src/app.ts`（`POST /dashboard-users/:id/disable`）＋ `index.ts` の DI 合成 | enable 追加は 1 ルート＋DI 1 行 |
| 初回リンク | `dashboard-users.ts:71` `linkAuthSubjectByEmail`（`AND disabled_at IS NULL` 条件付き単一 UPDATE） | **無変更で Req 1.3 を満たす**（再有効化で disabled_at が NULL に戻れば、既存条件のままリンク再開） |
| メール一意 | `db/migrations/0005:30` `ux_dashboard_users_email`＝`lower(email)` の**グローバル**部分一意（operator スコープではない） | Req 3.1 は現状維持。**Req 3.2 の案内強化に越境漏えいリスク**（下記 Constraint） |
| auth_subject | `db/migrations/0001:86` `text UNIQUE`（0005 で NOT NULL のみ解除・UNIQUE は健在） | 「再有効化一本化」の決裁により UNIQUE 衝突問題を構造的に回避（同一メール複数行を作らないため） |
| /me 応答 | `ts/apps/dashboard-api/src/me.ts` `MeUser = { role, agencyId, agencyName, displayName }` | **`id` を返さない** → UI が「自分の行」を識別できない（Req 2.2 の欠落前提） |
| UI | `ts/apps/dashboard-web/src/app/admin/users/page.tsx`（無効化ボタンは `!user.disabled` 行のみ・operator ゲート済み） | 有効化ボタン・自分行の非表示を追加 |
| TX 設備 | `ts/packages/db/src/pool.ts` は `Queryable`（query のみ）を公開。実 `Pool` は `connect()` を持ち、`@fwlm/store-identification` が `pool.connect()` による TX 前例を確立 | Req 2.5（並行ガード）の実装土台あり |
| テスト規約 | 単体=`admin.test.ts`（38）・配線=`app-routes.db.test.ts`（f5）・DAL=`dashboard-users.db.test.ts`（f4）。共有 DB の UUID prefix は **f7 まで使用済み → 本 spec は f8** | 追随する |

規約: エラー封筒 `{error:{code,message}}`・封筒コードは小文字・存在秘匿（404/403 の同一応答）・operatorId は認証由来のみ・SQL は @fwlm/db アクセサ（inline SQL 禁止・validate-impl 教訓）・API 契約変更は design contract 表へ同時反映（同教訓）。

### 2. 要件フィージビリティ（Requirement-to-Asset Map）

| 要件 | 既存資産 | ギャップ |
|---|---|---|
| 1.1/1.4/1.5 再有効化＋冪等＋存在秘匿 | disable 三点セット（DAL/handler/route） | **Missing**: `enableDashboardUser`（`SET disabled_at = NULL`・UPDATE 自体が冪等）＋ `POST /dashboard-users/:id/enable` ＋ DI |
| 1.2 リンク済み行の復帰 | `findByAuthSubject`（disabled 判定） | なし（disabled_at NULL に戻れば既存ロジックで即復帰） |
| 1.3 保留行のリンク再開 | `linkAuthSubjectByEmail:71` | なし（**無変更が正解**・条件を緩めないこと） |
| 1.6 UI 表示制御 | users/page.tsx のボタン出し分け | **Missing**: 無効行にのみ「有効化」ボタン |
| 2.1 自己無効化拒否 | handler の guard.user.id | **Missing**: `req.id === guard.user.id` の事前拒否（DAL 到達前） |
| 2.2 自分行のボタン非表示 | — | **Missing×2**: UI 判定＋**/me に `id` が無い**（MeUser への追加が前提。加算的変更・既存消費者は dashboard-web のみ） |
| 2.3/2.5 最終運営保護＋並行安全 | TX 前例（store-identification） | **Missing＋Research**: 単純な「判定→UPDATE」や単文 UPDATE+EXISTS は **write-skew**（最後の2人を同時に無効化→0人）を防げない。方式選定が必要（下記） |
| 2.4/3.1/3.3 既存挙動維持 | 既存実装 | なし（回帰テストで固定） |
| 2.6 拒否理由の明確表示 | 封筒コード体系 | **Missing**: ガード用エラーコード新設（例: 自己無効化/最終運営で別コード）＋UI 文言 |
| 3.2 409 時の復旧案内 | 409 `email_conflict` | **Missing＋Constraint**: 一意制約は**グローバル**のため、衝突行が**他運営配下**の場合に「無効化済みだから有効化せよ」と返すと越境の存在漏えいになる。**自運営スコープ内の衝突時のみ**案内を強化し、それ以外は現行の汎用 409 を維持する設計が必要 |
| 4.1–4.4 認可維持 | requireOperatorUser・スコープ付き UPDATE | なし（enable にも同型を適用） |

**Migration 不要**: 「再有効化一本化」決裁により DDL 変更なし（一意制約・リンク条件とも現状維持）。書込境界・grants も不変。インフラ・env 変更なし。

### 3. Req 2.5（並行ガード）の方式候補 — Research Needed

最後の有効運営 2 人を同時に無効化する競合で「互いに相手が残る」と判定し合う write-skew が本質。READ COMMITTED の単文 UPDATE+EXISTS では防げない。

- **案1: TX + `SELECT … FOR UPDATE`**: 同一 operator 配下の有効 operator 行を `FOR UPDATE` で行ロック → 残数判定 → UPDATE → COMMIT。行ロックで競合を直列化。前例（store-identification の TX）に沿う。プレーンで検証しやすい。
- **案2: TX + `pg_advisory_xact_lock(hashtext(operator_id::text))`**: テナント単位の助言ロックで disable 操作を直列化 → 判定 → UPDATE。ロック粒度が明快・行集合の変動に強い。ハッシュ衝突は理論上あるが実害なし（過剰直列化のみ）。
- **案3: SERIALIZABLE 隔離**: リトライ実装が必要になり複雑。既存コードベースに前例なし。非推奨。

いずれも db.test で「2 クライアント並行 disable → 必ず一方が拒否」を実証すること（f8 プレフィックス）。

### 4. 実装アプローチ

- **Option A: 既存拡張（推奨）** — DAL は `dashboard-users.ts` へ追加、ハンドラは `admin.ts` へ追加、ルートは `app.ts`、UI は `users/page.tsx`、`me.ts` に `id` を加算。新規ファイルなし。disable と enable が同居し対称性が読める。admin.ts は約 300 行で許容内。
  - ✅ 既存パターン完全踏襲・最小差分・レビュー容易 ❌ admin.ts の肥大が進む
- **Option B: 新規コンポーネント**（user-lifecycle 専用モジュール分離）— 2 エンドポイント規模では過剰。❌ 分離の便益が薄い
- **Option C: ハイブリッド** — 並行ガードのみ DAL 内の専用関数（例: `disableDashboardUserGuarded`）として切り出し、他は Option A。実質 A の変種。

### 5. 規模とリスク

- **Effort: S（1–3日）** — 既存三点セットの鏡写し＋ガード 2 種＋UI 2 箇所＋テスト。パターンは全て既存。
- **Risk: Low〜Medium** — 唯一の非自明点は 2.5 の並行ガード（Medium・方式候補あり・db.test で実証可能）。他は Low。

### 6. design フェーズへの引き継ぎ（Research Needed / Key Decisions）

1. **並行ガード方式の確定**（案1 FOR UPDATE vs 案2 advisory lock）＋ write-skew 防止の db.test 設計
2. **ガード拒否のエラーコード命名**（UI が文言を出し分けるため、例: 自己無効化と最終運営で別コード）→ **design の API contract 表へ必ず反映**（validate-impl 教訓）
3. **/me 応答への `id` 追加**（加算的・contract 表更新・dashboard-web の Me 型同期）
4. **3.2 の 409 強化の応答形**（自運営スコープ内衝突のみ詳細化・越境時は汎用 409 維持。コード分割 or メッセージのみかを設計で決定）
5. テスト計画: 単体（ガード分岐）・DAL（enable 冪等・スコープ）・配線（f8・並行 2 クライアント実証・agency 403 回帰）

---

## Design Synthesis（/kiro-spec-design・2026-07-19）

### Generalization
- #31（再有効化）と #32（無効化ガード）は「`dashboard_users` の `disabled_at` 状態遷移＋operator スコープガード」という単一問題の双方向。新モジュールを作らず、無効化の対称として `enableDashboardUser` を DAL に、`handleDashboardUserEnable` をハンドラに追加する（既存三点セットの鏡写し）。

### Build vs Adopt
- **並行ガードは Postgres ネイティブの `pg_advisory_xact_lock` を adopt**（アプリ層ロックを build しない）。TX クライアントは既存 `@fwlm/store-identification` が確立した `ConnectablePool`/`TransactionClient` 構造を踏襲（`getPool()` の戻り値をそのまま渡せる）。`TransactionCapable` を `pool.ts` に最小追加。
- SERIALIZABLE 隔離は不採用（リトライ実装が必要・前例なし）。**当初 design は `FOR UPDATE` を採ったが、validate-design（2026-07-19・ユーザー決裁）で advisory lock へ切替**——テナント単位の直列化により count 判定が自明に正しく、EvalPlanQual 再評価の機微に依存せず、並行テストが容易。管理操作は低頻度ゆえ過剰直列化は無害。

### Simplification
- **自己無効化ガードは DB 前（ハンドラ）**で弾く（往復不要・並行性問題ではない）。TX が要るのは最後の運営ガードのみ。
- **再有効化は無ガードのプレーン UPDATE**（`disabled_at`=NULL・冪等・TX 不要）。
- **migration ゼロ**（再有効化一本化により一意制約・リンク条件は無変更）。
- ガードなしの単純 `disableDashboardUser` は撤去（dead-export 化を避ける・validate-impl 教訓）。
- 409 強化は「自運営スコープ内の無効化済みのみ」詳細化（越境秘匿）。新規テーブル/フラグを増やさず既存一意違反＋スコープルックアップで実現。

### 決定した設計判断（design.md 反映済み・validate-design 後の最終形）
1. 並行ガード = TX＋`pg_advisory_xact_lock`（テナント=operator_id 単位で直列化・専用ロッククラス）。
2. 「有効な運営」= `role=operator` かつ `disabled_at IS NULL`（**保留＝未ログイン運営も含む**・ユーザー決裁）。初回ログインで復旧可能な正当な回復経路とみなす。
3. 新エラーコード 3 種（`self_disable_forbidden` / `last_operator` / `email_conflict_disabled`・すべて 409）→ design API 契約表・UI と同期。
4. `GET /me` に `id` 追加（UI の自己行識別・加算的）。
5. `DisableOutcome` 判別共用体で DAL→ハンドラの結果を型安全に写像。
6. テスト: 並行 2 クライアントで `last_operator` を決定的に実証（f8 prefix）。
7. 破壊的変更（simple disable 撤去・disableUser 戻り型・/me id）は「実装＋当該テスト更新」を同一タスクに束ねる（validate-design Issue 3）。
