# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

**fw-line-meo** = 飲食店向け LINE 一元管理アプリ（LINE Restaurant Manager）。
ITに不慣れな飲食店オーナーが **LINE だけで** 市場ポジション把握・Google クチコミ獲得促進・（将来）GBP 投稿を完結できるサービス。

現状は **要件定義・提案フェーズ完了直後／実装コード未着手** のリポジトリ。一次情報源は以下:
- `requirements.md` — 要件定義書 v1.0（全設計判断の根拠。章番号で参照される）
- `docs/proposal.md` — クライアント合意用の提案書（機能A/B/C = 機能3/1/2 の対応に注意）
- `README.md` — 技術スタック要約

## ビルド／テスト

アプリ層（TS/Go）の `package.json`・`go.mod` はまだ存在しない（`.gitignore` は Node/TS + Go + GCP/Terraform を想定済み）。

最初に確立した成果物は **DB スキーマ**（`four-tier-data-model` spec, `db/`）。コマンド（ランタイムは apple/container 既定・`CONTAINER_CMD` で差替可。ローカルに Docker/apple/container が無い場合は native postgres + `db/test/run.sh` 相当で代替検証可）:
- `make db-migrate` — 一時 postgres へ `db/migrations/*.sql` をクリーン適用（BUILD）
- `make db-smoke` — 適用後 `db/test/smoke/*.sql` を実行（観察可能完了の証明）
- `make db-test` — 適用後 `db/test/assertions/*.sql` を実行（網羅スイート）
- `make db-verify-docs` — ERD/write-boundary と実スキーマの整合・書込境界単一所有を機械検証

アプリ層のビルド・lint・テストは各層導入時に確立し追記すること。**未確立のコマンドを推測で書かない。**

## アーキテクチャの大方針（実装前に必読）

### 二刀流（TypeScript + Go）と書き込み境界
- **TypeScript = リアルタイム応答層**: LINE Webhook・リッチメニュー・Flex Message 組立・客向けアンケート Web・Gemini オーケストレーション（LINE 公式 SDK が充実、客向け Web と型共有）。
- **Go = 日次バッチ層**: 全店舗 × 競合5店の Places API を毎朝 goroutine で並行取得（低コスト・安定）。
- **致命的な運用規律**: 同一 Cloud SQL を 2 言語から触るため、**どの言語がどのテーブルを書くか（書き込み境界）を厳格に定義する**。共有定数（カテゴリ定義等）の同期も二重化リスク。新テーブル追加時は必ず書込責任言語を明記すること。

### 4階層データモデル（初期から確定構造・後からの階層挿入は不可）
```
運営（我々） → 代理店(Agency) → 飲食店オーナー(Owner) → 来店客(Customer)※匿名
```
- 運営と代理店は **同一 Web ダッシュボードにログインし RBAC でロール分離**（運営=全店閲覧、代理店=担当店のみ）。
- このモデルの確定が最初の基盤タスク（Kiro spec: `four-tier-data-model`）。スキーマ変更時はこの 4 階層を壊さないこと。

### GCP 単一帝国
Cloud Run（Webhook/客向けWeb/ダッシュボードAPI・ゼロスケール）／ Cloud Scheduler（日次バッチ起動）／ Cloud SQL(PostgreSQL)／ Identity Platform=Firebase Auth（ダッシュボードの Google ログイン、パスワード自前管理しない）／ Gemini API（生成）。

### マルチテナント
運営保有の **単一 LINE 公式アカウント** に全オーナーが友だち登録。客向け機能（機能3）は LINE を経由しない。

## 侵してはならない制約（コンプライアンス・プライバシー）

実装時にこれらに反するコードを書いてはならない:
- **レビューゲーティング禁止**: 高評価のみ Google へ誘導し低評価を隠す導線は Google 規約違反。低評価客も同一導線で Google 投稿へ誘導する。
- **Google クチコミは客本人が投稿**: API 代理投稿は規約違反。システムの責務は「下書き生成 → 客がコピペして貼る」まで。
- **スクレイピング禁止**: 競合データは Google Places API のみ（従量課金を許容）。
- **客の個人情報を一切取得しない**: アンケート回答は **Place 単位の匿名集計のみ** 保持。個別回答の永続保存は行わない。
- **AI ガードレール**: 嘘・誇張・誹謗中傷を生成しない。客本人が選んだ事実のみ反映。客ごとに語彙を変えスパム判定を回避。
- **GBP API（OAuth）は第2フェーズ**: 審査リスクが高く MVP の生死を賭けない。MVP に OAuth 連携を持ち込まない。

## MVP スコープ境界

含む: 機能3（口コミ QR・アンケート・AI 下書き）／機能1（競合日次サマリー＝閲覧まで）／代理店ダッシュボード（登録＋一覧の最小形）／段階的オンボーディング（店舗特定まで）／4階層データモデル。
含まない（第2フェーズ）: Google OAuth 基盤／機能2（GBP 投稿）／機能1-b（クチコミ返信）／競合範囲のオーナー設定／詳細分析画面／収益化。

## LINE Messaging API 実装時

`.claude/skills/messaging-api/` スキルを使う。**LINE API を記憶で答えない**（頻繁に更新される）。Webhook 署名検証・Flex Message・リッチメニュー実装時は同スキルの references を必ず参照。

## 開発ワークフロー（Kiro Spec-Driven）

`.kiro/` で Kiro 流の仕様駆動開発を行う。Requirements → Design → Tasks → Implementation の各フェーズで人間レビューを挟む（`-y` は意図的 fast-track のみ）。
- Specs: `.kiro/specs/`（現在 `four-tier-data-model` が initialized）
- Steering: `.kiro/steering/`（プロジェクト全体の永続メモリ。`/kiro-steering`・`/kiro-steering-custom` で生成）
- 進捗確認: `/kiro-spec-status {feature}`（いつでも可）
- 全 Markdown 成果物は `spec.json.language`（= `ja`）で記述する。

### コマンド体系（cc-sdd v3.0.2）
- 探索: `/kiro-discovery "idea"` — 単一/複数 spec の判断、`brief.md`＋`roadmap.md` を生成。
- 仕様（単一）: `/kiro-spec-quick {feature} [--auto]`、または手順分割で `/kiro-spec-init` → `/kiro-spec-requirements` → `/kiro-validate-gap`（既存コード統合時のみ）→ `/kiro-spec-design [-y]` → `/kiro-validate-design` → `/kiro-spec-tasks [-y]`。
- 仕様（複数）: `/kiro-spec-batch` — `roadmap.md` から依存ウェーブ単位で並列生成。
- 実装: `/kiro-impl {feature} [tasks]` — タスク番号なしは自律モード（タスク毎 subagent＋独立レビュー＋最終 validation）、番号ありは手動モード。完了前に reviewer ゲートを通す。`/kiro-validate-impl {feature}` で再検証。
- レビュー/検証規律: `kiro-review`（タスク局所の批判的レビュー）・`kiro-debug`（根本原因優先デバッグ）・`kiro-verify-completion`（完了・成功主張前の新証拠ゲート）。
