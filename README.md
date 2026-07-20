# fw-line-meo

飲食店向け LINE 一元管理アプリ（LINE Restaurant Manager）

ITに不慣れな飲食店オーナーが、**LINE だけで** 自店の市場ポジション把握・Google クチコミ
獲得促進・（将来）Google ビジネスプロフィール投稿を完結できるようにするサービス。

## これは何か

飲食店向けに複雑な Web UI を持たせず、LINE で全てを一元管理する。運営が保有する単一の
LINE 公式アカウントに全オーナーが友だち登録するマルチテナント構成。実装は「二刀流」で、
**TypeScript（リアルタイム応答層）** と **Go（日次バッチ層）** が単一の Cloud SQL を共有し、
GCP に一元デプロイされる。

システム全体の詳細は **[アーキテクチャ / サービス構成](./docs/architecture.md)** を参照。

## サービス構成（一目で）

デプロイ単位は Cloud Run サービス5 + ジョブ2 の計7。

| アプリ | Cloud Run 名 | 使う人 | 担当 |
|---|---|---|---|
| `@fwlm/line-webhook` | `line-webhook` | オーナー | LINE オンボーディング |
| `@fwlm/store-detail` | `store-detail` | オーナー | 機能1 競合レポート詳細（LIFF・読取専用） |
| `@fwlm/dashboard-web` | `dashboard-web` | 運営・代理店 | 管理画面 UI |
| `@fwlm/dashboard-api` | `dashboard-api` | 運営・代理店 | 管理 API・QR 発行 |
| `@fwlm/survey-web` | `survey-web` | 来店客（匿名） | 機能3 口コミアンケート・AI 下書き |
| （Go）daily-batch | `daily-batch`（Job） | 無人 | 機能1 競合データ取得 |
| `@fwlm/delivery-job` | `summary-delivery`（Job） | オーナー | 機能1 Flex 配信 |

各サービスの技術スタック・対応 spec は [docs/architecture.md](./docs/architecture.md) に一覧。

## 使われ方（E2E 3ステップ）

1. **準備（運営・代理店）** — ダッシュボードで代理店を登録し、招待コードを発行する。
2. **オーナー登録（LINE）** — オーナーが友だち追加 → 招待コード入力 → 店名検索 → 自店を
   確定。ここで機能1の配信対象になる。
3. **運用・口コミ（日常）** — 毎朝の競合レポートが LINE に届き、店頭の QR から来店客が
   匿名で口コミを投稿できる。

フロー図と詳細は [docs/architecture.md](./docs/architecture.md#4-オンボーディング-e2e-フロー) を参照。

## 主要機能（MVP）

- **機能3**: 口コミ用 QR・アンケート（来店客がタップ式回答 → AI が口コミ下書きを生成）
- **機能1**: 競合ポジショニング日次サマリー（毎朝 LINE に Flex Message 配信）
- 代理店ダッシュボード（登録＋一覧・RBAC）／段階的オンボーディング（店舗特定まで）

### 第2フェーズ
- **機能2**: Google ビジネスプロフィール投稿作成（OAuth 連携）
- クチコミ返信

（提案書では 機能A=機能3・機能B=機能1・機能C=機能2。詳細は [docs/architecture.md](./docs/architecture.md#7-機能ラベルの対応) 参照）

## 技術スタック

- プラットフォーム: LINE Messaging API（+ 必要箇所 LIFF）／客向けは通常 Web
- クラウド: GCP（Cloud Run / Cloud Scheduler / Cloud SQL(PostgreSQL) / Identity Platform）
- 生成AI: Gemini API
- 言語: TypeScript（リアルタイム応答層）＋ Go（日次バッチ層）

## リポジトリ構成

- `ts/` — TypeScript モノレポ。`apps/`（6アプリ）＋ `packages/`（`db`・`store-identification`）
- `go/` — Go 日次バッチ層。`cmd/daily-batch`＋`internal/*`
- `db/` — スキーマの正本。`migrations/`・[ERD.md](./db/ERD.md)・[write-boundary.md](./db/write-boundary.md)・`test/`
- `infra/` — Terraform（単一環境 `envs/prod/`）。手順は [infra/README.md](./infra/README.md)
- `.kiro/` — 仕様駆動開発（`specs/`）とプロジェクト永続メモリ（`steering/`）

## 開発コマンド

`Makefile` に確立済みの主なターゲット（詳細は `make help`）:

```
# データベース（DB スキーマが最初の成果物）
make db-migrate       # 一時 postgres へ migrations を適用
make db-smoke         # スモークテスト
make db-test          # 網羅アサーション
make db-verify-docs   # ERD・書込境界と実スキーマの整合検証

# Go 層
make go-build         # go/ 配下を全ビルド
make go-test          # go/ 配下を全テスト

# TypeScript 層
make ts-install       # 依存インストール
make ts-build         # 全アプリ・パッケージをビルド
make ts-lint          # lint
make ts-test          # テスト

# インフラ
make tf-plan          # terraform plan
make tf-apply         # terraform apply
```

## ドキュメント

- [アーキテクチャ / サービス構成とオンボーディングフロー](./docs/architecture.md) — 全体像はここから
- [要件定義書](./requirements.md) — 最上位の正典（章番号で全設計が参照）
- [提案書](./docs/proposal.md) — クライアント合意用（非技術）
- [インフラ手順](./infra/README.md) — GCP bootstrap runbook
- 各機能の詳細仕様: `.kiro/specs/{feature}/`
