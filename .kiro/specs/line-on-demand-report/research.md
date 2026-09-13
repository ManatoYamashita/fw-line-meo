# Research & Design Decisions — line-on-demand-report

## Summary

- Feature: `line-on-demand-report`
- Discovery Scope: Extension（既存の日次集計・配信ジョブ・Webhook・リッチメニュー・LIFF を横断して作り替える brownfield 変更）
- 分析の基点: `origin/main` = `c5a5598`（2026-09-13・#258 の店舗詳細の可読性改善を含む）。第2フェーズの比較には `origin/phase2/gbp-post-review-reply` = `39212f7` を読んだ
- 要件の状態: `requirements.generated: true` / `approved: false`。本分析は要件の承認前に行ったため、要件へ差し戻す候補を「4. 要件承認前に確認したい食い違い」に分けて記す
- Key Findings:
  - 3 つのレポートの材料は `daily_summaries` にほぼ揃っており、`line-webhook` の SA は既に全テーブルを SELECT できる。新しいテーブルと権限は必須ではない
  - 最大の構造上の穴は、`conversation.ts` の completed 段階が postback を復号せずに固定案内を返す点である。レポートの振り分けはここへ差し込む必要がある
  - Google Places の規約（一次情報・2026-09-13 取得）は、口コミの表示に投稿者の帰属（アバター・名前・プロフィールへのリンク）と、口コミ個別の `googleMapsUri` への到達手段を求めている。Go は `authorAttribution.displayName` 以外を捨てており、Req 8.2 と境界（日次取得は対象外）の双方に影響する
  - 通知の文言はリッチメニューの存在を前提にするが、`delivery-job` はマージで自動デプロイされ、メニュー差し替えは手作業でパイロット中は禁止される。公開の順序を設計で固定する必要がある
  - 比較・推移の表示は #255（未評価店を ★0 として保存し順位を水増しする不具合・OPEN）の是正後のデータ契約に依存する

## ギャップ分析（2026-09-13・/kiro-validate-gap）

### 1. 分析の前提

- 読んだもの: 本 spec の `requirements.md` / `spec.json`、steering（`product.md` / `tech.md` / `structure.md` / `review-gate.md`）、Issue #256（本文と 2026-09-13 の方針確定コメント）・#255・#252・#73、`competitive-daily-summary` / `line-onboarding` の要件・設計・調査、`.claude/skills/messaging-api/references/`、該当コード一式
- 一次情報として取得したもの: Places API のポリシー（`https://developers.google.com/maps/documentation/places/web-service/policies`・2026-09-13）
- 取り扱わないもの: 設計上の最終決定。以下は選択肢と根拠であり、決定は design フェーズで行う

### 2. 現状調査（既存資産）

| 面 | 既存資産 | 本 spec との関係 |
|---|---|---|
| 配信ジョブ | `ts/apps/delivery-job/src/targets.ts:48-73`（`delivery_hour` = 現在時・当日 `daily_summaries` あり・未配信の店舗を抽出。`status` で絞らない）、`flex.ts`（日次カード一式・30KB 検証）、`deliveries.ts:38-61`（`UNIQUE (store_id, summary_date)` と `ON CONFLICT DO NOTHING` による予約）、`index.ts:186-233`（予約→組立→push→記録・店舗単位の隔離） | 通知の条件判定と短文化で作り替える。冪等の仕組みはそのまま使える |
| Webhook | `src/webhook/dispatch.ts:98-104`（postback を正規化済み）、`src/app.ts:103-134`（イベント単位のエラー境界と再試行案内）、`src/onboarding/conversation.ts:380-417`（postback 処理）、`src/onboarding/stages.ts:20-88`（`a=<action>` の URLSearchParams 形式の符号化）、`src/line/messages.ts`（純関数の文言・Flex 組立）、`src/line/client.ts:16-18`（`LineMessage` は text と flex だけで `quickReply` を持たない） | レポートの振り分け・店舗選択・応答組立を足す面 |
| リッチメニュー | `scripts/setup-rich-menus.ts:50-51`（Half 2500×843）、`:204-229`（完了後は全面 1 区画の message「ステータス確認」）、`:231-246`（2 つのメニューを必ず両方作り、オンボーディング側を既定にする）、`:53-58`（action 型は postback と message のみ）、`assets/source/*.html` → PNG、`test/scripts/setup-rich-menus.test.ts`（IHDR と宣言寸法の照合） | 5 区画以上の完了後メニューへ作り直す面 |
| 店舗詳細（LIFF） | `ts/apps/store-detail/lib/liff-auth.ts`（`listOwnerConfirmedStores` と純関数 `selectAuthorizedStore`・クライアント由来の storeId は認可済み集合の内側でのみ解釈）、`app/api/detail/route.ts:183-198`（複数店舗は 409 と候補一覧・無効なヒントは記録して無視）、`lib/data.ts:133-145`（30 日推移は `rating_snapshots` の自店行から読む）、`app/store/page.tsx:9-12`（LIFF URL に storeId を含めないという契約） | 「詳細を見る」と「直近 30 日」の遷移先。店舗の認可の考え方を再利用できる |
| DB | `db/migrations/0004_competitive_daily_summary.sql:12-48`（`daily_summaries` は Go 書込・`summary_deliveries` は TS 書込・status の CHECK は 4 値）、`ts/packages/db/src/types.ts:100-140`（`DailySummaryCompetitor.rating` は `number`）、`infra/sql/grants.sql:54-55`（6 SA へ全テーブル SELECT） | 読み取りは追加権限なしで可能。通知しない日を記録するなら CHECK の改訂が要る |
| 日次バッチ（Go） | `go/internal/batch/run.go:137-138`（前日 = 暦日の前日）、`:389-411`（`rank_prev` と新着件数は前日の自店スナップショットがあるときだけ算出）、`:413-416`（成功した競合が 0 なら `no_competitors`）、`go/internal/summary/compute.go:46-48`（競合 0 のとき rank=1・total=1）、`go/internal/places/types.go:105`（`Rating float64` のゼロ値＝#255 の原因）、`:124-126` と `client.go:203-215`（口コミの帰属は `displayName` しか保持しない） | 本 spec の境界外だが、意味論と規約適合の前提を決めている |
| インフラ・運用 | `infra/modules/run-services/main.tf:52`（Cloud Run の最小インスタンス 0）、`infra/envs/prod/main.tf:69-72`（`LINE_RICHMENU_COMPLETED_ID` と `LIFF_STORE_DETAIL_URL` を line-webhook へ注入）、`infra/README.md` §10（メニュー差し替えの 5 段と per-user リンクの張り替え）、同 `:204`（配信の成功の証拠を「`summary_deliveries` に該当日の行が増えること」と定義） | メニュー移行の手順と、通知を減らしたときに崩れる運用上の証拠 |
| ガード・検査 | `db/test/check_no_optional_capabilities.sh:143`（line-webhook を含む TS 面で `optOut` / `unsubscribe` 等の識別子を禁止）、`db/test/assertions/15_competitive_daily_summary.sql:47-64`（配信 status の 4 分岐）、`scripts/check-log-field-canon.sh` / `check-log-field-binding.sh`（事象名と項目の正典登録）、`ts/apps/delivery-job/test/cross-runtime.e2e.test.ts:196-261`（`no_competitors` の店舗にも push されることを固定している） | 新しい事象名・status・振る舞いの変更で必ず触る |
| 第2フェーズ（未統合） | `phase2/gbp-post-review-reply` の完了後メニューは 800×540 の 2×2（ステータス確認を postback `a=resume` に変更・`a=g_post` / `a=g_reply` / `a=g_status`）。`conversation.ts` に completed 段階からの委譲口（`gbp?: GbpFlowHandlers` と `isGbpPostbackData`）を持つ | 本 spec のメニュー構成と振り分けの口は、この 3 導線を後から足せる形でなければならない（Req 2.7） |

守るべき既存の規約:

- postback の data は `a=<action>` のキー＝値形式（300 字以内）。復号は URLSearchParams で行い、不正な data は例外にせず案内へ倒す（`stages.ts:55-88`）
- 文言と Flex の組立は I/O を持たない純関数に集める（`messages.ts:15-17`）。依存は注入する
- 失敗は店舗・イベント単位で隔離し、記録を残す（silent drop 禁止）。記録には例外の本文を載せず種別だけを載せる
- 事象名と項目名は `docs/observability/log-field-canon.md` に登録してから使う
- 日付列は `to_char(..., 'YYYY-MM-DD')` で文字列として読む（`store-detail/lib/data.ts:125`。pg 既定の Date 化は実行環境の TZ で 1 日ずれうる）
- LINE 面の意匠は `lineLayout` / `lineColors` の役割トークンで組み、テキスト案内は `docs/design/design-language.md` §7.16（1 文 1 行・3 行以内・絵文字は完了の 1 箇所だけ・Flex 化しない）に従う

### 3. 要件とアセットの対応（Requirement-to-Asset Map）

区分: Missing = 実装が無い / Unknown = 調べるか決める必要がある / Constraint = 既存の構造や外部仕様が制約になる / Reuse = 既存資産をそのまま使える

#### Requirement 1: 意味のある変化だけを知らせる通知

| AC | 必要なもの | 既存資産 | ギャップ | 区分 |
|---|---|---|---|---|
| 1.1–1.3 | `status='ready'`・前回あり・新着 1 件以上または順位変動、の判定と 1 通への統合 | `targets.ts` の抽出（`ds.*` を返すので `rank` / `rank_prev` / `new_review_count` / `status` は手元にある） | 判定ロジックが無い。「順位変動」を `rank <> rank_prev` とするか母数の変化も含めるかが未定。`rank_prev` は当日の競合集合に前日スナップショットを当てて再計算した値（`run.go:389-403`）で、競合の入れ替わりでも動く | Missing / Unknown |
| 1.4–1.5 | 初回・変化なし・`no_competitors`・`failed` で送らない | 現状は `failed` 行も縮退カード（`flex.ts:161-168`）で、`no_competitors` 行も通常カードで送る | 除外が無い。送らなかった日を `summary_deliveries` に記録するかが未定（記録するなら CHECK の改訂＝migration・`assertions/15` の改訂が要り、記録しないなら `infra/README.md:204` の成功の証拠が偽になる） | Missing / Unknown |
| 1.6 | 店舗名・変化・メニューへの誘導・帰属表示を 1〜2 文で | 帰属の文言定数（`flex.ts:101`） | 店舗名を抽出していない（#73・`targets.ts:17-21`）。テキストか Flex か未定（§7.16 はテキスト案内の Flex 化をしないと定める） | Missing |
| 1.7 | 店舗ごとに 1 通 | 抽出が店舗単位 | 店舗名を足せば満たせる | Reuse |
| 1.8 | 同一日の再実行で重複しない | `reserveDelivery` の一意制約 | 送らない日を記録しない場合、同じ時間帯の再実行では毎回判定し直す（`daily_summaries` が再実行で置き換わると判定が変わりうる） | Reuse / Unknown |
| 1.9 | 配信時刻の設定値と方法を変えない | `owners.delivery_hour`（既定 7） | LINE 上で時刻を変える経路は未実装（`ts/packages/db/src/delivery-settings.ts:12` の `updateDeliveryHour` は呼び出し元が 0 件。`competitive-daily-summary` design.md:377 は「#6 統合ポイント」として配線を先送りした） | Constraint |

#### Requirement 2: 完了後リッチメニューからのレポート要求

| AC | 必要なもの | 既存資産 | ギャップ | 区分 |
|---|---|---|---|---|
| 2.1–2.2 | 3 レポート＋詳細＋ステータスの 5 導線 | 1 区画のメニューと焼き元 HTML | 区画の配置・新しい画像・寸法の宣言とテストが無い。`RichMenuAction` に `uri` が無い | Missing |
| 2.3 | タップ文言を発言として表示してから Reply | postback の正規化（`dispatch.ts`）。postback の `displayText` は LINE の仕様にある（action-objects.md） | completed 段階の postback は復号されず固定案内になる（`conversation.ts:386-391`）。レポート用の codec と振り分けが無い | Missing |
| 2.4 | 店舗確定後に既存詳細画面を LINE 内で開く | LIFF URL は line-webhook の env にある（`config.ts:28`）。store-detail は複数店舗の選択画面を自前で持つ | メニューの area に uri を置くなら、セットアップスクリプトへ LIFF URL を渡す口が要る。postback で店舗を選ばせてから uri を返す形も取れる | Missing / Unknown |
| 2.5 | 完了済みの旨と利用可能な機能の案内 | message「ステータス確認」→ `handleText` → `buildAlreadyCompletedMessage`（`messages.ts:194-201`） | 文言が「機能1（競合店舗の日次サマリー）」「追加の操作は必要ありません」のまま。完了メッセージの「毎朝、近隣の競合とのポジションをお届けします」（`messages.ts:318`）は新方針で偽になる | Missing |
| 2.6 | 未完了のオーナーにはオンボーディング用 | 既定メニュー＝オンボーディング用、per-user リンクは `handleConfirm` だけが張る（`conversation.ts:501-509`） | そのまま使える。ただし「店舗特定の完了」の定義が 2 系統ある（4-5） | Reuse / Constraint |
| 2.7 | 第2フェーズの導線を足しても既存 5 導線を変えない | LINE の上限: area 20・Full 2500×1686・`richmenuswitch` とエイリアス（切り替え先が per-user として残る・rich-menu.md:180） | 第2フェーズは 3 導線（投稿作成・返信・連携）を持ち、ステータス確認を postback に変えている。枠の確保（2×4 / 2×3＋入口 1 区画 / タブ）と postback の名前空間（`a=g_*` と衝突させない）が未定 | Unknown / Constraint |

#### Requirement 3: 複数店舗の明示的な選択とアクセス制御

| AC | 必要なもの | 既存資産 | ギャップ | 区分 |
|---|---|---|---|---|
| 3.1–3.3 | 1 店なら即応答、複数なら店舗名で選ばせる | `listOwnerConfirmedStores`（store-detail のアプリ内・共有パッケージではない） | line-webhook から使える店舗一覧の読み出しが無い。選択の UI が未定（クイックリプライは 13 件・ラベル 20 字・モバイルのみ／Flex のボタンはラベル 40 字／カルーセルは 12 枚）。`LineMessage` に `quickReply` が無い | Missing / Unknown |
| 3.4 | 本人に紐付く確定済み店舗だけ | 署名検証済みの `source.userId`（`app.ts:144-159`）と `owners.line_user_id` の突合、`place_status='confirmed'` | 同じ認可を 2 か所目に書くことになる（tech.md「同じ教訓の実装を 2 箇所に分散させない」） | Reuse / Constraint |
| 3.5 | 停止中の店舗を除外（停止が先に入った場合） | なし（#252 は OPEN・`stores` 単位の状態列を想定） | #252 の表現しだい | Unknown |
| 3.6 | 対象外の店舗指定は開示せず再提示 | store-detail の非オラクル方針（`selectAuthorizedStore`・無効ヒントは storeId を記録せずに無視） | postback に storeId を載せるか、提示順の添字を載せるかが未定。添字方式はセッション照合が要り、storeId 方式は無状態で認可の検査が関門になる | Unknown |
| 3.7 | 店舗が無いときの案内 | なし | 文言が無い。completed なのに確定店舗が 0 になるのは、現状では停止（#252）が入ったときに限られる | Missing |
| 3.8 | すべての通知と回答に店舗名 | なし（#73 は OPEN） | 抽出に `stores.name` を足す | Missing |

#### Requirement 4: 新着口コミレポート

| AC | 必要なもの | 既存資産 | ギャップ | 区分 |
|---|---|---|---|---|
| 4.1–4.4 | 最新の日次集計から件数・最大 3 件の抜粋・残り件数 | `flex.ts:242-289`（最大 3 件と「ほか N 件」）。jsonb は `{authorName, publishTime, rating, textExcerpt}` | 最新行の読み出し、店舗名と対象日の表示、投稿時刻の JST 表示が無い | Missing / Reuse |
| 4.5 | 件数はあるが抜粋が無い | Go は件数を差分から、抜粋を関連度順上位 5 件から拾う（`compute.go:100-126`）ので取りこぼしは起こる | 「抜粋を表示できない」の分岐が無い | Missing |
| 4.6 | 新着なし | `flex.ts:245-252`（「新着なし」） | 対象日と店舗名の添え方が無い | Missing |
| 4.7 | 新着＝前回の日次集計から増えた口コミ | Go の件数は暦日の前日との差分（`run.go:407-411`） | 前日が欠けると 0 件になる（4-2） | Constraint |

#### Requirement 5: 競合店との比較レポート

| AC | 必要なもの | 既存資産 | ギャップ | 区分 |
|---|---|---|---|---|
| 5.1–5.2 | 順位・評価・口コミ総数・競合の名称と星差 | `daily_summaries` の各列と `competitors` jsonb、`flex.ts:299-356` | 対象日・店舗名が無い | Reuse / Missing |
| 5.3–5.5, 8.5 | 未評価は「評価なし」、未評価を除いた順位だけ、確認できなければ順位と星差を出さない | なし。Go は未評価を 0 で保存し（`places/types.go:105`）、TS の型は `rating: number`（`types.ts:118-123`） | #255 の是正（`*float64` → jsonb の null、順位からの除外、既存行は「評価 0 かつ件数 0」を未評価と読む案）に依存する。未評価の判定を Flex・LIFF・レポートの 3 面で共有する置き場が無い | Constraint / Missing |
| 5.6 | 競合データなし | `status='no_competitors'`、`flex.ts:104` の文言 | 自店のみの表示で順位（1 位 / 1 店）を出さない扱いが要る | Missing |

#### Requirement 6: 直近の推移レポート

| AC | 必要なもの | 既存資産 | ギャップ | 区分 |
|---|---|---|---|---|
| 6.1–6.3 | 最新の対象日までの 7 暦日を日付順に | LIFF は `rating_snapshots` から 30 日（`data.ts:133-145`） | 7 日の読み出しと Flex の組み方（表か棒か）が無い | Missing |
| 6.4–6.5 | 欠損日・失敗日を識別し、補間しない。2 日未満は不足の旨 | `daily_summaries` は失敗日に `status='failed'` 行を持ち、未実行日は行が無い。`rating_snapshots` は失敗日に行が無い | 読み元の選択が未定（`daily_summaries` なら失敗と未実行を区別でき、#255 の既存行の判定に必要な競合の値も同じ行にある） | Unknown |
| 6.6 | 詳細画面の 30 日推移への導線 | LIFF URL | 店舗を指定して開くには LIFF URL へヒントを載せる必要がある。store-detail の契約は「storeId を LIFF URL に含めない」（`page.tsx:9-12`）で、LIFF の `liff.state` 経由で `?storeId=` が届くかは未検証 | Unknown |
| 6.7 | 30 日を超える Places 由来データを出さない | Go の 30 日ローリング削除（`go/internal/repo/summaries.go:112-119`） | 削除はバッチが走ったときにしか起きない。読み出し側でも日付の窓を切る必要がある | Constraint |

#### Requirement 7: データ未取得・取得失敗時の応答

| AC | 必要なもの | 既存資産 | ギャップ | 区分 |
|---|---|---|---|---|
| 7.1–7.2 | 行なし＝初回準備中、最新が失敗＝対象日つきの案内 | なし | 文言と分岐が無い | Missing |
| 7.3 | 5 秒以内の Reply | 同期処理＋再配信＋`webhookEventId` の重複排除（line-onboarding research.md:62-64） | Cloud Run は最小インスタンス 0 でコールドスタートと重なりうる。レポートは DB 読み出しだけで外部 API を呼ばない分、店名検索より軽い | Constraint / Unknown |
| 7.4 | 1 操作につき最大 1 回の Reply・push しない | Reply クライアント（非 2xx は記録のみ・`client.ts:111-133`）、1 リクエスト 5 メッセージまで | 要件どおりに組める | Reuse |
| 7.5 | 予期しない失敗で店舗名つきの再試行案内 | `app.ts:112-134` の境界は汎用文言（`messages.ts:451-460`）で店舗名を知らない | 店舗が確定した後の失敗をレポート側で捕まえる層が要る | Missing |

#### Requirement 8: 帰属表示と表示データの信頼性

| AC | 必要なもの | 既存資産 | ギャップ | 区分 |
|---|---|---|---|---|
| 8.1 | すべてに「データ提供: Google Maps」 | 定数と日次カードの footer | 規約は「可能な限り Google Maps のロゴ、場所が限られる場合はテキスト」（4-1）。LINE Flex の image でロゴを出すかテキストで足りるかが未判断 | Unknown |
| 8.2 | 口コミに投稿者名 | `authorName` | 規約は投稿者の帰属（アバター・名前・プロフィールリンク）と口コミ個別の `googleMapsUri` への到達を求める。データに `uri` / `photoUri` / `googleMapsUri` が無い（4-1） | Constraint |
| 8.3 | 対象日・対象期間の明示 | `summary_date` | `to_char` で読む（Date 化の TZ ずれを避ける） | Reuse |
| 8.4 | 無い値を作らない | 日次カードは null を「—」で出す | 各レポートでも同じ規律を置く | Reuse |

#### Requirement 9: 文書整合と安全なリッチメニュー移行

| AC | 必要なもの | 既存資産 | ギャップ | 区分 |
|---|---|---|---|---|
| 9.1 | 4 文書の整合 | `requirements.md` 3.3.4（:130-）、`docs/proposal.md`（:17, :33-35）、`competitive-daily-summary` Req 3 と design の Flex 構成契約、`line-onboarding` Req 6.3 | 列挙の外にも「毎朝届く」を前提にした記述がある（4-4） | Missing |
| 9.2 | 方針を #256 に記録 | #256 の 2026-09-13T01:57Z のコメントに方針確定が記録済み | クライアント合意の記録は未（#256 の完了条件 1） | Reuse / Missing |
| 9.3 | #255 の是正を確認 | #255 は OPEN | リリース前提 | Constraint |
| 9.4–9.6 | パイロット中は差し替えない・全員の張り替えを確認してから旧メニューを削除・実機確認 | `infra/README.md` §10-1〜10-5、per-user の張り替え（1 件ずつ / `bulk/link` 500 件・非同期）、一括置換 `POST /v2/bot/richmenu/batch`（`link` の from→to・3 回/時・rich-menu.md:128-139） | スクリプトは 2 メニューを必ず作り既定を切り替える（`setup-rich-menus.ts:231-246`）。2026-09-13 の本番 E2E で完了済みの検証用オーナーが実在するため、§10-6 の「対象が存在しない」は古い | Constraint / Missing |

### 4. 要件承認前に確認したい食い違い（要件へ差し戻す候補）

#### 4-1. Places の規約（一次情報）と Req 8.2・境界

Places API のポリシー（2026-09-13 取得）の該当箇所:

- 地図なしの表示: "Attribution should take the form of the Google Maps logo whenever possible. In cases where space is limited, the text Google Maps is acceptable."
- 口コミ: "You must always credit the author when displaying photos or reviews. Each photo and review includes an author attribution (author's avatar image, name, and profile link)." / "Attribute the author using all available resources (avatar, name, and profile link) when space allows." / "For each photo and review, end-users must always have access to view the individual source photo or review on Google Maps using the provided `googleMapsUri`."

一方、Go は `reviews` を丸ごと取得しているのに `authorAttribution.displayName` だけを残し（`go/internal/places/types.go:124-126`・`client.go:203-215`）、jsonb の契約も 4 項目に限っている（`go/internal/repo/summaries.go:11-16`）。現行の日次カードと LIFF も同じ状態である。`competitive-daily-summary` research.md:66 は当時「投稿者名・アバター必須」と記録しており、実装とのずれが既にある。

要件への影響: Req 8.2 は投稿者名しか求めていない。規約に合わせると、口コミ個別の Google Maps へのリンク（と、場所が許せばアバター・プロフィールリンク）が要り、そのためには Go のデータ契約の拡張が要る。これは Boundary Context の Out of scope（日次取得そのもの）に触れる。選択肢は (a) 境界を「取得済みデータの保存項目の追加」まで広げる、(b) 別 Issue で Go を先に直し本 spec の前提にする、(c) 新着口コミレポートで本文を出さず件数とリンクだけにする。いずれも要件の文言が変わる。

#### 4-2. 「前回の日次集計」と Go の「暦日の前日」

Req 1.1 / 1.2 / 1.4 / 4.7 は「前回の日次集計」を基準にするが、Go は暦日の前日のスナップショットだけを比較に使う（`run.go:137-138`・`:389-411`）。前日のバッチが失敗すると、2 日前の集計が存在しても新着は 0 件・`rank_prev` は null になり、欠けた日の間に増えた口コミはどの日の「新着」にも数えられない。Go の算出は本 spec の境界外なので、要件の語を「前日の日次集計」に揃えるか、境界を広げるかを決める必要がある。

#### 4-3. Req 1.9 の「設定方法」が実在しない

オーナーが LINE 上で配信時刻を変える経路は存在しない（`updateDeliveryHour` の呼び出し元は 0 件）。`competitive-daily-summary` Req 3.3 は実装されていない。Req 1.9 は既定値 7 時を維持するという意味に読むのが実態に合う。Req 9.1 の文書整合で `competitive-daily-summary` Req 3.3 をどう扱うかも併せて決める。

#### 4-4. Req 9.1 の文書範囲が狭い

列挙された 4 文書のほかに、「毎朝 Flex が届く」を前提にした記述が次にある。放置すると記述が虚偽のまま残る。

- `.kiro/steering/product.md:12`、`README.md:38,46`、`docs/architecture.md:43,61,88,121`
- `docs/design/design-language.md` §7.13（「日次サマリーの順位数値だけが最大の段を持つ」＝巨大表示の置き場が日次カードから比較レポートへ移る）
- `infra/README.md:204`（配信の成功の証拠）と §10-6（完了済みオーナーが存在しないという記述）
- 利用者に見える文言: `messages.ts:318`（毎朝お届けします）、`messages.ts:194-201`（機能1 のみの案内）
- `delivery-job/test/cross-runtime.e2e.test.ts:196-261`（`no_competitors` の店舗にも push されることを固定している）

#### 4-5. 「店舗特定の完了」の定義が 2 系統ある

LINE の会話は `onboarding_sessions.stage='completed'` で完了を判定し、完了後メニューのリンクもそこでだけ張る。一方、代理店がダッシュボードから店舗を登録すると `confirmStore` を通って `owners.onboarding_status='store_identified'` になるが、LINE の会話は未完了のまま残る（`ts/apps/dashboard-api/src/index.ts:79-80`）。この場合オーナーはオンボーディング用メニューのままで、確定済み店舗を持つ。Req 2.6 の「店舗特定が未完了」、Req 3.4 の対象、Req 9.5 の「完了済みオーナー全員」をどちらの定義で読むかを決める必要がある（§10-3 の張り替え対象の SQL は `onboarding_status` を使っている）。

#### 4-6. 競合なしの日の順位（Req 6.2）

`no_competitors` の日は rank=1・total=1 が保存される（`compute.go:46-48`）。Req 5.6 は比較レポートで順位を出さない方向だが、Req 6.2 は推移で各日の順位を出すと定めている。推移でも「—」にするなら要件に書き分けが要る。

#### 4-7. 選択肢の表示上限と PC 版 LINE（Req 3.2）

クイックリプライは 13 件・ラベル 20 字まで、Flex カルーセルは 12 枚まで。リッチメニューとクイックリプライは PC 版 LINE に表示されない（rich-menu.md:3・message-objects.md:355）。「全店舗の名称を提示」を上限なしで満たせる形は無いので、上限の扱い（長い店名の省略、13 店を超える場合）を要件か設計に置く。

### 5. 実装アプローチの選択肢

#### Option A: 既存コンポーネントを拡張する

- `conversation.ts` の completed 分岐でレポート postback を復号して処理し、`messages.ts` に 3 レポートと店舗選択の組立を足す
- `delivery-job` は `targets.ts` に条件と店舗名を足し、`flex.ts` を短文の組立へ置き換える
- `setup-rich-menus.ts` の完了後メニューを 5 区画にする。店舗一覧は line-webhook の中に SQL を直書きする
- 利点: 新しいファイルが少なく、既存の注入と試験の型をそのまま使える
- 欠点: オンボーディングの状態機械（558 行）にレポートの領域が混ざる。`messages.ts`（460 行）が倍近くに膨らむ。第2フェーズの委譲口と同じ場所を別の形で書き換えるので統合時に衝突する。未評価の判定と店舗の認可がそれぞれ 2〜3 か所に分散する

#### Option B: 新しいコンポーネントを作る

- line-webhook に `src/report/`（codec・振り分け・店舗選択・読み出し・組立）を新設する
- 共有パッケージ（例: `ts/packages/summary-view`）を新設し、最新の集計・7 日窓・未評価の正規化・星差の整形を line-webhook / delivery-job / store-detail で共有する
- `delivery-job` に通知専用のモジュールを置き、リッチメニューの定義もスクリプトから分離する
- 利点: 責務が分かれ、単体で試験できる。#255 の未評価の扱いを 1 か所に置ける。第2フェーズの導線も同じ口に並べられる
- 欠点: 新パッケージの配線（tsconfig の参照・型検査と試験の網羅ガード・各 Dockerfile の COPY）が要る。store-detail の認可（型レベルの守りを持つ security-critical なコード）を共有へ移すと影響範囲が広がる

#### Option C: ハイブリッド

- `conversation.ts` には薄い委譲口だけを置く（completed 段階で、レポートの postback なら `report` 側へ渡す。第2フェーズの `gbp?` と同じ形なので、統合時は兄弟として並べられる）
- 本体は line-webhook の `src/report/` に新設する
- 読み出し（本人の確定店舗・最新の集計・日付窓の集計）と未評価の正規化は新パッケージではなく `@fwlm/db` に足す。#255 が `DailySummaryCompetitor` の型を変える場所と同じなので、判定が型の隣に置かれる
- `delivery-job` は既存の抽出を拡張し、日次カードを短文の組立へ置き換える
- `setup-rich-menus.ts` はメニュー定義を分け、`uri` action と完了後メニューだけを作り直す経路を足す
- 段階: P0 #255 の型契約（`number | null`）に合わせる → P1 読み出しとレポートと委譲口（旧メニューは新しい postback を出さないので先に出してよい）→ P2 通知の切り替えを公開の順序に合わせる → P3 メニューの作成・env の反映・全員の張り替え・旧メニューの削除 → P4 文書の整合
- 利点: オンボーディングを汚さずに新しい面を分離でき、パッケージを増やさずに共有の置き場を得る。第2フェーズとの統合面が小さい
- 欠点: 公開の順序（コードのデプロイ・通知の切り替え・手作業のメニュー差し替え）の調整が要る

### 6. 工数とリスク

- 工数: L（1〜2 週間）。#256 の見積り 7 開発日（仕様 1・実装 5・本番の差し替えと実機確認 1）に、文書整合の範囲の拡大（4-4）と、4-1 を境界内へ入れる場合の Go のデータ契約の拡張が加わる
- リスク: Medium〜High。LINE の Reply・Flex・リッチメニューは既存の型と実装がある一方で、(1) 口コミ表示の規約適合がデータ契約の外にある、(2) per-user リンクの張り替えは CI で検証できず手作業で行う、(3) 比較の正しさが OPEN の #255 に依存する、(4) 通知とメニューの公開順序を誤ると「メニューから確認できます」と送った先にボタンが無い、(5) 第2フェーズの統合で同じファイルを双方が変える

### 7. 設計フェーズへの申し送り

#### 推奨アプローチ

Option C を第一候補とする。決め手は、第2フェーズと同じ委譲の形を取れること、オンボーディングの状態機械に手を入れる量が最小になること、未評価の判定を #255 の型と同じ場所に置けることの 3 点である。

#### 設計で決めること

- D1 postback の data の名前空間（例: レポート用の接頭辞）と、店舗の指定を storeId で運ぶか添字で運ぶか。オンボーディングの `a=select&i=` と第2フェーズの `a=g_*` の両方と衝突させない
- D2 レポートを受け付ける条件を、会話の段階（`stage='completed'`）と確定店舗の有無のどちらで判定するか（4-5）
- D3 店舗選択の見せ方（クイックリプライ / Flex のボタン / カルーセル）と、上限を超えたときの扱い（4-7）
- D4 推移の読み元（`daily_summaries` か `rating_snapshots` か）と 7 日の描き方（表か箱の棒か）。30 日の窓を読み出し側でも切る
- D5 未評価の判定規則。#255 後の null と、#255 前の「評価 0 かつ件数 0」を同じ関数で扱い、既存行を含む日は順位と星差を出さない
- D6 通知の形（テキストか Flex か）、「順位変動」の定義、送らない日を記録するか（記録するなら status の追加と migration・`assertions/15`・`infra/README.md:204` の改訂。migration の番号は #259 が 0009 を予定しているので後着側が振り直す）
- D7 公開の順序と切り替えの手段。`delivery-job` と `line-webhook` はマージで自動デプロイされ、メニュー差し替えは手作業でパイロット中は禁止される。通知の新しい文言をメニューの差し替えまで出さないための手段（env による切り替え・マージの順序・両方）を決める
- D8 リッチメニューの寸法と区画、第2フェーズの入れ方（2×4 / 2×3＋入口 / `richmenuswitch` のタブ）。#256 の完了条件 6 はこの記録を design に求めている
- D9 「詳細を見る」を area の uri で直接開くか、postback で店舗を選ばせてから uri を返すか。推移から 30 日へ飛ぶときに店舗のヒントを LIFF URL に載せるなら、store-detail の LIFF URL 契約の改訂を伴う
- D10 移行手順。完了後メニューだけを作り直すのか、オンボーディング用も作り直すのか。張り替えは per-user・`bulk/link`・`batch`（`link` の from→to）のどれで行い、全員分をどう確認するか
- D11 利用者に見える既存文言（完了メッセージ・ステータス確認の案内）の改訂と、文書の掃討範囲（4-4）
- D12 新しい事象名と項目名（レポートの応答・店舗選択・通知の見送り）を正典へ登録し、`delivery-job.run` の実行サマリーに見送り件数を足すか

#### Research Needed

- R1 Places の帰属表示を LINE Flex でどう満たすか。ロゴ画像を出す必要があるか、テキストで足りるか。口コミ個別の `googleMapsUri` への導線と、アバター・プロフィールリンクをどこまで出すか（4-1）
- R2 口コミ本文を抜粋（切り詰め）して表示してよいか（規約の該当箇所の確認）
- R3 LIFF の `https://liff.line.me/{liffId}/...?storeId=` が `liff.state` 経由で store-detail の `window.location.search` まで届くか（`page.tsx:158` は `liff.init` の後に読む）
- R4 リッチメニューの一括置換（`POST /v2/bot/richmenu/batch` の `link`）が per-user リンクを持つ全員に効くか、進捗照会で完了を確かめられるか。確かめる手段は `@line/bot-sdk` の生成型を一次情報にする
- R5 line-webhook のコールドスタートを含めた応答時間の実測（Req 7.3）
- R6 リッチメニューの postback で `displayText` と `inputOption`（メニューを閉じるか）の組み合わせが実機でどう見えるか
- R7 #255 の是正の形（jsonb の null、順位の母数の定義、是正の切り替え日に前日スナップショットの 0 を未評価として読むか）。切り替え日に見かけ上の順位変動が起き、不要な通知が出ないかを確かめる
- R8 #252 の停止状態の表現（`stores` の列か別表か）と、先に入った場合の除外箇所

#### 依存と順序

- #255（OPEN）: 比較と推移の正しさの前提。型契約が変わるので、本 spec の実装は `number | null` を前提に書く
- #252（OPEN）: 先に入れば停止中の店舗を通知・選択・応答から外す（Req 3.5）。後に入るなら #252 側が本 spec の抽出箇所を対象に含める
- #259: migration 0009 の予定と番号が重なりうる
- 第2フェーズ（`phase2/gbp-post-review-reply` は main に未統合）: メニューと振り分けの口を統合で作り直さずに済む形にする
- リリース計画: #256 は 2026-09-24〜10-25 に置かれ、パイロット（10-26〜）より前に差し替えを終える必要がある（Req 9.4）

---

## 要件改訂（2026-09-13・ギャップ分析 4 章の 7 件を推奨どおりに反映）

利用者の指示（7 件すべてを推奨の方法で修正する）に基づき、`requirements.md` を改訂した。用語 4 つ（店舗特定済みオーナー・前日の日次集計・未評価店舗・競合比較可能）を Introduction に定義し、受け入れ基準はその用語で書いた。

| 項目 | 採った方法 | 反映先 |
|---|---|---|
| 4-1 Places の規約 | 口コミの帰属に要る情報（投稿者の `uri`・`photoUri`、口コミの `googleMapsUri`）を、Go が既に受け取っている応答から日次集計へ保存する変更を境界内に入れた。取得項目と呼び出し回数は変えない。Google Maps 上の表示先を持たない口コミは内容を出さない。Google Maps の帰属はポリシーの形式（ロゴ、または表示領域が限られる場合のテキスト）に従う | Boundary（In / Out）、Req 4.3, 4.5, 8.1, 8.2, 8.6, 8.7 |
| 4-2 前回と前日 | 要件の語を Go の意味論（暦日の前日）に揃えた。前日が無い日は「新着口コミはありません」と言わず、判定できない旨を出す | 用語、Req 1.1, 1.2, 1.4, 4.6, 4.7, 4.8 |
| 4-3 配信時刻 | 「既存の配信時刻（初期値 7 時）をそのまま使い、値も変更手段も変えない」に改めた。未提供の変更手段の記述は文書整合の対象に入れた | Req 1.1, 1.2, 1.9, 9.1、Boundary（Out） |
| 4-4 文書範囲 | 文書整合の対象を列挙し直した。利用者に見える案内文に毎日配信の約束を残さない | Req 2.10, 9.1、Boundary（Adjacent） |
| 4-5 完了の定義 | 「店舗特定済みオーナー」を「確定店舗を 1 店以上持つオーナー」に一本化した。代理店登録の経路でも最初の通知より前に完了後メニューを表示し、LINE 操作にはオンボーディングの案内を返さない。完了後メニューが無いオーナーにメニューへ誘導する通知を送らない | 用語、Req 1.10, 2.1, 2.6, 2.8, 2.9, 9.5、Boundary（In） |
| 4-6 競合なしの日 | 競合比較可能でない日は推移でも順位を出さず、星評価と口コミ総数だけを出す | 用語、Req 5.6, 6.8 |
| 4-7 表示上限と PC 版 | 長い店名は選択肢で省略し、回答で全文を出す。上限を超える店舗数は分けて提示する。PC 版 LINE は対象外として境界に明記した | Req 3.9, 3.10、Boundary（Out） |

根拠の補足:

- 4-1: Places API のリファレンス（2026-09-13 取得）で、Review は `googleMapsUri`（"A link to show the review on Google Maps"）を、AuthorAttribution は `uri` と `photoUri` を持つ。Go の自店用フィールドマスクは `reviews` を丸ごと指定している（`go/internal/places/client.go:23`）
- 4-5: 代理店ダッシュボードの店舗登録は「オーナーのオンボーディング代行」と定義されており（`.kiro/specs/agency-dashboard/requirements.md:13, :24`）、この経路では LINE の会話が未完了のまま店舗が確定する。`delivery-job` は店舗単位で配信対象を決める（`targets.ts:48-73`）ので、この経路のオーナーにも通知は届く。メニューの表示条件を会話の段階で決めると、メニューへ誘導する通知だけが届き、ボタンの無い面を見ることになる
- #255 の是正方針（次節）に合わせ、Req 5.4 は外部の Issue を参照せずに定義を自足させ、Req 1.11 と Req 9.3 を足した

設計で決めることへの影響:

- D2 は要件で決着した（確定店舗の有無で判定する）。設計が決めるのは、代理店登録の経路で完了後メニューへ切り替える手段（ダッシュボード側から LINE を呼ぶか、配信や次の操作の前に照合して切り替えるか）で、Req 2.8 の「最初の通知より前」を満たす必要がある
- D5 は #255 の是正方針でほぼ決まった（次節の 7・8）
- D7 は Req 1.10 が上限を与えた（完了後メニューが無いオーナーへメニューへ誘導する通知を出さない）
- R1 の残りは、Flex でロゴ画像を出すかテキストにするかの判断だけになった
- 新しい調査項目 R9: フィールドマスク `reviews` の実レスポンスに `googleMapsUri`・`authorAttribution.uri`・`authorAttribution.photoUri` が含まれることを、設計で実レスポンス（または Go の既存テストの fixture）により確かめる

## Issue #255 の是正方針（2026-09-13 確定）

#255（クチコミ 0 件の店を ★0 として保存し、順位を水増しする不具合）の是正を、本 spec の前提として次のとおり確定した。実装は #255 側で行い、`competitive-daily-summary` の要件と設計を改訂する。

1. 未評価の保存: Places の応答に `rating` が無い店舗を未評価とし、0 ではなく値なしとして保存する。対象は自店の `daily_summaries.rating`、`rating_snapshots.rating`、`daily_summaries.competitors` の `rating`。未評価が関わる星差（`starDiff`）も値なしとする
2. 順位の定義: 順位の比較対象は「自店と当日有効な競合のうち、星評価を持つ店舗」とする。並びは従来どおり星評価の降順、同率はクチコミ総数の降順。順位母数（`rank_total`）はこの集合の大きさとする
3. 自店が未評価の日: 自店の順位と順位母数は値なしとする（比較対象に自店が入らないため）
4. 未評価の競合: 競合一覧には残し、名称とクチコミ総数を出す。評価と星差は値なし。並びは、星評価を持つ競合を順位の順に置き、その後ろに未評価の競合を置く。スナップショットの競合順位も値なしとする
5. 競合比較可能の判定: `daily_summaries.status` の意味（取得に成功した競合の有無）は変えない。比較可能かどうかは「自店の順位が値を持ち、順位母数が 2 以上」で読む。新しい status や列は足さない
6. 前日の順位: 同じ定義で前日のスナップショットから算出する。是正前に評価 0 で保存されたスナップショットは未評価として読む。是正の切り替え日に、見かけ上の順位変動（と不要な通知）を出さないためである
7. 既存行: 是正前の行は書き換えない（Go の 30 日ローリング削除で順に消える）。読む側は評価 0 を未評価として扱い、そうした値を含む行では順位・順位母数・星差を表示しない。Google の評価は 1.0〜5.0 なので、0 は是正前の行にしか現れない
8. 型と判定の置き場: TS の `DailySummaryCompetitor.rating` と `starDiff` を `number | null` にする。未評価（値なしと是正前の 0）を判定する関数を `@fwlm/db` の 1 か所に置き、日次カード・LIFF・LINE レポートが共有する
9. 表示: 未評価は「評価なし」と出し、「★0」と根拠のない星差を出さない。星差の書式は、日次カードの `formatStarDiff`（正の値は「+」付き・小数 1 桁）に LIFF も揃える
10. スキーマ: 列の追加と CHECK の変更はしない。`rating_snapshots.rating` の CHECK は 0 を許すが、是正前の行が残る 30 日間は締められない。締める場合は是正から 30 日後の別作業とする
11. 検査: Go の単体テストで「`rating` が無い応答は値なしになる」「未評価の店は順位と母数に入らない」「前日の評価 0 は未評価として読む」を固定する。cross-runtime の契約テストに未評価の競合を含む行を足し、Go が書いた行を日次カードと LIFF が「評価なし」と描くことを確かめる
12. 順序: #255 の是正は本 spec の本番提供の前提とする（Req 9.3）。本 spec の実装は、是正前でも `number | null` の型契約を前提に書く
