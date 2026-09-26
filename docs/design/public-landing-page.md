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
- 製品画面は実際のアプリを操作して撮影する。サンプルデータの使用をページに明記し、
  本番の店舗名・店舗ID・回答・QRコードを素材へ持ち込まない。
  画像は縦横比を保って全体を表示し、画面内の小さな文字を読める原寸画像へのリンクを添える。

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

## OGP画像・実画面の追加

ユーザー指定により、冒頭の説明図を既存OGP画像へ変更し、利用手順に回答・下書きの実画面を追加した。

| 素材（survey-web/public 配下） | 出典 | 寸法 |
| --- | --- | --- |
| `ogp.webp` | 既存の製品OGP画像 | 1200 × 630 |
| `screenshots/survey.png` | 実際のアンケート回答画面 | 780 × 1548 |
| `screenshots/draft.png` | 実際の口コミ下書き画面 | 780 × 1252 |

撮影時は `ts/scripts/with-test-db.sh` の一時DBへ既存E2Eのseedを投入し、
店舗名を「サンプル食堂」、Place IDを撮影用のダミー値に変更した。
そのDBに接続した本番ビルドを localhost:3213 で起動し、390px幅・2倍解像度のChromiumで撮影した。
本番コード・画面DOM・CSSを撮影用に変更していない。

回答画面では星4・良かった点「味」・気になった点「接客」を選択し、サンプルの一言を入力した。
送信後、既存のGeminiモックで下書き画面へ進み、製品の編集欄でサンプル文章へ変更して撮影した。
写真ではなく実際に操作した製品画面だが、生成結果の性能や実在の口コミを示すものではない。
次回撮影時もこの手順で両方の画面を更新する。

画像表示は `next/image` を使用。OGPは eager / high priority、下方のスクリーンショットは
標準の遅延読み込みとし、寸法・`sizes`・代替テキストを指定した。原寸画像への通常リンクは
JavaScriptや独自の拡大モーダルを必要としない。

追加後の確認：lint・型検査・本番ビルド、既存LP E2E 4件が成功。
320 / 390 / 768 / 1280pxで3画像の読み込み成功と縦横比を実ブラウザで確認し、
2つの拡大リンクで780px幅の原寸画像を開けることを確認した。
文字200%・キーボード・axeの既存検証も成功。6領域のレビューに追加の指摘はなく、
上記の未検証範囲は引き続き未検証である。

## リンク・開発者表記・SEOの整備（2026-09-26）

- CTAは文字だけに下線を付け、矢印は装飾SVGとして分離する。リンク全体の下線は
  flexの文字と矢印の双方へ伝播し、矢印の下に短い線が出ていた。44pxの操作領域と
  既存のフォーカス輪郭は維持する。
- 運営は「Firstweb」、開発は「新卒グルメ」。フッターとJSON-LDの情報を揃える。
- 主見出し・title・descriptionで対象と機能（飲食店、Google口コミ、QRアンケート）を伝える。
  WebSite・WebPage・SoftwareApplicationのJSON-LDは初期HTMLに出し、表示内容と一致する
  事実だけを記載する。料金や評価を創作してリッチリザルトの要件を埋めない。
- 公開URLの正典は `src/lib/public-site.ts`。canonical、OGP、サイトマップ、構造化データに使う。
  旧run.appのURLでもトップのcanonicalは公開ドメインを指す。既存QRのURLは維持する。
- layoutはnoindexを既定とし、公開LPのみindexを許可する。canonicalをlayoutへ置かない。
  新しい公開ページは検索可否を明示し、公開対象だけを `sitemap.ts` へ追加する。
- `/robots.txt` はサイトマップを案内し、APIとヘルスチェックのクロールを除外する。
  `/s/` と `/ui-check` はnoindexを読み取れるよう、robots.txtでは遮断しない。
- 実際の更新日時を追跡していないサイトマップへ、実行時刻をlastmodとして書かない。
- E2Eの画面遷移と描画前提は `e2e/fixtures/surfaces.ts` に集約する。LPのテストでも
  `check-e2e-goto-ownership.sh` と `check-a11y-audit-preconditions.sh` を通す。

参照：[Google SEOスターターガイド](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)、
[noindexの仕様](https://developers.google.com/search/docs/crawling-indexing/block-indexing)、
インストール済みNext.js 16.2.10のmetadata / robots / sitemap / JSON-LDドキュメント。

### 追加レビュー

範囲は公開LP全体と検索メタデータの継承。6領域のレビュー境界・未検証範囲は上記と同じ。

| 重要度 | 領域 | 場所 | 修正前 | 修正後 | 理由 |
| --- | --- | --- | --- | --- | --- |
| LOW | Typography / UI | `src/app/page.tsx` の2つのCTA | リンク全体に下線、文字矢印 | 文字に下線、装飾SVG | アイコンの下に不自然な短い線が出る |

AccessibilityはTab巡回・44pxの対象・axe、LayoutとTypographyは320〜1280pxと文字200%、
Writingは運営・開発・機能説明、Colorsは既存トークンと実描画のaxe、UIは両CTAの通常・hover・focusを確認。
修正後のスクリーンショットと計算済みtext-decorationを照合し、文字だけに下線があることを確認した。
判定は **Approve**。検索順位・検索結果への反映・実機読み上げを保証する判定ではない。

### SEOの検証

- 追加した2件のSEO E2Eは、修正前のビルドでtitle不一致・robots.txtの404により失敗することを確認。
- JavaScript無効の実ブラウザで、title・description・robots・OGP・canonical・JSON-LD・運営開発表記を確認。
  Next.jsがOGPのorigin末尾のスラッシュを正規化するため、URLはパースして比較する。
- サイトマップのHTTP 200・XML形式・公開URLのみの掲載、検証面と実際のアンケート画面のnoindex、
  LPのcanonicalが他の画面へ継承されないことを確認。
- ローカル本番ビルドのLighthouse 13（モバイル、単回）：SEO 100、Accessibility 100、
  Best Practices 100、Performance 98。これはローカルのラボ計測であり、本番の実利用計測ではない。
- survey-webの単体テスト378件成功、DB専用7件は単体実行時にスキップ。
  lint・型検査・本番ビルド・デザイントークン・差分検査を実施。

検索結果への掲載・順位はデプロイ直後のHTTP確認と分けて扱う。Search Consoleのサイトマップ送信・
URL検査はアカウント側の作業であり、この実装だけで実施済みとは記録しない。
