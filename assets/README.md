# assets（ブランド系の画像の目次）

アイコン・OGP 画像・公開トップの画面写真・LINE のリッチメニュー画像を、ここから一か所でたどれるようにしてある。

**ここにある画像はすべてシンボリックリンクで、本物は各アプリの中にある。** 本物は元の場所から動かせない。

- `icon.png` と `apple-icon.png` は Next.js App Router のファイル規約で、各アプリの `app/` に無いと効かない
- 本番のイメージは `ts/` だけをビルドの範囲にして作る。`ts/` の外へ移すと、本番から画像が消える

リンクが切れたり、新しい画像にリンクを張り忘れたりすると、`ts/packages/design-tokens/test/brand-assets.test.ts` が落ちる（Issue #463）。

## 一覧（18 点）

| ここ | 本物 | 寸法 | 使われ方 |
|---|---|---|---|
| `icon/survey-web-icon.png` | `ts/apps/survey-web/src/app/icon.png` | 64×64 | QR口コミ支援のブラウザのタブのアイコン |
| `icon/survey-web-apple-icon.png` | `ts/apps/survey-web/src/app/apple-icon.png` | 180×180 | 同、iPhone のホーム画面に追加したときのアイコン |
| `icon/store-detail-icon.png` | `ts/apps/store-detail/app/icon.png` | 64×64 | 店舗詳細のタブのアイコン |
| `icon/store-detail-apple-icon.png` | `ts/apps/store-detail/app/apple-icon.png` | 180×180 | 同、ホーム画面のアイコン |
| `icon/dashboard-web-icon.png` | `ts/apps/dashboard-web/src/app/icon.png` | 64×64 | 管理用ダッシュボードのタブのアイコン |
| `icon/dashboard-web-apple-icon.png` | `ts/apps/dashboard-web/src/app/apple-icon.png` | 180×180 | 同、ホーム画面のアイコン |
| `icon/dashboard-web-brand-icon.png` | `ts/apps/dashboard-web/public/brand-icon.png` | 64×64 | 管理用ダッシュボードの帯とログイン画面のワードマークのアイコン |
| `ogp/survey-web-ogp.jpg` | `ts/apps/survey-web/public/ogp.jpg` | 1200×630 | QR口コミ支援のリンクを共有したときの画像 |
| `ogp/survey-web-ogp.webp` | `ts/apps/survey-web/public/ogp.webp` | 1200×630 | 同（WebP 版。公開トップの画面にも載せている） |
| `ogp/store-detail-ogp.jpg` | `ts/apps/store-detail/public/ogp.jpg` | 1200×630 | 店舗詳細のリンクを共有したときの画像 |
| `ogp/store-detail-ogp.webp` | `ts/apps/store-detail/public/ogp.webp` | 1200×630 | 同（WebP 版） |
| `ogp/dashboard-web-ogp.jpg` | `ts/apps/dashboard-web/public/ogp.jpg` | 1200×630 | 管理用ダッシュボードのリンクを共有したときの画像 |
| `ogp/dashboard-web-ogp.webp` | `ts/apps/dashboard-web/public/ogp.webp` | 1200×630 | 同（WebP 版） |
| `screenshots/survey.png` | `ts/apps/survey-web/public/screenshots/survey.png` | 780×1548 | 公開トップに載せる、アンケート回答画面の写真 |
| `screenshots/draft.png` | `ts/apps/survey-web/public/screenshots/draft.png` | 780×1252 | 公開トップに載せる、口コミ下書き画面の写真 |
| `richmenu/richmenu-onboarding.png` | `ts/apps/line-webhook/assets/richmenu-onboarding.png` | 2500×843 | LINE のリッチメニュー（オンボーディング中） |
| `richmenu/richmenu-completed.png` | `ts/apps/line-webhook/assets/richmenu-completed.png` | 2500×1686 | 同（店舗の登録完了後） |
| `richmenu/richmenu-completed-gbp.png` | `ts/apps/line-webhook/assets/richmenu-completed-gbp.png` | 2500×1686 | 同（店舗の登録完了後・GBP 連携を有効にしたとき） |

対象外: `ts/apps/dashboard-web/public/google-g-logo.png`。Google のログインボタンの規定どおりの素材で、こちらで作り替えるものではない。

## 差し替え方

**リンクそのものを上書きしない。** Finder でここのリンクの上に新しい画像をドラッグすると、リンクが普通のファイルに置き換わる。本物は古いまま残り、上の検査が落ちる。中身だけを書き換える。

```bash
# リンク越しに中身を書き換える（cp はリンクの先の本物へ書く）
cp ~/Downloads/new-icon.png assets/icon/survey-web-icon.png
git status   # 変わるのは ts/apps/... の本物のほうで、assets/ は変わらない
```

- 寸法は上の表と同じにする。OGP は 1200×630。リッチメニューはオンボーディング中が 2500×843、登録完了後が 2500×1686。寸法を変えると押せる範囲と絵がずれる。リッチメニューは `ts/apps/line-webhook/scripts/setup-rich-menus.ts` で LINE へ上げ直すまで反映されない
- 3 つの面のアイコンは、いまは同じ画像である。揃えるなら 6 点とも差し替える
- 色の決め方は `docs/design/line-green-palette.md` の「画像」にある。リッチメニューの生成元の HTML は `ts/apps/line-webhook/assets/source/` にある
- 新しい画像を足したら、ここにリンクを張り（`ln -s ../../ts/apps/<面>/<場所> assets/<種類>/<名前>`）、上の表と検査の件数を増やす

リポジトリの外にあるもの: LINE 公式アカウントのプロフィール画像（640×640）は LINE Official Account Manager の［プロフィール］で設定する。リポジトリには無い。
