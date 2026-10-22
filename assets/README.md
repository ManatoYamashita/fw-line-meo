# assets（ブランド系の画像の目次）

アイコン・OGP 画像・公開トップの画面写真・LINE のリッチメニュー画像を、ここから一か所でたどれるようにしてある。

**ここにある画像はすべてシンボリックリンクで、本物は各アプリの中にある。** 本物は元の場所から動かせない。

- `icon.png` と `apple-icon.png` は Next.js App Router のファイル規約で、各アプリの `app/` に無いと効かない
- 本番のイメージは `ts/` だけをビルドの範囲にして作る。`ts/` の外へ移すと、本番から画像が消える

リンクが切れたり、新しい画像にリンクを張り忘れたりすると、`ts/packages/design-tokens/test/brand-assets.test.ts` が落ちる（Issue #463）。

## 一覧（20 点）

| ここ | 本物 | 寸法 | 使われ方 |
|---|---|---|---|
| `icon/survey-web-icon.png` | `ts/apps/survey-web/src/app/icon.png` | 64×64 | QR口コミ支援のブラウザのタブのアイコン |
| `icon/survey-web-apple-icon.png` | `ts/apps/survey-web/src/app/apple-icon.png` | 180×180 | 同、iPhone のホーム画面に追加したときのアイコン |
| `icon/store-detail-icon.png` | `ts/apps/store-detail/app/icon.png` | 64×64 | 店舗詳細のタブのアイコン |
| `icon/store-detail-apple-icon.png` | `ts/apps/store-detail/app/apple-icon.png` | 180×180 | 同、ホーム画面のアイコン |
| `icon/dashboard-web-icon.png` | `ts/apps/dashboard-web/src/app/icon.png` | 64×64 | 管理用ダッシュボードのタブのアイコン |
| `icon/dashboard-web-apple-icon.png` | `ts/apps/dashboard-web/src/app/apple-icon.png` | 180×180 | 同、ホーム画面のアイコン |
| `icon/dashboard-web-brand-icon.png` | `ts/apps/dashboard-web/public/brand-icon.png` | 64×64 | 管理用ダッシュボードの帯とログイン画面のワードマークのアイコン |
| `icon/line-oa-profile.svg` | `ts/apps/line-webhook/assets/line-oa-profile.svg` | 180×180 の格子（書き出しは 640×640） | アイコンの生成元のベクター画像。各アプリの `apple-icon.png` を写し取ったもの |
| `icon/line-oa-profile.png` | `ts/apps/line-webhook/assets/line-oa-profile.png` | 640×640 | LINE 公式アカウントのプロフィール画像（LINE Official Account Manager の［プロフィール］で上げる） |
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

## LINE 公式アカウントのプロフィール画像を書き出す

生成元は `icon/line-oa-profile.svg`（Issue #466）。形と色は各アプリの `apple-icon.png` を写し取ったもので、180px に縮めて元と比べると、画素の差の平均は 2.78/255、48 を超えて違う画素は 2.05% だった（差は輪郭の 1〜2px に集まる）。SVG を直したら、Chrome で 640×640 に書き出し直す。

```bash
cd ts/apps/line-webhook/assets
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --force-device-scale-factor=1 --default-background-color=FFFFFFFF \
  --window-size=640,640 --screenshot="$PWD/line-oa-profile.png" "file://$PWD/line-oa-profile.svg"
```

- 書き出した `line-oa-profile.png` を、LINE Official Account Manager の［プロフィール］から上げる（2025 年 8 月 6 日から、プロフィール画像の設定は［アカウント設定］ではなく［プロフィール］の中にある）
- 一度変えると 1 時間は変え直せない。友だちの数が一定以上だと自分では変えられず、LINE への問い合わせが要る（LINE 公式アカウントガイドライン）
- 上げたあとの画像は、Messaging API の `GET /v2/bot/info` が返す `pictureUrl` で確かめられる
- 色は `#00B64C`（屋根の左右・右の棒）・`#C2E4C7`（屋根の中央の帯）・`#ADDCB4`（本体）・`#7DCD8B` / `#28BA56`（左・中の棒）。いまのアイコンの実際の色であり、トークンの `brand`（`#06C755`）とは少し違う
