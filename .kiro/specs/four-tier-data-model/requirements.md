# Requirements Document

## Project Description (Input)

出典: GitHub Issue ManatoYamashita/fw-line-meo#1 「[MVP] 4階層データモデル設計（運営→代理店→店舗→客）」

### 誰の課題か
fw-line-meo（LINE × MEO 製品）の開発チームおよび運営。データ基盤の土台を最初に固める必要がある立場。

### 現状
要件定義書（`requirements.md` の 2.3 / 5.1 / 5.2）で 4 階層データモデル（運営 → 代理店 → 店舗 → 客）が言及されているが、ER 図および Cloud SQL（PostgreSQL）スキーマがまだ確定していない。階層構造は後からの挿入が不可能であり、構造を先に完璧に固めないと後続の全機能が手戻りリスクを負う。

### 変えたいこと（あるべき姿）
4 階層データモデルの構造を最初に確定し、ER 図とスキーマ DDL をレビュー済みの成果物としてリポジトリに格納する。

### スコープ
- ER 図の作成
- Cloud SQL（PostgreSQL）スキーマ設計（DDL）
- 主要エンティティの定義:
  - 運営（operator）
  - 代理店（agency）
  - 店舗（store: Google Place ID・場所・カテゴリ）
  - 競合リスト（competitor）
  - 評価・順位の時系列（rating / ranking time-series）
  - （将来）OAuth トークン
- アンケート回答は Place 単位の匿名集計のみ保持する方針を反映する
- TypeScript / Go 二刀流の書き込み境界（write boundary）を定義する

### 完了条件
- ER 図・スキーマ DDL がレビュー済みでリポジトリに格納されている

### 区分・参照
- 区分: MVP / 基盤
- 参照: `requirements.md`（2.3, 5.1, 5.2）

## Requirements
<!-- Will be generated in /kiro-spec-requirements phase -->
