# Project Structure

## Organization Philosophy

**言語境界 = 責務境界。** リポジトリは「リアルタイム応答層（TypeScript）」と「日次バッチ層（Go）」という2つの実行責務で分割する。両者は同一 Cloud SQL を共有するが、**書き込み境界**（どの言語がどのテーブルを書くか）で結合を規律する。

現状は **要件定義・提案フェーズ完了直後／実装コード未着手**。本ファイルは確立済みの設計原則を記録し、ディレクトリの実体はコード導入時に確定する（その際に追記する）。

## Directory Patterns（現状の確定領域）

### ドキュメント（一次情報源）
**Location**: リポジトリ直下 / `docs/`
**Purpose**: 全設計判断の根拠。`requirements.md`（要件定義 v1.0・章番号で参照）、`docs/proposal.md`（クライアント合意用・機能A/B/C = 機能3/1/2）、`README.md`（技術スタック要約）。

### Kiro 仕様駆動開発
**Location**: `.kiro/`
**Purpose**: `specs/`（機能単位の仕様。現在 `four-tier-data-model` が initialized）、`steering/`（プロジェクト永続メモリ＝本ファイル群）、`settings/`（テンプレート・メタデータ）。

### エージェント・スキル
**Location**: `.claude/skills/`
**Purpose**: `messaging-api`（LINE API 参照規律）、`kiro-*`（仕様駆動ワークフロー）。

## 実装時の組織原則（コード導入時の指針）

- **言語ごとにトップレベルを分離**: TypeScript 層と Go 層は明確に分けたツリーで管理し、相互の実装詳細を混在させない。
- **書き込み境界を構造で表現**: テーブルごとに「書込責任言語」を1つ定め、スキーマ定義・マイグレーションの所在を責任言語側に集約する。読み取りは両言語可、書き込みは責任言語のみ。
- **4階層データモデルを壊さない**: `運営 → 代理店 → オーナー → 来店客` の階層を前提にスキーマ・モジュールを設計。階層の後挿入は不可。
- **共有定数の単一情報源**: カテゴリ定義など2言語で参照する定数は二重定義を避ける運用を確立する（同期の二重化リスクを構造で抑える）。
- **客向け Web とオーナー向けの分離**: 機能3 の客向け Web は LINE 非経由・匿名集計のみ。LINE 文脈（Webhook/リッチメニュー）と物理的に分けて配置する。

## Naming Conventions

- **Markdown 成果物**: `.kiro/specs/` 配下は `spec.json.language`（= `ja`）で記述する。
- **コードの命名規約**: 実装着手時に各言語の慣習（TS: camelCase/PascalCase、Go: 標準 gofmt 規約）へ準拠して確立する。

---
_Document patterns, not file trees. New files following patterns shouldn't require updates_
_created_at: 2026-06-28_
