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

- [x] 1.2 (P) 店舗特定ロジックを共有パッケージ `@fwlm/store-identification` へ移設
  - `ts/packages/store-identification` を新設し、`line-webhook` の `places/search.ts`（PlacesSearchAdapter・FieldMask 固定）と `onboarding/store-identification.ts`（searchCandidates/confirmStore・重複 place 冪等処理）を挙動変更なしで移設。公開契約（`SearchOutcome`/`ConfirmOutcome`/`createPlacesSearchAdapter`/`createStoreIdentificationService`）を維持（line-onboarding の再検証トリガのため署名変更禁止）
  - `line-webhook` の import を新パッケージへ差し替え、`package.json` に依存追加。FieldMask・1.5s タイムアウト・pageSize 10・ja/JP は不変
  - 完了状態: `line-webhook` の既存テスト（店舗特定・会話フロー）が回帰なしで緑、新パッケージが単体でビルド・テスト緑
  - _Requirements: 3.4, 3.5, 3.6, 3.8, 3.9, 3.10, 3.11_
  - _Boundary: store-identification pkg, line-webhook_

- [x] 1.3 (P) 店舗一覧・オーナー・代理店・カテゴリ・招待コードのアクセサ追加
  - `@fwlm/db` に追加: `listStoresWithStatus`（stores×owners×agencies JOIN＋competitors(active) EXISTS で `competitorConfigured`・agency 絞り込み可）、`listOwnersByAgency`（`owner-line-unlink` 4.4 で `listOwners` へ置き換え）/`findOwnerWithAgency`、`createAgency`/`listAgencies`、`listCategories`（seed が SoT・コード内定義禁止）、`listInviteCodes`/`createInviteCode`/`disableInviteCode`（agency_id をスコープ列として WHERE に含める）
  - `competitors` は read のみ（書込アクセサを持たない＝競合設定は変更不可）。来店客系テーブルへの参照を一切持たない
  - 完了状態: 各アクセサの `*.db.test.ts` が緑。特に agency 絞り込みで他代理店の店舗・オーナー・コードが漏れないこと、`competitorConfigured` が competitors(active) の有無を反映することを確認
  - _Requirements: 2.1, 2.2, 4.1, 4.2, 4.3, 4.5, 5.1, 5.2, 5.3, 7.2_
  - _Boundary: @fwlm/db_
  - _Depends: 1.1_

- [x] 1.4 ダッシュボード利用者アクセサ（解決・初回リンク・事前登録・無効化）
  - `@fwlm/db` の `dashboard-users.ts` を拡張: `findByAuthSubject` を無効化状態を含む解決（`DashboardUserResolution`）へ、`linkAuthSubjectByEmail`（`WHERE lower(email)=$1 AND auth_subject IS NULL AND disabled_at IS NULL` の原子的 UPDATE）、`createPendingDashboardUser`（email のみの保留行・role/agency 整合）、`listDashboardUsers`（operator スコープ）、`disableDashboardUser`（operator スコープ）
  - 完了状態: `*.db.test.ts` で「保留行の原子的リンク成功」「二重リンクが 0 行」「disabled 行はリンク不可」「email 大文字小文字を無視した一意性」が緑
  - _Requirements: 6.2, 6.4_
  - _Boundary: @fwlm/db_
  - _Depends: 1.1_

## 2. Core: dashboard-api 認証・スコープと業務ハンドラ

- [x] 2.1 認証拡張（初回リンク・無効化）と RBAC スコープ中核
  - `dashboard-api` の `auth.ts` を拡張: `AuthOutcome` に `disabled`(403) を追加、`TokenVerifier` を `VerifiedToken`（uid/email/emailVerified/signInProvider）へ拡張、未登録かつ `signInProvider==='google.com' && emailVerified===true` のとき正規化 email（trim+lower）で `linkByEmail` を試行、無効化行は `disabled` を返す。資格情報は一切保持しない（Identity Platform 委譲）
  - `scope.ts` を新設: `resolveAgencyScope`（agency は常に自代理店・operator は指定時 single/未指定 all・agency の他代理店指定は 403）、`requireOperator`（管理 API 前置ガード）
  - 既存 `qr.ts`・`index.ts` の配線を新 `TokenVerifier`/`findUser` シグネチャへ更新（`disabled`→403 に写像し後方互換）
  - 完了状態: ユニットテストで「google.com＋email_verified のみリンク試行」「disabled→403」「agency の他代理店指定→403」「operator 未指定→all」が緑、既存 qr テストが回帰なしで緑
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 2.1, 2.2, 2.3, 5.4, 6.2, 6.4, 6.5, 7.1_
  - _Boundary: dashboard-api auth, scope_
  - _Depends: 1.4_

- [x] 2.2 (P) 自己紹介・店舗一覧ハンドラ
  - `GET /me`（ロール・所属代理店・表示名）と `GET /stores`（スコープ解決→`listStoresWithStatus`→店舗特定/競合設定ステータス同梱。operator は代理店名同梱・agency は自代理店のみ）の純粋ハンドラを実装。エラー封筒は既存 `jsonError` 形式（日本語 message）
  - 完了状態: 注入 deps のユニットテストで operator=全件・agency=自代理店のみ・0 件時の応答が確認できる
  - _Requirements: 2.1, 2.2, 4.1, 4.2, 4.3, 4.4_
  - _Boundary: dashboard-api stores-list, me_
  - _Depends: 2.1, 1.3_

- [x] 2.3 (P) 店舗登録ハンドラ（オーナー選択・検索・確定・カテゴリ）
  - `GET /owners`（スコープ内オーナー一覧・空配列で 3.3 の UI 案内を可能に）、`GET /categories`、`POST /stores/search`（`PlacesSearchAdapter` 委譲・最大 10 件・0 件は空配列 200・`error` は 502）、`POST /stores`（`ownerId` がスコープ内 agency 配下かの検証→`confirmStore` 委譲、`place_already_registered`→409、`categoryCode` は存在コードのみ）の純粋ハンドラを実装
  - 完了状態: 注入 deps のユニットテストでスコープ外 owner→403・候補 0 件→空配列 200・検索失敗→502・重複 place→409・確定成功→201 が確認できる
  - _Requirements: 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10_
  - _Boundary: dashboard-api store-registration, owners-list_
  - _Depends: 2.1, 1.2, 1.3_

- [x] 2.4 (P) 招待コードハンドラとコード生成
  - `invite-code-gen.ts`（`crypto.randomInt`・`23456789ABCDEFGHJKMNPQRSTUVWXYZ` の 8 文字・UNIQUE 衝突時は最大 3 回再生成・外部ライブラリ不使用）と、`GET /invite-codes`（スコープ絞り込み）・`POST /invite-codes`（agency は自代理店・operator は agencyId 指定）・`POST /invite-codes/:id/disable`（agency スコープ検証・不一致は 404）の純粋ハンドラを実装
  - 完了状態: ユニットテストでコードの文字集合・長さ・衝突リトライ・3 回失敗で 500、発行/無効化のスコープ強制が確認できる
  - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - _Boundary: dashboard-api invite-codes, invite-code-gen_
  - _Depends: 2.1, 1.3_

- [x] 2.5 (P) 管理ハンドラ（代理店・ダッシュボード利用者）
  - `admin.ts`: 冒頭に `requireOperator` 前置ガード（agency ロールは 403）。`GET/POST /agencies`、`GET /dashboard-users`、`POST /dashboard-users`（role・（agency 時のみ必須の）所属代理店・email・表示名の検証、email 重複は 409、`createPendingDashboardUser` 委譲）、`POST /dashboard-users/:id/disable` の純粋ハンドラを実装
  - 完了状態: ユニットテストで agency→全管理 API 403・代理店ロールの agencyId 欠落→400・email 重複→409・作成成功が確認できる
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - _Boundary: dashboard-api admin_
  - _Depends: 2.1, 1.3, 1.4_

## 3. Integration: dashboard-api の配線

- [x] 3.1 config・CORS・ルート配線・実依存注入
  - `config.ts` に `DASHBOARD_WEB_ORIGIN`・`PLACES_API_KEY` を必須 env として追加。`app.ts` で全業務ルートを `authenticate` 前置で登録し、`hono/cors` を `DASHBOARD_WEB_ORIGIN` 単一オリジン許可（Authorization 許可・credentials 不使用）。`index.ts` で firebase verifier（email/emailVerified/signInProvider 抽出）・pool・`PlacesSearchAdapter`＋`StoreIdentificationService`・全 DAL を実配線
  - 完了状態: `app.request` 経由の `*.db.test.ts` で未認証→401・許可外オリジン遮断・`/health` は認証不要・agency→管理 API 403・operator 全許可の認可マトリクスが緑
  - _Requirements: 2.3, 6.5, 7.1, 7.3_
  - _Depends: 2.2, 2.3, 2.4, 2.5, 1.2_

## 4. Core: dashboard-web（Next.js UI）

- [x] 4.1 dashboard-web 雛形（standalone・Dockerfile・health）
  - `ts/apps/dashboard-web` を新設: `package.json`（`@fwlm/dashboard-web`・next/react/firebase・**`@fwlm/db` に依存しない**＝ブラウザから dashboard-api を HTTP 呼び出しするため DB 直結しない）、`next.config.ts`（`output:'standalone'`・turbopack/outputFileTracing root=`ts/`）、`tsconfig.json`/`vitest.config.ts`/`.env.example`、4 ステージ `Dockerfile`（`next build` 前に `NEXT_PUBLIC_*`（Firebase 設定・API ベース URL）を `ARG`+`ENV` で焼き込み）、`health` ルート（force-static）
  - 完了状態: `pnpm -C ts --filter @fwlm/dashboard-web build` が成功、`check-next-public-buildargs.sh` が緑（参照する全 `NEXT_PUBLIC_*` に対応する ARG が Dockerfile に存在）
  - _Requirements: 7.3_
  - _Boundary: dashboard-web_

- [x] 4.2 Firebase ログイン・認証コンテキスト・API クライアント
  - `lib/firebase.ts`（`NEXT_PUBLIC_*` から初期化）、`lib/auth-context.tsx`（`signInWithPopup(GoogleAuthProvider)`・ログイン後 `GET /me`・`unregistered`/`disabled` は即 `signOut` して案内表示・管理情報を一切描画しない・token は SDK 管理）、`lib/api.ts`（`getIdToken()` を Bearer 付与・エラー封筒 `{error:{code,message}}` を判別共用体で解釈）、`login/page.tsx`、共有ナビゲーション/認可ガード部品
  - 完了状態: ユニットテストで「unregistered 時に signOut し管理データを描画しない」「api クライアントがエラー封筒を型付きで判別」が緑
  - Identity Platform の Google プロバイダ有効化（design の Open Question・tf 未定義）が前提。エンドツーエンドのログイン確認前に有効化状態を確認する（tf 化の要否は 6.3 の手動検証フックで判断）
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 7.4_
  - _Boundary: dashboard-web auth_
  - _Depends: 4.1, 3.1_

- [x] 4.3 (P) 店舗一覧・登録ウィザード画面
  - `stores/page.tsx`（店舗特定・競合設定のステータスバッジ・0 件時の登録導線・operator には代理店名列・競合設定の変更手段を持たない）、`stores/new/page.tsx`（オーナー選択［operator は代理店選択が先行・選択肢 0 件時は招待コード先行の案内］→店名検索→候補選択・確認→カテゴリ等基本情報→確定、409 は登録済み案内、検索 0 件/失敗の案内）。全文言日本語
  - 完了状態: モック api で一覧のステータス表示・ウィザードの確定完了・0 件オーナー時の案内・409 時の案内が描画テストで確認できる
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 4.1, 4.2, 4.3, 4.4, 4.5, 7.3_
  - _Boundary: dashboard-web stores UI_
  - _Depends: 4.2_

- [x] 4.4 (P) 招待コード画面
  - `invite-codes/page.tsx`（有効/無効バッジ付き一覧・発行・無効化、operator は代理店セレクタ付き）。全文言日本語
  - 完了状態: モック api で一覧表示・発行後のコード提示・無効化後の状態反映が描画テストで確認できる
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 7.3_
  - _Boundary: dashboard-web invite UI_
  - _Depends: 4.2_

- [x] 4.5 (P) 管理画面（代理店・利用者）
  - `admin/agencies/page.tsx`（代理店作成・一覧）、`admin/users/page.tsx`（利用者登録＝role・（agency 時のみ）所属代理店・email・表示名、一覧、無効化）。agency ロールにはナビ非表示＋直接アクセス時 403 案内。全文言日本語
  - 完了状態: モック api で代理店作成・利用者登録フォーム・無効化が描画テストで確認でき、agency ロールで管理画面が拒否表示になる
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.3_
  - _Boundary: dashboard-web admin UI_
  - _Depends: 4.2_

## 5. Integration: CI・デプロイ・インフラ配線

- [x] 5.1 (P) push-images.sh・deploy.yml に dashboard-api/dashboard-web を追加
  - `scripts/push-images.sh` の `IMAGE_NAMES`＋`DOCKERFILE`/`CONTEXT`/`BUILD_ARGS` 連想配列に `dashboard-api`（context `ts`・build-arg なし）と `dashboard-web`（context `ts`・`NEXT_PUBLIC_*` 一式を `--build-arg`）を登録し、`--image` の case 検証・usage も更新。`deploy.yml` に両サービスの image-only 反映（`gcloud run services update`）を追加し、dashboard-web の build-arg 用 `NEXT_PUBLIC_*` vars を push ステップへ受け渡し
  - 完了状態: `scripts/push-images.sh` の usage/検証に両イメージが現れ、`check-next-public-buildargs.sh` が緑（dashboard-web の ARG 整合）。実ビルドは CI/Cloud Build で初検証（docker 不在のためローカルは規約準拠まで）
  - _Requirements: 7.1_
  - _Boundary: CI scripts, deploy workflow_
  - _Depends: 4.1_

- [x] 5.2 (P) Terraform: dashboard-web サービス追加・dashboard-api env 追加
  - `infra/envs/prod/main.tf`（＋`variables.tf`）に `dashboard-web` Cloud Run サービスを追加（public・ゼロスケール・DB 直結なし＝needs_cloudsql 不要・NEXT_PUBLIC は build-time のため runtime secret 不要）。既存 `dashboard-api` サービスに `DASHBOARD_WEB_ORIGIN` env と `PLACES_API_KEY`（secret_env）を追加。grants.sql は変更不要（新テーブルなし・DML 付与済み）
  - 完了状態: `terraform -chdir=infra/envs/prod validate` が成功
  - _Requirements: 7.1_
  - _Boundary: infra_

## 6. Validation: 統合検証と受け入れ

- [x] 6.1 (P) 店舗登録・重複拒否・オーナー遷移の統合検証
  - `dashboard-api` の `*.db.test.ts`: `POST /stores` 経由の `confirmStore` 実トランザクションで stores 行作成＋owner の `store_identified` 遷移が同時成立、他店舗として登録済み place→409、スコープ外 owner への登録→403 を実 DB で検証
  - 完了状態: 上記シナリオがすべて `*.db.test.ts` で緑
  - _Requirements: 2.4, 3.8, 3.9, 3.10_
  - _Boundary: dashboard-api store-registration db-test_
  - _Depends: 3.1_
  - 6.2 と別ファイル・別 UUID prefix でスコープし共有 DB 上で並行安全にする

- [x] 6.2 (P) 招待コード整合と初回ログインリンクの統合検証
  - `*.db.test.ts`: ダッシュボード発行の招待コードが `findActiveInviteCode`（line-onboarding 経路）で解決可能・無効化後は解決不可。保留利用者（email のみ）が初回 Google ログイン（email_verified）でリンクされ再ログインで uid が安定、disabled 利用者はログイン拒否、非 google/未検証は非リンク
  - 完了状態: 上記シナリオがすべて `*.db.test.ts` で緑
  - _Requirements: 1.2, 5.2, 5.3, 6.2, 6.4_
  - _Boundary: dashboard-api auth-link invite db-test_
  - _Depends: 3.1_
  - 6.1 と別ファイル・別 UUID prefix でスコープし共有 DB 上で並行安全にする

- [x] 6.3 全体受け入れ検証
  - `make ts-test`／`make ts-test-db`／`make ts-lint`／`make ts-build`／`make db-verify-docs`／`terraform -chdir=infra/envs/prod validate` を実行し全緑を確認。来店客系テーブルへの参照が本 feature のコードに一切無いことを確認（7.2）。手動検証フックを明記: gmail と Google Workspace 独自ドメインの両メールでの初回ログイン→リンク→再ログイン（UID 安定）、Identity Platform の Google プロバイダ有効化状態の確認
  - 完了状態: 上記コマンドがすべて終了コード 0、手動検証フックが Issue/PR に記録される
  - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - _Depends: 3.1, 4.3, 4.4, 4.5, 5.1, 5.2, 6.1, 6.2_

## 7. 招待コードの記録（Requirement 8・Issue #486）

> 前提: 本番の migration 適用は自動ではない。`0017` を書くイメージより先に本番へ適用しないと、オーナー登録がすべて失敗する（design.md「Migration Strategy」）。7.5 の順序を崩さないこと。
> PR #472（招待コード入力の正規化・line-webhook）と照合経路が隣接する。7.3 の着手前に #472 の状態を確かめ、マージ済みなら取り込んでから始める。

- [x] 7.1 migration 0017（owners.invite_code_id）と DB アサーション・文書
  - `0017_owner_invite_code.sql`: `agency_invite_codes` に `ux_agency_invite_codes_agency_id UNIQUE (agency_id, id)`、`owners` に `invite_code_id uuid`（NULL 許容）と複合 FK `fk_owners_invite_code_same_agency (agency_id, invite_code_id) → agency_invite_codes (agency_id, id) ON DELETE RESTRICT`。既存行を書き換える UPDATE を持たない
  - `db/test/assertions/51_owner_invite_code.sql`: NULL の行を作れる／同じ代理店のコードで作れる／別の代理店のコードは FK 違反で拒否（`GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME` で制約名まで確かめる）／参照中のコードは削除できない／コードの無効化後も `invite_code_id` は変わらない
  - `db/ERD.md`（関係図に `agency_invite_codes |o--o{ owners`・`owners` の FK 欄と注記）と `db/write-boundary.md`（`owners` 行に `invite_code_id`・TS 書込）を更新。`grants.sql` と `30_compliance.sql` の表 allowlist は新テーブルが無いので変更不要（変更不要であることを本タスクで確認する）
  - 完了状態: native postgres（Implementation Notes の正典レシピ）で全 migration の適用・全 assertions・`check_docs.sh` が緑。別代理店のコードを拒否する assertion について、複合 FK を単独の FK（`invite_code_id → agency_invite_codes(id)`）に置き換える変異で赤になることを実測する
  - _Requirements: 8.2, 8.3, 8.4_
  - _Boundary: db migrations, db docs_

- [x] 7.2 `@fwlm/db` の契約変更（照合の id・作成の必須 id・一覧の記録）
  - `findActiveInviteCode` が `{ id, agencyId }` を返す（照合の条件は不変）。`CreateOwnerInput` に `inviteCodeId: string` を**必須**で足し、`createOwner` の INSERT へ `invite_code_id` を加える。`OwnerRow`・`OWNER_COLUMNS` を 0017 に同期する（教訓: migration 追加は Row 型の同期まで含める）
  - `listOwnersByAgency`（`owner-line-unlink` 4.4 で `listOwners` へ置き換え）が `agency_invite_codes` を LEFT JOIN し、`OwnerListItem.inviteCode`（`{ id, code, disabled } | null`）を返す
  - 既存の `createOwner` 呼び出し（`@fwlm/db`・store-identification・dashboard-api・line-webhook の各 `*.db.test.ts`）を、フィクスチャのコード行を用意したうえで `inviteCodeId` 付きへ直す
  - 完了状態: `*.db.test.ts` で「照合が id を返す・無効化済みは null」「作成した行の `invite_code_id` が渡した id と一致」「一覧で記録ありは `{ id, code, disabled }`・記録なしは `null`・無効化後のコードは `disabled: true`」が緑。新規の UUID prefix は既存と衝突しない値を使う
  - _Requirements: 8.1, 8.3, 8.5_
  - _Boundary: @fwlm/db_
  - _Depends: 7.1_

- [x] 7.3 (P) line-webhook: 照合したコードの id をオーナー作成へ渡す
  - `conversation.ts` の `InviteCodesAccessor` / `OwnersAccessor` の型を 7.2 の契約へ合わせ、`handleValidInviteCode` の `createOwner` へ `inviteCodeId: activeCode.id` を渡す。トランザクション境界・段階遷移・応答・監査ログ `owner_created` は変えない
  - 完了状態: 単体テストで `createOwner` が `inviteCodeId: activeCode.id` で呼ばれること、`invite-code-integration.db.test.ts` で実際に登録したオーナーの `invite_code_id` が送信したコードの行の id と一致すること、セッション更新を失敗させたときにオーナー行が残らないことが緑。`CreateOwnerInput.inviteCodeId` を省略可能にする変異で line-webhook の型検査が赤になることを実測する
  - _Requirements: 8.1, 8.2_
  - _Boundary: line-webhook onboarding_
  - _Depends: 7.2_

- [x] 7.4 (P) dashboard-api / dashboard-web: GET /owners の応答に記録を載せる
  - GET /owners の応答 `OwnerListItem` に `inviteCode` を通す（エンドポイント・認可・スコープは不変）。design.md の contract 表と `@fwlm/db` 追加アクセサの型を同じタスクで更新する
  - dashboard-web の `lib/types.ts` のオーナー型と、E2E の API スタブ（`e2e/fixtures/api.ts`）のオーナー応答に `inviteCode` を足す（記録あり・記録なしの両方の行を置く）。画面への表示は代理店詳細画面の要件で扱い、本タスクでは描画を変えない
  - 完了状態: `app.request` 経由の試験で、GET /owners が記録ありのオーナーに `inviteCode` を、記録の無いオーナーに `null` を返すことが緑。dashboard-web の型検査・既存の描画テスト・E2E が回帰なしで緑
  - _Requirements: 8.5_
  - _Boundary: dashboard-api owners-list, dashboard-web types, e2e fixtures_
  - _Depends: 7.2_

- [x] 7.5 全体検証と本番の適用順
  - `make ts-lint`／`make ts-test`／`make ts-test-db`／`make go-test`／db assertions／`check_docs.sh` を実行し全緑を確認する（Go 側は `owners` を直接 INSERT するフィクスチャを持つので、NULL 許容の列で回帰しないことを確かめる）
  - 本番の順序: (1) マージ前に `0017` を本番へ適用し、`information_schema.columns` と `pg_constraint` で列と 2 制約の存在を確かめる → (2) マージ → (3) deploy の結果を自分で確認する（line-webhook・dashboard-api のイメージ差し替え）→ (4) 本番の新しいオーナー登録で `invite_code_id` が埋まることを確かめる（登録が無ければ、確認待ちとして追跡先を Issue に記録する）
  - 完了状態: 上記コマンドがすべて終了コード 0、本番の適用・確認結果が PR / Issue #486 に記録されている
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
  - _Depends: 7.1, 7.2, 7.3, 7.4_

## 8. 代理店ごとの詳細の閲覧（Requirement 9・Issue #486）

> 前提: API・DB は変えない（dashboard-web だけの変更）。7.5 の本番での記録の確認とは独立に進めてよい。
> 共用部品（`OwnerRosterTable`・`TopNav`・`status-labels.ts`）は店舗登録（3.12–3.14）と他の面も使う。8.1 は既存の面の描画を変えないことを完了状態に含める。

- [x] 8.1 共用部品の拡張（表示語・オーナーの表・現在地）
  - `lib/status-labels.ts` に「有効／無効」の表示語を足し、`app/invite-codes/page.tsx`・`app/admin/users/page.tsx` が直接書いている同じ語をここから引くように置き換える（語は変えない）
  - `components/owner-roster-table.tsx` に省略可能な `showInviteCode?: boolean` を足す。`true` のときだけ「招待コード」の列を作成日の後に描く（記録あり＝コード・無効のコードには「無効」のラベル・`null` ＝「記録なし（この機能より前の登録）」・`wrap="none"`）
  - `components/top-nav.tsx` の現在地の判定を「完全一致は `aria-current="page"`。どれにも完全一致しないときは `href + '/'` で始まる最も長い項目に `aria-current="true"`」に変え、下線を `aria-[current=true]` からも出す（全リンクの class は同一のまま・正典 §7.8）
  - 完了状態: `OwnerRosterTable` の単体テストで、`showInviteCode` のときだけ列が増え、3 通り（記録あり・無効のコード・記録なし）が出ること。`top-nav.test.tsx` で、`/admin/agencies/<id>` では「代理店管理」が `"true"`、`/admin/agencies` では `"page"`、`/stores/new` では「店舗一覧」が現在地にならないこと。`stores-new-page.test.tsx`・`invite-codes-page.test.tsx`・`admin-users-page.test.tsx` が変更なしで緑（既存の面の描画が変わっていない）。前方一致を「最も長い項目」に限らない変異で `/stores/new` の試験が赤になることを実測する
  - _Requirements: 9.2, 9.4_
  - _Boundary: dashboard-web components, lib/status-labels, invite-codes page, admin/users page_

- [x] 8.2 (P) 代理店詳細の純粋関数（`lib/agency-detail.ts`）
  - `toAgencyId`（UUID の形なら小文字へ正規化・形でなければ null）・`usersOfAgency`（GET /dashboard-users の全件から `agencyId` が一致する行だけ・運営の行は含めない）・`ownersByInviteCode`（`owner.inviteCode.id` → オーナーの並び。記録なしは入れない）・`unrecordedOwnerCount`
  - 完了状態: 単体テストで、他代理店と運営の利用者が混ざらないこと、記録なしのオーナーがどのコードにも入らないこと（9.4）、形の不正な id を弾くことが緑
  - _Requirements: 9.2, 9.4, 9.6_
  - _Boundary: dashboard-web lib_

- [x] 8.3 代理店詳細の画面（`/admin/agencies/[agencyId]`）
  - `app/admin/agencies/[agencyId]/page.tsx`（サーバー部品・`PageProps` の `params` を `await`）と `agency-detail-view.tsx`（クライアント部品）。取得・状態・描画は design.md「代理店詳細」に従う: 代理店ロールは API を呼ばない／UUID の形でなければ API を呼ばない／5 本を同時に発行／存在は GET /agencies で判定し判定まで区分を描かない／区分ごとの状態と再読み込み／GET /stores を店舗の区分とオーナーの表の両方に使う／概要の件数（`loading`・`error` を 0 と出さない）／ブロックの注記／記録なしのオーナーの件数／書込の API を呼ばない
  - 完了状態: 描画の単体テストで design.md「代理店詳細の試験」2 の各項目が緑。存在しない代理店で区分も件数も描かないことについて、存在判定を外す変異（GET /agencies を待たずに区分を描く）で赤になることを実測する
  - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10_
  - _Boundary: dashboard-web app/admin/agencies/[agencyId]_
  - _Depends: 8.1, 8.2_

- [x] 8.4 (P) 代理店管理の一覧から詳細へのリンク
  - `app/admin/agencies/page.tsx` の代理店名のセルを `next/link` で詳細へのリンクにする。リンクの文字は代理店名そのもの。行全体は押せるようにしない（§7.2）
  - 完了状態: 一覧の描画テストで、代理店名が `/admin/agencies/<id>` へのリンクになり、行に押せる役割が付かないことが緑。既存の一覧の契約（表の捲れる領域 1 件など）が緑のまま
  - _Requirements: 9.1_
  - _Boundary: dashboard-web app/admin/agencies/page_

- [x] 8.5 E2E の面の追加
  - `e2e/fixtures/api.ts` のスタブに、詳細で使う行（記録あり・記録なしのオーナー、無効のコード、停止中の店舗、無効の利用者）が揃っていることを確かめ、足りなければ足す。詳細を開く手順（表が実際に描けたことを前提として assert する）を足し、`DASHBOARD_SURFACES` へ詳細を足す（捲れる領域は表の容器 4 件として宣言する）
  - 完了状態: `bash scripts/run-e2e-local.sh --only surfaces` が緑（横の溢れ・携帯の幅・a11y 監査に詳細が載る）。宣言を 3 件に変える変異で赤になることを実測する
  - _Requirements: 9.2, 9.7_
  - _Boundary: dashboard-web e2e_
  - _Depends: 8.3, 8.4_

- [x] 8.6 全体検証とデプロイの確認
  - `make ts-lint`／`make ts-test`／dashboard-web の型検査（`next typegen` を含む）／`bash scripts/run-e2e-local.sh --only surfaces`／静的ガード（`check-design-tokens.sh`・`check-jst-offset-consistency.sh` ほか ts-ci が回すもの）を実行し全緑を確認する
  - マージ後に deploy の結果を自分で確かめ（dashboard-web のイメージ差し替え）、本番で運営として 1 代理店の詳細を開き、4 区分と件数が出ることを確かめる
  - 完了状態: 上記コマンドがすべて終了コード 0、本番での確認結果が PR / Issue #486 に記録されている
  - _Requirements: 9.1–9.10_
  - _Depends: 8.1, 8.2, 8.3, 8.4, 8.5_

## 9. 名前からの遷移と店舗・オーナーの詳細（Requirement 10・11・Issue #526）

> 前提: migration は無く、書込境界も変わらない（読み出しの追加だけ）。API と画面は同じ PR でマージしてよい。`deploy.yml` は 1 回のデプロイの中で dashboard-api を更新してから dashboard-web を更新するためである（design.md「Requirement 10・11 の順序」）。`storeNames` の削除（9.10）だけは、新しい画面が本番に出たことを確かめた後の別 PR にする。
> 共用部品（`StoreQrPanel`・`OwnerRosterTable`・停止と連携解除の操作部品）は、店舗一覧・オーナー一覧・店舗登録・代理店詳細も使う。それらを変えるタスクは、既存の面の描画を変えないことを完了状態に含める。
> 停止の述語ガード（`check-store-serviceable-predicate.sh`）: 確定の比較は `store-detail-view.tsx` の QR の分岐の 1 か所だけに書く。表示語は添字と関数で引き、`EXPECTED_DISPLAY_ONLY_MARKERS` は 2 のまま変えない。

- [x] 9.1 `@fwlm/db`: 1 件の取得と絞り込み
  - `stores.ts`: `findStoreWithStatus(db, { storeId, agencyId })` を足し、`listStoresWithStatus` の絞り込みに `ownerId` を足す。SELECT 句と JOIN はモジュール内の定数にして、一覧と 1 件の取得の両方から使う。範囲は `WHERE s.id = $1::uuid AND ($2::uuid IS NULL OR o.agency_id = $2::uuid)` の 1 文に含める（取得した後で所属を比べる 2 段にしない）
  - `owners.ts`: `findOwner(db, { ownerId, agencyId })` を足し、`listOwners` と SELECT 句を共有する。店舗の集約を `array_agg(s.name …)` から `json_agg(json_build_object('id', s.id, 'name', s.name) ORDER BY s.created_at, s.id)` へ置き換え、`OwnerListItem` に `stores: { id, name }[]` を足す。`storeNames` は `stores` の名前から作って残す。表示だけの判定の印（`serviceable-predicate: display-only`）は、確定の判定の行と同じ行か直前の行に残す
  - UUID の形でない id は DB へ問い合わせずに `null` を返す（既存の `UUID_RE` を使う）
  - 完了状態: `*.db.test.ts` で design.md「名前からの遷移と店舗・オーナーの詳細の試験」1 の各項目が緑（範囲内は 1 件、範囲外と不存在はどちらも `null`、列の値が一覧の同じ行と一致、`ownerId` の絞り込みは未確定の店舗を含む、`stores` と `storeNames` の並びが一致）。`check-store-serviceable-predicate.sh` が緑。`findStoreWithStatus` から代理店の条件を外す変異で、範囲外の試験が赤になることを実測する
  - _Requirements: 10.1, 11.1, 11.6, 11.7, 11.9, 11.10_
  - _Boundary: ts/packages/db（stores.ts・owners.ts・types.ts・index.ts）_

- [x] 9.2 dashboard-api: GET /stores/:id・GET /owners/:id と GET /owners の項目の追加
  - `src/store-detail.ts`・`src/owner-detail.ts`: 認証 → UUID の形の検査（形でなければ DB を呼ばずに 404）→ `resolveAgencyScope(user, undefined)` → 取得 → `null` なら 404。404 の本文は、形の不正・不存在・範囲外のどれでも同じにする（店舗は「店舗が見つかりません」、オーナーは「オーナーが見つかりません」）。GET /owners/:id は、オーナーが見つかったときだけ `listStoresWithStatus({ ownerId })` を呼ぶ
  - `src/owners-list.ts`: 応答の各オーナーに `agencyId` と `stores` を足す。`storeNames` は残す
  - `src/app.ts`・`src/index.ts`（または `composition.ts`）: ルートの配線と依存の注入。既存の `/stores/:storeId/qr.png`・`/stores/:storeId/review-funnel`・`POST /stores/:id/suspend` などと経路が衝突しないことを確かめる
  - 既存の QR と実績の取得の応答（不在に 404、担当外に 403）は変えない（11.9 の範囲外）
  - 完了状態: 単体テストで design.md の試験 2 の各項目が緑（401・未登録と無効の 403・3 通りの 404 の本文が同一・範囲外で店舗を読まない・GET /owners に `agencyId`・`stores`・`storeNames` が載る）。`app-routes.db.test.ts` の認可の表に 2 本を足して緑。範囲外を 403 で返す変異で、本文が同一であることの試験が赤になることを実測する
  - _Requirements: 10.1, 10.2, 10.3, 11.9, 11.10_
  - _Boundary: ts/apps/dashboard-api_
  - _Depends: 9.1_

- [ ] 9.3 (P) dashboard-web の土台: 経路・リンク部品・API クライアント・表示語
  - `lib/entity-paths.ts`: `toEntityId`（`agency-detail.ts` の `toAgencyId` をここへ移し、代理店詳細もこれを使う）・`storePath`・`ownerPath`・`agencyPath`
  - `components/entity-link.tsx`: `EntityLink`（`next/link`＋`textLinkVariants()`）と `AgencyName`（運営のときだけ `EntityLink`、それ以外は素の文字）
  - `lib/api.ts`・`lib/types.ts`: `getStore(id)`・`getOwner(id)` と応答の型を足し、`OwnerListItem` に `agencyId`・`stores` を足す（HTTP の契約が正典。9.2 の実装を待たずに型から進めてよい）
  - `lib/status-labels.ts`: `COMPETITOR_STATUS_LABEL`（競合設定済み／競合未設定）を足し、店舗一覧が直接書いている語をここから引くように置き換える（語は変えない）
  - 完了状態: `entity-paths` の単体テスト（design.md の試験 3）が緑。`EntityLink`・`AgencyName` の単体テストで、運営ではリンク、代理店ロールでは文字になること。代理店詳細の既存の試験（`agency-detail.test.ts` ほか）が、`toEntityId` への置き換えの後も緑。`stores-page.test.tsx` が変更なしで緑
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.8_
  - _Boundary: dashboard-web lib・components/entity-link.tsx_

- [ ] 9.4 共用部品の変更（操作部品の移設・QR パネル・オーナーの表）
  - `app/stores/store-suspension-control.tsx`・`app/owners/owner-line-unlink-control.tsx` を `components/` へ移す。失敗時の文言の「一覧」を、どちらの面でも通じる語に改める（「表示を更新しました」「画面の表示を確認してください」）。引数と、それ以外の振る舞いは変えない
  - `components/store-qr-panel.tsx`: `onClose` を省略可能にし、省略したときは閉じる押しボタンを描かない
  - `components/owner-roster-table.tsx`: 省略可能な `linkNames?: boolean` を足し、`true` のときだけ表示名と登録済みの店舗名を `EntityLink` にする
  - 完了状態: 移設した 2 部品の試験を新しい場所で緑にし、失敗の文言に「一覧」が出ないことを assert する。`StoreQrPanel` は、`onClose` を省略すると閉じる押しボタンが無く、店舗一覧の Drawer では従来どおり閉じられる。`OwnerRosterTable` は、`linkNames` のときだけリンクになり、渡さないときの描画は変わらない（`stores-new-page.test.tsx` が変更なしで緑・10.7）
  - _Requirements: 10.7, 11.2, 11.5, 11.8_
  - _Boundary: dashboard-web components（store-suspension-control・owner-line-unlink-control・store-qr-panel・owner-roster-table）と、その import 元（stores/page・owners/page）_
  - _Depends: 9.3_

- [ ] 9.5 店舗の詳細の画面（`/stores/[storeId]`）
  - `app/stores/[storeId]/page.tsx`（サーバー部品・`PageProps` の `params` を `await`）と `store-detail-view.tsx`（クライアント部品）。取得・状態・描画は design.md「名前からの遷移と店舗・オーナーの詳細」に従う
    - 状態は 4 つ（読み込み中・失敗・見つからない・表示）。形の不正な id は API を呼ばない。404 は概要・操作・QR を描かない
    - 概要の `dl`。担当代理店は運営だけで、`AgencyName` を使う。表示語は添字と関数で引く
    - 停止・再開の操作。成功の後は 1 件だけを読み直し、表示を読み込み中へ置き換えない。最後の要求の応答だけを採る
    - QR の区分は、停止中 → 未確定 → 確定済みの順で判定する。確定済みなら `StoreQrPanel` を `onClose` なし・`showHeader={false}` で置き、停止に切り替わったら外す
    - 戻るリンクを置き、h1 の店名はリンクにしない
  - 完了状態: 描画の単体テストで、design.md の試験 4 のうち店舗の詳細の項目が緑。`check-store-serviceable-predicate.sh` が緑（このファイルは確定の判定 1・停止の判定 1）。次の 2 つの変異で赤になることを実測する: (1) 停止の判定と確定の判定の順を入れ替える（停止中かつ未確定の店舗で「場所の確定が必要です」が出る）、(2) 404 でも概要を描く
  - _Requirements: 10.7, 11.1, 11.2, 11.3, 11.4, 11.5, 11.9, 11.11, 11.12, 11.13, 11.14_
  - _Boundary: dashboard-web app/stores/[storeId]_
  - _Depends: 9.3, 9.4_

- [ ] 9.6 (P) オーナーの詳細の画面（`/owners/[ownerId]`）
  - `app/owners/[ownerId]/page.tsx` と `owner-detail-view.tsx`。状態と読み直しは 9.5 と同じ
    - 概要の `dl`: 招待コードの記録なしは「記録なし（この機能より前の登録）」、担当代理店は運営だけ、店舗の引き継ぎ先は文字のまま（リンクにしない）
    - 連携の解除の操作（`OwnerLineUnlinkControl`。GET /owners/:id の `owner` をそのまま渡す）
    - 店舗の表: 店名（`EntityLink`）・店舗特定・競合設定・利用状況の 4 列で、操作の列は置かない。0 件は `EmptyState`。表示語は添字と関数で引き、比較を書かない
  - 完了状態: 描画の単体テストで、design.md の試験 4 のうちオーナーの詳細の項目が緑（操作の列が無い・0 件の案内・引き継ぎ先がリンクでない）。`check-store-serviceable-predicate.sh` が緑（このファイルに確定の判定を書かない）。店舗の表に停止の操作を置く変異で、11.7 の試験が赤になることを実測する
  - _Requirements: 10.7, 11.6, 11.7, 11.8, 11.9, 11.11, 11.12, 11.13_
  - _Boundary: dashboard-web app/owners/[ownerId]_
  - _Depends: 9.3, 9.4_

- [ ] 9.7 (P) 一覧の名前のリンク
  - `app/stores/page.tsx`: 店名を `EntityLink` にし、店名の隣に「オーナー」列を足す（表示名が無ければ「（表示名なし）」）。担当代理店は `AgencyName`。`BASE_COLUMN_COUNT` を 6 にする。QR と停止の列はそのまま
  - `app/owners/page.tsx`: オーナー名と店舗（`stores` の各店）を `EntityLink`、担当代理店を `AgencyName` にする。引き継ぎ先の文はリンクにしない
  - `app/admin/users/page.tsx`: 所属代理店を `AgencyName` にする
  - `app/admin/agencies/[agencyId]/agency-detail-view.tsx`: 店舗の区分の店名とオーナー、招待コードの区分の「このコードで登録したオーナー」を `EntityLink` にし、`OwnerRosterTable` に `linkNames` を渡す。見出しの代理店名はリンクにしない
  - `text-link-usage.test.ts` の `EXPECTED` を新しいリンクの数へ更新する。`top-nav.test.tsx` に、`/stores/<id>` で「店舗一覧」、`/owners/<id>` で「オーナー一覧」が `"true"` になる試験を足す（`TopNav` 本体は変えない）
  - 完了状態: 描画の単体テストで、design.md の試験 5・6 の各項目が緑（対象の名前がリンクで経路が正しい・代理店ロールでは代理店名が文字・オーナー列・特殊な状態もリンク・対象外はリンクでない・既存の列と操作が残る）。代理店名のリンクを役割で切り替えない変異で、10.4 の試験が赤になることを実測する
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 11.12_
  - _Boundary: dashboard-web app/stores/page・app/owners/page・app/admin/users/page・agency-detail-view・test/text-link-usage・test/top-nav_
  - _Depends: 9.3, 9.4_

- [ ] 9.8 E2E の面の追加
  - `e2e/fixtures/api.ts` のスタブに GET /stores/:id・GET /owners/:id を足す。範囲外として 404 を返す id と、停止中・未確定・確定済みの店舗、表示名の無いオーナー・連携を解除したオーナーを含める
  - 店舗の詳細とオーナーの詳細を `DASHBOARD_SURFACES`（横の溢れ・携帯の幅・a11y 監査）へ足す。面を開く手順では、概要が実際に描けたことを前提として assert する。捲れる領域は、店舗の詳細では QR パネルの実績の表、オーナーの詳細では店舗の表として宣言する
  - 店舗一覧は、列が増えても捲れる領域が表の容器 1 件のままであることを宣言し、`mobile-layout.spec.ts` の `measuredCells` を実測の値へ更新する
  - `dashboard-surfaces.spec.ts` の印刷の検査と同じ型で、確定済み・利用中の店舗の詳細を印刷すると掲示面だけが刷られ、概要と操作は刷られないことを確かめる
  - 完了状態: `bash scripts/run-e2e-local.sh --only surfaces` が緑（シェルの `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` を外して付属の Chromium で流す）。次の 2 つの変異で赤になることを実測する: (1) 捲れる領域の宣言の件数を変える、(2) 店舗の詳細で掲示面の外側に `data-print-region` を付ける（概要が刷られる）
  - _Requirements: 10.1, 10.2, 10.8, 11.2, 11.9, 11.12_
  - _Boundary: dashboard-web e2e_
  - _Depends: 9.5, 9.6, 9.7_

- [ ] 9.9 全体検証とデプロイの確認
  - 次をすべて実行し、緑を確認する
    - `make ts-lint`・`make ts-test`・`make ts-test-db`
    - dashboard-web の型検査（`next typegen` を含む）
    - `bash scripts/run-e2e-local.sh --only surfaces`
    - ts-ci が回す静的ガード（`check-store-serviceable-predicate.sh`・`check-design-tokens.sh`・`check-compliance-wording.sh`・`check-run-env-wiring.sh` ほか）
  - マージの後、自分のマージコミットの SHA に対する ts-ci と deploy-prod の結果を確かめる（dashboard-api と dashboard-web のイメージの差し替え）
  - 本番で運営として、店舗の詳細（確定済み・停止中のそれぞれ）とオーナーの詳細を開き、一覧の名前から遷移できることを確かめる。代理店ロールのアカウントで確かめられない場合は、その旨と追跡先を Issue #526 に記録する
  - 完了状態: 上記コマンドがすべて終了コード 0、本番での確認結果が PR / Issue #526 に記録されている
  - _Requirements: 10.1–10.9, 11.1–11.14_
  - _Depends: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

- [ ] 9.10 `storeNames` の削除（別 PR・9.9 の本番確認の後）
  - `@fwlm/db` の `OwnerListItem`、dashboard-api の GET /owners の応答、dashboard-web の型、試験と E2E のスタブから `storeNames` を消す。`.kiro/specs/owner-line-unlink/design.md` の該当する注記（「画面の切り替え後に消す」）を、消した事実に合わせて改める
  - 完了状態: `git grep -n storeNames -- ts` が 0 件、`make ts-test`・`make ts-test-db`・`bash scripts/run-e2e-local.sh --only surfaces` が緑。マージの後、本番のオーナー一覧で店舗名が表示されることを確かめる
  - _Requirements: 10.1_
  - _Boundary: ts/packages/db・dashboard-api owners-list・dashboard-web lib/types と試験・owner-line-unlink design.md_
  - _Depends: 9.9_

## Implementation Notes
<!-- 実装中に得られた横断的な知見をここに追記する -->
- 環境: docker/apple-container 不在。DB スキーマ検証（`make db-migrate`/`db-test`/`db-verify-docs` 相当）は native postgres で代替する。正典レシピ: `ts/scripts/with-test-db.sh bash -c 'for f in db/test/assertions/*.sql; do psql -v ON_ERROR_STOP=1 -f "$f"; done; MANAGE_CONTAINER=0 PSQL_EXEC="psql" db/test/check_docs.sh'`（with-test-db.sh が native postgres 起動＋全 migrations 適用＋PG 環境変数 export を行う）。TS の `*.db.test.ts` は `make ts-test-db` でそのまま可。
- 1.1: **`db/test/assertions/30_compliance.sql` の PII denylist（5.3c）は全列を走査するため、`dashboard_users.email`（運営/代理店スタッフのログイン識別子）追加で誤検知 FAIL する**。denylist を `table_name NOT IN ('operators','agencies','dashboard_users')` でスタッフ識別テーブル除外に scope 修正（来店客テーブルへのガードは完全維持・reviewer が stores.email/survey_rating_tallies.phone 注入で発火継続を実証）。今後スタッフ系テーブルに login 識別列を足す際は同 denylist を確認すること。`30_compliance.sql` の table allowlist（5.3a）は新テーブル追加時に更新必須だが、0005 は列追加のみ（新テーブルなし）のため allowlist 変更不要。
- 1.1: assertion で「特定の CHECK 制約が発火したこと」を証明するには `GET STACKED DIAGNOSTICS v = CONSTRAINT_NAME`（`PG_EXCEPTION_CONSTRAINT` ではない）を使う。二重リンク検証は `GET DIAGNOSTICS n = ROW_COUNT` で UPDATE 影響行数（1回目=1・2回目=0）を確認する。
- 1.2: `@fwlm/store-identification` の公開契約は line-onboarding が依存する再検証トリガ。移設は git rename 検出される byte-identical 移動で行った。移設タスクのコミットは削除ファイルが既に staged（`D ` 列1）な場合があり、`git add <deleted-path>` は "did not match" で invocation 全体が失敗する。対処: `git status` の列1を先に確認し、削除は既 staged 分を活かして modified/新規のみ明示 add する（または `git add -A -- <明示パス>`）。
- 1.3: `AgencyItem` は design.md に明示ボディが無く `{ id, operatorId, name, createdAt }` を agencies DDL から導出した。`/agencies` API（2.5・6.x）はこの shape を response 封筒に合わせること。`findOwnerWithAgency` は design 署名どおり UUID ガード無し → 呼び出し側（2.3）が有効 UUID を渡すこと。共有 DB テストの UUID prefix は `f3` を使用（次タスクは `f4` 以降）。
- 1.4: `DashboardUserItem` も design 未定義のため `{ id, role, operatorId, agencyId, email, displayName, disabled, createdAt }` を導出（2.5 の API はこれに合わせる）。UUID prefix `f4` 使用済み（次は `f5` 以降）。
- 2.1: `AuthOutcome` は4値（unauthenticated/unregistered/disabled/authenticated）。disabled と unregistered は QR/API とも**同一封筒の 403**（存在有無を漏らさない）。リンク適格は `eligibleLinkEmail`（google.com && email_verified && email 有・trim+lower）に隔離済み — 以降のハンドラは authenticate の結果だけ見ればよい。実行が中断された実装 subagent の残骸が worktree に残ることがある — 後続 subagent は「既存未コミット変更を spec と突き合わせ検証→採用/破棄」を明示的に行うこと（今回2.1で実施し成功）。
- 2.2: 新ハンドラのエラーコードは design コード体系どおり小文字（`unauthenticated`/`forbidden`）。既存 qr.ts は大文字のまま → **3.1 で統一を検討**。3.1 への引き継ぎ: (a) `MeDeps.findAgencyName`/`findDisplayName` は狭い注入関数で DAL 未実装 — 配線時に実クエリで裏付ける（@fwlm/db に既存 SELECT の再利用または小アクセサ追加）。(b) ルート層で空文字 `?agencyId=` を `undefined` に正規化してからハンドラへ渡すこと（ハンドラは undefined のみを「未指定」と解釈）。
- 2.3: 決定事項: GET /owners で operator の agencyId 未指定は 400（オーナー選択には具体的代理店が必要・design ウィザードの代理店先行選択と整合）（`owner-line-unlink` 4.4・Issue #487 で、運営の未指定は全代理店のオーナーを返すように改めた。オーナー選択は引き続き代理店を指定して呼ぶ。design.md の GET /owners の注記を参照）。不正 UUID の ownerId は findOwner 未到達の 404（存在秘匿）。**3.1 への最重要引き継ぎ: `registerStore({ownerId, candidate, categoryCode})` dep の実装合成** — 凍結契約 `confirmStore(ownerId, candidate)` は categoryCode を受けないため、共有 TX 意味論（stores INSERT confirmed → owner store_identified 単一TX・`ux_stores_place_id` 違反の冪等/409 正規化）を保ったまま category を設定する合成が必要（例: `createConfirmedStore` ベースの自前 TX か confirmStore＋同一TX category UPDATE）。
- 2.4: GET /invite-codes・POST /invite-codes とも operator は agencyId 指定必須（400）・agency は自代理店強制（2.3 と同型）。disable は operator のみ body `{agencyId}` 必須（design 表の Request「—」からの拡張・DAL の scope 列契約による。`InviteCodeDisableRequest` JSDoc に文書化済み）。3.1 への引き継ぎ: (a) `issueCode` = `createUniqueInviteCode`＋`createInviteCode` の合成を配線側で組む。(b) 発行失敗（3試行切れ）の error は handler が握り潰すため、**配線側の issueCode 内でログ出力**してから rethrow すること（design Monitoring「5xx 詳細はログへ」）。
- 4.2: **Firebase クライアント初期化は必ず遅延アクセサ（`getFirebaseAuth()`）にする**。モジュール評価時に `getAuth()` を呼ぶ eager 版は `next build` の静的プリレンダで build-arg 未注入（空 apiKey）により `auth/invalid-api-key` を投げ build 失敗する（store-detail の LIFF 起動障害と同型）。`getApps()` 再初期化ガードも必須。/me 403（forbidden）は auth-context が即 firebaseSignOut→status='unregistered'→me=null（`handlingUnregistered` ref で onAuthStateChanged(null) の status 上書きを防止）。AuthGuard/TopNav は 4.2 で共有部品として先行実装済み・4.3–4.5 で結線。dashboard-web の ESLint scope は `src` のみ（test 未 lint・survey-web と同じ既存設定）。
- 3.1: dashboard-api バックエンドは配線完了（14ルート・単一オリジンCORS・/health 認証免除・app.request 認可マトリクスDBテスト）。決定事項: (a) `registerStore` は凍結 `confirmStore` を再利用し、category は confirmed 時のみ **best-effort な別 UPDATE**（非原子的・失敗時は storeId のみログ・Go バッチ fallback あり）。(b) **qr.ts のエラーコードは大文字のまま未統一**（group-2 は小文字）— 契約変更＋既存テスト影響のため別途明示決定が必要（現状は機能上無害・別エンドポイント）。(c) POST の不正JSON body は authenticate 前に固定封筒 400（情報漏洩なし・全 body ルートで同一）。CORS 許可オリジンは `DASHBOARD_WEB_ORIGIN` env。dashboard-web は build 時 `NEXT_PUBLIC_API_BASE_URL` でこの API を指す。
- 6.3 全体受け入れ結果（全緑）: `make ts-lint`✅ / `make ts-test`（160 passed）✅ / `make ts-test-db`（183 passed・native postgres）✅ / db assertions 全 PASS ✅ / `make db-verify-docs`（17 テーブル整合・grants 整合）✅ / `terraform -chdir=infra/envs/prod validate`（Success）✅ / 7.2 来店客系テーブル参照なし ✅ / build 全緑（backend chain＋dashboard-web/store-detail/survey-web を個別 build で確認・check-next-public-buildargs 緑）✅。**注意: このマシンはディスク逼迫のため `make ts-build`（全 Next app 同時 build）が ENOSPC で失敗する。回避策=非 Next（tsc）を先に build → Next app を1つずつ build して都度 `rm -rf ts/apps/*/.next`。CI/Cloud Build（十分なディスク）では通常どおり `make ts-build` 可**。
- validate-impl 後の掃除（GO 判定・Warning 是正）: (a) 合成根 index.ts の inline SQL 3箇所を @fwlm/db の小アクセサ（`setStoreCategory`/`findAgencyName`/`findDashboardUserDisplayName`）へ移設（DI 複製テスト2ファイルも同期・直接 db テスト4件追加）。(b) `DashboardUserRow` を 0005 DDL（auth_subject NULL 許容・email・disabled_at）へ同期（design Modified Files で計画済みだった未実施分）。(c) design.md へ実装時決定を還流: contract 表の 400 拡張（GET /owners・GET/POST /invite-codes の operator agencyId 必須）・disable の body `{agencyId?}` 契約・best-effort category の明文化・File Structure Plan 補記（categories.ts / lib/types.ts）・30_compliance.sql スコープ修正の記録。**教訓: migration 追加タスクは types.ts の対応 Row 型同期を完了条件に含める。API 契約を実装中に拡張したら design.md contract 表を同一タスクで更新する（tasks.md 記録だけでは validate-impl で DRIFT 扱い）**。
- 6.3 **手動検証フック（本番 go-live 前に必須・PR に転記すること）**: (1) **Identity Platform の Google プロバイダ有効化状態を確認**（tf に `default_supported_idp_config` 未定義の Open Question。未有効ならコンソール有効化、必要なら gcp-infra-foundation へ tf 追記）。(2) **gmail アカウントでの初回ログイン→リンク→再ログインで UID 安定**を実機確認。(3) **Google Workspace 独自ドメインのメールでの同フロー**（research 案B の最重要前提＝Workspace は untrusted provider のため自動統合が公式保証外。email_verified=true でのリンク動作を実機で確認）。(4) デプロイ順序: migration 0005 を本番適用 → `infra/sql/grants.sql` は変更不要 → tf apply（dashboard-web サービス作成・dashboard-api env 追加）→ GitHub `vars.NEXT_PUBLIC_*`（API_BASE_URL/FIREBASE_*）と tfvars `dashboard_web_origin`（相互参照する両 Cloud Run URL）を設定 → image デプロイ。(5) 初代運営 `dashboard_users`（auth_subject NULL・email 付き保留行）は SQL/seed で投入（鶏卵回避）。
- 7.1: **migration は 1 本ずつ `BEGIN;` … `COMMIT;` で囲む**（0001〜0016 はすべて自前で持ち、`db/test/run.sh` は `-1` を付けずにその前提で流す）。0017 は当初これを欠いており、途中の文が失敗すると列だけが残って FK が無い状態になり、再実行も 1 文目で落ちる形だった（レビューで発見・同名制約を先に置く実験で再現と是正を実測）。この慣習を機械で検査するガードは無く、スイートは欠いたままでも全緑だった。
- 7.1: このマシンの bash は `/bin/bash` 3.2 のみで、`db/test/check_structured_survey_privileges.sh`（#437）は `mapfile` で落ちる。`run-db-test-suites.sh` の NG がこの 1 件だけなら環境要因（`mapfile` の代用関数を入れた写しでは 768 件 PASS をレビューで確認）。CI（ubuntu・bash 5）では走る。変異で検査の効き目を測った結果: 単独 FK・FK 無し・DEFERRABLE・制約名違い→51c、CASCADE・SET NULL→51d、NO ACTION→51f、MATCH FULL・NOT NULL・既定値→51a が赤。
- 7.2: **JOIN を足した読み出しの試験は、結合先の行を同じ親に 2 件以上置き、親の件数を実数と厳密に比べる。** 代理店のコードが 1 本だけのフィクスチャでは、`listOwnersByAgency` の結合キーを `c.agency_id = o.agency_id` に誤っても行が増えず全件緑だった（レビューで実測）。記録に使わない 2 本目のコードと件数・id の一意性の assert で赤になる。
- 7.2 → 7.3: **line-webhook の `OwnersAccessor.createOwner` はメソッド構文で独自の狭い入力型を持つため、引数の双変性で `inviteCodeId` を渡さなくても型検査を通る**（7.2 の時点で実測。実行時は undefined が NULL として送られ、会話経由のオーナーは記録なしになる）。7.3 ではアクセサの入力型を `@fwlm/db` の `CreateOwnerInput` に揃える。網の実測は「呼び出しから `inviteCodeId` を消す」変異で取る（design の試験 5 にある「省略可能にする変異」は実装側の引数が広がるだけで、構造上 line-webhook では赤にならない）。
- 7.2 → 7.4: dashboard-api の `owners-list.ts` の `toJson` は `inviteCode` を落とす（GET /owners の応答に載せるのは 7.4）。
- 7.2 → 7.5: `OWNER_COLUMNS` が `invite_code_id` を読むので、`findOwnerByLineUserId`／`findOwnerById` を通る line-webhook の全イベントが 0017 に依存する。本番は 0017 の適用が先（逆順だと Webhook がすべて失敗する）。なお `OWNER_COLUMNS` が `delivery_hour` を選ばないのに `OwnerRow` が持つ食い違いは 7.2 より前からある（範囲外）。
- 7.2: 一括の `pnpm -C ts run test` は負荷で無関係なタイムアウト（store-detail `trend-scale`・dashboard-web `store-review-funnel`・line-webhook `report/stores.test.ts`）を出すことがある。差分に無いファイルなら単独で流し直して判定する。
- 7.3: 型の網は、受け口（`OwnersAccessor.createOwner`）の入力を `CreateOwnerInput` にそろえて成立した。「呼び出しから `inviteCodeId` を消す」変異で `conversation.ts` の呼び出し箇所が TS2345 で赤になる。対照として受け口を旧来の狭い独自型へ戻すと、src は型エラーを出さない（7.2 の見立てどおり）。タスク本文の「省略可能にする変異」は、この変異で代替した。
- 7.3: **失敗を差し込む試験は、狙った経路に着いたことを引数で固定する。** 招待コードの無効な経路も同じ `updateSession` を呼ぶため、「例外が出た・オーナー行が 0 件」だけでは、照合に失敗しても緑だった（存在しないコードを送る変異で実測・レビューで発見）。差し込む関数を名前付きの spy にし、`stage: 'await_store_name'` と `ownerId` を持つ呼び出しで 1 回だけ呼ばれたこと、その `ownerId` の行が残っていないことを確かめる形にした。
- 7.3 → #472 の取り込み: #472（招待コード入力の正規化・未マージ）が足す単体試験の `validCodes`（例 `{ ABCD2345: { agencyId: AGENCY_ID } }`）は `id` を持たないため、本ブランチと統合すると line-webhook の型検査が赤になる。取り込み時にその試験データへ `id: INVITE_CODE_ID` を足す。src の衝突は無い（#472 が変える照合の行に 7.3 の差分は触れていない）。
- 7.4: **このシェルは `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` が Aside を指すので、E2E は `env -u PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH bash scripts/run-e2e-local.sh --only surfaces` で流す。** 素で流すと試験は全件通るのに、worker が 300 秒で強制終了されて exit 1 になる（#381 の Aside の crashpad の居残り・98 + 23 passed のまま赤）。付属 Chromium では 73〜135 秒で緑。
- 7.4: **app コードのコメントに前置きなしの `#486` を書くと `check-design-tokens.sh` が色の直書きとして赤にする**（7.3 の `conversation.ts` で発生し、7.4 のレビューで発見・`33a3be2` で「Issue #486」に修正）。タスク単位の試験では見えないので、コミットの前に ts-ci が呼ぶ `scripts/check-*` を一通り流す（`grep -ohE 'scripts/check-[a-z0-9-]+\.(sh|py)' .github/workflows/ts-ci.yml` で一覧が取れる・33 本）。
- 7.4: GET /owners の応答は `inviteCode` を参照のまま渡さず 3 項目（id・code・disabled）だけを写す。レビューの指摘で足した防御だが、当初は試験が無く参照渡しへ戻す変異が緑だった。DAL が余分な項目を返す場合の試験を足し、その変異で赤になることを確かめて閉じた（指摘への修正にも、それを赤にできる試験を付ける）。E2E スタブの OWNERS は `as const` で web の型に縛られていない（タスク外として記録のみ）。
- 7.5（進行中・2026-10-25）: main（1519b5f）へ載せ直した後のローカルの全体の検証は緑（build・typecheck・lint・全 14 パッケージの試験・Go・ts-ci のガード 33 本・番号ガード。DB スイートの赤は 7.1 の bash 3.2 の `mapfile` 1 件のみ）。PR #491 を作成。**残りは本番の手順**: マージ前に 0017 を本番へ適用して列と 2 制約を確認 → マージ → deploy の確認 → 本番の新しいオーナー登録で `invite_code_id` が埋まることの確認。完了の印はこれらが済んでから付ける。
- 8.2: **経路の値の大小は、判定と比較で同じ正規化を通す。** 形の判定で大小を許したまま、利用者の絞り込みを素の値の厳密一致で書いていた（レビューで発見）。API の id は小文字なので、大文字の URL で利用者の区分だけが偽の 0 件になる。`toAgencyId` で小文字へ正規化して全経路で使う形にした。あわせて、**大小を試す入力には英字を含める**: 試験の id が `22222222-…` と数字だけで `toUpperCase()` が値を変えず、大小の試験が空振りしていた（小文字化を外す変異で赤が 1 件しか出ないことで発見）。
- 8.3: **「判定まで描かない」は、判定の取得を保留した状態で試験する。** 最後の状態（見つかりません）まで `findBy` で待つ試験は、判定の前に区分を描いて後で消す退行を捕まえない（レビューで発見）。`getAgencies` を解決しない約束で保留し、他の 4 本が届いた後に区分が無いことを表明した。また**件数を並べる面の fixture は各件数を互いに違う値にする**（2・2・2 だと、ある件数を別の区分から数える取り違えが緑で通る）。
- 8.5: **面ごとに要る状態は、共有の fixture を変えずにスタブの引数で注入する**（`stubDashboardApi` の `suspendedStoreIds`）。注入した状態が画面まで届いたことは、面を開く手順の前提の表明で確かめる。当初は共有の `STORES` を汚すのを避けて停止中の店舗を省き、「単体試験が覆う」と説明していたが、単体試験は値を置くだけで表明していなかった（レビューで発見）。`mustOverflow` は部分集合の主張なので、空のままにせず、全表を宣言して失敗させ、実測（`label=scrollWidth/clientWidth`）を取ってから決める。手元の E2E はシェルの `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`（Aside）を外して流す。Aside のままだと全件緑でもワーカーの終了で止まって exit 1 になり（docs/testing/e2e.md #381）、途中の試験も 13〜17 分止まった。付属の Chromium では 116 件を 40 秒で流せた。
- 9.2: dashboard-api は `@fwlm/db` の **dist** を読む。共有パッケージの公開面を足した・取り消したときは `rm -rf ts/packages/db/dist && pnpm -C ts/packages/db build` で作り直してから試験する（取り消した `isUuid` が古い dist に残り、作り直さないと緑に見えた）。API のハンドラの UUID の判定は `@fwlm/db` から借りず、`store-suspension.ts` と同じくモジュール内の `UUID_RE` を持つ（9.2 のレビューで境界の外と判定された）
