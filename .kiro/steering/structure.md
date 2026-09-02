# Project Structure

## Organization Philosophy

**言語境界 = 責務境界。** リポジトリは「リアルタイム応答層（TypeScript）」と「日次バッチ層（Go）」という2つの実行責務で分割する。両者は同一 Cloud SQL を共有するが、**書き込み境界**（どの言語がどのテーブルを書くか）で結合を規律する。

実体は TypeScript モノレポ `ts/`（pnpm workspace。`apps/` がデプロイ単位、`packages/` が共有ライブラリ）と Go モジュール `go/`、スキーマ `db/`、インフラ `infra/`、CI ガード `scripts/`。**本ファイルは個々のディレクトリを列挙しない。** 新しいファイルが既存の型に従う限り、本ファイルの更新は要らない。

## Directory Patterns

### ドキュメント（一次情報源）
**Location**: リポジトリ直下 / `docs/`
**Purpose**: 全設計判断の根拠。`requirements.md`（要件定義 v1.0・章番号で参照）、`docs/proposal.md`（クライアント合意用・機能A/B/C = 機能3/1/2）、`README.md`（技術スタック要約）、`docs/architecture.md`（サービス構成とフローの俯瞰）、`docs/design/`（意匠。写像版が `design-language.md`、原典の逐語コピーが `upstream/`）。

### Kiro 仕様駆動開発
**Location**: `.kiro/`
**Purpose**: `specs/`（機能単位の仕様。**各 spec のフェーズは `spec.json` が持つ。** 本ファイルは spec 名も件数も持たない。増減で必ず腐るため）、`steering/`（プロジェクト永続メモリ＝本ファイル群）、`settings/`（テンプレート・メタデータ）。

### UI・意匠
**Location**: `ts/packages/design-tokens` / `ts/packages/ui` / `docs/design/`
**Purpose**: 値の単一情報源が `design-tokens`（依存ゼロ。CSS を経由しない LINE 層からも参照する）、
CSS と共通部品が `ui`（`theme.css` の `@theme` と `@layer base`）。読む面は `docs/design/design-language.md`、
規律は `.kiro/steering/design-tokens.md`、原典の逐語コピーは `docs/design/upstream/`。
**色は必ずトークン経由で指定する**（直書き hex と生パレット色クラスは `scripts/check-design-tokens.sh` が落とす）。

## 組織原則

- **言語ごとにトップレベルを分離**: TypeScript 層と Go 層は明確に分けたツリーで管理し、相互の実装詳細を混在させない。実体は `ts/` と `go/`。
- **書き込み境界を構造で表現**: テーブルごとに「書込責任言語」を1つ定め、スキーマ定義・マイグレーションの所在を責任言語側に集約する。読み取りは両言語可、書き込みは責任言語のみ。
- **4階層データモデルを壊さない**: `運営 → 代理店 → オーナー → 来店客` の階層を前提にスキーマ・モジュールを設計。階層の後挿入は不可。
- **共有定数の単一情報源**: 2言語で参照する定数は二重定義を避け、共有パッケージへ寄せる。**codegen は持たず、手動同期を機械検証で固める**（同期の二重化リスクを構造で抑える）。
- **客向け Web とオーナー向けの分離**: 機能3 の客向け Web は LINE 非経由・匿名集計のみ。LINE 文脈（Webhook/リッチメニュー）と物理的に分けて配置する。

## Naming Conventions

- **Markdown 成果物**: `.kiro/specs/` 配下は `spec.json.language`（= `ja`）で記述する。
- **コードの命名規約**: 各言語の慣習に従う（TS: camelCase/PascalCase、Go: 標準 gofmt 規約）。

---
_Document patterns, not file trees. New files following patterns shouldn't require updates_
_created_at: 2026-06-28_
_updated_at: 2026-09-02（#175: 「実装コード未着手」「spec は 1 件が initialized」「`.claude/skills/` に `kiro-*`」の 3 つの虚偽記述を是正し、UI・意匠層の所在を追加した）_
