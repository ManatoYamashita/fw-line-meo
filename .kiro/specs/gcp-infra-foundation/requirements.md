# Requirements Document

## Project Description (Input)

**誰の問題か**: fw-line-meo 開発チーム（運営）および将来的に担当する代理店

**現状**: GCP プロジェクトが未作成。DB スキーマ（four-tier-data-model）は確定したが、アプリ層（Cloud Run ×3 + Job）・Cloud SQL・認証基盤（Identity Platform）を稼働させるクラウドインフラが存在しない。

**変えたいこと**: Terraform IaC で **単一 GCP プロジェクト `fwlm`（asia-northeast1）** にインフラを一式宣言し、GitHub Actions から WIF 経由でゼロキー CI/CD デプロイを確立する。dev 環境はローカル（既存 `make db-*` ハーネス）で完結させ、常時課金リソース（Cloud SQL）を prod 一台に限定することでコストを最小化する。

### 合意済み構成（会話確定事項）

| 項目 | 内容 |
|---|---|
| GCP プロジェクト | **`fwlm` 単一**（dev/prod 分離なし・コスト最小化） |
| リージョン | asia-northeast1（東京） |
| Cloud Run | Services ×3（webhook / survey-web / dashboard-api・min-instances=0）＋ Job ×1（daily-batch） |
| Cloud SQL | PostgreSQL 16・最小構成（db-f1-micro 相当）・自動バックアップ・Cloud SQL Connector |
| 認証 | Identity Platform（Firebase Auth）—ダッシュボード Google ログイン・SAキー自前管理なし |
| IaC | Terraform（GCS remote state）・modules/ 分割（将来プロジェクト分離の退路） |
| CI/CD | GitHub Actions + Workload Identity Federation（SA JSON キー不発行） |
| Secrets | Secret Manager（LINE チャネルシークレット・Gemini APIキー・Places APIキー・DB パスワード） |
| ガードレール | Budget alert 1本（月 ¥10,000 通知）・Places API クォータ上限 |
| dev 環境 | ローカル native postgres ハーネス（`make db-migrate` 等）・クラウド dev インスタンス不使用 |

## Introduction

本仕様は fw-line-meo の全アプリケーション層（LINE Webhook・客向けアンケート Web・ダッシュボード API・日次バッチ）が稼働するクラウドインフラ基盤を定義する。基盤は単一プロジェクトに IaC で宣言され、キーレス CI/CD・シークレット管理・コストガードレールを備える。開発検証はローカルで完結させ、クラウド側の常時課金リソースをデータベース 1 台に限定する。

## Boundary Context

- **In scope**: クラウドリソース一式の IaC 宣言（実行環境・データベース・認証基盤・シークレット管理・課金ガードレール）、キーレス CI/CD デプロイ経路の確立、確定済み DB スキーマのクラウド適用経路。
- **Out of scope**: アプリケーション実装コード（Webhook・アンケート Web・ダッシュボード・バッチの中身は後続 spec）、LINE 公式アカウント自体のチャネル開設作業、GBP OAuth 関連リソース（第2フェーズ）、dev 用クラウド環境の構築、カスタムドメイン・独自 DNS。
- **Adjacent expectations**: four-tier-data-model で確定した `db/migrations/*.sql` が変更なしでクラウド DB へ適用できること。後続 spec（機能3・機能1・ダッシュボード・LINE 基盤）は本基盤の実行環境へデプロイされることを前提とする。DB スキーマの開発検証は既存ローカルハーネス（`make db-*`）が引き続き担い、本基盤はそれを置き換えない。

## Requirements

### Requirement 1: 単一プロジェクトへの IaC 集約

**Objective:** As a 運営（開発チーム）, I want インフラ全体を単一のクラウドプロジェクトに IaC で宣言的に管理すること, so that 手作業構築の再現不能性を排除し、常時課金リソースの重複を構造的に防げる

#### Acceptance Criteria

1. The インフラ基盤 shall すべてのクラウドリソースを単一プロジェクト（東京リージョン）に集約し、環境別のプロジェクト分離を行わない
2. The インフラ基盤 shall すべてのクラウドリソースを IaC 定義から作成・変更可能とし、IaC 定義に存在しない手作業リソースを持たない
3. When IaC 定義を変更せずに差分確認を実行した, the インフラ基盤 shall 差分ゼロを報告する（冪等性）
4. The インフラ基盤 shall IaC の状態をリモート共有ストレージに保管し、複数作業者および CI からの一貫した参照を可能にする
5. The インフラ基盤 shall 機能領域単位のモジュール分割構造を維持し、将来の環境・プロジェクト分離時に定義を再利用できる形を保つ

### Requirement 2: アプリケーション実行基盤

**Objective:** As a 運営, I want リアルタイム応答層 3 サービスと日次バッチの実行環境, so that 後続 spec のアプリ実装が完成し次第すぐにデプロイ・稼働できる

#### Acceptance Criteria

1. The インフラ基盤 shall リアルタイム応答層向けに 3 つの独立したサービス実行環境（LINE Webhook 受信／客向けアンケート Web／ダッシュボード API）を提供する
2. While リクエストが到達していない, the 各サービス実行環境 shall インスタンス数ゼロまでスケールインし、待機課金を発生させない
3. The インフラ基盤 shall 日次バッチ層向けに 1 つのジョブ実行環境（競合データ取得）を提供する
4. When 毎朝の定刻に達した, the インフラ基盤 shall 日次バッチジョブを自動起動する
5. If 日次バッチジョブが失敗した, the インフラ基盤 shall 失敗を実行履歴として記録し、運営が検知できる状態にする
6. The インフラ基盤 shall 外部公開の要否をサービス単位で制御する（客向け・LINE 向けは公開、内部用途は非公開）
7. The 各実行環境 shall 実行ログを運営が閲覧できる形で収集する

### Requirement 3: データベース基盤

**Objective:** As a 運営, I want 確定済み DB スキーマがそのまま動くマネージドデータベース 1 台, so that データ基盤を低コストで安全に運用できる

#### Acceptance Criteria

1. The インフラ基盤 shall PostgreSQL 16 のマネージドデータベースインスタンスを 1 台のみ提供する
2. The データベース基盤 shall four-tier-data-model で確定した migration SQL を変更なしで適用できる
3. The データベース基盤 shall 日次の自動バックアップを保持する
4. The データベース基盤 shall インターネットからの直接接続を許可せず、認可された実行環境および運営者の管理経路からの接続のみ受け付ける
5. Where ステージング検証が必要になった, the インフラ基盤 shall 同一インスタンス内への論理データベース追加で対応し、追加インスタンスを作成しない

### Requirement 4: ダッシュボード認証基盤

**Objective:** As a 運営・代理店, I want Google アカウントでダッシュボードにログインできる認証基盤, so that パスワードの自前管理リスクなしに RBAC ロール分離の前提を得られる

#### Acceptance Criteria

1. The インフラ基盤 shall ダッシュボード利用者（運営・代理店）向けに Google アカウントによるログイン基盤を提供する
2. The 認証基盤 shall パスワードを自前で保存・管理しない
3. The 認証基盤 shall ログイン成功時に後続のダッシュボード API が利用者を一意に識別できる情報（検証可能なトークン）を発行する

### Requirement 5: シークレット管理

**Objective:** As a 運営, I want 外部サービス資格情報の一元的なシークレット管理, so that 資格情報の漏洩リスクを構造的に抑えられる

#### Acceptance Criteria

1. The インフラ基盤 shall 外部サービス資格情報（LINE チャネルシークレット・生成 AI API キー・地図データ API キー・DB パスワード）を専用のシークレット管理機構で保管する
2. The インフラ基盤 shall シークレット値をリポジトリ・IaC 状態・ビルドログへ平文で残さない
3. When 実行環境がシークレットを必要とする, the インフラ基盤 shall 実行時にシークレット管理機構から供給する
4. The 各実行環境 shall 自身の責務に必要なシークレットのみ読み取り可能とする（最小権限）

### Requirement 6: キーレス CI/CD

**Objective:** As a 運営（開発チーム）, I want GitHub からクラウドへの永続キー不要のデプロイ経路, so that キー漏洩リスクをゼロにしつつ継続的デプロイを実現できる

#### Acceptance Criteria

1. When デプロイ対象ブランチが更新された, the CI/CD パイプライン shall クラウドへの認証を一時トークンによるキーレス連携で行う
2. The CI/CD パイプライン shall サービスアカウントの永続キー（JSON キー）を発行・保管しない
3. The キーレス連携 shall 対象リポジトリ以外からの認証を拒否する
4. If デプロイが失敗した, the CI/CD パイプライン shall 稼働中の旧リビジョンを維持し、サービス停止を発生させない

### Requirement 7: コストガードレール

**Objective:** As a 運営, I want 課金の暴走を早期検知・抑止する仕組み, so that MVP フェーズの予算を超える予期しない課金を防げる

#### Acceptance Criteria

1. When 月間課金額が閾値（月 ¥10,000）を超過した, the インフラ基盤 shall 運営へ通知する
2. The インフラ基盤 shall 従量課金の外部 API（地図データ取得）に呼び出し上限（クォータ）を設定する
3. The インフラ基盤 shall 常時課金リソースをデータベース 1 インスタンスのみに限定する

### Requirement 8: 開発検証のローカル完結（環境境界）

**Objective:** As a 運営（開発チーム）, I want 開発検証をクラウドに依存せずローカルで完結させること, so that dev 用クラウド環境の維持コストと管理負担をゼロに保てる

#### Acceptance Criteria

1. The インフラ基盤 shall 開発検証専用のクラウドリソース（dev 用データベース・dev 用サービス）を作成しない
2. The 開発チーム shall DB スキーマの検証を既存ローカルハーネス（`make db-migrate` / `db-smoke` / `db-test` / `db-verify-docs`）で引き続き実施できる
3. If クラウド上での検証が必要になった, the 開発チーム shall 本番相当の単一環境（および Requirement 3.5 の論理データベース）で検証し、恒常的な検証環境を新設しない
