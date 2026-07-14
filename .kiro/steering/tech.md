# Technology Stack

## Architecture

**GCP 単一帝国上のマルチテナント・サーバレス構成。**
運営保有の **単一 LINE 公式アカウント** に全オーナーが友だち登録するマルチテナント型。客向け機能（機能3）は LINE を経由しない。

リアルタイム応答層（TypeScript）と日次バッチ層（Go）を **言語で役割分離する二刀流**。両者は同一 Cloud SQL を共有するため、**書き込み境界の規律**（後述）が最重要。

## Core Technologies

- **言語**: TypeScript（リアルタイム応答層）＋ Go（日次バッチ層）
- **プラットフォーム**: LINE Messaging API（公式アカウント／Bot）＋ 必要箇所のみ LIFF。客向けは通常 Web（LIFF ではない）。
- **クラウド**: GCP
  - **Cloud Run**: Webhook／客向け Web／ダッシュボード API（ゼロスケール）
  - **Cloud Scheduler**: 日次バッチ起動
  - **Cloud SQL (PostgreSQL)**: 単一 DB（2 言語が共有）
  - **Identity Platform = Firebase Auth**: ダッシュボードの Google ログイン（パスワードを自前管理しない）
- **生成AI**: Gemini API（口コミ下書き生成）
- **外部データ**: Google Places API（競合データ・従量課金許容。スクレイピング禁止）

## 二刀流の役割分担

- **TypeScript = リアルタイム応答層**: LINE Webhook・リッチメニュー・Flex Message 組立・客向けアンケート Web・Gemini オーケストレーション。LINE 公式 SDK が充実し、客向け Web と型を共有できる。
- **Go = 日次バッチ層**: 全店舗 × 競合5店の Places API を毎朝 goroutine で並行取得。低コスト・安定。

## Key Technical Decisions

- **書き込み境界（最重要運用規律）**: 同一 Cloud SQL を 2 言語から触るため、**どの言語がどのテーブルを書くか** を厳格に定義する。新テーブル追加時は必ず書込責任言語を明記。共有定数（カテゴリ定義等）の同期も二重化リスクとして管理する。
- **4階層データモデルを初期から確定**: `運営 → 代理店(Agency) → オーナー(Owner) → 来店客(Customer)※匿名`。後からの階層挿入は不可。スキーマ変更時もこの4階層を壊さない。
- **RBAC によるロール分離**: 運営（全店閲覧）と代理店（担当店のみ）は同一ダッシュボードにログインし権限分離。
- **MINI App 不採用**: 審査が重く初期不要。客向けは通常 Web、LINE 内入力は LIFF に限定。
- **GBP OAuth は第2フェーズ**: MVP に OAuth 連携を持ち込まない（審査リスク回避）。
- **Next.js `NEXT_PUBLIC_*` はビルド時 build-arg 必須**: `NEXT_PUBLIC_*` は `next build` 時にクライアントバンドルへインライン化される値。Cloud Run のランタイム env 注入はサーバー側にしか効かず、クライアントバンドルには一切反映されない。standalone アプリで使う `NEXT_PUBLIC_*` は必ず Dockerfile の `ARG`+`ENV`（`next build` 前）でビルド時に渡し、`scripts/push-images.sh` の `BUILD_ARGS` にも対応エントリを足すこと。CI の `scripts/check-next-public-buildargs.sh` が「ソースで参照する `NEXT_PUBLIC_X` に対応する `ARG` が Dockerfile に在るか」を機械強制する。CI 自動デプロイ（`.github/workflows/deploy.yml`・`ts-ci` 緑後に image-only 反映・Direct WIF）は `vars.NEXT_PUBLIC_LIFF_ID`（= tfvars `liff_id`）を build-arg として渡す。出典: 2026-07-14 の本番 LIFF 起動障害（`.kiro/specs/competitive-daily-summary/tasks.md` Implementation Notes 参照）。

## Development Standards

### LINE Messaging API 実装規律
- `.claude/skills/messaging-api/` スキルを使う。**LINE API を記憶で答えない**（頻繁に更新される）。
- Webhook 署名検証・Flex Message・リッチメニュー実装時は同スキルの references を必ず参照。

### ライブラリ方針
- 外部ライブラリは必要性を吟味して最小限に。LINE/GCP/Gemini の公式 SDK を基軸とする。

### Type Safety / Code Quality / Testing
- 実装着手時に確立する（現状ルール未策定）。確立後に本ファイルへ追記すること。

## Development Environment

### 現状
**実装コード・`package.json`・`go.mod` はまだ存在しない**（要件定義・提案フェーズ完了直後）。
`.gitignore` は Node/TS + Go + GCP/Terraform を想定済み。

### Common Commands
```bash
# DB スキーマ（four-tier-data-model で確立。ランタイムは apple/container 既定、CONTAINER_CMD で差替可）
make db-migrate   # BUILD: 一時postgresへ db/migrations/*.sql をクリーン適用
make db-smoke     # SMOKE: 適用後 db/test/smoke/*.sql を実行
make db-test      # TEST:  適用後 db/test/assertions/*.sql を実行（網羅スイート）
make db-verify-docs # DOCS: ERD/write-boundary と実スキーマの整合・書込境界単一所有を機械検証
# アプリ層（TS/Go）のビルド・lint・テストは各層導入時に確立し追記する。推測で書かない。
```

---
_Document standards and patterns, not every dependency_
_一次情報源: `requirements.md` 2章／`README.md`／`CLAUDE.md`_
_created_at: 2026-06-28_
