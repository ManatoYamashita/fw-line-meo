# Implementation Plan: line-crosspost

PR の単位ごとに、マージしてよい条件を書く。**どの PR も既定 OFF のまま本番の挙動を変えない**。本番の設定変更・Terraform の apply・機能の有効化・実店舗への投稿は、運営の明示的な承認があるまで行わない。

## PR 1: spec（文書のみ）

- [x] 1.1 requirements.md・design.md・research.md・tasks.md を作る
  - 現状調査（main との差分・既存コードの問題点）と、画面の方式・画像を AI に渡さない判断を research.md に残す
  - _Requirements: 全体_
- [x] 1.2 `requirements.md`（プロジェクト）§8.2 に「LINE 起点の一括発信（候補）」を追記する
  - マージ条件: 文書の整合（`check-compliance-wording.sh` を含む ts-ci の文書ガードが緑）

## PR 2: データ（migration・アクセサ）

- [x] 2.1 `0019_line_crosspost.sql`（3 表・4 enum・部分一意索引・CHECK）
  - _Requirements: 5.6, 5.7, 6.2, 6.4, 8.1, 8.3, 8.4_
- [x] 2.2 `db/write-boundary.md`・`db/ERD.md`（列一覧を含む）・`infra/sql/grants.sql`（line-webhook の SA だけに DML）
  - _Requirements: 8.1_
- [x] 2.3 `@fwlm/db` の `crosspost.ts`（所有の検証を SQL に含める・CAS・期限切れ・保存期間の削除）
  - _Requirements: 1.5, 2.8, 2.9, 4.5, 5.5, 5.6, 5.7, 6.1, 6.4, 6.6, 6.8, 6.9, 8.1, 8.4_
- [x] 2.4 DB の試験（アクセサの integration・assertions・書き込み権限）
  - マージ条件: `run-db-test-suites.sh`（smoke・assertions・docs 整合）と `@fwlm/db` の試験が緑。本番への migration の適用は運営の承認の後

## PR 3: 会話・生成・発信先の共通処理（既定 OFF）

- [x] 3.1 設定（`CROSSPOST_PILOT_STORE_IDS`・`CROSSPOST_MEDIA_*`・`CROSSPOST_GOOGLE_ENABLED`）。全部あるか全部無いか。無ければ経路を組み立てない
  - _Requirements: 10.1, 10.2, 10.3, 10.4_
- [x] 3.2 postback の符号化と復号（`a=x_*`）
  - _Requirements: 5.4, 8.1_
- [x] 3.3 生成（Instagram・Google）と事実の照合・受理条件
  - _Requirements: 3.1〜3.9, 4.3, 4.4_
- [x] 3.4 画像の検証と正規化（sharp・メタデータの除去）・`MediaStore` の境界・LINE の写真の取得
  - _Requirements: 2.1, 2.4, 2.5, 2.6, 2.7, 8.2_
- [x] 3.5 発信先アダプタの契約・publisher（承認・実行権の獲得・結果の分類・再試行・確認・期限切れの in_progress）
  - _Requirements: 5.4〜5.7, 6.1〜6.10, 9.1〜9.5_
- [x] 3.6 Instagram アダプタ（v1: not_ready）
  - _Requirements: 9.4_
- [x] 3.7 Flex とテキストの組み立て（確認のカルーセル・投稿先・最終確認・結果・状況）
  - _Requirements: 4.1, 4.2, 5.1〜5.3, 7.1, 7.3, 7.4, 8.7_
- [x] 3.8 会話の状態機械と router・dispatch への配線（OFF のとき何も引き受けない）
  - _Requirements: 1.1〜1.5, 2.1〜2.10, 4.6, 7.2_
  - マージ条件: line-webhook の typecheck・lint・unit・DB integration が緑。既存の試験（GBP・レポート・オンボーディング）に変更が要らないこと。本機能 OFF の既存の E2E が緑

## PR 4: Google の発信先アダプタ（既定 OFF）

- [x] 4.1 `gbp/client.ts` に `publishLocalPost`（写真の `media[]`・時間制限・送信後の失敗を「結果不明」に分類）を足す。既存の `createLocalPost` は変えない
  - _Requirements: 6.3, 6.10, 9.1_
- [x] 4.2 `adapters/google.ts`（availability・写真の条件・分類表）
  - _Requirements: 5.2, 6.2, 6.3, 6.7_
  - マージ条件: 分類表の全行の試験が緑。**GBP API の実疎通は未実施**（#146 の承認待ち）であることを PR に明記

## 残る作業（外部の準備が要る・本 spec の次の PR）

- [ ] 5.1 入口: リッチメニューの区画（#354 と合わせて区画名を決める）。パイロットと実演の期間中は差し替えない
- [ ] 6.1 写真の置き場の本番実装（GCS の非公開バケット・寿命 7 日・Terraform・line-webhook の SA の権限）
- [ ] 6.2 取得用 URL の方式の決定と実装（署名付き URL か、line-webhook の短命トークンの配信経路か）。**Meta・Google が受け付けるかを実測してから決める**
- [ ] 7.1 Meta のログイン方式の決定（前提資料 §7.4・§7.5 の技術検証）→ `oauth_provider` の汎用化・Meta の OAuth・認可の解除とデータ削除のコールバック（別 spec）
- [ ] 7.2 Instagram アダプタの実装（コンテナ → 状態 → 公開・checkpoint の再利用・照合）
- [ ] 7.3 Google の照合（`localPosts.list` による結果不明の自動照合）。GBP API の承認後に実測してから
- [ ] 8.1 実機確認（iOS・Android: 写真の送信・まとめて送信・クリップボード・Flex の表示・読み上げ）
- [ ] 8.2 監視（結果不明・失敗の件数のログベース指標とアラート）
- [ ] 8.3 既存の `g_post` の「結果不明」の扱い（research.md §5-1）
