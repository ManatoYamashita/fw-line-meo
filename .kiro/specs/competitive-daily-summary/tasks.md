# Implementation Plan — competitive-daily-summary

- [ ] 1. Foundation: DB スキーマと言語間契約の確立
- [x] 1.1 日次サマリー・配信記録・配信時刻設定のスキーマを追加する
  - migration 0004 として daily_summaries（store×日付一意・status/順位/前日比/新着/競合一覧）・summary_deliveries（store×日付一意・retry_key・結果）・owners の配信時刻（時単位・default 7・0-23 CHECK）を追加のみで定義する
  - PK/FK の型・命名は 0001 の規約に厳密準拠する
  - 一意制約・CHECK・delivery_hour 範囲を検証する assertion SQL を追加する
  - 観察可能な完了: `make db-migrate` と `make db-test` がクリーン環境で成功する
  - _Requirements: 2.3, 2.6, 3.2, 3.9_

- [x] 1.2 書込境界と ERD の文書を新テーブルへ拡張する
  - daily_summaries=Go・summary_deliveries=TypeScript の単一所有を write-boundary.md に明記し、ERD.md に関係を追記する
  - 観察可能な完了: `make db-verify-docs` が新テーブル込みで成功する
  - _Requirements: 2.3, 3.9_

- [ ] 2. Foundation: 3 ランタイムの骨格確立
- [x] 2.1 (P) Go バッチ層の骨格を新設する
  - リポジトリ初の go.mod・エントリポイント・env 設定読取・コンテナイメージ定義を確立する
  - 後続タスクが go.mod/go.sum を書き換えないよう、本タスクで pgx を含む依存一式を確定させる（3.1/3.3 の並列安全の前提）
  - Makefile に Go のビルド/テストターゲットを追加し、確立したコマンドを CLAUDE.md のビルド/テスト節へ追記する
  - 観察可能な完了: Go のビルドと空テストスイートがローカルで成功し、イメージがビルドできる
  - _Requirements: 2.1_
  - _Boundary: Go batch（go/ ツリー全体）_

- [x] 2.2 (P) 配信ジョブアプリの骨格を新設する
  - pnpm workspace に新アプリとして組込み、strict TS・vitest・コンテナイメージ定義を既存アプリの規約で確立する
  - 観察可能な完了: エントリポイントが実行サマリー形式のログ 1 行を出して正常終了し、ビルドとテストが workspace で成功する
  - _Requirements: 3.1_
  - _Boundary: delivery-job_

- [x] 2.3 詳細閲覧アプリの骨格を新設する
  - pnpm workspace に読取専用の Web アプリとして組込み、コンテナイメージ定義を確立する
  - 2.2 と共有 lockfile（pnpm-lock.yaml）を書き換えるため並列不可 — 2.2 完了後に逐次実行する
  - 観察可能な完了: プレースホルダ画面がローカルで起動・表示され、ビルドが workspace で成功する
  - _Requirements: 4.1_
  - _Boundary: store-detail_

- [x] 2.4 (P) 共有 DB パッケージを新テーブルへ拡張する
  - 新テーブルの行型と、配信時刻更新関数（0-23 検証・該当オーナー不在エラー・postback データ契約準拠）を追加する
  - 新規外部依存を追加しない（lockfile を書き換えないことが 2.2/2.3 との並列安全の前提）
  - 観察可能な完了: 更新関数の正常系・境界値・異常系がユニットテストで通る
  - _Requirements: 3.2, 3.3_
  - _Boundary: packages/db_
  - _Depends: 1.1_

- [ ] 3. Core: Go 日次バッチ（競合抽出・取得・計算・記録）
- [x] 3.1 (P) Places API クライアントを実装する
  - Nearby Search（半径・主カテゴリ・距離順・最大件数）と Place Details（自店用/競合用のフィールドマスク 2 種）を唯一の外部取得点として実装する
  - 429/5xx の指数バックオフ、NOT_FOUND・閉業の型付きエラー判別を実装する
  - 観察可能な完了: フェイク HTTP サーバー相手にマスク・バックオフ・エラー分岐がテストで検証される
  - _Requirements: 1.1, 2.1, 2.2, 2.7_
  - _Boundary: places/client_

- [x] 3.2 (P) 順位・前日比・新着差分の計算を純関数で実装する
  - 星評価降順・同率クチコミ総数降順の順位付け、前日なし時の差分省略、新着件数（総数差分が正）とレビュー抜粋（publishTime 差分・帰属情報付き）を実装する
  - 観察可能な完了: 同率決着・自店単独・前日なし・抜粋取りこぼしの各ケースがユニットテストで通る
  - _Requirements: 1.3, 2.4, 3.5, 3.7_
  - _Boundary: summary/compute_

- [x] 3.3 (P) Go リポジトリ層を実装する
  - 対象店舗・競合の読取、競合の固定と無効化（active=false・履歴保持）、スナップショットとサマリーの同日再実行安全な書込、30日超のパージを実装する
  - 観察可能な完了: 実 postgres 相手に同日 2 回書込で行が重複せず、パージが 30 日境界で正しく削除するテストが通る
  - _Requirements: 1.5, 2.3, 2.6_
  - _Boundary: repo_
  - _Depends: 1.1_

- [x] 3.4 競合の自動抽出・固定ロジックを実装する
  - 検索結果から自店を除外して近い順上位 5 店を固定し、5 店未満はある分のみ、0 店は競合なし状態として扱う
  - 観察可能な完了: 6件ヒット→5件固定・自店除外・0件時の状態が places クライアントのフェイクとテスト DB で検証される
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 3.5 日次バッチのオーケストレーションを実装する
  - 確定済み店舗の抽出（競合未固定店舗はまず抽出）、店舗単位ワーカープールとエラー隔離、取得不能競合の無効化、サマリー確定、パージ、起動ジッター、固定フィールドの実行サマリーログを統合する
  - 1 店舗あたり約 6 コール（自店 1＋競合最大 5）に収まることをテストで数え上げる
  - 観察可能な完了: フェイク Places＋実 postgres の一気通貫実行で snapshots/summaries が生成され、再実行しても行数が増えない
  - _Requirements: 1.5, 2.1, 2.5, 2.6, 2.7, 5.1, 5.2_

- [x] 3.6 Cloud SQL IAM ダイヤラを配線する
  - **背景（task 3.5 レビューで発見）**: `config.go`(2.1)→`repo/db.go`(3.3)→`cmd/daily-batch/main.go`(3.5) の3タスクにわたり Cloud SQL IAM 接続の実配線が「次のタスクへ」と先送りされ続けた結果、どのタスクにも属さない未実装のまま残った。実 GCP の `infra/modules/batch-job` は `CLOUDSQL_CONNECTION_NAME` を配線しており `DATABASE_URL` を渡さないため、現状の Go バイナリは `DBModeCloudSQLIAM` で起動できず即エラー終了する。このままでは task 6.3（daily-batch Job の Go 実体化）が実 GCP で必ず失敗する。
  - `go/internal/repo/db.go` に Cloud SQL Go Connector（`cloud.google.com/go/cloudsqlconn`、公式ライブラリ）を用いた IAM 認証ダイヤラを実装し、`DBModeCloudSQLIAM` で `pgxpool.Pool` を確立できるようにする（`config.go` が既に読み取っている `CLOUDSQL_CONNECTION_NAME`/`DB_IAM_USER`/`DB_NAME` を使用）
  - `go/cmd/daily-batch/main.go` の `buildPool` から両モード（DATABASE_URL・Cloud SQL IAM）を実際に配線する
  - 観察可能な完了: `DBModeCloudSQLIAM` 指定時にダイヤラが呼ばれpgxpool確立を試みることをユニットテストで検証する（実 Cloud SQL への実接続は統合/実環境検証（7.1/7.2）の範囲。ここでは配線の正しさ＝関数呼び出しとエラーハンドリングを検証）
  - _Requirements: 2.1_
  - _Boundary: repo/db, cmd/daily-batch_

- [ ] 4. (P) Core: TS 配信ジョブ（Flex 組立・Push・記録）
- [x] 4.1 (P) Flex Message 組立を実装する
  - 結論ファースト 4 段構成（順位＋前日比矢印／星・総数／新着（件数＋抜粋 or「新着なし」）／競合一覧＋星差）、「詳細を見る」ボタン、Google 帰属表示、日本語文言、altText 400 字以内、30KB 検証を実装する
  - 前日なし・競合なし・新着なしの表示分岐を含める
  - 観察可能な完了: 各分岐の出力 JSON がスナップショットテストで検証され、サイズ検証が超過を検出する
  - _Requirements: 1.3, 3.4, 3.5, 3.6, 3.7, 3.11_
  - _Boundary: delivery-job/flex_

- [x] 4.2 (P) LINE Push クライアントを実装する
  - Stateless チャネルアクセストークンの取得、Retry-Key 常時付与、再送規則（500/タイムアウトのみ同一キー再送・409 は成功扱い・400 は失敗記録・429 クォータは即時終了シグナル）、Request-Id の取得を実装する
  - 観察可能な完了: LINE モック相手に各ステータスの分岐と再送回数がテストで検証される
  - _Requirements: 3.1, 3.8, 3.9_
  - _Boundary: delivery-job/line_

- [x] 4.3 配信対象抽出と配信記録を実装する
  - 現在時（JST）の配信時刻・当日サマリー有・未配信の対象抽出、retry_key 付き行の事前確保（一意制約衝突は処理済みスキップ）、結果とエラー分類（delivered/failed/skipped_no_summary/quota_exceeded）の記録を実装する
  - 観察可能な完了: テスト DB で同一対象への 2 回実行が 1 通分の記録に収束し、サマリー欠損対象が skip として記録される
  - _Requirements: 3.1, 3.2, 3.8, 3.9, 3.10_

- [x] 4.4 配信ジョブのエントリを統合する
  - 対象抽出→組立→Push→記録のループ、オーナー単位のエラー隔離、固定フィールドの実行サマリーログを統合する
  - 観察可能な完了: LINE モックとの一気通貫実行で正常・409・500 再送・クォータ・skip の記録が期待どおり残る
  - _Requirements: 3.1, 3.8, 5.1, 5.2_

- [ ] 5. (P) Core: 詳細閲覧（LIFF・読取専用）
- [x] 5.1 (P) LIFF 認可ライブラリを実装する
  - ID トークンのサーバーサイド検証→sub→オーナー・自店解決までを単体ライブラリとして実装し、URL/ボディ由来の店舗指定を受け付けない
  - 観察可能な完了: 検証モック相手に有効トークン→自店解決・無効トークン→検証エラーがユニットテストで通る
  - _Requirements: 4.1, 4.2_
  - _Boundary: store-detail/liff-auth_

- [x] 5.2 詳細データの読取 API を実装する
  - 認可ライブラリを組み込んだ読取専用 API として、当日サマリー・自店/競合の指標・直近 30 日の推移を返し、競合 0 店では自店のみ返す
  - 無効トークン→401・店舗未特定→404 のルート挙動を含めて実装する（ルートの所有は本タスク）
  - **task 5.1 で発見**: `resolveOwnerStore`（liff-auth）は confirmed 店舗が複数（1オーナー:N店舗）の場合 `AMBIGUOUS_STORE` を返す。design.md の API Contract 更新に従い、これも 404 として扱う（店舗未特定と同じ扱い・詳細は design.md「既知の制約」参照。誤った店舗の情報を返さないことを優先する）
  - 観察可能な完了: テスト DB で 30 日窓・競合なし分岐・401/404（店舗未特定・AMBIGUOUS_STORE 双方）のレスポンスが検証される
  - _Requirements: 4.1, 4.2, 4.3_
  - _Boundary: store-detail/data_
  - _Depends: 5.1_

- [x] 5.3 詳細画面 UI を実装する
  - 自店・競合・推移の日本語表示、Google 帰属表示、書込操作を一切持たない閲覧専用画面を実装する
  - 観察可能な完了: モックデータでの画面表示が確認でき、書込系のフォーム・API 呼出が存在しない
  - _Depends: 5.1, 5.2_
  - _Requirements: 4.1, 4.2, 4.4_

- [ ] 6. Integration: インフラ配線と実体化
- [x] 6.1 配信ジョブのインフラモジュールを新設する
  - 既存バッチジョブモジュールのパターンで、TS 配信 Job・毎時 Scheduler（JST）・専用 SA・LINE チャネルトークンの accessor・IAM DB ユーザーを co-locate し、root へ配線する
  - grants.sql に新テーブルへの GRANT（Go バッチ user・配信 user・閲覧 user）を追記する
  - 観察可能な完了: terraform validate/plan が成功し plan に Job・Scheduler・accessor が現れる。かつローカル postgres で grants.sql を適用し、Go バッチ user が daily_summaries に INSERT 可・配信 user が summary_deliveries に INSERT 可であることを確認する
  - _Requirements: 3.1, 5.1_

- [x] 6.2 詳細閲覧サービスのインフラを追加する
  - run-services へ読取専用サービスを追加し root へ配線する（LIFF チャネル作成は runbook 手順として記録・実施は LINE 基盤と調整）
  - 観察可能な完了: terraform validate/plan が成功し、plan にサービスと SA が現れる
  - _Requirements: 4.1_
  - _Depends: 6.1_

- [x] 6.3 各イメージの push と既設ジョブの実体化手順を確立する
  - Go バッチ・配信ジョブ・詳細閲覧の各イメージを Artifact Registry へ push する手順（スクリプト or CI）を確立し、既設 daily-batch Job（placeholder・ignore_changes[image]）を Go 実体イメージへ更新する apply 外の更新手順を runbook 化して実行する
  - **task 3.6 レビューで発見**: `infra/modules/batch-job/main.tf` は daily-batch Job に `CLOUDSQL_CONNECTION_NAME`・`PLACES_API_KEY` のみを配線しており、Go 側 `config.Load()` が Cloud SQL IAM モードで必須とする `DB_IAM_USER`・`DB_NAME` が未配線。このままでは Go バイナリは env 読取の時点で起動失敗する。`DB_IAM_USER` は `google_sql_user.job_iam.name`（`trimsuffix(google_service_account.job.email, ".gserviceaccount.com")`）から、`DB_NAME` は database モジュールの DB 名から導出し、Job テンプレートの env に追加すること
  - 観察可能な完了: 3 イメージが registry に存在し、daily-batch Job の実行が Go 実体で成功する（実行サマリーログが出る）。Job の env に `DB_IAM_USER`・`DB_NAME`・`CLOUDSQL_CONNECTION_NAME` が揃っていることを terraform plan で確認する
  - _Depends: 3.5, 3.6, 4.4, 5.3, 6.1, 6.2_
  - _Requirements: 2.1, 3.1_

- [ ] 7. Validation: 横断検証
- [x] 7.1 言語間契約の整合検証を実装する
  - Go バッチが生成した daily_summaries を TS 配信ジョブが読み取って配信するクロスランタイム統合テスト（実 postgres・フェイク Places・LINE モック）を通す
  - 競合リスト再抽出・調整手段およびオプトアウト手段が存在しないこと（能力の不在）を確認項目として記録する
  - 観察可能な完了: バッチ→配信の一気通貫テストが CI 相当環境で成功し、`make db-verify-docs` を含む全 make ターゲットが通る
  - _Requirements: 1.4, 2.6, 3.9, 3.10, 5.2_

- [ ] 7.2 実環境スモークで完了条件を証明する
  - 本タスクは「Issue #4 完了条件（Cloud Scheduler 日次起動→対象店舗へ Flex 配信）の証明」であり、デプロイ作業除外ルールの意図的例外として実施する
  - 実 GCP にシード店舗 1 件を投入し、日次バッチ→サマリー生成→配信ジョブ→実 LINE 受信を確認する
  - 「詳細を見る」→LIFF 起動の確認は LINE Login チャネル整備（LINE 基盤と共同・同一プロバイダー必須）後に実施し、未整備の場合はその旨を記録して API 直接検証で代替する
  - 観察可能な完了: 実 LINE で Flex Message の受信が確認され、summary_deliveries に delivered 行が残る
  - _Depends: 6.3, 7.1_
  - _Requirements: 3.1, 4.1, 5.1_

## Implementation Notes
- この開発環境には apple/container・docker・podman が無い。`make db-migrate`/`make db-test` を直接使わず、native Homebrew postgres 16.14 を initdb/pg_ctl で手動起動して検証する（scratchpad の長いパスは AF_UNIX ソケットパス上限103バイトを超えるため、短い `/tmp/pgrev_$$` 等をソケットディレクトリに使うこと）。
- `db/test/assertions/30_compliance.sql` はテーブル allowlist を持つレビューゲートで、新テーブル追加時に allowlist 追記が意図的に必要（ファイル自身のコメントに明記）。新テーブルを追加するタスクは対応する 30_compliance.sql の追記も自タスクの境界内として扱ってよい。
- go/go.mod で `go get` のみで pgx v5 を事前宣言しても、後続タスクで誰かが `go mod tidy` を実行すると未 import のため自動的に削除される（`go mod tidy -diff` で再現確認済み）。task 3.1/3.3 の実装者は pgx を実際に import した直後に `go mod tidy` を実行し、go.sum の整合を取ること。事前宣言は go.sum のバージョンピン留めとしては機能するが、go.mod の require 行自体の永続化は保証されない。
- `summary/compute.Rank` は rank_prev を算出しない（design.md の Service Interface に rank_prev 専用関数が無いため）。task 3.3/3.5 の実装者は前日の active 競合集合（self含む）を用意し、`Rank` を再適用して rank_prev を得ること。
- go.mod の `go` ディレクティブは `go mod tidy` により pgx v5.10.0 の要求で 1.24→1.25.0 に自動昇格した（design.md「Go 1.24+」の範囲内）。CI/デプロイイメージが 1.24.x 固定の場合は task 6.x で toolchain バージョンの確認が必要。
- `stores.category_code` → Places `primaryType` のマッピングは既存コードに無かったため task 3.4 で新設した（`go/internal/competitor/extract.go` の `categoryToPrimaryType`）。seeded 全11カテゴリを網羅、Table A に対応語が無い一部（izakaya/washoku/curry→japanese_restaurant, yakiniku→barbecue_restaurant）は近似。より正確なマッピングが必要になった場合はオンボーディング時に実 primaryType を取得する方式への変更を検討。
- rank_prev の比較集合は「今日成功取得した競合のうち、昨日分のスナップショットが存在するもの」の交差を採用（同日churnした競合は今日・昨日どちらの比較集合からも除外）。design.md に厳密な規定が無いための判断。同日churn時のrank_prevテストは未整備（follow-up）。
- タスク3.6を追加した理由: Cloud SQL IAM 接続の実配線が config.go(2.1)→repo/db.go(3.3)→main.go(3.5) と3タスクにわたり先送りされ、誰も実装しないまま残っていたため。実GCPのbatch-jobモジュールはCLOUDSQL_CONNECTION_NAMEのみ配線しており、このままではtask 6.3が実GCPで起動失敗する。
- task 3.6 の初回レビューは REJECTED（テストが旧stub文字列の不在のみを確認しfalse green リスクあり）。cloudsqlconn由来の型エラー（errtype.RefreshError等）をerrors.Asで積極確認するよう修復し2回目レビューでAPPROVED。実装（db.go/main.go）自体は初回から正しく、テストのみの問題だった。
- task 3.6 レビューでさらに発見: `infra/modules/batch-job/main.tf` に `DB_IAM_USER`・`DB_NAME` env が未配線（`CLOUDSQL_CONNECTION_NAME`・`PLACES_API_KEY` のみ）。task 6.3 のスコープに追記済み。
- **task 5.1 で発見（設計レベルの既知の制約）**: `four-tier-data-model` の1オーナー:N店舗仕様と、本 spec の LIFF URL 契約（storeId 非包含・IDOR対策）が緊張関係にある。複数店舗オーナーは `AMBIGUOUS_STORE` により詳細画面を解決できない（安全側フェイル）。design.md の Open Questions / Risks・API Contract に既知の制約として明記し、task 5.2 は AMBIGUOUS_STORE を 404 として扱う。第2フェーズで per-store 署名付きトークン方式の再設計が必要。
- **task 6.3: 実 GCP デプロイで発見・修正した実ビルド不良4件**（ローカル検証・native postgresテストでは検出できず、Cloud Build での実ビルドで初めて顕在化）:
  1. `go/Dockerfile` の `golang:1.24-alpine` が `go.mod`（1.25.8・task 3.3/3.6 の pgx/cloudsqlconn 依存で自動昇格）と不整合 → `golang:1.25-alpine` に修正。
  2. `ts/package.json` に `packageManager` 固定・`pnpm.onlyBuiltDependencies` 未設定 → Docker の `corepack enable` が最新pnpm（11.x）を取得し `[ERR_PNPM_IGNORED_BUILDS]` で `pnpm install --frozen-lockfile` が失敗。`packageManager: "pnpm@10.33.2"`（CI が既に固定していたバージョンと同一）と `onlyBuiltDependencies: ["esbuild","msw"]` を追加。
  3. `ts/apps/delivery-job/Dockerfile`・`ts/apps/store-detail/Dockerfile` の `build` ステージで `COPY --from=deps /repo/node_modules ./node_modules` がルート node_modules のみコピーし、pnpm がパッケージ単位で作る `packages/db/node_modules`（`pg`/`@google-cloud/cloud-sql-connector` 等の非hoistシンボリックリンク）が欠落 → `COPY --from=deps /repo ./` に変更。
  4. さらに `delivery-job` の `runner` ステージで `/app` へ再配置した結果、pnpm workspace の相対シンボリックリンク（`apps/delivery-job/node_modules/@fwlm/db -> ../../../../packages/db`）の深さが崩れ実行時 `ERR_MODULE_NOT_FOUND` （tscのビルド時チェックでは検出不可・実行して初めて判明）→ runner ステージも `WORKDIR /repo` を維持し同一相対階層でコピーするよう修正（`CMD` パスも変更）。store-detail は Next.js standalone 出力（実体ファイルに解決済み）のため同種の修正は不要と確認。
  - また `infra/modules/project-services` に `cloudbuild.googleapis.com` を追加（ローカル docker 不在のため Cloud Build 必須）、`ts/.gcloudignore` を新設（node_modules 除外漏れで 659MB アップロードが発生していた）。
- **task 6.3: 実インフラの運用上の欠落2件を発見・修正**（コードの変更ではなく実 Cloud SQL への直接対応）: (1) 実 `fwlm-pg` に migration 0004 が未適用だった → Cloud SQL Auth Proxy 経由で適用。(2) `postgres` 管理者パスワードが `db-admin-password` シークレットの値と不一致（gcp-infra-foundation 時からの out-of-band drift）→ パスワードをリセットしシークレットへ新バージョンとして同期。`infra/sql/grants.sql` は `-v project=gen-fw-line-meo` で明示上書きして適用（デフォルトは `fwlm` 固定のプレースホルダ）。
- **task 6.3 レビューで発見（follow-up・未対応）**: `daily-batch-xpfrj`（2026-07-11 21:00 UTC・placeholder イメージ時代の Scheduler 定時実行）が 1800秒タイムアウトで失敗していた。これは本タスクの実イメージ反映前の既存事象で対応不要だが、次回 06:00 JST の Scheduler 定時実行（v1 の Go 実体イメージに対して）が手動実行と同様にクリーンに完了するか、実運用開始後に確認すること。
- **task 7.1 で発見・修正した実スキーマ契約バグ**: `ts/packages/db/src/types.ts` の `DailySummaryCompetitor.rating`/`starDiff` が `string | null` と誤って宣言されていた。同ファイルの慣例（トップレベルの numeric 列は pg ドライバが精度保持のため文字列で返す）を jsonb 内のネスト値にも誤って適用したもの。実際は Go 側（`repo.SummaryCompetitor` は `float64`）が JSON数値としてマーシャルするため、pg の jsonb パーサは Node 側で `number` を返す。task 4.1/4.4 のテストがそれぞれ独自に誤った文字列型フィクスチャ（`rating: '4.5'`）を発明していたため今まで検出されず、Go の実オーケストレーションと TS の実オーケストレーションを同一 postgres 上で直結するクロスランタイムテスト（本タスクの核心）で初めて型不一致が表面化した。`number` へ修正し `flex.ts` の表示整形（`.toFixed(1)`）を追加。既存 Flex スナップショットは無変更（表示自体はたまたま正しかった）。
- **task 7.1 で発見・修正した bash 実行時バグ**: 全角括弧に隣接する未ブレースの `$VAR` が `set -u` 下で変数名を破損させ `unbound variable` を起こす（例: `"$x（text）"`）。新設した `db/test/check_no_optional_capabilities.sh` の R1.4/R3.10 違反検知時の診断メッセージ内に2箇所存在し、まさに検知すべき違反が発生した瞬間にスクリプト自身がクラッシュして診断が失われるという皮肉な不良だった（レビュー1回目で発見、`${VAR}` 化で修正・2回目レビューで独立に失敗パス再現確認済み）。
- **task 6.1 で発見（非ブロッキング follow-up 2件）**: (1) `line-channel-access-token` の accessor は design.md の指示通り delivery-job SA へ付与したが、実装（line.ts）は Stateless client_credentials 発行方式のためこの secret を消費しない未使用grant。害はないが design.md の記述と実装の乖離として残っている。(2) `infra/README.md` の runbook 例（gcp-infra-foundation task 4.4 由来・本specより前）が migration 0004 を含んでおらず、記載通りに実行すると本specのgrants.sqlが失敗する。両者とも6.1のスコープ外（前者はdesign.md追記、後者はinfra/README.md修正）。task 6.2 実施時に合わせて対応するのが効率的。
