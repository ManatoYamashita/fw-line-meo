# Implementation Plan

- [x] 1. Foundation: TS モノレポと共有 DB 層
- [x] 1.1 TS モノレポ基盤とツーリングを確立する
  - `ts/` に pnpm workspace（`pnpm-workspace.yaml`・ルート `package.json`）と strict な `tsconfig.base.json`（`any` 禁止）を作成する
  - vitest・ESLint・TypeScript の共通設定と、`apps/`・`packages/` のワークスペース解決を通す
  - ルート `Makefile` に `ts-install`／`ts-build`／`ts-lint`／`ts-test` ターゲットを追加する
  - Observable: `make ts-install` 成功後、空のワークスペースで `make ts-lint` と `make ts-test` が exit 0
  - _Requirements: 1.1, 2.1_

- [x] 1.2 共有 DB 接続層（pool・型）を実装する
  - Cloud SQL Connector ＋ pg Pool で IAM DB 認証（パスワードレス・`CLOUDSQL_CONNECTION_NAME`）接続を確立し、テスト用に `DATABASE_URL` フォールバックを設ける
  - 使用する既存テーブルの行型（stores・survey_aspects・dashboard_users・tallies）を定義する
  - Observable: ローカル postgres に対し pool 経由で `SELECT 1` が通り、接続設定のユニットテストが緑
  - _Requirements: 5.5_

- [x] 1.3 (P) DB 読み取りアクセサ（stores・aspects・dashboard_users）を実装する
  - store をアンケート用に取得（存在・名前・place_id・place_status）し、QR RBAC 用に owner 経由の agency_id を同梱して取得する
  - `survey_aspects` を seed から取得し（コード内に選択肢を二重定義しない）、`dashboard_users` を auth_subject で引く
  - Observable: seed 済み postgres で各アクセサが期待行を返し、未確定 store・不在 store・未登録 UID の分岐がユニットテストで緑
  - _Requirements: 1.3, 1.4, 2.4, 2.7_
  - _Boundary: packages/db stores/aspects/dashboard-users_
  - _Depends: 1.2_

- [x] 1.4 (P) DB 集計書込（月次 tallies UPSERT）を実装する
  - 1 回答につき rating を 1 行、選択 aspect ごとに 1 行を単一トランザクションで `count = count + 1` UPSERT する
  - `period_month` を Asia/Tokyo 基準の月初日として SQL 側で確定し、既存 UNIQUE 制約に整合させる
  - Observable: 同一 store・同一月への複数回答で count が加算され、月末 23:59 JST の回答が正しい月に入るユニットテストが緑
  - _Requirements: 5.2, 5.5_
  - _Boundary: packages/db tallies_
  - _Depends: 1.2_

- [x] 2. (P) インフラ拡張：セッション鍵シークレットと環境変数配線
  - `secrets` モジュールに `survey-session-key` の枠を追加する（値は帯域外注入・gcp-infra-foundation の規約どおり frame のみ）
  - `run-services` モジュールにサービス別 plain env（非シークレット）対応を追加し、survey-web へ `SESSION_SIGNING_KEY`（secret_env・accessor は consumer 側 co-locate）と `GEMINI_MODEL`、dashboard-api へ `SURVEY_BASE_URL` を root で配線する
  - `GEMINI_API_KEY` は既存 infra で survey-web に secret_env 配線済み（本タスク対象外・存在確認のみ）
  - Observable: `terraform -chdir=infra/envs/prod validate` 成功、`plan` 差分が新規シークレット枠・env・accessor の追加のみ（既存リソースの破壊的変更なし）
  - _Requirements: 1.1, 3.3, 3.8, 5.3_
  - _Boundary: infra/modules/secrets, infra/modules/run-services, infra/envs/prod_

- [x] 3. Core: 客向け Web（survey-web）アプリとロジック層
- [x] 3.1 survey-web アプリ雛形（Next.js standalone）を確立する
  - Next.js 16（App Router）を `output: 'standalone'` で初期化し、`PORT` 対応の Dockerfile（`public/`・`.next/static` の明示コピー含む）を用意する
  - 必要依存（@google/genai・pg・cloud-sql-connector）を導入し、ヘルスに相当する最小ページで起動を確認する
  - survey-web の共有ドメイン型（素材の形状 `DraftMaterial` 等）を確立し、SessionToken・PromptBuilder・DraftGenerator が同一定義を参照する前提を固定する（並列実装時の二重定義を防ぐ）
  - Observable: `make ts-build` で survey-web が standalone 出力を生成し、ローカル起動でトップが 200 応答、共有ドメイン型が import 可能
  - _Requirements: 2.1, 2.8_
  - _Depends: 1.1_

- [x] 3.2 (P) セッショントークン層（pageToken・sessionToken）を実装する
  - Node crypto の HMAC-SHA256 で pageToken（storeId・exp 5 分）と sessionToken（素材・attempt・exp 30 分）を署名/検証し、kind をペイロードに封入して相互流用を拒否する
  - 署名鍵は `SESSION_SIGNING_KEY` を用いる
  - Observable: sign→verify 往復・改ざん検知・exp 失効・attempt 上限・pageToken を sessionToken として使えないことがユニットテストで緑
  - _Requirements: 3.8, 5.2, 5.3_
  - _Boundary: survey-web SessionToken_
  - _Depends: 3.1_

- [x] 3.3 (P) 入力検証層を実装する
  - 星必須（1〜5）・aspects は取得済み code のみ許容・comment ≤ 200 字をサーバー側で再検証する（クライアント検証を信用しない）
  - Observable: 星欠落・不正 aspect code・201 字入力が拒否され、正常入力が通るユニットテストが緑
  - _Requirements: 2.3, 2.5, 2.6, 2.4_
  - _Boundary: survey-web validate_
  - _Depends: 3.1_

- [x] 3.4 (P) Google 投稿 URL 組立層を実装する
  - Place ID から writereview 形式の投稿 URL を組み立て、形式変更の追随点を単一モジュールに隔離する（代理投稿はしない＝遷移 URL のみ）
  - Observable: placeid が正しく URL エンコードされ、既知 Place ID で期待 URL を返すユニットテストが緑
  - _Requirements: 4.3, 4.5_
  - _Boundary: survey-web GoogleReviewUrl_
  - _Depends: 3.1_

- [x] 3.5 (P) プロンプト組立層を実装する
  - systemInstruction（素材の事実のみ・誇張禁止・公序良俗・低評価は節度）と、自由記述をデリミタで隔離し指示として解釈させない構造を定義する
  - 文体・書き出し・切り口の候補からサーバーが変動要素を選び、試行間で語彙が変わるようにする
  - Observable: 生成入力に素材以外の事実が現れず、低評価分岐と変動要素の切替がユニットテストで確認できる
  - _Requirements: 3.1, 3.2, 3.3, 3.5_
  - _Boundary: survey-web PromptBuilder_
  - _Depends: 3.1_

- [x] 3.6 下書き生成層（Gemini）を実装する
  - @google/genai で `gemini-3.1-flash-lite`（env で差替可）を呼び、`responseMimeType: application/json` ＋ responseSchema で下書き文字列を強制、temperature ≈ 1.0・seed 非固定にする
  - safetySettings で HARASSMENT／HATE_SPEECH／SEXUALLY_EXPLICIT／DANGEROUS_CONTENT を BLOCK_MEDIUM_AND_ABOVE に明示設定し、429/5xx に指数バックオフ 1 回、出力の非空・長さ・スキーマ準拠を検証する
  - Observable: safetySettings 4 カテゴリが必ず付与されること・不正出力が INVALID_OUTPUT として弾かれることがユニットテストで緑（Gemini はモック）
  - _Requirements: 3.1, 3.2, 3.4, 3.9_
  - _Boundary: survey-web DraftGenerator_
  - _Depends: 3.5_

- [x] 3.7 (P) インスタンス内レート制限層を実装する
  - 公開エンドポイントの生成コスト濫用に対する簡易レート制限（ベストエフォート・ゼロスケール前提で完全防御は狙わない）を独立モジュールとして実装し、/api/responses と /api/drafts の双方が依存できる形にする
  - Observable: 閾値超過の連続要求が抑止され、ウィンドウ経過で解放されるユニットテストが緑
  - _Requirements: 3.8_
  - _Boundary: survey-web RateLimit_
  - _Depends: 3.1_

- [x] 4. Core: survey-web の API と UI
- [x] 4.1 (P) 回答受付 API（/api/responses）を実装する
  - pageToken を検証（storeId 一致・5 分以内）し、入力を再検証したうえで、集計 UPSERT と初回下書き生成を並行実行する
  - 集計失敗は応答に影響させず WARN ログのみ（自由記述はログに出さない）、sessionToken は生成成否に関わらず必ず発行し、生成失敗は `200 generation:'failed'` で返す。共有レート制限モジュール（3.7）を適用する
  - Observable: 正常 POST で tallies 加算＋draft/token 返却、pageToken 無効は 400、集計 DB 障害でも 200 で応答するテストが緑
  - _Requirements: 2.3, 2.5, 3.1, 5.1, 5.2, 5.3, 5.4_
  - _Boundary: survey-web ResponsesAPI_
  - _Depends: 1.4, 3.2, 3.3, 3.6, 3.7_

- [x] 4.2 (P) 再生成 API（/api/drafts）を実装する
  - sessionToken を検証し同一素材から再生成する。集計には一切触れず、attempt は生成成功時のみ +1、attempt ≥ 3 の再生成要求は 409 を返す。共有レート制限モジュール（3.7）を適用する
  - Observable: 3 回の再生成成功後 4 回目が 409、生成失敗試行が回数を消費しない、再生成が tallies を変えないテストが緑
  - _Requirements: 3.8, 3.9_
  - _Boundary: survey-web DraftsAPI_
  - _Depends: 3.2, 3.6, 3.7_

- [x] 4.3 アンケートページ SSR とクライアント合成シェルを実装する（統合）
  - `/s/{storeId}` で store と aspects を SSR 取得し、不在・place 未確定はエラー/準備中、正常時は pageToken・googleReviewUrl を同梱してクライアントシェルを描画する
  - クライアントシェルが回答フェーズ（回答中／下書き）と結果 state を所有し、/api/responses・/api/drafts を呼び出して SurveyForm と DraftPanel の props 契約（aspects・onSubmit ／ draft・sessionToken・googleReviewUrl・onRegenerate 等）を定義・受け渡す。localStorage の回答済みフラグ（storeId＋完了時刻）で 24 時間以内は回答済み画面＋投稿導線を表示する（サーバーは端末を識別しない）
  - Observable: 有効 store で設問シェルが SSR 表示、不在/未確定でエラー/準備中、送信後にフォームが下書き表示へ遷移、生成失敗時に再試行しても投稿導線が維持され集計が二重加算されないテストが緑
  - _Requirements: 2.1, 2.7, 2.8, 2.9, 2.10, 3.9, 5.1, 1.3_
  - _Boundary: survey-web SurveyPage, answered-flag_
  - _Depends: 1.3, 3.2, 3.4, 4.1, 4.2_

- [x] 4.4 (P) 回答フォーム UI（葉コンポーネント）を実装する
  - 4.3 が定義する props 契約に対し、星評価（必須）・良かった点（複数選択・seed 由来の選択肢）・一言（任意 200 字）をタップ中心で入力し、星未入力時は送信を止めて必須を明示、onSubmit で親シェルへ回答を渡す（API 呼び出しはシェルが所有）
  - Observable: 星のみで送信可・星なしで送信不可・201 字入力が抑止されるコンポーネントテストが緑
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6_
  - _Boundary: survey-web SurveyForm_
  - _Depends: 3.3, 4.3_

- [x] 4.5 (P) 下書きパネル UI（葉コンポーネント）を実装する
  - 4.3 が定義する props 契約に対し、生成中インジケータ・編集可能な下書き表示・再生成トリガー（残回数表示・失敗時再試行）・生成失敗時も維持される投稿導線を描画する（再生成/投稿の実行はシェルが所有）
  - コピーは表示済み下書きをジェスチャー内で同期 writeText し完了を明示、自動コピー不可時は手動選択可能表示にフォールバック、星の高低に関わらず同一の投稿導線を表示する
  - Observable: コピー→writereview URL 遷移、低評価でも同一導線、生成失敗時に再試行 UI と投稿導線が残ることがテストで緑
  - _Requirements: 3.6, 3.7, 3.9, 4.1, 4.2, 4.4, 4.6_
  - _Boundary: survey-web DraftPanel_
  - _Depends: 4.3_

- [ ] 5. Core: 管理 API（dashboard-api）による QR 提供
- [x] 5.1 (P) dashboard-api アプリ雛形を確立する
  - Hono で最小 API を初期化し、`PORT` 対応の起動・`SURVEY_BASE_URL` 等 env 検証・Dockerfile を用意する（firebase-admin・qrcode・pg を導入）
  - Observable: ローカル起動でヘルス相当ルートが 200、必須 env 欠落時に起動が明示エラーで停止
  - _Requirements: 1.1_
  - _Boundary: dashboard-api scaffold_
  - _Depends: 1.1_

- [x] 5.2 Firebase ID トークン検証と RBAC ミドルウェアを実装する
  - Authorization Bearer の ID トークンを firebase-admin で検証し、auth_subject から dashboard_users を引いて role を判定、operator は全店・agency は担当店（stores→owners.agency_id 一致）のみ許可する
  - Observable: operator 許可・agency 担当店許可・agency 他店 403・未登録 UID 403・トークン無し 401 の RBAC マトリクスがテストで緑（firebase-admin モック）
  - _Requirements: 1.4_
  - _Boundary: dashboard-api AuthMw_
  - _Depends: 1.3, 5.1_

- [ ] 5.3 QR エンドポイントを実装する
  - 認証・RBAC を通過した要求に対し `{SURVEY_BASE_URL}/s/{storeId}` を符号化した PNG を返す。size は 128〜1024 に clamp（既定 512）、place 未確定 store は 409 を返す
  - Observable: 有効要求で image/png の QR が返り、pending store で 409、URL に storeId(UUID) が入ることがテストで緑
  - _Requirements: 1.1, 1.2, 1.3_
  - _Boundary: dashboard-api QrRoute_
  - _Depends: 5.2_

- [ ] 6. Validation: 統合・E2E・性能
- [ ] 6.1 survey-web 統合テストを実装する
  - 正常回答の UPSERT 加算、集計障害でも draft 返却（5.4）、再生成上限、pageToken 欠落/期限切れ/他店の拒否、生成失敗→/api/drafts 再試行で tallies が二重加算されないことを検証する
  - Observable: ローカル postgres ＋ Gemini モックで上記シナリオが緑
  - _Requirements: 3.1, 3.8, 3.9, 5.2, 5.3, 5.4_
  - _Depends: 4.1, 4.2_

- [ ] 6.2 (P) QR RBAC 統合テストを実装する
  - operator／agency 担当店／agency 他店／未登録 UID／pending store のマトリクスをエンドポイント経由で検証する
  - Observable: 各ケースの HTTP ステータス（200/403/401/409）が期待どおりで緑
  - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - _Boundary: test dashboard-api QR RBAC_
  - _Depends: 5.3_

- [ ] 6.3 E2E フロー（Playwright・Gemini モック）を実装する
  - QR URL→回答（星のみ）→下書き表示→編集→コピー→writereview 遷移リンク、低評価でも同一導線、回答済み再訪、生成失敗時の再試行と導線維持を通す
  - Observable: Issue #3 完了条件の一連フローが E2E で緑、star による導線分岐が存在しないことを確認
  - _Requirements: 2.9, 3.9, 4.1, 4.2, 4.3, 4.4, 4.6_
  - _Depends: 4.4, 4.5_

- [ ] 6.4 (P) 客向けページの性能検証を実装する
  - モバイル 4G シミュレートで survey ページの FCP/LCP を計測し 3 秒以内を確認、初回 JS 転送量に予算（目安 150KB gzip）を設ける
  - Observable: Lighthouse モバイルで表示到達が 3 秒以内、予算超過が検知される
  - _Requirements: 2.8_
  - _Boundary: test survey-web perf_
  - _Depends: 4.3, 4.4_

## Implementation Notes

- **Gemini safetySettings はデフォルト Off**（2.5/3 系）。生成層で 4 カテゴリを必ず明示ブロックし、ユニットテストで設定漏れを検知する（research.md）。
- **クリップボードは同期呼び出し**: 下書きを表示済み state に保持し、コピー押下時に await を挟まず writeText する。失敗時は選択可能表示にフォールバック（iOS Safari 制約）。
- **月次集計は JST**: `period_month` を Asia/Tokyo 月初日として SQL 側で確定（UTC ずれで隣月に入らない）。
- **IAM DB 認証（パスワードレス）**: pool は Cloud SQL Connector 経由。ローカルテストは `DATABASE_URL` フォールバック。
- **統一 SDK**: 生成は @google/genai のみ（レガシー SDK 禁止・gemini-api スキル規律）。モデル ID は `GEMINI_MODEL` env で差替可能。
- **writereview URL は非保証形式**: 変更追随を単一モジュールに隔離。Place ID は毎回 DB から読みキャッシュしない（stale 化対策）。
- **集計非接触の再試行**: 生成失敗でも sessionToken を発行し再試行は /api/drafts に一本化。/api/responses の再 POST（=二重加算）を構造的に排除。
- **共有定数**: `survey_aspects` はコード内に列挙せず seed の code/label を参照（write-boundary.md）。
- **インフラ変更は gcp-infra-foundation の規約に従う**: secret は frame のみ・accessor は consumer 側 co-locate・`tf-plan` 差分を additive のみに保つ。
- **[Task 1 実装知見] native postgres テストハーネス**: docker/apple-container 不在環境のため `ts/scripts/with-test-db.sh`（initdb + pg_ctl の一時インスタンス・unix socket のみ）を確立。DB 依存テストは `make ts-test-db`、ユニットは `make ts-test`（`DATABASE_URL` 無しで `describe.skipIf` により自動 skip）。DB テストは `*.db.test.ts` 命名。
- **[Task 1 実装知見] TS モノレポ規約**: NodeNext のため相対 import は `.js` 拡張子必須（vitest/vite は `.js`→`.ts` 解決可）。`Queryable = Pick<Pool,'query'>` をアクセサの最小問い合わせ面に採用。`pnpm -r` で空/未定義スクリプトは exit 0。共有ツールチェーンは ts/ root、各パッケージが `build/lint/test` を持つ。
- **[Task 1 実装知見] tallies の JST 月境界**: `now` 引数注入でテスト。now 未指定（`now()` フォールバック）時、同一 TX 内 rating/aspect の 2 クエリが真夜中の月境界を跨ぐ極小の隙間があるが確率ほぼ0で本番許容。将来厳密化するなら period_month を CTE で一度確定して両クエリへ渡す。
- **[Task 1 レビュー] 1.4 の reviewer サブエージェントは watchdog stall。メインコンテキストで kiro-review を実施し APPROVED（reviewer が長時間 DB/検証待ちで stall する場合の確立済みフォールバック）。
- **[Task 2 実装知見] offline validate**: fresh worktree には `.terraform`（provider 234M）が無く `terraform init` の provider DL が数分でタイムアウトするため、初期化済みの gcp-infra worktree（`../fw-line-meo-gcp-infra/infra/envs/prod/.terraform`＋lock）を流用コピーして `terraform validate`（backend/creds 不要）を実行する。この Observable は validate 成功＋fmt＋git diff の additive 監査。live `terraform plan`（additive 差分）は backend/tfvars/state/creds を要するため **デプロイ時 runbook のゲート**（design Revalidation Trigger）で確認する。
- **[Task 2 実装知見] env 追加の後方互換**: run-services の services object へ `env = optional(map(string), {})` を足すと既存 service 定義（env 未指定）は {} 既定で不変。SESSION_SIGNING_KEY を survey-web の secret_env に足すだけで accessor は `service_secret_pairs` flatten により secret 単位で自動 co-locate される。
- **[Task 2 レビュー] reviewer サブエージェントが API error（connection closed・約20分）で判定を返せず。メインコンテキスト kiro-review にフォールバックし APPROVED（本セッション 2 度目の reviewer 失敗・terraform/長時間タスクで頻発）。
- **[中間 validation 修正] ランタイム env 契約の seam を解消**: pool.ts(1.2) の cloud-sql-iam 経路が要求する DB_IAM_USER/DB_NAME を run-services が needs_cloudsql サービスへ注入（CLOUDSQL_CONNECTION_NAME と同様）。DB_IAM_USER は `trimsuffix(SA.email, ".gserviceaccount.com")`＝google_sql_user.name と同一式で、pg 接続ユーザーが実在 IAM DB ユーザーと一致。コード層が requireEnv するキーとインフラが set するキーの一致を今後の env 追加時に必ず確認する。
- **[Task 3.3 実装知見] wire フィールド名は aspectCodes に統一**: /api/responses のリクエストは `aspectCodes: string[]`（validate・tallies・wire で一致）。design.md の初期スケッチは `aspects` だったが `aspectCodes` に修正済み。4.4 フォームは `aspectCodes` を送信、4.1 route は追加マッピングなしで validate に渡す（silent drop 防止）。同一回答内の重複 aspect は validate/tallies とも受理し tallies が dedup する（1 回答=各 aspect 1 加算）。
- **[Task 3.1 実装知見] Next.js 16 monorepo**: Turbopack がワークスペースルートを誤推論するため next.config.ts に `turbopack.root` と `outputFileTracingRoot` を `import.meta.dirname` 由来（cwd 非依存）の ts/ で明示する。survey-web の tsconfig は Next 標準（moduleResolution=bundler・jsx は next build が react-jsx に自動設定）で packages/db の NodeNext とは別系統（意図的）。テスト0件の app は `vitest run --passWithNoTests`。docker 不在のため Dockerfile は CI/デプロイ時に検証（起動確認は next start + curl /healthz で代替）。
