# Gap Analysis: agency-dashboard

実施日: 2026-07-14（`/kiro-validate-gap`）。requirements.md（Requirement 1–7）と既存コードベースの差分分析。

## 1. 現状調査（既存資産マップ）

### 1.1 認証・RBAC（ほぼ完成済み・再利用可能）

- `ts/apps/dashboard-api/src/auth.ts` — `authenticate()`: Bearer トークン → Identity Platform ID トークン検証（`TokenVerifier` として firebase-admin を注入・テストはモック）→ `findByAuthSubject` で `dashboard_users` 解決。結果は `unauthenticated`(401) / `unregistered`(403) / `authenticated` の3値。**Requirement 1.1–1.3 の中核がそのまま使える**。
- 同ファイル `canAccessStore(user, storeAgencyId)` — operator=常時許可、agency=自代理店のみ。**Requirement 2 の判定関数が既存**。
- `ts/apps/dashboard-api/src/index.ts` — firebase-admin の ADC 初期化・DI 配線パターンが確立済み。
- インフラ: `infra/modules/auth/` で `google_identity_platform_config` 済み。`infra/envs/prod/main.tf` に Cloud Run サービス `dashboard-api`（public・Cloud SQL 接続付き）が定義済み。

### 1.2 DB スキーマ（4階層＋招待コード。一部列が不足）

- `dashboard_users`: `role`(operator/agency) / `operator_id` / `agency_id` / `auth_subject NOT NULL UNIQUE`。`ck_dashboard_role_scope`（operator⇔agency_id NULL）と複合FK `fk_dashboard_agency_operator`（クロスオペレータ越権の構造遮断）が既存。**ただし無効化列（disabled_at 等）が無い**。
- `agency_invite_codes`: `code UNIQUE` / `agency_id` / `disabled_at`（0003）。**発行・無効化に必要な列は揃っている**。
- `stores`: `place_status`(pending/confirmed) + `ck_place_confirmed` + `place_id` 部分一意（重複 Place の構造拒否）。`competitors.active` で「競合設定済み」判定可能。
- `owners`: `agency_id NOT NULL` / `line_user_id NOT NULL UNIQUE` / `onboarding_status`。要件どおり「LINE 登録済みオーナー選択」方式と整合。

### 1.3 共有 DAL `@fwlm/db`（`ts/packages/db/src/`）

再利用可能: `findByAuthSubject` / `findStoreWithAgency` / `createConfirmedStore`（confirmed・`ck_place_confirmed` 充足）/ `findStoreByPlaceId`（重複 Place 判定）/ `findOwnerByLineUserId` / `markOwnerStoreIdentified` / `findActiveInviteCode` / `getPool` / `StoreCandidate` 型。

### 1.4 Place 検索（line-webhook 内・要共有化）

- `ts/apps/line-webhook/src/places/search.ts` — Places API (New) searchText の型付きアダプタ。**FieldMask を Pro SKU に固定（1フィールドでも足すと Enterprise SKU 昇格）**・1.5s タイムアウト・ja/JP・最大10件・`found/empty/error` の型付き結果。Requirement 3.4–3.6, 3.11 と完全一致。**ただし line-webhook アプリ内にあり、dashboard-api から import 不可**（共有パッケージへの抽出 or 複製が必要）。
- `ts/apps/line-webhook/src/onboarding/store-identification.ts` — `confirmStore(ownerId, candidate)`: TX 内で stores INSERT（confirmed）→ owner を `store_identified` へ遷移。重複 Place は拒否。**Requirement 3.7–3.10 のドメインロジックが既存**（ただし同じく line-webhook 内）。

### 1.5 Web フロントエンド・CI/デプロイの型

- Next.js アプリの雛形: `ts/apps/survey-web`・`ts/apps/store-detail`（Dockerfile / vitest / playwright / `NEXT_PUBLIC_*` build-arg 規律 + `scripts/check-next-public-buildargs.sh` 機械強制）。**運営・代理店向けダッシュボード Web は存在しない**。
- Hono アプリのファクトリ＋DI パターン（`createApp(deps)` を `app.request` でテスト）: dashboard-api で確立済み。
- CI: `ts-ci.yml`（テスト）→ `deploy.yml`（main マージ後 image-only 反映・Direct WIF）。`scripts/push-images.sh` の対象は現状 `daily-batch` / `summary-delivery` / `store-detail` のみ。

## 2. Requirement-to-Asset Map

| Requirement | 既存資産 | ギャップ（タグ） |
|---|---|---|
| 1. Google ログイン認証 | `authenticate()` / firebase-admin 配線 / Identity Platform config (tf) | **[Missing]** フロントエンドのログイン UI（Firebase JS SDK）。**[Unknown]** Google プロバイダ（`default_supported_idp_config`）が tf に無い — コンソール手動有効化済みか要確認。**[Constraint]** Firebase クライアント設定（apiKey 等）は `NEXT_PUBLIC_*` → build-arg 規律に従う |
| 2. RBAC | `canAccessStore()` / `ck_dashboard_role_scope` / 複合FK | **[Missing]** 一覧・登録・招待コード・管理系エンドポイントでのスコープ強制の適用（判定関数はあるが適用先 API が無い） |
| 3. 店舗登録（代行） | `PlacesSearchAdapter` / `confirmStore` TX / `findStoreByPlaceId` / `createConfirmedStore` | **[Missing]** dashboard-api の検索・登録エンドポイント、オーナー選択 UI/API（代理店別オーナー一覧 DAL が無い）。**[Constraint]** 検索・確定ロジックが line-webhook 内 → 共有パッケージ抽出 or 複製の設計判断。**[Unknown]** 基本情報入力の項目範囲 — stores に address/types 列は無く name/lat/lng/place_id/category_code のみ永続化。`category_code` は LINE フローでは未設定（NULL）で Go バッチはフォールバックで動作するが、ダッシュボードで入力させるか要設計判断 |
| 4. 一覧表示 | `place_status` / `competitors.active` | **[Missing]** RBAC スコープ付き店舗一覧 DAL（stores × owners × agencies JOIN + competitors EXISTS）。competitors は Go 所有だが **read は境界違反ではない**（write-boundary は書込のみ規律） |
| 5. 招待コード管理 | `agency_invite_codes`（disabled_at あり）/ `findActiveInviteCode` | **[Missing]** 発行・無効化・一覧の DAL とエンドポイント（現状は検証関数のみ）。コード生成方式（フォーマット・衝突回避）は設計事項 |
| 6. 代理店・利用者管理 | `agencies` / `dashboard_users` スキーマと構造制約 | **[Missing]** 作成・一覧・無効化の DAL とエンドポイント。**[Missing]** `dashboard_users` の無効化列（migration 0005 必要・TS 所有で書込境界は整合）。**[Unknown]** 未ログイン利用者の事前登録方式 — `auth_subject NOT NULL` のため登録時に Firebase UID が必要。候補: (a) Admin SDK で email から事前作成し UID 取得、(b) email 列追加＋初回ログイン時リンク（スキーマ変更）。**Research Needed（設計フェーズ最重要論点）**。**[Constraint]** 初代運営ユーザーは自己登録不可（鶏卵）→ seed/手動投入が前提 |
| 7. セキュリティ等 | 401/403 の型付き認証結果 / 「持たないデータは漏れない」設計 | **[Missing]** 新設エンドポイント全てへの認証必須の徹底（横断関心事）。日本語 UI は新規実装内で担保 |

### 横断ギャップ（デプロイ・インフラ）

- **[Missing]** `push-images.sh` / `deploy.yml` に dashboard-api・（新設する）dashboard-web が未登録。
- **[Missing]** dashboard-web 用 Cloud Run サービスの Terraform 定義（`run-services` モジュールへの追加）。
- **[Constraint]** dashboard-api は tf 定義済み・Dockerfile ありだが CI デプロイ対象外（イメージ反映経路の整備が必要）。

## 3. 実装アプローチ選択肢

### Option A: dashboard-api 拡張のみ（フロントエンドも dashboard-api が配信）
Hono でサーバーレンダリング or 静的配信。
- ✅ サービス数最小・tf 変更ほぼ不要
- ❌ Google ログイン UI・フォーム・一覧を Hono で作るのはプロジェクトの Next.js 資産（build-arg 規律・テスト雛形）と乖離。管理画面の成長余地に対して不利
- ❌ 客向け Web とオーナー/運営向けの物理分離という structure.md の方針に沿うが、UI 開発効率が低い

### Option B: dashboard-web（Next.js フルスタック）単体新設
Route Handlers で直接 DB を触り、dashboard-api は QR 専用のまま。
- ✅ 1 アプリ完結・survey-web の型を最大流用
- ❌ 認証・RBAC ロジックが dashboard-api と二重化（`authenticate`/`canAccessStore` の複製）
- ❌ gcp-infra-foundation が定義した「ダッシュボード API = dashboard-api」という役割分担と矛盾。QR 発行（既存）とその他 API が別サービスに分裂

### Option C: dashboard-web（Next.js UI）＋ dashboard-api 拡張（API 集約）【推奨】
新設 `ts/apps/dashboard-web` は UI と Firebase JS SDK ログインのみ担い、業務 API は全て dashboard-api に集約（ブラウザ → Bearer ID トークン → dashboard-api）。Place 検索・店舗確定は共有パッケージ（例: `@fwlm/places` への抽出、または `@fwlm/db` 隣接の共有化）で line-webhook と単一実装を維持。
- ✅ 既存の認証・RBAC・QR と同居し二重化ゼロ。gcp-infra-foundation の役割分担どおり
- ✅ Next.js 資産（Dockerfile・build-arg 規律・テスト構成）を流用
- ✅ FieldMask SKU 規律を単一実装で保全（複製による将来の昇格事故を防ぐ）
- ❌ 触るパッケージが多い（dashboard-web 新設・dashboard-api 拡張・packages 抽出・migration・tf・CI）→ タスク分割で吸収

## 4. 工数・リスク

- **工数: L（1–2週間）** — 新規 Next.js アプリ＋約 8–10 エンドポイント＋DAL 追加＋migration 0005＋検索ロジック共有化＋CI/tf 追加。個々は確立パターンの反復だが面数が多い。
- **リスク: Medium** — 唯一の High 候補は「未ログイン利用者の事前登録（auth_subject 問題）」。それ以外（RBAC・Place 検索・店舗確定・招待コード）は既存実装の水平展開で Low。

## 5. 設計フェーズへの推奨

- **推奨アプローチ: Option C**（dashboard-web 新設 + dashboard-api 集約 + 検索/確定ロジックの共有化）。
- **migration 0005（TS 所有）**: `dashboard_users.disabled_at`（Req 6.4）＋利用者事前登録方式の決定に伴う列（方式次第）。`db/write-boundary.md`・ERD の更新と `make db-verify-docs` 通過を忘れないこと。
- **Research Needed（設計フェーズで解決）**:
  1. **利用者事前登録方式**: Firebase Admin SDK の email 事前作成（`createUser` → UID 確定）vs email 列＋初回ログイン時リンク。Identity Platform の「メールアドレスごとに1アカウント」設定と Google プロバイダのアカウントリンク挙動を要調査。
  2. **Google プロバイダの有効化状態**: tf に `default_supported_idp_config` が無い。現環境の設定確認と tf 化の要否。
  3. **店舗登録の「基本情報」項目**: `category_code` を入力させるか（競合抽出精度に影響・categories seed は 0002 に既存）。stores に列が無い情報（住所等）は表示のみで永続化しない方針の確認。
  4. **招待コードの生成仕様**: フォーマット・エントロピー・衝突時リトライ。
  5. **Firebase クライアント設定の受け渡し**: `NEXT_PUBLIC_*` build-arg 一式（apiKey/authDomain 等）と `check-next-public-buildargs.sh` への追従。

---

# Design Discovery & Decisions（設計フェーズ・2026-07-14）

## Summary

- **Feature**: `agency-dashboard`
- **Discovery Scope**: Extension（light discovery + 外部調査1件）
- **Key Findings**:
  - `StoreIdentificationService`（line-webhook 内）は既に LINE 非依存で、コメントに「代理店ダッシュボードが本契約を再利用」と明記済み。共有パッケージへの移設のみで Req 3 の中核が完成する。
  - Firebase「1メール=1アカウント」の trusted provider 仕様上、**Google Workspace 独自ドメインのメールは untrusted 扱い**であり、Admin SDK 事前作成（案A）は同一 UID 統合が公式保証されない。
  - CI は `pnpm -C ts -r test` の再帰実行のため、新アプリのテストは配置するだけで自動包含される。`check-next-public-buildargs.sh` も `ts/apps/*/` を自動走査する。

## Research Log

### 利用者事前登録方式（Research Needed #1 の決着）

- **Context**: `dashboard_users.auth_subject NOT NULL` と「運営が未ログイン利用者を事前登録できる」（Req 6.2）の構造的衝突。
- **Sources Consulted**: firebase.google.com/docs/auth/users（trusted provider と同一メール衝突4パターン）／docs/auth/admin/manage-users／docs/auth/admin/verify-id-tokens／docs/auth/web/redirect-best-practices／docs.cloud.google.com/identity-platform/docs/concepts-manage-users
- **Findings**:
  - Google が trusted provider なのは **@gmail.com のみ**。Workspace 独自ドメインは untrusted で、事前作成アカウントへの Google ログイン統合は `account-exists-with-different-credential` になり得る（UID 保持の明文保証なし）。
  - `verifyIdToken` の戻りには検証済みの `email` / `email_verified` / `firebase.sign_in_provider` が含まれる。Google プロバイダ経由では gmail/Workspace とも通常 `email_verified: true`。
  - クライアントは `signInWithPopup` が現行推奨（`signInWithRedirect` はサードパーティストレージ分離で追加設定なしでは不動）。
- **Implications**: 案B（メール事前登録＋初回ログイン時に検証済みクレームで `auth_subject` を埋める）を採用。DB は `auth_subject` NULL 許容化＋`email` 列（小文字正規化・部分一意）＋`disabled_at` 追加（migration 0005）。

### 統合ポイント詳細（コードベース）

- **Findings**（設計に直結する契約のみ・詳細は探索サマリー参照）:
  - `@fwlm/db`: `Queryable`/`getPool`/`Result<T,E>`、`DashboardUserIdentity`、`createConfirmedStore`/`findStoreByPlaceId`/`markOwnerStoreIdentified` 等が再利用可能。`withTransaction` ヘルパは無く、TX は `ConnectablePool`＋手動 BEGIN/COMMIT が既存流儀。
  - `store-identification.ts`: `ConfirmOutcome = confirmed | place_already_registered`。unique violation（`ux_stores_place_id`）検出→同一 owner は冪等 confirmed。
  - dashboard-api: `createApp(deps)` DI・`jsonError` 封筒 `{error:{code,message}}`・`*.db.test.ts`（`describe.skipIf(!DATABASE_URL)`）の検証パターン確立済み。
  - Next.js アプリ規約: `output:'standalone'`・4ステージ Dockerfile（context=`ts/`）・`NEXT_PUBLIC_*` は build ステージ `ARG`+`ENV`。
  - categories seed（0002・11種）が SoT。コード内二重定義は禁止（steering）。

## Design Decisions

### Decision: 利用者登録は「メール事前登録＋初回ログイン時リンク」（案B）

- **Context**: Req 6.2/6.4 と `auth_subject NOT NULL` の衝突。
- **Alternatives Considered**:
  1. 案A — firebase-admin `createUser({email})` で UID を先取り
  2. 案B — email を DB に置き、初回 Google ログインの検証済みクレームでリンク
- **Selected Approach**: 案B。`authenticate` 内で `findByAuthSubject` 不在時、`sign_in_provider==='google.com' && email_verified===true` の場合のみ小文字正規化 email で保留行を原子的 UPDATE（`WHERE auth_subject IS NULL AND disabled_at IS NULL`）。
- **Rationale**: Workspace ドメインで案Aは公式保証外／案Bはコンソール設定非依存で失敗が「照合不一致→明示エラー」と安全側／認可の真実を Postgres に置く方針と整合。
- **Trade-offs**: 初回ログインまで Firebase 側にユーザーが存在しない（管理コンソールで見えない）が、認可は DB 一覧で可視のため実害なし。
- **Follow-up**: Workspace ドメインのメールでの初回ログインを含む動作検証を実装タスクに含める。

### Decision: 店舗特定ロジックを共有パッケージ `@fwlm/store-identification` へ移設

- **Context**: `PlacesSearchAdapter`（FieldMask=Pro SKU 固定）と `StoreIdentificationService` が line-webhook 内にあり dashboard-api から import 不可。
- **Alternatives**: (1) 複製（SKU 規律の二重管理で将来の課金事故リスク）、(2) line-webhook から cross-app import（アプリ境界違反）、(3) `ts/packages/store-identification` へ移設。
- **Selected Approach**: (3)。`places-search.ts`＋`store-identification.ts` を新パッケージへ移動し、line-webhook は import 先を差し替え（挙動変更なし）。
- **Rationale**: FieldMask の SKU 規律・重複 Place 冪等処理を単一実装で保全。steering「共有定数の単一情報源」と同型の原則。

### Decision: dashboard-web はブラウザから dashboard-api を直接呼ぶ（CORS 許可制）

- **Context**: Firebase ID トークンはクライアント側（Firebase JS SDK）にあり、業務 API は dashboard-api に集約する（gap 分析 Option C）。
- **Alternatives**: (1) Next.js route handlers でプロキシ（ホップ増・認証透過の二重化）、(2) ブラウザ→dashboard-api 直接（`hono/cors` で dashboard-web オリジンのみ許可）。
- **Selected Approach**: (2)。`getIdToken()` を `Authorization: Bearer` で送付。dashboard-api に CORS ミドルウェア（許可オリジンは env `DASHBOARD_WEB_ORIGIN`）。
- **Trade-offs**: API URL とオリジンを NEXT_PUBLIC/env で双方向に設定する必要（build-arg 規律に従う）。

### Decision: 招待コード生成は Node crypto＋紛らわしい文字を除いた英大数字

- **Selected Approach**: `crypto.randomInt` で `23456789ABCDEFGHJKMNPQRSTUVWXYZ`（0/O/1/I/L 除外・31字）から 8 文字生成。`code UNIQUE` 衝突時は再生成リトライ（最大3回）。外部ライブラリ不使用。

### Decision: カテゴリは DAL＋API 経由で配信（コード内ハードコード禁止）

- **Context**: 店舗登録の「基本情報入力」でカテゴリを選択させる（Research Needed #3 の決着＝入力させる。競合抽出精度に直結）。categories seed（0002）が SoT。
- **Selected Approach**: `@fwlm/db` に `listCategories`、dashboard-api に `GET /categories`。dashboard-web はこれを表示。

## Risks & Mitigations

- Workspace メールの初回ログイン検証不足 — 実装タスクに Workspace/gmail 双方の手動検証を明記（validation hook）。
- Google プロバイダが Identity Platform で未有効（tf に `default_supported_idp_config` 無し）— 実装前にコンソール確認、必要なら tf 追加（Research Needed #2 は実装タスクへ持ち越し）。
- 新 Cloud Run サービス（dashboard-web）の tf/CI 追加漏れ — File Structure Plan に修正ファイルを明記しタスク化。

## References

- https://firebase.google.com/docs/auth/users — trusted provider と同一メール衝突
- https://firebase.google.com/docs/auth/admin/verify-id-tokens — 検証済みクレーム
- https://firebase.google.com/docs/auth/web/redirect-best-practices — signInWithPopup 推奨
- `.kiro/specs/line-onboarding/design.md` — StoreIdentificationService 原設計
