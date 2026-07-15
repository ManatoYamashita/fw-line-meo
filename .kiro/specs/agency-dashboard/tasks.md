# Implementation Plan: agency-dashboard

> 実装前提の共有知見（line-onboarding の教訓より）:
> - **grants.sql は変更不要**: migration 0005 は新テーブルを追加せず `dashboard_users` の ALTER のみ。`sa-dashboard-api` は `infra/sql/grants.sql` で既に operators/agencies/dashboard_users/owners/stores/agency_invite_codes への DML を付与済み（列追加は表権限を継承）。`make db-verify-docs`（`check_docs.sh`）は新テーブルが無いため追加変更なしで緑を維持する。
> - **DB テストは native postgres で代替検証可**: サンドボックスに docker/apple-container が無いため `make db-migrate`/`db-test`/`db-verify-docs` は `ts/scripts/with-test-db.sh` 相当の native postgres で代替実行する。`make ts-test-db` はそのまま利用可。
> - **共有 DB の UUID フィクスチャ衝突回避**: `*.db.test.ts` は `pnpm -r test` で全パッケージ共有 postgres に対し並行実行される。新規テストの UUID prefix・センチネル値は既存（`e1`〜`f2` 使用済み）と衝突しない値を使い、行カウント検証はフィクスチャスコープで WHERE 絞り込みする。
> - **Dockerfile は実ビルド未検証**: docker 不在のため新規 Dockerfile は CI/Cloud Build 実ビルドで初検証する。ローカルは `check-next-public-buildargs.sh` と 4 ステージ規約準拠までを担保する。

## 1. Foundation: DB スキーマ・共有パッケージ・DAL

- [x] 1.1 migration 0005（dashboard_users 拡張）と DB アサーション
  - migration `0005_agency_dashboard.sql`: `dashboard_users` に `email text`・`disabled_at timestamptz` を追加、`auth_subject` の NOT NULL を解除、CHECK `ck_dashboard_users_identity`（`auth_subject IS NOT NULL OR email IS NOT NULL`）、`lower(email)` の部分 UNIQUE インデックス `ux_dashboard_users_email`（`WHERE email IS NOT NULL`）を追加。追加のみで既存行・既存制約を破壊しない
  - `db/ERD.md` の `dashboard_users` エンティティ一覧に `email`（自然キー・部分一意）/`disabled_at` を追記。`db/write-boundary.md` は新テーブルなしのため変更なし。`infra/sql/grants.sql` も新テーブルなし・既存 DML 付与済みのため変更なし（本タスクで変更不要を確認）
  - `db/test/assertions/50_agency_dashboard.sql`: 両方 NULL の行を CHECK が拒否・大文字小文字違いの email 重複を拒否・`auth_subject` NULL の保留行を作成可・`WHERE auth_subject IS NULL` 前提の二重リンク UPDATE が 0 行、を検証
  - 完了状態: `make db-migrate && make db-test && make db-verify-docs`（または native postgres 代替）が緑
  - _Requirements: 6.2, 6.4_

- [ ] 1.2 (P) 店舗特定ロジックを共有パッケージ `@fwlm/store-identification` へ移設
  - `ts/packages/store-identification` を新設し、`line-webhook` の `places/search.ts`（PlacesSearchAdapter・FieldMask 固定）と `onboarding/store-identification.ts`（searchCandidates/confirmStore・重複 place 冪等処理）を挙動変更なしで移設。公開契約（`SearchOutcome`/`ConfirmOutcome`/`createPlacesSearchAdapter`/`createStoreIdentificationService`）を維持（line-onboarding の再検証トリガのため署名変更禁止）
  - `line-webhook` の import を新パッケージへ差し替え、`package.json` に依存追加。FieldMask・1.5s タイムアウト・pageSize 10・ja/JP は不変
  - 完了状態: `line-webhook` の既存テスト（店舗特定・会話フロー）が回帰なしで緑、新パッケージが単体でビルド・テスト緑
  - _Requirements: 3.4, 3.5, 3.6, 3.8, 3.9, 3.10, 3.11_
  - _Boundary: store-identification pkg, line-webhook_

- [ ] 1.3 (P) 店舗一覧・オーナー・代理店・カテゴリ・招待コードのアクセサ追加
  - `@fwlm/db` に追加: `listStoresWithStatus`（stores×owners×agencies JOIN＋competitors(active) EXISTS で `competitorConfigured`・agency 絞り込み可）、`listOwnersByAgency`/`findOwnerWithAgency`、`createAgency`/`listAgencies`、`listCategories`（seed が SoT・コード内定義禁止）、`listInviteCodes`/`createInviteCode`/`disableInviteCode`（agency_id をスコープ列として WHERE に含める）
  - `competitors` は read のみ（書込アクセサを持たない＝競合設定は変更不可）。来店客系テーブルへの参照を一切持たない
  - 完了状態: 各アクセサの `*.db.test.ts` が緑。特に agency 絞り込みで他代理店の店舗・オーナー・コードが漏れないこと、`competitorConfigured` が competitors(active) の有無を反映することを確認
  - _Requirements: 2.1, 2.2, 4.1, 4.2, 4.3, 4.5, 5.1, 5.2, 5.3, 7.2_
  - _Boundary: @fwlm/db_
  - _Depends: 1.1_

- [ ] 1.4 ダッシュボード利用者アクセサ（解決・初回リンク・事前登録・無効化）
  - `@fwlm/db` の `dashboard-users.ts` を拡張: `findByAuthSubject` を無効化状態を含む解決（`DashboardUserResolution`）へ、`linkAuthSubjectByEmail`（`WHERE lower(email)=$1 AND auth_subject IS NULL AND disabled_at IS NULL` の原子的 UPDATE）、`createPendingDashboardUser`（email のみの保留行・role/agency 整合）、`listDashboardUsers`（operator スコープ）、`disableDashboardUser`（operator スコープ）
  - 完了状態: `*.db.test.ts` で「保留行の原子的リンク成功」「二重リンクが 0 行」「disabled 行はリンク不可」「email 大文字小文字を無視した一意性」が緑
  - _Requirements: 6.2, 6.4_
  - _Boundary: @fwlm/db_
  - _Depends: 1.1_

## 2. Core: dashboard-api 認証・スコープと業務ハンドラ

- [ ] 2.1 認証拡張（初回リンク・無効化）と RBAC スコープ中核
  - `dashboard-api` の `auth.ts` を拡張: `AuthOutcome` に `disabled`(403) を追加、`TokenVerifier` を `VerifiedToken`（uid/email/emailVerified/signInProvider）へ拡張、未登録かつ `signInProvider==='google.com' && emailVerified===true` のとき正規化 email（trim+lower）で `linkByEmail` を試行、無効化行は `disabled` を返す。資格情報は一切保持しない（Identity Platform 委譲）
  - `scope.ts` を新設: `resolveAgencyScope`（agency は常に自代理店・operator は指定時 single/未指定 all・agency の他代理店指定は 403）、`requireOperator`（管理 API 前置ガード）
  - 既存 `qr.ts`・`index.ts` の配線を新 `TokenVerifier`/`findUser` シグネチャへ更新（`disabled`→403 に写像し後方互換）
  - 完了状態: ユニットテストで「google.com＋email_verified のみリンク試行」「disabled→403」「agency の他代理店指定→403」「operator 未指定→all」が緑、既存 qr テストが回帰なしで緑
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 2.1, 2.2, 2.3, 5.4, 6.2, 6.4, 6.5, 7.1_
  - _Boundary: dashboard-api auth, scope_
  - _Depends: 1.4_

- [ ] 2.2 (P) 自己紹介・店舗一覧ハンドラ
  - `GET /me`（ロール・所属代理店・表示名）と `GET /stores`（スコープ解決→`listStoresWithStatus`→店舗特定/競合設定ステータス同梱。operator は代理店名同梱・agency は自代理店のみ）の純粋ハンドラを実装。エラー封筒は既存 `jsonError` 形式（日本語 message）
  - 完了状態: 注入 deps のユニットテストで operator=全件・agency=自代理店のみ・0 件時の応答が確認できる
  - _Requirements: 2.1, 2.2, 4.1, 4.2, 4.3, 4.4_
  - _Boundary: dashboard-api stores-list, me_
  - _Depends: 2.1, 1.3_

- [ ] 2.3 (P) 店舗登録ハンドラ（オーナー選択・検索・確定・カテゴリ）
  - `GET /owners`（スコープ内オーナー一覧・空配列で 3.3 の UI 案内を可能に）、`GET /categories`、`POST /stores/search`（`PlacesSearchAdapter` 委譲・最大 10 件・0 件は空配列 200・`error` は 502）、`POST /stores`（`ownerId` がスコープ内 agency 配下かの検証→`confirmStore` 委譲、`place_already_registered`→409、`categoryCode` は存在コードのみ）の純粋ハンドラを実装
  - 完了状態: 注入 deps のユニットテストでスコープ外 owner→403・候補 0 件→空配列 200・検索失敗→502・重複 place→409・確定成功→201 が確認できる
  - _Requirements: 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10_
  - _Boundary: dashboard-api store-registration, owners-list_
  - _Depends: 2.1, 1.2, 1.3_

- [ ] 2.4 (P) 招待コードハンドラとコード生成
  - `invite-code-gen.ts`（`crypto.randomInt`・`23456789ABCDEFGHJKMNPQRSTUVWXYZ` の 8 文字・UNIQUE 衝突時は最大 3 回再生成・外部ライブラリ不使用）と、`GET /invite-codes`（スコープ絞り込み）・`POST /invite-codes`（agency は自代理店・operator は agencyId 指定）・`POST /invite-codes/:id/disable`（agency スコープ検証・不一致は 404）の純粋ハンドラを実装
  - 完了状態: ユニットテストでコードの文字集合・長さ・衝突リトライ・3 回失敗で 500、発行/無効化のスコープ強制が確認できる
  - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - _Boundary: dashboard-api invite-codes, invite-code-gen_
  - _Depends: 2.1, 1.3_

- [ ] 2.5 (P) 管理ハンドラ（代理店・ダッシュボード利用者）
  - `admin.ts`: 冒頭に `requireOperator` 前置ガード（agency ロールは 403）。`GET/POST /agencies`、`GET /dashboard-users`、`POST /dashboard-users`（role・（agency 時のみ必須の）所属代理店・email・表示名の検証、email 重複は 409、`createPendingDashboardUser` 委譲）、`POST /dashboard-users/:id/disable` の純粋ハンドラを実装
  - 完了状態: ユニットテストで agency→全管理 API 403・代理店ロールの agencyId 欠落→400・email 重複→409・作成成功が確認できる
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - _Boundary: dashboard-api admin_
  - _Depends: 2.1, 1.3, 1.4_

## 3. Integration: dashboard-api の配線

- [ ] 3.1 config・CORS・ルート配線・実依存注入
  - `config.ts` に `DASHBOARD_WEB_ORIGIN`・`PLACES_API_KEY` を必須 env として追加。`app.ts` で全業務ルートを `authenticate` 前置で登録し、`hono/cors` を `DASHBOARD_WEB_ORIGIN` 単一オリジン許可（Authorization 許可・credentials 不使用）。`index.ts` で firebase verifier（email/emailVerified/signInProvider 抽出）・pool・`PlacesSearchAdapter`＋`StoreIdentificationService`・全 DAL を実配線
  - 完了状態: `app.request` 経由の `*.db.test.ts` で未認証→401・許可外オリジン遮断・`/healthz` は認証不要・agency→管理 API 403・operator 全許可の認可マトリクスが緑
  - _Requirements: 2.3, 6.5, 7.1, 7.3_
  - _Depends: 2.2, 2.3, 2.4, 2.5, 1.2_

## 4. Core: dashboard-web（Next.js UI）

- [ ] 4.1 dashboard-web 雛形（standalone・Dockerfile・healthz）
  - `ts/apps/dashboard-web` を新設: `package.json`（`@fwlm/dashboard-web`・next/react/firebase・**`@fwlm/db` に依存しない**＝ブラウザから dashboard-api を HTTP 呼び出しするため DB 直結しない）、`next.config.ts`（`output:'standalone'`・turbopack/outputFileTracing root=`ts/`）、`tsconfig.json`/`vitest.config.ts`/`.env.example`、4 ステージ `Dockerfile`（`next build` 前に `NEXT_PUBLIC_*`（Firebase 設定・API ベース URL）を `ARG`+`ENV` で焼き込み）、`healthz` ルート（force-static）
  - 完了状態: `pnpm -C ts --filter @fwlm/dashboard-web build` が成功、`check-next-public-buildargs.sh` が緑（参照する全 `NEXT_PUBLIC_*` に対応する ARG が Dockerfile に存在）
  - _Requirements: 7.3_
  - _Boundary: dashboard-web_

- [ ] 4.2 Firebase ログイン・認証コンテキスト・API クライアント
  - `lib/firebase.ts`（`NEXT_PUBLIC_*` から初期化）、`lib/auth-context.tsx`（`signInWithPopup(GoogleAuthProvider)`・ログイン後 `GET /me`・`unregistered`/`disabled` は即 `signOut` して案内表示・管理情報を一切描画しない・token は SDK 管理）、`lib/api.ts`（`getIdToken()` を Bearer 付与・エラー封筒 `{error:{code,message}}` を判別共用体で解釈）、`login/page.tsx`、共有ナビゲーション/認可ガード部品
  - 完了状態: ユニットテストで「unregistered 時に signOut し管理データを描画しない」「api クライアントがエラー封筒を型付きで判別」が緑
  - Identity Platform の Google プロバイダ有効化（design の Open Question・tf 未定義）が前提。エンドツーエンドのログイン確認前に有効化状態を確認する（tf 化の要否は 6.3 の手動検証フックで判断）
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 7.4_
  - _Boundary: dashboard-web auth_
  - _Depends: 4.1, 3.1_

- [ ] 4.3 (P) 店舗一覧・登録ウィザード画面
  - `stores/page.tsx`（店舗特定・競合設定のステータスバッジ・0 件時の登録導線・operator には代理店名列・競合設定の変更手段を持たない）、`stores/new/page.tsx`（オーナー選択［operator は代理店選択が先行・選択肢 0 件時は招待コード先行の案内］→店名検索→候補選択・確認→カテゴリ等基本情報→確定、409 は登録済み案内、検索 0 件/失敗の案内）。全文言日本語
  - 完了状態: モック api で一覧のステータス表示・ウィザードの確定完了・0 件オーナー時の案内・409 時の案内が描画テストで確認できる
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 4.1, 4.2, 4.3, 4.4, 4.5, 7.3_
  - _Boundary: dashboard-web stores UI_
  - _Depends: 4.2_

- [ ] 4.4 (P) 招待コード画面
  - `invite-codes/page.tsx`（有効/無効バッジ付き一覧・発行・無効化、operator は代理店セレクタ付き）。全文言日本語
  - 完了状態: モック api で一覧表示・発行後のコード提示・無効化後の状態反映が描画テストで確認できる
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 7.3_
  - _Boundary: dashboard-web invite UI_
  - _Depends: 4.2_

- [ ] 4.5 (P) 管理画面（代理店・利用者）
  - `admin/agencies/page.tsx`（代理店作成・一覧）、`admin/users/page.tsx`（利用者登録＝role・（agency 時のみ）所属代理店・email・表示名、一覧、無効化）。agency ロールにはナビ非表示＋直接アクセス時 403 案内。全文言日本語
  - 完了状態: モック api で代理店作成・利用者登録フォーム・無効化が描画テストで確認でき、agency ロールで管理画面が拒否表示になる
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.3_
  - _Boundary: dashboard-web admin UI_
  - _Depends: 4.2_

## 5. Integration: CI・デプロイ・インフラ配線

- [ ] 5.1 (P) push-images.sh・deploy.yml に dashboard-api/dashboard-web を追加
  - `scripts/push-images.sh` の `IMAGE_NAMES`＋`DOCKERFILE`/`CONTEXT`/`BUILD_ARGS` 連想配列に `dashboard-api`（context `ts`・build-arg なし）と `dashboard-web`（context `ts`・`NEXT_PUBLIC_*` 一式を `--build-arg`）を登録し、`--image` の case 検証・usage も更新。`deploy.yml` に両サービスの image-only 反映（`gcloud run services update`）を追加し、dashboard-web の build-arg 用 `NEXT_PUBLIC_*` vars を push ステップへ受け渡し
  - 完了状態: `scripts/push-images.sh` の usage/検証に両イメージが現れ、`check-next-public-buildargs.sh` が緑（dashboard-web の ARG 整合）。実ビルドは CI/Cloud Build で初検証（docker 不在のためローカルは規約準拠まで）
  - _Requirements: 7.1_
  - _Boundary: CI scripts, deploy workflow_
  - _Depends: 4.1_

- [ ] 5.2 (P) Terraform: dashboard-web サービス追加・dashboard-api env 追加
  - `infra/envs/prod/main.tf`（＋`variables.tf`）に `dashboard-web` Cloud Run サービスを追加（public・ゼロスケール・DB 直結なし＝needs_cloudsql 不要・NEXT_PUBLIC は build-time のため runtime secret 不要）。既存 `dashboard-api` サービスに `DASHBOARD_WEB_ORIGIN` env と `PLACES_API_KEY`（secret_env）を追加。grants.sql は変更不要（新テーブルなし・DML 付与済み）
  - 完了状態: `terraform -chdir=infra/envs/prod validate` が成功
  - _Requirements: 7.1_
  - _Boundary: infra_

## 6. Validation: 統合検証と受け入れ

- [ ] 6.1 (P) 店舗登録・重複拒否・オーナー遷移の統合検証
  - `dashboard-api` の `*.db.test.ts`: `POST /stores` 経由の `confirmStore` 実トランザクションで stores 行作成＋owner の `store_identified` 遷移が同時成立、他店舗として登録済み place→409、スコープ外 owner への登録→403 を実 DB で検証
  - 完了状態: 上記シナリオがすべて `*.db.test.ts` で緑
  - _Requirements: 2.4, 3.8, 3.9, 3.10_
  - _Boundary: dashboard-api store-registration db-test_
  - _Depends: 3.1_
  - 6.2 と別ファイル・別 UUID prefix でスコープし共有 DB 上で並行安全にする

- [ ] 6.2 (P) 招待コード整合と初回ログインリンクの統合検証
  - `*.db.test.ts`: ダッシュボード発行の招待コードが `findActiveInviteCode`（line-onboarding 経路）で解決可能・無効化後は解決不可。保留利用者（email のみ）が初回 Google ログイン（email_verified）でリンクされ再ログインで uid が安定、disabled 利用者はログイン拒否、非 google/未検証は非リンク
  - 完了状態: 上記シナリオがすべて `*.db.test.ts` で緑
  - _Requirements: 1.2, 5.2, 5.3, 6.2, 6.4_
  - _Boundary: dashboard-api auth-link invite db-test_
  - _Depends: 3.1_
  - 6.1 と別ファイル・別 UUID prefix でスコープし共有 DB 上で並行安全にする

- [ ] 6.3 全体受け入れ検証
  - `make ts-test`／`make ts-test-db`／`make ts-lint`／`make ts-build`／`make db-verify-docs`／`terraform -chdir=infra/envs/prod validate` を実行し全緑を確認。来店客系テーブルへの参照が本 feature のコードに一切無いことを確認（7.2）。手動検証フックを明記: gmail と Google Workspace 独自ドメインの両メールでの初回ログイン→リンク→再ログイン（UID 安定）、Identity Platform の Google プロバイダ有効化状態の確認
  - 完了状態: 上記コマンドがすべて終了コード 0、手動検証フックが Issue/PR に記録される
  - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - _Depends: 3.1, 4.3, 4.4, 4.5, 5.1, 5.2, 6.1, 6.2_

## Implementation Notes
<!-- 実装中に得られた横断的な知見をここに追記する -->
- 環境: docker/apple-container 不在。DB スキーマ検証（`make db-migrate`/`db-test`/`db-verify-docs` 相当）は native postgres で代替する。正典レシピ: `ts/scripts/with-test-db.sh bash -c 'for f in db/test/assertions/*.sql; do psql -v ON_ERROR_STOP=1 -f "$f"; done; MANAGE_CONTAINER=0 PSQL_EXEC="psql" db/test/check_docs.sh'`（with-test-db.sh が native postgres 起動＋全 migrations 適用＋PG 環境変数 export を行う）。TS の `*.db.test.ts` は `make ts-test-db` でそのまま可。
- 1.1: **`db/test/assertions/30_compliance.sql` の PII denylist（5.3c）は全列を走査するため、`dashboard_users.email`（運営/代理店スタッフのログイン識別子）追加で誤検知 FAIL する**。denylist を `table_name NOT IN ('operators','agencies','dashboard_users')` でスタッフ識別テーブル除外に scope 修正（来店客テーブルへのガードは完全維持・reviewer が stores.email/survey_rating_tallies.phone 注入で発火継続を実証）。今後スタッフ系テーブルに login 識別列を足す際は同 denylist を確認すること。`30_compliance.sql` の table allowlist（5.3a）は新テーブル追加時に更新必須だが、0005 は列追加のみ（新テーブルなし）のため allowlist 変更不要。
- 1.1: assertion で「特定の CHECK 制約が発火したこと」を証明するには `GET STACKED DIAGNOSTICS v = CONSTRAINT_NAME`（`PG_EXCEPTION_CONSTRAINT` ではない）を使う。二重リンク検証は `GET DIAGNOSTICS n = ROW_COUNT` で UPDATE 影響行数（1回目=1・2回目=0）を確認する。
