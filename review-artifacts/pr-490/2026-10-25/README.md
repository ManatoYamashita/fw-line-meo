# PR #490 のローカル画面 E2E 検証（2026-10-25・JST）

対象コミット: `46f083ddf9e21c96ec0f00a8c99dfa21aad19f02`

既存の実行手順 `bash scripts/run-e2e-local.sh --only surfaces` を Node.js 24.19.0 / pnpm 10.33.2 / Playwright 1.61.1 / 付属 Chromium 149.0.7827.55、`CI=true` で実行しました。全体の終了コードは 0、surfaces 層は PASS（250 秒・準備のビルドとブラウザ導入時間を除く）です。終了時に dashboard-web / store-detail の両方を認証スタブなしの通常ビルドへ復元しました。

| 対象 | 成功 | スキップ | 失敗 |
| --- | ---: | ---: | ---: |
| dashboard-web 既存 E2E | 107 | 4 | 0 |
| スクショ撮影・動作確認用の追加ケース | 3 | 0 | 0 |
| store-detail 既存 E2E | 23 | 0 | 0 |
| 合計 | 133 | 4 | 0 |

4 件のスキップは既存の QR モーダルが背面の帯・横スクロールの手がかりを覆うための R2/R3（393px / 320px）です。今回追加した除外はありません。

## #485 に関する確認

- 運営の代理店区画内にオーナーと店舗の表が描画される。代理店ロールは自代理店の表が描画され、代理店の区画を持たない。
- 登録済み候補は「登録済み」と理由を表示し、候補を選ぶボタンを持たない。
- 登録先のオーナーを表示する。運営では代理店名も表示する。
- 「オーナーを選び直す」で一覧へ戻り、見出しへ焦点が移る。
- 店舗登録・検索結果の WCAG A/AA 自動監査、320px / 393px のページのはみ出し・表・帯の検査が成功。
- 追加ケースでは viewport 1280×900 と 320×800 のスクリーンショットを採取（全ページ、CSS ピクセル）。既存の mobile-chromium プロジェクトを利用。

## 検証範囲

この実行は `surfaces` 層です。認証と API 応答は既存 fixture に置き換えています。実 API / DB / Google Places との疎通、本番環境への店舗登録、survey / lighthouse / cross-runtime の各層は今回の実行には含みません。すべて撮影用データです。

## 成果物

- `e2e-surfaces.log`: 準備から通常ビルド復元までの全実行ログ。ブラウザ初回取得時の一部 URL の 403 は、Playwright 既定の代替 URL からの取得により回復しています。
- `dashboard-web-last-run.json` / `store-detail-last-run.json`: Playwright が記録した成功状態。
- `screenshots/`: 実ブラウザから取得した PNG 6 枚（編集なし）。
- `manifest.json`: 検証コミット・実施時刻・ファイルの SHA-256。
- `capture/`: 検証時だけ追加した撮影用の 2 ファイル。再現する場合は、それぞれ `ts/apps/dashboard-web/e2e/pr490-evidence.spec.ts` と `ts/apps/dashboard-web/e2e/fixtures/pr490-evidence.ts` へコピーし、同じ surfaces コマンドを実行します。採取後は作業ツリーから除去しました。PR の実装ファイルは変更していません。
