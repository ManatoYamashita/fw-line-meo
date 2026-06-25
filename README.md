# fw-line-meo

飲食店向け LINE 一元管理アプリ（LINE Restaurant Manager）

ITに不慣れな飲食店オーナーが、**LINE だけで** 自店の市場ポジション把握・Google クチコミ獲得促進・
（将来）Google ビジネスプロフィール投稿を完結できるようにするサービス。

## コンセプト
飲食店向けに複雑な Web UI を持たず、LINE で全てを一元管理する。

## 主要機能（MVP）
- **機能3**: 口コミ用 QR・アンケート（来店客がタップ式回答 → AI が口コミ下書きを生成）
- **機能1**: 競合ポジショニング日次サマリー（毎朝 LINE に Flex Message 配信）

## 第2フェーズ
- **機能2**: Google ビジネスプロフィール投稿作成（OAuth 連携）
- クチコミ返信

## 技術スタック
- プラットフォーム: LINE Messaging API（+ 必要箇所 LIFF）／客向けは通常 Web
- クラウド: GCP（Cloud Run / Cloud Scheduler / Cloud SQL(PostgreSQL) / Identity Platform）
- 生成AI: Gemini API
- 言語: TypeScript（リアルタイム応答層）＋ Go（日次バッチ層）

## ドキュメント
- [要件定義書](./requirements.md)
