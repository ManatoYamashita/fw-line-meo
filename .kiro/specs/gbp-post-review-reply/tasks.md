# Implementation Plan

- [ ] 1. 基盤: DB スキーマ・共有パッケージ・シークレット配線
- [x] 1.1 GBP 連携用の DB スキーマを確立する
  - migration 0005 として gbp_locations（store 一意・account/location リソース名・placeId・投稿可否）と gbp_sessions（owner 一意・flow/stage enum・payload・draft・期限）を追加する
  - ERD と書込境界ドキュメントに 2 テーブル（書込責任 = TypeScript）を追記する
  - make db-migrate / db-smoke / db-test / db-verify-docs がすべて成功する
  - _Requirements: 1.7_

- [x] 1.2 新テーブルと oauth_tokens の DB アクセサを実装する
  - oauth_tokens の upsert/取得/削除（store×provider）、gbp_locations の upsert/取得/削除、gbp_sessions の取得/upsert/クリア（期限判定込み）を既存規約（Queryable 第1引数・Result 型）で実装する
  - store に到達する取得系はすべて owner 所有検証を伴うクエリ形状にする（storeId 単独で他店舗に到達できるアクセサを作らない）
  - アクセサの unit テストが通過し、packages/db の公開 index から export されている
  - _Requirements: 1.7, 2.6_

- [x] 1.3 (P) Gemini 実行核を共有パッケージへ抽出する
  - survey-web から GenAiClient 抽象・safetySettings・リトライ・出力検証の実行核を packages/gemini へ移設し、公開インターフェース形状を維持する
  - @google/genai 依存をパッケージへ移動し、survey-web は import 差し替えのみで移行する
  - Result 型はパッケージ自前 export とする（既存 2 定義の統合はしない）
  - survey-web の既存下書き生成テストが全通過する（回帰ゼロの証明）
  - _Requirements: 3.2, 4.2, 6.2, 6.6_
  - _Boundary: PkgGemini, survey-web_

- [x] 1.4 (P) シークレット枠と実行環境設定を配線する
  - infra に gbp-oauth-client-secret・gbp-token-cipher-key の secret 枠を追加し、line-webhook サービスへ両者と既存 gemini-api-key の secret_env 配線を追加する
  - line-webhook の設定モジュールに GBP_OAUTH_CLIENT_ID / GBP_OAUTH_CLIENT_SECRET / GBP_OAUTH_REDIRECT_URL / GBP_TOKEN_CIPHER_KEY / GEMINI_API_KEY を必須として追加する
  - terraform fmt/validate が通過し、必須 env 欠落時に設定読込が fail-fast する unit テストが通過する
  - _Requirements: 2.1_
  - _Boundary: infra, line-webhook config_

- [ ] 2. コア: トークン保管・GBP クライアント・共通部品
- [ ] 2.1 認可情報の暗号化保管層を実装する
  - AES-256-GCM による暗号化/復号と token_ref v1 形式（iv/authTag/暗号文）を実装する
  - 保存・取得・削除・連携判定と、操作ごとの refresh grant によるアクセストークン供給を実装する
  - invalid_grant を失効（token_invalid）として分類する
  - 暗号化→復号ラウンドトリップと失効分類の unit テストが通過し、平文トークンがログ・エラーに現れない
  - _Depends: 1.2, 1.4_
  - _Requirements: 1.7, 2.1, 2.2, 2.3_

- [ ] 2.2 GBP API クライアントを実装する
  - v4（投稿作成・クチコミ一覧・返信 upsert）と v1（アカウント・ロケーション列挙）の薄い REST クライアントを実装し、name 形式差の変換を単一所有にする
  - 429/5xx の 1 回リトライとエラー分類（token_invalid 透過・permission_denied・rate_limited・upstream_error）を実装する
  - name 変換とエラー分類の unit テストが通過する
  - _Requirements: 3.5, 4.1, 4.4, 5.3_

- [ ] 2.3 (P) GBP 系 postback の符号化を実装する
  - g_ プレフィックスの全 action（連携・店舗選択・状態・解除・投稿・返信・クチコミ選択・承認・再生成・修正・上書き確認・キャンセル）の型と encode/decode を実装する
  - 不正 data の null フォールバックと 300 字上限検証を既存規約どおりに実装する
  - 全 action の encode/decode 対称性 unit テストが通過する
  - _Requirements: 1.3, 3.3, 4.3_
  - _Boundary: GbpPostback_

- [ ] 2.4 (P) 投稿・返信の下書き生成を実装する
  - 投稿素材（店舗名・オーナー入力要点）と返信素材（店舗名・評価・本文・投稿者名）の型とプロンプトを実装し、素材外の事実を注入しない構造にする
  - 低評価（1–2 星）返信の節度あるトーン指示・variation seed・修正指示の反映を実装する
  - 日本語検証・投稿 1500 字・返信 4096 バイトの検証と、超過時の内部再生成（1 回）を実装する
  - 素材外情報の非注入・文字数検証・低評価トーン分岐の unit テストが通過する
  - _Depends: 1.3_
  - _Requirements: 3.2, 3.4, 3.8, 6.1, 6.2, 6.3, 6.4, 6.5_
  - _Boundary: GbpPrompts, PkgGemini_

- [ ] 3. コア: Google 連携（OAuth）フロー
- [ ] 3.1 認可フローの中核を実装する
  - business.manage 単一スコープの認可 URL 生成（offline・consent）と DB 裏付け state の発行・照合・消費を実装する
  - 認可コード交換・アカウント/ロケーション列挙・placeId 突合・不一致時の revoke を実装する
  - 突合成功時に oauth_tokens と gbp_locations が同一トランザクションで永続化され、不一致時は何も残らない
  - _Depends: 2.1, 2.2_
  - _Requirements: 1.2, 1.4, 1.5, 1.6, 1.8_

- [ ] 3.2 OAuth コールバック受け口と結果通知を実装する
  - callback ルートで code/state/error を受け、結果別（連携成立・拒否/中断・state 不一致・権限なし）の最小 HTML と LINE Push 通知を返す
  - Google エンドポイントをモックした 4 経路の integration テストが DB 状態と Push 内容込みで通過する
  - _Requirements: 1.4, 1.5, 1.6_

- [ ] 3.3 連携系の会話フローとディスパッチ基盤を実装する
  - completed 段階からの GBP 委譲分岐（g_ prefix postback / アクティブセッション時の text）を追加し、既存オンボーディング挙動を変えない
  - 連携誘導（Place 確定済み店舗のみ）・複数店舗の選択・連携状態確認・連携解除（revoke + 行削除 + 未連携案内）を実装する
  - セッション期限切れと stale postback の安全側処理を実装する
  - 連携済み/未連携それぞれで g_status が正しい状態と操作ボタンを返す
  - _Depends: 2.3, 3.1_
  - _Requirements: 1.1, 1.2, 1.3, 2.4, 2.5_

- [ ] 4. コア: 投稿・返信の会話フロー
- [ ] 4.1 Google 投稿作成フローを実装する
  - 未連携時の連携誘導分岐、要点入力受付、下書き生成と全文提示、承認/再生成/修正指示の 3 択、修正反映の再提示を実装する
  - 承認は executing への条件付き更新（CAS）で排他し、成功時のみセッションをクリア、失敗時は下書きを温存して再試行導線を返す
  - トークン失効時は処理を実行せず再連携誘導を返す。生成失敗時の案内と再試行を実装する
  - 承認以外の経路から投稿 API が呼ばれないことのモック検証と、二重タップで投稿が高々 1 回になるテストが通過する
  - _Depends: 2.4, 3.3_
  - _Requirements: 2.3, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.9, 6.6_

- [ ] 4.2 クチコミ返信フローを実装する
  - 返信対象のオンデマンド取得と新着順・未返信優先の一覧提示（評価による選別なし・最大 5 件）を実装する
  - 既返信クチコミの上書き確認ステージ、下書き生成→承認→返信 upsert→結果通知を投稿フローと同一の状態機械・CAS ガードで実装する
  - 返信失敗時の下書き温存と再試行導線を実装する
  - モック GBP での一気通貫 integration テスト（未返信選択・既返信上書きの両経路）が通過する
  - _Depends: 4.1_
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 5.3_

- [ ] 5. 統合: 導線解禁
- [ ] 5.1 (P) 日次サマリーへアクションボタンを追加する
  - Flex のローカル型に postback アクションを追加し、footer に「クチコミに返信」「Google 投稿作成」ボタンを無条件で追加する
  - 30KB サイズ検証を含む既存テストが拡張後も通過する
  - _Depends: 2.3_
  - _Requirements: 5.1_
  - _Boundary: FlexBuilder_

- [ ] 5.2 (P) 完了後リッチメニューを 4 領域化する
  - ステータス確認・Google 投稿作成・クチコミ返信・Google 連携/設定の 4 領域と postback data を設定する（messaging-api skill の references を参照）
  - セットアップスクリプトの dry-run で領域座標と postback data が検証できる
  - _Depends: 2.3_
  - _Requirements: 5.4_
  - _Boundary: RichMenu script_

- [ ] 5.3 導線からの分岐を統合検証する
  - サマリーボタン・リッチメニューからの投稿/返信開始が、連携済みはフロー開始・未連携は連携誘導に正しく分岐する integration テストを実装する
  - 未連携店舗の全入口（g_post・g_reply・サマリーボタン）で連携誘導が返る
  - _Depends: 4.2, 5.1, 5.2_
  - _Requirements: 3.9, 4.8, 5.2_

- [ ] 6. 検証
- [ ] 6.1 セキュリティ・排他の検証テストを完成させる
  - 他オーナーの storeId を含む偽造 postback が所有検証で拒否されるテスト、失効トークンで処理が実行されず再連携誘導になるテストを実装する
  - 二重承認 CAS・セッション期限切れ・stale postback の各テストが通過する
  - _Requirements: 2.3, 2.6, 3.6, 4.5_

- [ ] 6.2 全体回帰を検証する
  - make db-migrate/db-test/db-verify-docs、TS 全パッケージの build/test、Go の build/test（無変更の確認）を実行する
  - 全スイートが成功し、survey-web・オンボーディング・配信の既存テストに回帰がない
  - _Requirements: 1.4, 2.2, 3.5, 4.4, 5.1, 5.4_

- [ ]* 6.3 実環境での手動 E2E を実施する
  - 実 Google アカウント・検証用店舗で 連携→投稿→返信→解除 の一連を確認する（CI 外・GBP 利用審査承認後）
  - 連携済み店舗が LINE から Google 投稿・返信を実行できる（Issue #8 完了条件の実証）
  - _Requirements: 1.4, 2.2, 3.5, 4.4_

## Implementation Notes

- 1.1: DB テーブル追加の変更対象は 5 点セット — migration / db/ERD.md / db/write-boundary.md / infra/sql/grants.sql（check_docs が DML GRANT を機械検証）/ db/test/assertions/30_compliance.sql の allowlist（テーブル追加のレビューゲート）。
- 検証はこのマシンでは native postgres: `ts/scripts/with-test-db.sh <cmd>`（migrations 適用 + DATABASE_URL 供給）、check_docs は `MANAGE_CONTAINER=0 PSQL_EXEC="psql $DATABASE_URL"`。worktree では初回に `pnpm install`（ts/ 配下）+ `make ts-build` が必要（ts-test の前提）。
- 1.3: `@fwlm/gemini` の実行核 API は `generateText(client, {model, contents, config?, validateOutput?, backoff?})` + `createDefaultGenAiClient()`。検証関数は `(text) => string | null`（抽出兼検証）。消費者渡し `config.safetySettings` より実行核の既定が優先される。task 2.4 はこの API を消費する。
- 1.2: DB テスト fixture の固定 UUID は **ts/ ワークスペース全体で一意** が必要（with-test-db.sh の一時 DB は 1 実行を全パッケージで共有）。gbp 系は `fc` プレフィックスを使用。テナント隔離クエリ形状の正典は `ts/packages/db/src/oauth-tokens.ts`。oauth_tokens+gbp_locations の同時作成/削除の原子性はトランザクションを張る呼び出し側（TokenStore/flows）の責務。`make ts-build` は `store-detail/next-env.d.ts` を汚すことがある（コミット前に確認・復元）。
