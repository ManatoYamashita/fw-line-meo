# E2E テスト手順

このサービスの E2E は 3 層に分かれていて、1 本のコマンドでは全部を通せない。LINE の会話・カメラ・LIFF は実機でしか通らないからである。
自動で流せる 2 層はコマンドにまとめてあり、残りの実機確認は本書の手順で行う（Issue #257）。

## 1. 全体像

| 層 | 確かめるもの | コマンド | 本番への影響 |
|---|---|---|---|
| 自動層（ローカル） | 客向け口コミ画面・管理ダッシュボード・店舗詳細の実描画、Lighthouse、Go → TS の契約 | `make e2e` | なし |
| 本番の読み取り確認 | 稼働イメージ・シークレット・実疎通の鮮度・本番コミットの CI・日次ジョブ・配信の件数 | `PROJECT_ID=gen-fw-line-meo make e2e-prod-checks` | 読むだけ |
| 本番の実機確認 | QR → 回答 → 下書き → Google 投稿画面、変化を知らせる通知 → LIFF、（任意）オンボーディング | 本書の 4. | 回答が匿名集計に加算される |

自動層は、ts-ci の e2e / e2e-surfaces / lighthouse / cross-runtime が毎 PR で流しているものと同じである。ローカルで流すのは、コミットの前に赤を見るためである。
Lighthouse で測った画面が seed の店舗の回答画面であることの確認も、ts-ci の lighthouse ジョブとローカルの実行装置が同じスクリプト（`ts/apps/survey-web/perf/verify-lhr.mjs`）で行う（#264）。

## 2. 自動層（ローカル）

```bash
make e2e                                                  # 全層
bash scripts/run-e2e-local.sh --only survey,lighthouse    # 一部だけ
```

| 層 | 中身 | CI の対応ジョブ |
|---|---|---|
| `survey` | 客向け口コミ画面の Playwright。一時 DB ＋ seed ＋ Gemini モック | e2e |
| `surfaces` | 管理ダッシュボードと店舗詳細の Playwright。IdP をスタブへ差し替えたビルドで、データは fixture が返す | e2e-surfaces |
| `lighthouse` | 客向け画面の Lighthouse（LCP・accessibility）と、測った画面が seed の店舗の回答画面であることの確認（`perf/verify-lhr.mjs`。CI と同じもの） | lighthouse |
| `cross-runtime` | Go 日次バッチ → TS 配信の契約検証（実 DB 越し） | cross-runtime |

前提は pnpm、Homebrew の postgres（initdb / pg_ctl / psql）、go、lsof、Chrome である。コンテナランタイムは要らない。

Playwright は既定で付属の Chromium を使う。**ローカルでも付属 Chromium で流すこと。** `make e2e` は差し替えの有無にかかわらず、流す前に付属 Chromium を入れる（入っていれば何もしない）。そのため実行装置から流す限り、差し替えてもダウンロードは省けない。CI も付属 Chromium を使う。

インストール済みのブラウザで流したいときは、`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` に実行ファイルのパスを渡す。付属 Chromium のダウンロードを省くための仕組みで、CI（`CI` が立っている環境）ではこの変数を無視する。判定は `@fwlm/e2e-support/browser` の 1 箇所にあり、3 面の `playwright.config.ts` が共有している。差し替えたブラウザには `--disable-gpu` を渡し、付属 Chromium と同じソフトウェア描画に寄せている。それでも付属 Chromium と同じ結果にはならない。2026-09-27 に surfaces 層を流した結果は次のとおり（#381）。

| 差し替え先 | 所要時間 | 結果 | 起きたこと |
|---|---|---|---|
| なし（付属 Chromium） | 59 秒 | 100 件すべて緑 | — |
| Google Chrome | 159 秒・182 秒 | 2 回で計 3 件赤 | R3 の「描画が安定していない」（同じ状態の 2 枚に差がある） |
| Aside | 3384 秒（56 分） | 1 件赤 | 1 件が 17 分止まって時間切れ。終了処理で止まる（下記） |

**Aside は使わない**（#381）。Aside は Playwright が渡す `--disable-breakpad` を受けても `chrome_crashpad_handler` を 2 本起動する。これと、そこから起動される AsideUpdater の crash handler が Aside の標準エラー出力を継ぎ、本体の終了後も居残る。Playwright はブラウザの標準入出力が全部閉じるまで終了を待つので、`browser.close()` のたびに止まる。単独の起動・終了で 8〜50 秒かかり（付属 Chromium は 10ms 前後、Google Chrome は 40ms 前後）、居残りには上限が無い。ワーカーの終了で止まれば 5 分後に強制終了され、テストが全件緑でも exit 1 になる。実行中のワーカーで止まった実例では 55 分間 1 件も進まず、居残ったプロセスを止めた 1 秒後に再開した。居残りを消す手として `--disable-crash-reporter`・`--disable-crashpad-for-testing`・`--disable-crashpad-forwarding`・環境変数 `CHROME_HEADLESS=1` の 4 つを 5 回ずつ試したが、**どれを付けても終了処理で止まった**（効く手は見つかっていない・#386）。同じ手を試し直さない。

Google Chrome の R3 の赤は、#378 で Aside に起きたものと症状が同じである（原因は切り分けていない）。#378 では、GPU で描かせると同じ状態を描き直すたびに濃淡や罫線の色が 1/255 揺れ、画素差で測る検査（dashboard-web の `mobile-layout.spec.ts` の R3）が散発的に落ちた（GPU で描かせた Aside で 11〜18%）。Aside は `--disable-gpu` で揺れが止まったが、Chrome では付けても赤が残る。**画素の一致を前提にする検査がローカルでだけ落ちるときは、まず変数を外して付属 Chromium で流し直す**（`env -u PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH make e2e`）。

手で流すと踏む罠は、実行装置の側で扱っている。

- node 24 未満なら nvm の v24 へ切り替える（`ts/package.json` の engines。版が違うとバンドル容量が CI とずれる）
- 使うポート（各 `playwright.config.ts` と `lighthouserc.json` から読む）に先客がいれば、その層を止める。Playwright はローカルでは既存のサーバーを再利用するので、先客が別アプリだとその画面を測ってしまう。先客は止めない（他のセッションのものでありうる）
- `surfaces` の後、IdP スタブ入りのビルドを通常のビルドへ戻す。途中で中断（Ctrl-C）したときは戻さずに止まり、スタブ入りのビルドが残りうることと戻し方を表示する
- 前提のコマンド（psql・go・npx など）が無い層だけを止め、ほかの層は流す。node 24 と pnpm は全層に要るので、無ければ全層を止める
- Gemini モックの `NODE_OPTIONS` は `survey` の Playwright にだけ渡す
- DB と鍵を明示して渡す。survey-web の `.env.local` は既存の env を上書きしないので、開発用 DB や実の鍵へは繋がらない
- シェルに残った `E2E_BASE_URL` などの値を外す（残っていると、サーバーを起動せずにその URL を測る）
- Lighthouse は「店舗が見つからない 1 段落の画面」でも合格しうるので、lhci の後に `perf/verify-lhr.mjs` で測った画面を確かめる。見るのは次の 4 つで、判定の中身は `perf/lhr-verification.mjs` の 1 箇所にある
  - 結果の件数が lighthouserc.json の回数ちょうどであること
  - URL が seed の店舗の回答画面であること
  - LCP 要素が seed の店名であること。lhci が標準出力の区切りで 1 文字を U+FFFD に化けさせた形（その 1 文字の UTF-8 のバイト数までの 2 個以上の連続が 1 箇所）だけは通し、`WARN:` の行を出す（#408）。化けは測定 180 回に 1 回なので、`WARN:` が出ないことは上流が直った証拠にならない。許容の撤去は、上流の修正が `@lhci/cli@0.15.x` の範囲で公開された（または ts-ci の版の指定を上げた）後に、その版の `src/collect/node-runner.js` を読んで判断する（#410）
  - 回答フォームの accessibility の監査（`button-name`・`label`）が評価されていること

結果は最後の表で層ごとに読む。Playwright の想定内の失敗（`test.fail`）は ✘ と表示されるが、passed に数えられる。✘ の有無ではなく、層の PASS / FAIL と件数で判断すること。
検査したコミットが origin/main と違えば WARN が出る。

## 3. 本番の読み取り確認

```bash
PROJECT_ID=gen-fw-line-meo make e2e-prod-checks
```

本番の状態は一切変えない。運用者の資格情報で実行する（gcloud は本番プロジェクトの閲覧とログの閲覧、gh はリポジトリの閲覧）。CI からは呼ばない。ログは件数の項目だけを表示し、本文は出さない。

| # | 確かめること | 赤のときに疑うこと |
|---|---|---|
| 1 | 稼働イメージが origin/main と一致する。デプロイ待ち・デプロイ中（猶予内の未反映）は WARN | デプロイの失敗・未反映 |
| 2 | シークレットの version 構成が宣言どおり | 実値の未投入（プレースホルダーのまま） |
| 3 | 外部 API 実疎通の記録が有効期間内 | `infra/README.md` §8 の手順で実疎通をやり直す |
| 4 | 本番のコミットに対する ts-ci の E2E ジョブ（e2e / e2e-surfaces / lighthouse / cross-runtime）が success | 本番のコミットが自動層を通っていない |
| 5 | daily-batch と summary-delivery の直近の実行が成功していて新しい | Scheduler やジョブの失敗 |
| 6 | 直近 24 時間の配信で、失敗と上限超過が 0 件、完了後メニューの準備判定が true、対象がすべて「送信」か「理由つきの見送り」に数えられている。同じ期間に配信の致命的な失敗（delivery-job.fatal）が無い | 配信の失敗・上限超過・完了後メニューの差し替え漏れ・記録されない対象 |

4 を置いているのは、ローカルで流した自動層の結果が、本番とコミットが違えば本番の証拠にならないからである。2026-09-13 の実施では、ローカルで検査したコミットが本番より 16 コミット古かった。

6 で「送信した件数」を合格の条件にしていないのは、通知を**変化があった日にだけ**送るからである。1 通も送らない実行は正常でありうる。代わりに、送らなかった対象がすべて理由つきで記録されていること（当日の集計なし・変化なし・比較不能・メニュー未準備）と、完了後メニューの準備判定が通っていることを見る。準備判定は、メニューの差し替えをやり忘れて「誰にも届かないまま毎時の実行だけが成功している」状態を赤にするための条件である。

完了後メニューの差し替え（`infra/README.md` §10）の途中では、6 は**意図どおり赤になる**。Step B（コードのマージとデプロイ）から Step C（メニューの差し替え）の間、設定されている完了後メニューはまだレポートの 3 導線を持たないので、準備判定が false になり、対象は「メニュー未準備」の見送りに数えられる。この期間の赤を装置の誤りと読んで条件を緩めないこと。

**差し替えを終えても、すぐには緑にならない。** 6 は `jsonPayload.targetsTotal > 0` の実行だけを「直近の配信」として拾う（対象 0 件の実行は数えない）。そのため、新しいコードで**対象のある実行が 1 回走るまで**は、旧コードが残した最後の行を読み続ける。旧コードの行は新しい実行サマリーの項目（`reportMenuReady`・`skippedNoChange`・`skippedNotComparable`・`skippedMenuUnavailable`）を持たないので、判定は「実行サマリーの項目が欠けています」で赤くなる。**これは「コードが壊れている」ではなく「新しい実行サマリーをまだ観測していない」の意味である。** 配信時刻が既定（7 時）だけの本番では、差し替えの翌朝 7 時の実行で緑になる。差し替え自体が済んだことは、§10-5 のとおり準備判定が true に変わったことで確かめる（対象 0 件の実行のログでも読める）。

6 が読む実行は「対象が 1 件以上あった実行」だけに絞り込む（`jsonPayload.targetsTotal>0`）。対象が 1 件も無い実行は、その時刻に配信時刻の合う店舗が無かった回であり、読んでも内訳が空だからである。対象が出るのは店舗ごとに 1 日 1 回（`owners.delivery_hour` と一致する時刻）なので、直近 24 時間にその実行がひとつも入らなければ、配信が壊れていなくても「直近 24 時間に、配信対象のある実行がありません」で赤になる。24 時間の窓の縁に当たった場合と、配信時刻の合う店舗がそもそも無い場合の両方で起こる。この文言の赤を見たら、配信の失敗を疑う前に、対象になる店舗と配信時刻を確かめること。

本番スキーマと `db/migrations` の一致は、この装置では確かめていない（#251）。

## 4. 本番の実機確認

### 4-1. 始める前に

- 3. の装置に FAIL が無く、デプロイ待ちの WARN も出ていないこと（WARN のままだと、確認の途中で本番のコードが入れ替わる）
- 検証用のテナントを使い回す。新しく作らず、スモークテスト代理店配下の確定済み店舗を使う。本番の店舗・オーナーを削除する経路は無い。店舗を毎朝の取得と配信の対象から外す手段は停止（Issue #252）だけで、停止しても行は残る。停止は dashboard-web の `/stores` の「利用状況」列の「停止」ボタンで行う（運営は全店舗、代理店は担当店舗のみ）。確認に使う検証用店舗は停止しない（停止中はアンケート・QR 発行・詳細画面・レポートも使えなくなる）
- 実クライアントの店舗では試さない。回答は匿名集計に加算され、匿名である以上あとから取り除けない
- このリポジトリは公開されている。実在の店舗名と否定的な文面を Issue に並べないこと（伏せ字にする）

### 4-2. 客向け口コミ（機能3）

1. 運営アカウントで dashboard-web の `/stores` を開き、検証用店舗の「QR 発行」を押す
2. 表示された QR をスマホの標準カメラで読む（LINE の中では読まない。客向け機能は LINE を通らない設計である）
3. 星・良かった点・気になった点・一言を回答する。入力した内容は控えておく（回答の個票は保存されない設計なので、あとから確かめる手段が無い）
4. 下書きを 4-5. の方法で入力と突き合わせる。同じ入力で何本か見たいときは、「別の文章を生成」（残り 3 回）を使う。匿名集計への加算は最初の送信 1 件だけで済む。プライベートタブで送信し直すと 2 件目が加算され、取り消せない
5. 「文章をコピー」を押し、続けて「Google のクチコミ欄を開く」を押して、Google の投稿画面が開いたところで止める
6. 別のブラウザかプライベートタブで、星 1 でも同じ導線（「文章をコピー」「Google のクチコミ欄を開く」）が出ることを確かめる

合格の条件は、導線が最後まで通ること、低評価でも同じ導線が出ること、下書きが入力の事実だけで書かれていることの 3 つである。

下書きの中身だけを確かめるときは、スマホの代わりにデスクトップのブラウザで 1 の QR パネルが示す URL（`https://review.firstweb-works.com/s/<店舗 ID>`）を開いてもよい。survey-web は客と同じ経路を通る。省けるのは、カメラで読む手順だけである（Issue #339 の本番確認で使った）。

### 4-3. 変化を知らせる通知と LIFF（機能1）

通知は**変化があった日にだけ**届く（新着口コミか順位の変動）。届いていない日を不具合と読まないこと。その日に何が起きたかは 3. の 6 が理由ごとの件数で示す（変化なし・比較不能・当日の集計なし・メニュー未準備）。

1. 3. の 6 で、直近の実行の内訳を読む。送信が 0 件でも、対象がすべて理由つきの見送りに数えられていれば正常である
2. 送信のあった実行があれば、検証用オーナーの LINE でその通知を開き、4-6. の方法で表示値を確かめる
3. リッチメニューの「詳細を見る」で LIFF を開き、今日のポジション・自店の評価・競合との比較・直近の推移が出ることを確かめる

### 4-4. オンボーディング（任意）

完了済みの LINE アカウントでは、オンボーディングをやり直せない（完了した段階は、どの入力にも同じ案内を返すだけである）。未登録の LINE アカウントが要る。
owner-line-unlink（Issue #487）のデプロイ後は、運営・代理店がオーナー一覧でそのアカウントの LINE の連携を解除すれば、同じアカウントで最初からやり直せる。解除とやり直しを本番で確かめる手順は 5-8. にある。解除するたびにオーナーの行が 1 つ増え、消す経路は無いので、オンボーディングを見るためだけに解除を繰り返さない。

1. 公式アカウントのトークにスタンプを 1 つ送り、返信で状態を確かめる。テキストは送らない。招待コードの段階では、テキストはすべて間違った招待コードとして数えられ、5 回で 10 分ロックされる
2. 運営アカウントで、検証用の代理店を選んで `/invite-codes` から招待コードを発行する
3. LINE で招待コードを送る → 店名を送る → 候補から選ぶ → 確定する
4. 完了メッセージが届き、リッチメニューが完了版に切り替わり、`/stores` に確定済みとして出ることを確かめる

### 4-5. 下書きの突き合わせ

画面が出ただけでは合格にしない。下書きの記述を 1 つずつ入力と突き合わせる。

| 下書きの記述（例） | 対応する入力 | 判定 |
|---|---|---|
| 「駅前を通る際に立ち寄りました」 | なし | 創作（来店の経緯） |
| 「非常に小さく」 | 一言「小さかった」 | 誇張 |
| 「清潔さに関して気になる点があり」 | 気になった点「清潔さ」 | 正しい |
| 「開放的で落ち着いた雰囲気」「独特の雰囲気」 | 良かった点「雰囲気」の選択のみ | 選んだ観点への属性の補完 |
| 「期待して伺いました」「期待していただけに」 | なし | 来店前の期待の創作 |
| 「また機会があれば利用したい」「再訪は慎重に考えたい」 | なし | 再訪の意向の創作 |
| 「その他の要素についての特筆すべき事項は特にない」「気になった点は特になく」 | 選ばなかった観点 | 選ばなかったことを「無かった」と書く |
| 「落ち着いて過ごすことが難しかった」 | 気になった点「雰囲気」 | 体験の状態の推し量り |

見る型は次のとおりである。

- 来店の経緯・動機・日時・同行者の創作
- 来店前の期待（「期待して」「期待以上」「期待していただけに」）と再訪の意向（「また〜したい」）の創作。アンケートはどちらも尋ねない
- 選んだ観点への具体的な属性・状態の補完（「開放的」「香り漂う」「濃厚」）。選んだ観点は項目名の水準（「雰囲気が良かった」）までが素材である
- 選ばなかったことを「無かった」と書く断定（「良かった点は特にありません」「気になった点は特になく」「その他は特筆すべき点はない」）。選ばなかったことは、無かったことではない
- 一言に無い具体的な事実の追加と、気になった点からの体験の推し量り
- 強調語による誇張
- 選んだ観点の意味のすり替え（評価を来店の動機に変える など）
- 選んでいない観点への言及

本番の事後検証（`ts/apps/survey-web/src/lib/draft/generator.ts` で検出したら 1 回作り直す）が見るのは、選んでいない観点への言及、来店前の期待、選ばなかったことを「無かった」と書く断定の 3 つだけである（後の 2 つは Issue #413）。ほかの型のいくつかは eval の検出器で下限を測っている（`ts/apps/survey-web/eval/README.md`）が、本番では検出されない。どの型も検出は下限なので、本番の下書きでは人の目で突き合わせる。

### 4-6. 表示値の確認

- 通知を見て、どの店舗のものか分かる（多店舗オーナーには同じ時刻に複数届く）
- 通知に書かれた変化（新着口コミの件数・順位の起点と終点）が、詳細画面の値と食い違わない
- 詳細画面の評価は 1〜5 の範囲にある。★0 や範囲外の値は不具合である
- 詳細画面の順位と、並んでいる評価の大小が整合している
- Google Maps の帰属表示（「データ提供: Google Maps」）が通知にも詳細画面にもある

### 4-7. やってはいけないこと

- Google に実際に投稿しない。実体験に基づかないクチコミになる
- 一言に個人情報を書かない
- LINE の状態をテキストで偵察しない（4-4. の 1）

### 4-8. 記録

実施のたびに、追跡 Issue へ次を残す。

- 実施日と実施者
- 本番のコミット（3. の出力）と、自動層を流したコミット（2. の出力）
- 各層・各手順の結果
- 見つけた不具合の Issue 番号

## 5. オーナーの LINE 連携の解除の公開と実測（Issue #487）

owner-line-unlink（`.kiro/specs/owner-line-unlink/`）を本番へ出し、効いたことを確かめる手順である。順序は design.md の Migration Strategy のとおりで、入れ替えない。
A〜D は実装 PR のマージより前に行い、A2 はデプロイを確かめた後に行う。main の ts-ci が緑になると `deploy.yml` が自動でデプロイするので、マージの後に当てると、新しいコードが無い列・権限・env を読む（新しい dashboard-api は LINE の env が無いと起動しない）。

| Step | 何をするか | いつ | 節 |
|---|---|---|---|
| A | migration `0018` を当てる | マージ前 | 5-2 |
| B | `infra/sql/grants.sql` を当て直す | マージ前 | 5-3 |
| C | 本番の列・CHECK・列権限を照会する | マージ前 | 5-4 |
| D | dashboard-api に LINE のチャネル ID とチャネルシークレットを渡す（Terraform） | マージ前・イメージより先 | 5-5 |
| E | 照会の結果を Issue #487 に記録してからマージし、デプロイを確かめる | C・D の後 | 5-6 |
| A2 | 2026-10-24 に手作業で切り離した行（`detached-` 接頭辞）を解除済みへ移す（一回限り） | E のデプロイを確かめた後・F の前 | 5-7 |
| F | 検証用のアカウントで解除と引継ぎを実測する | E の後 | 5-8 |

記録の雛形は 5-9. にある。

### 5-1. 始める前に

- 作業はこの PR のブランチ（head）の checkout で行う。`0018`、`grants.sql` の owners の列単位の付与、dashboard-api の env の配線は、マージまで main に無い
- `0018` の番号が open PR と重ならないことを確かめる（下のコマンドで、この PR 以外の番号が出ないこと）。番号のガードは main しか見ない
- 接続は `infra/README.md` §3 の Auth Proxy（ポート 15432）で行い、`cloudsql.iam_authentication` が `on` であることを確かめてから流す。ユーザーは表の所有者（`postgres`）である。`ALTER TABLE` は所有者でないと実行できず、`REVOKE` は付与した本人でないと効かない
- 本番の識別子（オーナー・店舗・代理店の id）は先頭 8 文字までしか記録しない。LINE ユーザー ID は先頭 8 文字も Issue・PR に書かない（リポジトリは公開されている）
- A からマージまでの間、`prod-schema-drift`（6 時間ごと）は `0018` の列と制約を「migration に無い本番対象」として赤にし、追跡 Issue（ラベル `prod-schema-drift`）を立てる。main の migration にまだ無いからで、想定どおりである。マージ後の次の実行で閉じる。A からマージまでを 1 日のうちに終える
- A2 はデプロイの後に行う。移した行は `line_user_id` が NULL になり、旧 delivery-job は解除済みを対象から外す述語を持たないので、配信時刻のたびにその店舗の配信の予約で失敗する（`summary_deliveries.line_user_id` は NOT NULL）。移す前の `detached-` の行は `0018` の CHECK の上では連携中として有効なので、A〜E の間に残しておいてよい

```bash
gh pr list --repo ManatoYamashita/fw-line-meo --state open --json number,files \
  --jq '.[] | select(any(.files[]; .path | startswith("db/migrations/0018"))) | .number'
```

ログと退避の置き場所を、リポジトリの外に先に作る。5-3. の当て直しのログと 5-7. の退避はここへ入る。

```bash
BACKUP_DIR="$HOME/fwlm-prod-backup/487"
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
```

### 5-2. Step A: migration 0018 を当てる

まず、`db/migrations` の全番号が本番に当たっていて、足りないのが `0018` の対象だけであることを確かめる。`0017`（#486）は適用済みのはずである。照合は `prod-schema-drift` と同じスクリプトを、このブランチの migration で流して行う（読むのは本番の catalog の名前だけで、表の行は読まない）。手元の postgres は本番と同じ 16 系であること（版が違うと catalog の行がずれる）。

```bash
# §3 の PGPASSWORD を export したシェルで流す。一時 DB はこのブランチの migration を当てた正解側に使う
ts/scripts/with-test-db.sh bash -c 'PROJECT_ID=gen-fw-line-meo EXPECTED_DATABASE_URL="$DATABASE_URL" \
  PROD_DATABASE_URL="postgresql://postgres@127.0.0.1:15432/fwlm" bash scripts/check-prod-schema-drift.sh'
```

当てる前の期待は exit 1 で、「本番に存在しない対象」が次の 7 件だけ、「migration に無い本番対象」が 0 件であること。

- 列（owners）: `line_unlinked_at`・`menu_pending_line_user_id`・`taken_over_by_owner_id`
- 制約（owners）: `ck_owner_line_link`・`ck_owner_menu_pending`・`ck_owner_taken_over`・`owners_taken_over_by_owner_id_fkey`

ほかの対象が足りなければ、先行の migration の適用漏れである。`0018` を当てずに止める（`grants.sql` は全表を前提にするので、漏れがあると 5-3. で全付与が巻き戻る）。

続けて `0018` の冒頭のコメントにある事前確認を流し、当てる。

```bash
psql -X -At <<'SQL'
SELECT conname FROM pg_constraint WHERE conrelid = 'audit_logs'::regclass AND contype = 'c';
SELECT count(*) FROM owners WHERE line_user_id IS NULL;
SELECT count(*) FROM pg_constraint
 WHERE conrelid = 'owners'::regclass
   AND conname IN ('ck_owner_line_link', 'ck_owner_menu_pending', 'ck_owner_taken_over');
SQL
# 期待: ck_audit_logs_action の 1 行 / 0 / 0

psql -X -v ON_ERROR_STOP=1 -f db/migrations/0018_owner_line_unlink.sql
# 期待: BEGIN / ALTER TABLE / ALTER TABLE / COMMIT
```

当てた後に、冒頭のコメントの「適用の確認」を流す。owners の 4 列がすべて `is_nullable = YES`、owners の CHECK に 3 本、`ck_audit_logs_action` の定義に `owner_line_unlinked`・`owner_stores_taken_over`・`store_taken_over` が入っていること。最後に上の照合をもう一度流し、`OK: 本番スキーマは db/migrations 適用後の catalog と一致しています` が出ること（exit 0）。

### 5-3. Step B: grants.sql を当て直す

当てるのはこのブランチの `infra/sql/grants.sql` である。owners の INSERT に `invite_code_id` を含む版でなければならない（含まない版を当てると、新しいオーナーの登録が `permission denied` で失敗する）。

PostgreSQL の `REVOKE` は自分が付与した権限しか剥がせず、剥がせなくても警告で終わり、`ON_ERROR_STOP` では止まらない（store-suspension で得た教訓）。当てる前に、owners の現行の付与者が接続ユーザーと一致することを確かめる。`information_schema.role_table_grants` は付与者か被付与者が自分の行しか見せないので、`pg_class` の ACL を直接読む。

```bash
grep -c 'delivery_hour, invite_code_id' infra/sql/grants.sql   # 期待: 1

psql -X <<'SQL'
SELECT DISTINCT g.rolname AS grantor, current_user AS me
  FROM pg_class c
 CROSS JOIN LATERAL aclexplode(c.relacl) a
  JOIN pg_roles g ON g.oid = a.grantor
  JOIN pg_roles e ON e.oid = a.grantee
 WHERE c.oid = 'public.owners'::regclass
   AND a.privilege_type IN ('INSERT', 'UPDATE')
   AND e.rolname IN ('sa-line-webhook@gen-fw-line-meo.iam', 'sa-survey-web@gen-fw-line-meo.iam');
SQL
# 期待: 1 行で grantor と me が同じ。違えば止めて、付与者のユーザーで繋ぎ直す

LOG="$BACKUP_DIR/grants-apply.log"
psql -X -v ON_ERROR_STOP=1 -f infra/sql/grants.sql > "$LOG" 2>&1; echo "exit=$?"
grep -c 'WARNING' "$LOG"
# 期待: exit=0 / 0。WARNING が 1 件でもあれば（no privileges could be revoked など）失敗として扱い、C へ進まない
```

### 5-4. Step C: 本番の列・CHECK・列権限を照会する

CI の権限の検査（`db/test/check_owner_line_privileges.sh`）は superuser で流れるので、付与者の食い違いを再現できない。本番ではこの照会が唯一の確認である。line-webhook・客向け Web のどちらかが `line_user_id` を UPDATE できる結果なら、マージにも解除の操作にも進まず、付与者を合わせて 5-3. からやり直す。

```bash
psql -X <<'SQL'
WITH checks(role_name, col, priv, want) AS (
  SELECT r, c.col, c.priv, c.want
    FROM unnest(ARRAY['sa-line-webhook@gen-fw-line-meo.iam', 'sa-survey-web@gen-fw-line-meo.iam']) AS r
   CROSS JOIN (VALUES
     ('line_user_id',              'INSERT', true),
     ('line_user_id',              'UPDATE', false),
     ('line_unlinked_at',          'INSERT', false),
     ('line_unlinked_at',          'UPDATE', false),
     ('menu_pending_line_user_id', 'INSERT', false),
     ('menu_pending_line_user_id', 'UPDATE', false),
     ('taken_over_by_owner_id',    'INSERT', false),
     ('taken_over_by_owner_id',    'UPDATE', true),
     ('invite_code_id',            'INSERT', true),
     ('invite_code_id',            'UPDATE', false),
     ('onboarding_status',         'UPDATE', true)
   ) AS c(col, priv, want)
  UNION ALL
  SELECT 'sa-dashboard-api@gen-fw-line-meo.iam', c, 'UPDATE', true
    FROM unnest(ARRAY['line_user_id', 'line_unlinked_at', 'menu_pending_line_user_id']) AS c
)
SELECT role_name, col, priv, want,
       has_column_privilege(role_name, 'public.owners', col, priv) AS got,
       has_column_privilege(role_name, 'public.owners', col, priv) = want AS ok
  FROM checks
 ORDER BY role_name, col, priv;

-- テーブル単位の INSERT・UPDATE が剥がれていること（残っていると列の絞りが効かない）
SELECT r,
       has_table_privilege(r, 'public.owners', 'INSERT') AS table_insert,
       has_table_privilege(r, 'public.owners', 'UPDATE') AS table_update
  FROM unnest(ARRAY['sa-line-webhook@gen-fw-line-meo.iam', 'sa-survey-web@gen-fw-line-meo.iam']) AS r;
SQL
```

期待: 1 つ目は 25 行で `ok` がすべて `t`。2 つ目は 2 行で、どちらも `f`・`f`。列と CHECK は 5-2. の「適用の確認」の結果を使う。

### 5-5. Step D: dashboard-api に LINE の設定を入れる（イメージより先）

新しい dashboard-api は `LINE_CHANNEL_ID`・`LINE_CHANNEL_SECRET` が無いと起動時に落ちる。旧イメージは知らない env を無視するので、env を先に入れる。CI が替えるのはイメージだけで、env は Terraform が持つ（`infra/README.md` §5）。

- apply はこのブランチの checkout から行う（main の宣言にはまだ env が無い）。マージまでの間に、main の checkout から dashboard-api を apply しない（env が外れ、マージ後のイメージが起動できなくなる）
- 素の `make tf-apply` を打たず、`-target` で 2 つに絞る（`infra/README.md` §10-0 の「apply の作法」。`module.guardrails` を巻き込まないため）。保存した plan は当てない
- Terraform は ADC の資格情報で動く（gcloud のアカウントとは別の主体である）

```bash
# 1. 進行中のデプロイが無いこと（in_progress / queued が無い）
gh run list --repo ManatoYamashita/fw-line-meo --workflow deploy-prod --limit 3

# 2. plan。差分がこの 2 つだけであることを、属性まで下りて読む
terraform -chdir=infra/envs/prod plan \
  -target='module.run_services.google_cloud_run_v2_service.svc["dashboard-api"]' \
  -target='module.run_services.google_secret_manager_secret_iam_member.accessor["dashboard-api.LINE_CHANNEL_SECRET"]'

# 3. 同じ -target で apply
terraform -chdir=infra/envs/prod apply \
  -target='module.run_services.google_cloud_run_v2_service.svc["dashboard-api"]' \
  -target='module.run_services.google_secret_manager_secret_iam_member.accessor["dashboard-api.LINE_CHANNEL_SECRET"]'
```

plan の期待: `line-channel-secret` への dashboard-api の SA の accessor が 1 つ追加、dashboard-api のサービスが in-place の変更で、env に `LINE_CHANNEL_ID`（値）と `LINE_CHANNEL_SECRET`（`secret_key_ref`）が足されるだけ。イメージは差分に出ない（`ignore_changes`）。ほかの差分が出たら当てずに読む。
サービスの更新が secret の権限で失敗したときは、IAM の反映待ちである。数分おいて同じ apply をもう一度流す。

当てた後の確認（値は出さず、env の名前だけを読む）:

```bash
gcloud run services describe dashboard-api --project gen-fw-line-meo --region asia-northeast1 \
  --format='value(status.latestReadyRevisionName,status.latestCreatedRevisionName)'
gcloud run services describe dashboard-api --project gen-fw-line-meo --region asia-northeast1 \
  --format='value(spec.template.spec.containers[0].env[].name)'
```

期待: 1 つ目の 2 つの名前が同じ（新しいリビジョンが旧イメージのまま Ready）。2 つ目に `LINE_CHANNEL_ID` と `LINE_CHANNEL_SECRET` がある。dashboard-web の `/stores` が従来どおり開くこと。

### 5-6. Step E: 記録してからマージし、デプロイを確かめる

1. 5-2.〜5-5. の結果を 5-9. の雛形で Issue #487 に記録する。記録してからマージする（Req 9.1）
2. PR をマージする。`gh run list --repo ManatoYamashita/fw-line-meo --workflow deploy-prod --limit 3` で、マージしたコミットの deploy-prod が success になるまで待つ（PR には出ないので自分で見る）
3. `PROJECT_ID=gen-fw-line-meo make e2e-prod-checks` の 1 が PASS で、デプロイ待ちの WARN が出ていないこと
4. 5-5. の 1 つ目の `gcloud` で、dashboard-api の新しいリビジョンが Ready であること（起動に失敗すると 2 つの名前が食い違う）
5. dashboard-web の「オーナー一覧」（`/owners`）が開くこと。5-9. の E の行を Issue #487 に追記し、続けて 5-7. の A2 を行う

### 5-7. Step A2: 手作業で切り離した行を解除済みへ移す（一回限り・デプロイの後）

5-6. でデプロイを確かめた後に行う（理由は 5-1.）。新しい delivery-job は解除済みのオーナーの店舗を配信の対象から外すので、移した行の配信は失敗せずに止まる。

2026-10-24 に、オンボーディングの撮り直しのため、運営自身のオーナーの `line_user_id` を `'detached-YYYYMMDD:' || 元の ID` へ書き換えた。この行は `0018` の CHECK の上では「連携中」に見えるので、店舗を引き継げず、配信は存在しない宛先へ push を試み続ける。正規の「解除済み」へ移す。

- `menu_pending_line_user_id` は NULL にする。個別メニューは 2026-10-24 に手作業で外し済みで、元のアカウントはその後に新しいオーナーとして登録し直している。印を残すと、外し直しの操作が新しいオーナーのメニューを外す余地を作り、個人に紐づく識別子も必要以上に残る
- `line_unlinked_at` は変換した時刻（`now()`）にする。`taken_over_by_owner_id` は NULL のままにする（まだ誰も引き継いでいない）
- 会話（`onboarding_sessions`）は 2026-10-24 に消してある。残っていれば記録と状態が食い違っているので、消さずに止める（同じ LINE ユーザー ID の会話は、登録し直した新しいオーナーのものでありうる）
- 監査記録は書かない（アプリの操作ではない）。実施の記録は Issue #487 に残す

1. 照会する。件数（N）を控える。0 件なら（撮影の後に手で戻した場合）この節の 2〜4 を飛ばし、0 件だったことを記録する

   ```bash
   psql -X <<'SQL'
   SELECT count(*) AS detached FROM owners WHERE line_user_id LIKE 'detached-%';
   -- 接頭辞は 'detached-YYYYMMDD:' の 18 文字までだけを出す（元の LINE ユーザー ID は出さない）
   SELECT left(o.id::text, 8) AS owner8,
          left(o.line_user_id, 18) AS prefix,
          o.onboarding_status,
          o.delivery_hour,
          o.line_unlinked_at,
          o.menu_pending_line_user_id IS NOT NULL AS pending,
          (SELECT count(*) FROM stores s WHERE s.owner_id = o.id) AS stores,
          (SELECT count(*) FROM onboarding_sessions os WHERE os.owner_id = o.id) AS sessions
     FROM owners o
    WHERE o.line_user_id LIKE 'detached-%'
    ORDER BY o.created_at;
   SQL

   # 移す行の id を控える（オーナーの id は秘密ではない）。4 で、移した行だけを照会するのに使う
   DETACHED_IDS="$(psql -X -At -c "SELECT coalesce(string_agg(id::text, ',' ORDER BY created_at), '') FROM owners WHERE line_user_id LIKE 'detached-%'")"
   printf '%s' "$DETACHED_IDS" | tr ',' '\n' | grep -c .   # 期待: N
   ```

   期待: `prefix` がすべて `detached-20261024:`、`line_unlinked_at` が空、`pending` が `f`、`sessions` が 0。`delivery_hour` は記録に使わない（デプロイの後なので配信の失敗にならない）

2. 退避する。行には元の LINE ユーザー ID が入っているので、リポジトリの外に置き、Issue・PR・リポジトリへ貼らない

   ```bash
   # 5-1. で作った BACKUP_DIR を使う。マージを挟んで別のシェルで流すときのために、同じ定義を繰り返す（流し直しても害は無い）
   BACKUP_DIR="$HOME/fwlm-prod-backup/487"
   mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"
   psql -X -At -v ON_ERROR_STOP=1 \
     -c "SELECT row_to_json(o) FROM owners o WHERE line_user_id LIKE 'detached-%' ORDER BY created_at" \
     > "$BACKUP_DIR/owners-detached.jsonl"
   chmod 600 "$BACKUP_DIR/owners-detached.jsonl"
   wc -l < "$BACKUP_DIR/owners-detached.jsonl"   # 期待: N
   ```

3. 移す。`expected` には 1 で控えた N を手で書く。照会から変わっていれば、DO ブロックが例外を投げてトランザクションごと戻る（`ON_ERROR_STOP` で psql が止まり、COMMIT まで届かない）

   ```bash
   psql -X -v ON_ERROR_STOP=1 -v expected=<N> <<'SQL'
   BEGIN;
   -- psql の変数は $$ の中へ展開されないので、トランザクション内の設定値として DO ブロックへ渡す
   SELECT set_config('fwlm.expected_detached', :'expected', true);
   DO $$
   DECLARE
     want      integer := current_setting('fwlm.expected_detached')::integer;
     remaining integer;
     sessions  integer;
     updated   integer;
   BEGIN
     SELECT count(*) INTO remaining FROM owners WHERE line_user_id LIKE 'detached-%';
     IF remaining <> want THEN
       RAISE EXCEPTION '切り離し行が % 件あります（照会では % 件）。照会からやり直してください', remaining, want;
     END IF;
     SELECT count(*) INTO sessions
       FROM onboarding_sessions os JOIN owners o ON o.id = os.owner_id
      WHERE o.line_user_id LIKE 'detached-%';
     IF sessions <> 0 THEN
       RAISE EXCEPTION '切り離し行のオーナーに会話が % 件残っています。記録と食い違うので止めます', sessions;
     END IF;
     UPDATE owners
        SET line_user_id = NULL,
            line_unlinked_at = now(),
            menu_pending_line_user_id = NULL
      WHERE line_user_id LIKE 'detached-%';
     GET DIAGNOSTICS updated = ROW_COUNT;
     IF updated <> want THEN
       RAISE EXCEPTION '更新が % 件でした（照会では % 件）', updated, want;
     END IF;
     RAISE NOTICE '解除済みへ移した行: % 件', updated;
   END
   $$;
   COMMIT;
   SQL
   ```

   期待: `NOTICE:  解除済みへ移した行: N 件` と `COMMIT`。3 列を 1 文で書くので、`ck_owner_line_link`・`ck_owner_menu_pending` を途中で破らない

4. 確かめる。解除の操作は 5-6. でデプロイ済みなので、解除済みのオーナーには画面で解除された行も混ざりうる。移した行は 1 で控えた id で絞って照会し、それ以外の解除済みは別に出す

   ```bash
   psql -X -v ids="$DETACHED_IDS" <<'SQL'
   SELECT count(*) AS detached_left FROM owners WHERE line_user_id LIKE 'detached-%';
   -- 移した行（1 で控えた id）
   SELECT left(id::text, 8) AS owner8,
          line_user_id IS NULL AS no_line_id,
          line_unlinked_at IS NOT NULL AS unlinked,
          menu_pending_line_user_id IS NULL AS no_pending,
          taken_over_by_owner_id IS NULL AS not_taken_over
     FROM owners
    WHERE id = ANY (string_to_array(:'ids', ',')::uuid[])
    ORDER BY created_at;
   -- 移した行以外の解除済み（5-6. のデプロイの後に画面で解除されたもの）
   SELECT left(id::text, 8) AS owner8, line_unlinked_at
     FROM owners
    WHERE line_unlinked_at IS NOT NULL
      AND NOT (id = ANY (string_to_array(:'ids', ',')::uuid[]))
    ORDER BY created_at;
   SQL
   ```

   期待: `detached_left` が 0。2 つ目は 1 の `owner8` と同じ N 行で、4 列がすべて `t`。3 つ目は、5-6. から A2 まで（F の前）に誰も解除していなければ 0 行である。行が出たら、それは 5-6. の後に画面で解除されたオーナーで、移し損ねではない。`owner8` と `line_unlinked_at` を記録する

5. 結果を 5-9. の A2 の行で Issue #487 に追記する（0 件で 2〜4 を飛ばしたときは、0 件だったことを書く）

### 5-8. Step F: 解除と引継ぎを実測する（Req 9.2・9.3・2.6）

使うのは 4-1. の検証用テナント（スモークテスト代理店）にいる、運営自身の LINE アカウントのオーナーである。実クライアントのオーナーでは試さない。解除すると、そのオーナーの店舗の日次の通知と詳細画面は、引き継ぐまで止まる。
引き継ぐと新しいオーナーの行が 1 つ増え、解除済みのオーナーは店舗 0 件で残る。どちらも消す経路は無いので、この手順は必要なときだけ行う。

前提:

- 5-7. まで終わっていること
- 同じ代理店の有効な招待コードがあること。無ければ運営アカウントで `/invite-codes` から発行する（引継ぎは同じ代理店の招待コードでしか起きない）
- 5 で確定し直す Place は、検証するオーナー（1 の `OWNER_ID`）が持つ確定済みの店舗の Place であること（店名で候補に出せること）。別の Place を選ぶと、引継ぎの判定（`lockPlaceHolder`）はその Place の店舗の所有者を見るので、所有者が同じ代理店の解除済みのオーナー（5-7. で移した行など）なら、検証と無関係なそのオーナーの全店舗を引き継いでしまう。店舗の無い Place なら、引継ぎではなく新しい店舗の登録になる

1. 対象のオーナーを決め、その LINE ユーザー ID をシェルの変数にだけ持つ（画面にも記録にも出さない）。宛先は推測せず、プロフィールの表示名で自分のアカウントであることを確かめる。あわせて、そのオーナーが確定済みの店舗を持つことを確かめる

   ```bash
   OWNER_ID='<検証するオーナーの id（全桁。手元だけで使う）>'
   VERIFY_UID="$(psql -X -At -v owner_id="$OWNER_ID" <<'SQL'
   SELECT line_user_id FROM owners WHERE id = :'owner_id' AND line_user_id IS NOT NULL;
   SQL
   )"
   printf '%s' "$VERIFY_UID" | grep -cE '^U[0-9a-f]{32}$'   # 期待: 1
   # 3・8 の psql は \getenv でこの値を環境変数から読む（psql の -v に渡すと argv に載る）。\getenv は psql 15 以上
   export VERIFY_UID

   # 確定済みの店舗。5 ではここに出た店舗の Place を選ぶ（オーナーの id・店名は秘密ではないが、記録には先頭 8 文字だけを書く）
   psql -X -v owner_id="$OWNER_ID" <<'SQL'
   SELECT left(s.id::text, 8) AS store8, s.name
     FROM stores s
    WHERE s.owner_id = :'owner_id'
      AND s.place_status = 'confirmed'
    ORDER BY s.created_at;
   SQL
   # 期待: 1 行以上。0 行なら引継ぎを確かめられないので、別のオーナーを選ぶ

   # チャネルアクセストークンは infra/README.md §8-3 と同じ方法で TOKEN に発行する（シークレットを argv に置かない）
   # URL も設定として渡し、LINE ユーザー ID を argv に置かない
   curl -sS -K - <<CFG | sed -n 's/.*"displayName":"\([^"]*\)".*/\1/p'
   url = "https://api.line.me/v2/bot/profile/${VERIFY_UID}"
   header = "Authorization: Bearer ${TOKEN}"
   CFG
   # 期待: 自分の LINE の表示名

   # 解除の前の個別メニュー（完了後メニューが張られている）
   curl -sS -o /dev/null -w '%{http_code}\n' -K - <<CFG
   url = "https://api.line.me/v2/bot/user/${VERIFY_UID}/richmenu"
   header = "Authorization: Bearer ${TOKEN}"
   CFG
   # 期待: 200
   ```

   この手順で発行するトークン（`/oauth2/v3/token` のステートレスなチャネルアクセストークン）は約 15 分で失効する（`.claude/skills/messaging-api/references/channel-token.md` の Stateless Channel Access Token）。2〜6 の画面の操作を挟むと、3・5 の `curl` の時点で切れていることがある。どの `curl` でも 401 が返ったら（表示名を読む `curl` は何も出さなくなる）、`infra/README.md` §8-3 と同じ方法で TOKEN を発行し直して同じ `curl` を流し直す。401 を 404（メニューが外れた）や失敗と読まない

2. 運営アカウントで dashboard-web の「オーナー一覧」（`/owners`）を開き、対象の行の「LINE の連携を解除」を押す。確認ダイアログの 3 点を読み、「解除する」を押す
   - 期待: 「<名前> の LINE の連携を解除しました。」と出て、行が「解除済み」になる
   - 「メニューを外せませんでした」と出て「解除済み（メニュー未解除）」になったら、「メニューを外し直す」を押す。外し直しで済んだことも記録する
3. 個別メニューが外れたことと、DB の状態を確かめる

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' -K - <<CFG
   url = "https://api.line.me/v2/bot/user/${VERIFY_UID}/richmenu"
   header = "Authorization: Bearer ${TOKEN}"
   CFG
   # 期待: 404（個別メニューが無い。トークには既定のオンボーディング用メニューが出る）

   psql -X -v owner_id="$OWNER_ID" <<'SQL'
   \getenv uid VERIFY_UID
   SELECT line_user_id IS NULL AS no_line_id,
          line_unlinked_at IS NOT NULL AS unlinked,
          menu_pending_line_user_id IS NULL AS no_pending
     FROM owners WHERE id = :'owner_id';
   SELECT count(*) AS sessions FROM onboarding_sessions WHERE line_user_id = :'uid';
   SQL
   # 期待: t / t / t、sessions は 0
   ```

4. スマホの LINE で、公式アカウントのトークにスタンプを 1 つ送る。テキストは送らない（4-4. の 1 と同じ理由）
   - 期待: 「友だち追加ありがとうございます。」で始まり、招待コードの送信を求める案内が返る（Req 9.2）
5. 招待コードを送る → 店名を送る → 候補から 1 の照会に出た店舗の Place を選ぶ → 確定する（前提のとおり、別の Place を選ばない）
   - 期待: 「登録が完了しました」のメッセージが届き、リッチメニューが完了版に切り替わる。1 の 2 つ目の `curl` をもう一度流して 200 になる
6. リッチメニューの「詳細を見る」で LIFF を開き、引き継いだ店舗が出ることを確かめる（Req 9.3）
7. 運営アカウントで「オーナー一覧」を再読み込みする
   - 期待: 解除したオーナーが「解除済み（引継ぎ先: <新しいオーナー>）」、新しいオーナーが「連携中」と出る（Req 2.6）。`/stores` では店舗のオーナーが新しいオーナーになっている
8. DB で引継ぎを確かめる

   ```bash
   psql -X -v owner_id="$OWNER_ID" <<'SQL'
   \getenv uid VERIFY_UID
   SELECT left(o.id::text, 8) AS owner8,
          o.line_user_id IS NOT NULL AS linked,
          o.onboarding_status,
          left(o.taken_over_by_owner_id::text, 8) AS taken_over_by8,
          (SELECT count(*) FROM stores s WHERE s.owner_id = o.id) AS stores
     FROM owners o
    WHERE o.id = :'owner_id' OR o.line_user_id = :'uid'
    ORDER BY o.created_at;
   SELECT action, count(*)
     FROM audit_logs
    WHERE action IN ('owner_line_unlinked', 'owner_stores_taken_over', 'store_taken_over')
      AND occurred_at >= now() - interval '2 hours'
    GROUP BY action ORDER BY action;
   SQL
   ```

   期待: 1 行目（解除したオーナー）は `linked` が `f`、`taken_over_by8` が 2 行目の `owner8`、`stores` が 0。2 行目（新しいオーナー）は `linked` が `t`、`store_identified`、`stores` が引き継いだ件数。監査は `owner_line_unlinked` 1・`owner_stores_taken_over` 1・`store_taken_over` が引き継いだ店舗の件数。監査の書込はベストエフォート（#250）なので、欠けていても引継ぎの不合格にはしないが、欠けたことを記録する

9. 終わったら変数を消す: `unset VERIFY_UID OWNER_ID TOKEN SECRET`

翌朝の配信の時刻を過ぎたら、3. の装置の 6 で、引き継いだ店舗の配信が新しいオーナーに対して記録されていること（失敗が 0 件であること）を確かめてもよい。

### 5-9. 記録（Issue #487）

識別子は先頭 8 文字まで、LINE ユーザー ID と LINE の表示名は書かない。退避したファイルの中身は貼らない。
A〜D の行はマージの前に記録する（5-6. の 1）。E と A2 の行はマージの後に、同じ Issue へ追記する（A2 は 5-7. の 4 を終えてから）。

```markdown
## 本番適用の記録（owner-line-unlink 10.1）
- 実施日・実施者:
- 作業したコミット（PR の head・先頭 8 文字）:
- A: 適用前の照合 missing=7（0018 の 3 列・4 制約のみ）/ extra=0 → 0018 適用 → 照合 OK（expected=<n> / production=<n>）
- B: 付与者と接続ユーザーが一致 / grants.sql exit=0・WARNING 0 件
- C: 列権限 25 件すべて ok / テーブル単位の INSERT・UPDATE はどちらも f / CHECK 3 本・監査 action 28 値
- D: plan は accessor 1 追加・dashboard-api 1 変更のみ / 新リビジョン Ready / env に LINE_CHANNEL_ID・LINE_CHANNEL_SECRET
- E（マージ後に追記）: PR #<n> をマージ / deploy-prod success / 本番コミット <8 文字> / e2e-prod-checks の 1 PASS / /owners が開く
- A2（マージ後に追記）: 切り離し行 <N> 件（接頭辞 detached-20261024:・会話 0 件）/ 退避 <N> 行（手元のみ）/ 更新 <N> 件 / 残り 0 件 / 対象 owner: <owner8>, ... / 移した行以外の解除済み <0 件、または owner8 と解除の時刻> / /owners で解除済み

## 解除と引継ぎの実測（owner-line-unlink 10.2）
- 実施日・実施者:
- 対象: 解除したオーナー <owner8> / 新しいオーナー <owner8> / 店舗 <store8>
- 解除前の個別メニュー: 200
- 解除: 画面の通知 / 一覧「解除済み」/ 個別メニュー 404 / 会話 0 件（メニュー未解除になったか: いいえ / はい→外し直しの結果）
- 最初の案内: スタンプに招待コードの案内が返った
- 引継ぎ: 完了メッセージ / 個別メニュー 200 / 店舗詳細に店舗が出た / 一覧「解除済み（引継ぎ先: …）」・新しいオーナー「連携中」
- DB: 旧 stores 0・taken_over_by が新オーナー / 新 store_identified・stores <件数>
- 監査: owner_line_unlinked <n> / owner_stores_taken_over <n> / store_taken_over <n>
- 見つけた不具合の Issue:
```

## 6. 関連

- `.github/workflows/ts-ci.yml` — 自動層の CI
- `docs/architecture.md` §4 — オンボーディングから口コミ獲得までの流れ
- `infra/README.md` §3（本番 DB への接続）・§7-3（日次ジョブの手動実行）・§8（外部 API 実疎通）・§11-4（相関 ID からログを束ねる）
