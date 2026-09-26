# QR口コミ支援の公開トップページ

Issue: [#361](https://github.com/ManatoYamashita/fw-line-meo/issues/361)

## 役割と実装の規律

`review.firstweb-works.com` は `survey-web` の公開ドメインである。
従来の `/` はアプリ名だけの1行で、直接アクセスした人にサービスの内容や次の行動が伝わらなかった。

- `/` はサービス紹介・来店客の利用手順・店舗オーナー向けの導入案内を表示する。
  LINE認証、Cookie、DB、外部APIの成功を表示条件にしない。
- `/s/[storeId]` は店頭QRから開く既存のアンケート。トップから仮の店舗IDへ誘導しない。
  店舗オーナー向けのLIFF認証は別サービスであり、この公開ページには追加しない。
- 口コミは回答内容から下書きを作り、お客様本人が確認・編集・投稿する。
  評価によって導線を分けず、自動投稿・未実装機能・実績値・料金を宣伝しない。
- 遷移には通常のリンクを使い、JavaScript無効でも説明とページ内リンクが利用できるようにする。
- 色、文字サイズ、フォント、フォーカスは既存の意味論トークンを使い、幅は共通の
  `PageShell` を使う。LPのためだけに新しい依存ライブラリや色の体系を足さない。
- トップ固有の説明・canonical・OGPは `src/app/page.tsx` で定義する。
  トップのcanonicalをルートlayoutへ置いて、店舗別の回答ページへ継承させない。

## インターフェースレビュー（2026-09-26）

対象は `/` の初期表示とページ内リンク・外部案内リンク。
Next.js 16.2.10 App Router、React、Tailwind CSS 4、既存の `@fwlm/ui` を使用。
参照文書は `CLAUDE.md`、`.kiro/steering/design-tokens.md`、
`.kiro/steering/review-gate.md`、`docs/design/design-language.md`。
`better-interface` 配下の6領域と `modern-web-guidance` の HTML・accessibility を適用した。

| 領域 | 確認した証拠 | 結果 |
| --- | --- | --- |
| Accessibility | 見出し・ランドマーク・リンク名、全リンクのTab巡回、スキップリンク、axe WCAG A/AA | 問題なし |
| Layout | 320 / 390 / 768 / 1280px、各幅で文字100% / 200%、要素・文字の実矩形 | 横はみ出し・文字欠けなし |
| Writing | QR案内、投稿の任意性、本人による投稿、LINEとGoogleのログイン条件、相談先 | 現在の機能と一致 |
| Typography | 実描画の日本語改行、見出し階層、共通フォント、拡大時の折り返し | 省略・切り捨てなし |
| Colors | 実ブラウザの文字色と実背景色を相対輝度で計算、axeのコントラスト監査 | 本文最小5.049:1、ブランド見出し3.516:1（20px/700、閾値3:1） |
| UI | 320 / 390px・デスクトップの画面、リンクのhover・focus、共通の輪郭と余白 | 問題なし。新規アニメーションなし |

対応が必要なインターフェース指摘はなし。確認した範囲の判定は **Approve**。

静的ページのため読み込み中・空・エラーの独自状態は存在しない。
VoiceOver等の実機読み上げ、Safari、RTL、ブラウザUIからの200%ズームは未検証。
200%の検証はルート文字サイズの変更による文字拡大であり、ブラウザズームとは区別する。
LINE認証やGoogleへの実投稿、店舗別の本番データは今回の実描画レビューの対象外。

## 検証結果

- `pnpm -C ts --filter @fwlm/survey-web lint`：成功。
- `pnpm -C ts --filter @fwlm/survey-web typecheck`：成功。
- `pnpm -C ts --filter @fwlm/survey-web test`：371件成功、DB接続が必要な7件はスキップ。
- `pnpm -C ts --filter @fwlm/survey-web build`：成功。`/` が静的生成され、
  `/s/[storeId]` とAPIは既存の動的ルートとして残ることを確認。
- `E2E_BASE_URL=http://127.0.0.1:3212 pnpm -C ts --filter @fwlm/survey-web exec playwright test e2e/landing-page.spec.ts`：
  本番ビルドをローカルで起動して4件成功。開発サーバーでも同じ4件が成功。
  ローカルのNode.js 24とインストール済みChromiumを使用。
  サーバーは接続不能なダミーDBとダミーのAPIキーで起動し、実DB・生成APIに接続していない。
- 旧トップページへ一時的に戻した場合、JavaScript無効の検証が主見出し不在で失敗することを確認。
  成功だけを返す検証ではないことを確かめてから、実装を復元した。
- `bash scripts/check-design-tokens.sh`、`bash scripts/check-compliance-wording.sh`：成功。
- Next.js MCP `get_errors`：設定・実行時エラーなし。`get_routes`：既存ルート維持。
- 実ブラウザで390pxとデスクトップの本番モードを確認。
  通常文字のコントラストは5.049〜15.910:1。
  装飾矢印に対する追加監査の自動判定不能は、実色測定で14.851:1以上を確認した。
- 運営サイト・問い合わせ・プライバシー・利用規約のリンク先はHTTP 200を確認。

全体のアンケートE2Eは既存の `scripts/run-e2e-local.sh --only survey` が実行経路。
`playwright test` を環境指定なしで実行しないこと。
公開LPだけを確認するときは、ダミー設定のローカルサーバーを起動して
`E2E_BASE_URL` で接続先を明示し、`landing-page.spec.ts` に限定する。

本番公開はマージと既存のデプロイフローで行う。この記録はローカル実装・検証の完了を示す。
