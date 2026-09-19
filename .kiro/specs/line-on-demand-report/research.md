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
- D5 未評価の判定規則。#255 後の null と、#255 前の「評価 0 かつ件数 0」を同じ関数で扱い、既存行を含む日は順位と星差を出さない（→ 決着済み。#255 側が読込時の正規化で既存行を正しい値へ戻す方針に決めたため、この案は採らない。末尾の「Issue #255 の是正方針」を参照）
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
- R7 #255 の是正の形（jsonb の null、順位の母数の定義、是正の切り替え日に前日スナップショットの 0 を未評価として読むか）。切り替え日に見かけ上の順位変動が起き、不要な通知が出ないかを確かめる（→ 解消済み。#255 側で決定され、評価 0 の店は常に最下位だったため自店の順位も前日の順位も変わらない。末尾の節を参照）
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
- #255 の是正方針（次節）に合わせ、Req 5.4 の定義を自足させ、Req 5.5・5.7・5.8・6.8・8.5 を #255 側の決定どおりに書き、Req 9.3 を足した。当初足した Req 1.11（既存データの順位差を順位変動として扱わない）は、#255 の読込時の正規化で順位と母数が正しく戻るため撤回した

設計で決めることへの影響:

- D2 は要件で決着した（確定店舗の有無で判定する）。設計が決めるのは、代理店登録の経路で完了後メニューへ切り替える手段（ダッシュボード側から LINE を呼ぶか、配信や次の操作の前に照合して切り替えるか）で、Req 2.8 の「最初の通知より前」を満たす必要がある
- D5 は #255 側の決定で決まった（次節）。本 spec は `@fwlm/db/daily-summary` の正規化と整形を再利用する
- D7 は Req 1.10 が上限を与えた（完了後メニューが無いオーナーへメニューへ誘導する通知を出さない）
- R1 の残りは、Flex でロゴ画像を出すかテキストにするかの判断だけになった
- 新しい調査項目 R9: フィールドマスク `reviews` の実レスポンスに `googleMapsUri`・`authorAttribution.uri`・`authorAttribution.photoUri` が含まれることを、設計で実レスポンス（または Go の既存テストの fixture）により確かめる

## Issue #255 の是正方針（2026-09-13・#255 側の決定に合わせる）

#255（クチコミ 0 件の店を ★0 として保存し、順位の母数を水増しする不具合）の是正方針は、本 spec とは別の作業として #255 側で既に決定されていた（Issue #255 の 2026-09-13T02:10Z のコメント「方針（決定）」・ブランチ `fix/unrated-rating-255`）。本 spec は独自の方針を立てず、この決定をそのまま前提にする。当初この節に書いた独自の方針（既存行では順位を出さない）は、次の実測に基づく決定で置き換えた。

#255 側の実測（本番・read-only・2026-09-13 11:09 JST）: `daily_summaries` 60 行のうち、評価 0 は競合 jsonb の 1 店だけ（30 日すべて・クチコミ 0 件）で、自店の `rating` と `rating_prev` に 0 は無かった。`rank_total` は全行で「1 + 競合の件数」だった。評価 0 の店は常に最下位に数えられるので自店の順位は正しく、母数だけがちょうど評価 0 の件数ぶん多い。

#255 側で決まっていること:

- 評価の無い店は、順位の比較集合と母数の両方から外す（`competitive-daily-summary` Req 2.8・2.9 として追加）
- 競合一覧には末尾に「評価なし」として残し、一覧の下に「評価のない店は順位に含めていません」と添える（同 Req 3.13）
- 自店が未評価の日は順位を出さず、「まだ Google の評価が無いため、順位は出せません」と表示する（同 Req 3.14）
- 星差は「自店 − 競合」を小数 1 桁で示し、正の値に「+」を付ける。Flex と LIFF で同じ関数を使う（同 Req 3.12・4.8）
- 既存行は書き換えず、読込時に正規化する。競合の評価 0 は評価なしとして読み、自店に評価があれば母数から評価 0 の件数を引く。自店の評価が無い（null か 0）なら順位・母数・前日の順位を持たせない。前日の評価が 0 なら前日の順位も持たせない
- 進め方は 2 PR。PR-1（TS の読込・表示・spec）を先に出し、PR-2（Go が未評価を null で保存し、順位から外す。前日のスナップショットで未評価の行を読み飛ばさない）は PR-1 のデプロイ後に出す。新しい Go の null を古い TS が読むと、日次カードの `toFixed` で配信が落ちるためである
- 正規化と表示整形は `ts/packages/db/src/daily-summary.ts` に置かれ、`@fwlm/db/daily-summary` のサブパスから公開される（pg を含まない純関数。store-detail のクライアントにも同梱されるため、値の import を持たないことを ESLint が強制する）

本 spec が依存する点（設計で使う）:

- 通知の判定とレポートの表示は、`normalizeSummaryRatings` で正規化した行に対して行う。既存行の評価 0 はここで未評価に揃うので、本 spec 側で既存行を特別扱いする規則は持たない（当初の Req 1.11 は撤回した）
- 「競合比較可能」は、正規化後の行で「取得失敗ではなく、自店の順位が値を持ち、順位母数が 2 以上」と読める。`daily_summaries.status` の意味は変えない
- 文言（「評価なし」・順位に含めていない旨・自店に評価が無い旨）と整形（`formatRatingLabel`・`formatStarDiff`）は同モジュールの定数と関数を使い、3 面（日次カード・LIFF・LINE レポート）で揃える
- 推移の順位は、正規化した `daily_summaries` の行から読む。母数（比較可能かどうか）が要るので、`rating_snapshots` だけでは足りない
- 本 spec の Go の変更（口コミの帰属情報の保存・4-1）は、PR-2 と同じファイル（`go/internal/places/types.go`・`client.go`・`go/internal/repo/summaries.go`）と TS の `ts/packages/db/src/types.ts` を触る。PR-2 の後に載せて衝突を避ける
- 本 spec の本番提供は PR-1 と PR-2 の両方の本番反映を前提にする（Req 9.3）

---

## 設計フェーズの調査と決定（2026-09-13・/kiro-spec-design）

### Summary（設計）

- Discovery Scope: Extension（軽量ディスカバリ）。外部依存（LINE Messaging API・Google Places）は既に統合済みで、新しいライブラリは入れない。規約適合と移行手順の 2 点だけ一次情報を取り直した
- Key Findings:
  - Places のテキストの帰属表示には細則がある（文字の改変・改行・翻訳の禁止、Roboto 400、12〜16sp、色は白・#1F1F1F・#5E5E5E、同じ容器の上端か下端）。既存の日次カードは `xxs`（12sp 未満）と `#AAAAAA` で満たしていない。LINE では書体を指定できない（書体は任意であり逸脱にならない。下の「訂正（2026-09-20・#287）」を参照）
  - 代理店がダッシュボードから店舗を登録する経路では、LINE の会話が未完了のままオーナーの店舗が確定し、完了後メニューへのリンクが一度も張られない。通知の前に照合して張る仕組みが要る
  - #255 の PR #266 が、正規化と表示整形を `@fwlm/db/daily-summary` に置いた。本 spec はこれをそのまま使える

### Research Log（設計）

#### Places の帰属表示の細則

- Context: Req 8.1 はポリシーが定める形式での帰属表示を求める。どこまで LINE で満たせるかを確かめる
- Sources Consulted: `https://developers.google.com/maps/documentation/places/web-service/policies`（2026-09-13 取得）、`.claude/skills/messaging-api/references/flex-message.md`（Text の `size` はキーワードかピクセル、`action` を持てる）
- Findings:
  - "Don't modify the text Google Maps in any way"（大文字小文字を変えない・複数行へ折り返さない・翻訳しない）
  - "Font family: Roboto. Font weight: 400. Font size: Minimum font size: 12sp Maximum font size: 16sp"、色は "White, black (#1F1F1F), or gray (#5E5E5E)"、配置は "near the top or bottom of the content, and within the same visual container"
  - 口コミ本文の切り詰め、帰属リンクをタップ可能にすべきかは原文に記述が無い
  - LINE Flex の Text は `size` にピクセル値を取れる。書体を指定するプロパティは無い。テキストメッセージ（`type: text`）は大きさも色も指定できない
- Implications: 通知もレポートも Flex の footer にテキストの帰属表示を置き、大きさを 12〜16 の範囲のピクセル値に、色を #5E5E5E に固定する。書体は既知の逸脱として残す（この判断は誤りだった。下の「訂正」を参照）。通知をテキストメッセージにすると大きさと色まで逸脱するため、通知も Flex にする

#### 口コミの帰属情報の取得元

- Context: Req 8.2・8.6・8.7 を満たすための項目が、既存の取得で手に入るか
- Sources Consulted: Places API リファレンス（`places` リソースの Review と AuthorAttribution・2026-09-13 取得）、`go/internal/places/client.go:23`（自店のフィールドマスクは `reviews`）、`go/internal/places/types.go:112-126`
- Findings: Review は `googleMapsUri` を、AuthorAttribution は `displayName`・`uri`・`photoUri` を持つ。Go は `displayName` だけを構造体へ受けている
- Implications: Go の受け皿と jsonb の要素に 3 項目を足すだけで、取得回数とフィールドマスクは変えない。実レスポンスに 3 項目が含まれることは、実疎通（`infra/README.md` §8）で確かめる

#### 完了後メニューのリンクが張られる経路

- Context: Req 2.8（どの経路でも最初の通知より前に完了後メニュー）と Req 1.10（メニューが無いオーナーへメニューへ誘導する通知を送らない）
- Sources Consulted: `conversation.ts:476-535`（リンクは `handleConfirm` だけ）、`ts/apps/dashboard-api/src/index.ts:79-80`（代理店登録は `confirmStore` を呼ぶだけで LINE に触れない）、`.claude/skills/messaging-api/references/rich-menu.md`（per-user リンクは既定より優先・削除されたメニューへのリンクは既定へ落ちる）
- Findings: 代理店登録の経路ではリンクが一度も張られない。dashboard-api は LINE の資格情報を持たない。delivery-job は LINE の資格情報を持ち、通知の直前に動く
- Implications: 通知の直前に delivery-job がオーナーのメニューを確かめ、違えば張ってから送る。張れなければ送らない。LINE の資格情報を新しいサービスへ配らない

#### PR #266（#255 前半）の公開 API

- Context: 本 spec が未評価の扱いを独自に持たないため
- Sources Consulted: `origin/fix/unrated-rating-255`（6763813）の `ts/packages/db/src/daily-summary.ts`・`targets.ts`・`ts/eslint.config.js`
- Findings: `normalizeSummaryRatings`・`normalizeSnapshotRating`・`formatRatingLabel`・`formatStarDiff`・`hasUnratedCompetitor`・`isUnratedSelf` と文言 3 つを、pg を含まないサブパス `@fwlm/db/daily-summary` から公開する。`queryDeliveryTargets` は正規化した行を返す
- Implications: レポートの組立も通知の判定も、正規化した行だけを入力にする。本 spec の実装は #266 のマージを前提にする

### Architecture Pattern Evaluation（設計）

| Option | Description | Strengths | Risks / Limitations | Notes |
|---|---|---|---|---|
| 振り分けを conversation.ts の completed 分岐へ足す | 段階ごとの分岐の中にレポートを書く | ファイルが増えない | 代理店経路のオーナーは completed に来ないので Req 2.9 を満たせない。オンボーディングの状態機械が肥大する | 不採用 |
| 店舗特定済みオーナー用の振り分け口を前段に置く | `handleEvent` の冒頭でオーナーの状態を見て、専用の router へ渡す | 経路を問わず同じ扱い（Req 2.9）。第2フェーズは router に 1 分岐を足すだけ | オーナーの照会が 1 回増える | 採用 |
| レポート codec を line-webhook の中に置く | codec をアプリ内に閉じる | パッケージが増えない | delivery-job がメニューの準備判定に同じ codec を要し、アプリ間 import か二重定義になる | 不採用 |
| レポート codec を共有パッケージに置く | `@fwlm/line-report`（実行時依存なし） | line-webhook・スクリプト・delivery-job が同じ定義を読む | 新パッケージの配線（Dockerfile・型検査と試験の網羅ガード） | 採用 |
| メニューのリンク状態を DB に持つ | `owner_rich_menu_links` 表で照合する | API 照会が減る | migration・書込境界・権限が増え、LINE 側の実状態と食い違いうる | 不採用。LINE の実状態を照会する |

### Design Decisions（設計）

#### Decision: 店舗特定済みオーナーの判定と振り分け

- Context: Req 2.9・3.4 と、2 系統の完了の定義（4-5）
- Alternatives Considered: 1. `onboarding_sessions.stage` で判定する 2. `owners.onboarding_status` で判定する
- Selected Approach: `owners.onboarding_status = 'store_identified'` で判定する。確定店舗の作成は `confirmStore` だけが行い、同じトランザクションでこの状態へ遷移させるので、「確定店舗を 1 店以上持つ」と同値である
- Rationale: 代理店経路を含む唯一の判定点で、既存の張り替え手順（`infra/README.md` §10-3）の SQL とも一致する
- Trade-offs: 会話のセッションが未完了のまま残るオーナーが生まれる。router が初回の操作でリンクを張り、段階を completed に揃える
- Follow-up: 第2フェーズの GBP 委譲（phase2 ブランチは `session.stage === 'completed'` で判定している）を統合するときに、判定を router へ寄せる

#### Decision: レポートの postback 契約

- Context: Req 2.3・3.2・3.10 と、メニューに埋め込まれた data が作り直すまで変えられないこと
- Selected Approach: `a=rpt&k=<nr|cmp|tr>`、店舗の指定は `&s=<storeId>`、選択肢の頁は `&p=<n>`。メニューの area は店舗も頁も持たない形だけを使う
- Rationale: オンボーディング（`a=select|confirm|restart|resume`）と第2フェーズ（`a=g_post|g_reply|g_status`）の action と衝突しない。店舗を storeId で運ぶので、候補の保存（セッション）が要らない
- Trade-offs: 形式を変えると、利用者の手元のメニューとトーク履歴の選択肢が古い data を送り続ける。形式は Revalidation Trigger に入れる
- Follow-up: 復号器が onboarding の data を受理しないこと、onboarding の復号器がレポートの data を受理しないことを試験で固定する

#### Decision: 通知を Flex にする

- Context: Req 1.6・8.1 と、帰属表示の細則
- Alternatives Considered: 1. テキストメッセージ（§7.16 の書き方） 2. 小さな Flex バブル
- Selected Approach: 本文 1〜2 文と footer の帰属表示だけを持つ Flex バブルにする。altText に同じ文と帰属を入れる
- Rationale: テキストメッセージは帰属の大きさと色を指定できず、細則から 3 点逸脱する。Flex なら書体の 1 点だけになる。§7.16 は案内文の書き方であり、Places 由来のデータを載せる通知には帰属の細則が優先する
- Trade-offs: 通知のバブルが案内文より重く見える。ボタンは置かない（誘導先はリッチメニュー）
- Follow-up: `docs/design/design-language.md` §7.16 に、Places 由来の通知は Flex にする例外を書く（Req 9.1）

#### Decision: 帰属表示はテキストで、ロゴは別判断にする

- Context: ポリシーは「可能な限りロゴ」、場所が限られればテキストを認める
- Selected Approach: 本 spec はテキスト「データ提供: Google Maps」を採り、大きさ 13px・色 #5E5E5E・折り返しなし・同じバブルの footer に置く
- Rationale: 既存の LINE 面と LIFF もテキストで揃っており、ロゴへ切り替えるなら画像の配信元（公開 HTTPS）とロゴの使用条件の確認を 3 面まとめて行うべきである
- Trade-offs: 書体（Roboto）を指定できない逸脱が残る（この逸脱は存在しなかった。下の「訂正」を参照）
- Follow-up: ロゴへの切り替えと、LIFF の帰属表示の細則適合を、横断の別 Issue で判断する

#### 訂正（2026-09-20・#287）: 書体の逸脱は存在しなかった

- Context: #287 でオンボーディングの候補カルーセルの帰属を塞ぐにあたり、原文（同じ URL・2026-09-20 取得）を当たり直した
- Findings: 上の Findings は**テキスト帰属の書式の表から 2 行を落として引用していた**。原文の表は 7 行あり、落ちていたのは次の 2 行である
  - `Font family: "Roboto. Loading the font is optional."`
  - `Fallback font family: "Any sans serif body font already used in your product or 'Sans-Serif'"`
- Implications: **原文は sans-serif のフォールバックを明示的に許している。** LINE Flex の既定の書体は sans-serif であり、書体を指定するプロパティが無いことは逸脱にならない。テキストの帰属表示は、書体を含めて細則を全て満たしている
- Decision: ロゴ画像への切り替えは行わない。公開 HTTPS の配信元もロゴの使用条件の確認も要らない
- Lesson: 表から引用するときは行を落とさない。落ちた 2 行が「満たせない」という誤った前提を作り、design.md・`report/format.ts`・`design-tokens/test/tokens.test.ts` の 3 箇所へ 1 週間伝播した

#### Decision: 通知の前にメニューを照合する

- Context: Req 1.10・2.8
- Selected Approach: delivery-job は実行ごとに、設定された完了後メニュー（`LINE_RICHMENU_COMPLETED_ID`）がレポートの 3 導線を持つかを 1 回照会する。持たなければ、その実行ではメニューへ誘導する通知を送らない。持つ場合は、通知するオーナーごとに現在のメニューを照会し、違えば張ってから送る。張れなければ送らない
- Rationale: 差し替え前にコードが出ても、誤った設定値が入っても、ボタンの無い面へ誘導する通知が構造的に出ない。代理店経路のオーナーにも最初の通知より前にメニューが付く
- Trade-offs: 通知 1 件ごとに LINE API の照会が 1〜2 回増える（通知は変化があった日だけなので件数は少ない）
- Follow-up: 第2フェーズでタブ切り替え（`richmenuswitch`）を入れると、per-user のメニューがタブの側を指しうる。そのときは照合の「同じメニュー」の定義を広げる（Revalidation Trigger）

#### Decision: 通知しなかった日も記録する

- Context: Req 1.4・1.5・1.8・1.10 と、`infra/README.md:204` の成功の証拠、silent drop の禁止
- Selected Approach: `summary_deliveries.status` に `skipped_no_change`・`skipped_not_comparable`・`skipped_menu_unavailable` を足す（CHECK の作り直し）。予約→判定→記録の既存の 2 段を保つ
- Rationale: 再実行時の重複判定（1.8）と、送らなかった理由の追跡が同じ行で済む
- Trade-offs: migration の番号が #259（0009 予定）と重なりうる。後着側が振り直す
- Follow-up: `db/test/assertions/15_competitive_daily_summary.sql` の分岐を 7 値にする

#### Decision: 推移の読み元は daily_summaries

- Context: Req 6.4・6.8（失敗日・未実行日・比較不能日を区別する）
- Selected Approach: 最新の対象日から 7 暦日の `daily_summaries` を読み、正規化してから日ごとに「比較可能・比較不能・取得失敗・行なし」に分ける
- Rationale: `rating_snapshots` は失敗日に行が無く、順位母数（比較可能かどうか）も持たない

#### Decision: リッチメニューの構成と第2フェーズの足し方

- Context: Req 2.1・2.2・2.7
- Selected Approach: Full（2500×1686）。上段 3 区画に 3 つのレポート（postback＋displayText）、下段 2 区画に「詳細を見る」（LIFF への uri）と「ステータス確認」（既存と同じ message）。第2フェーズは下段を 3 区画に割り直し、3 つ目に「Google 連携」（postback で第2フェーズの Flex メニューを返す）を置く。口コミ返信は新着口コミレポートの口コミごとに置く
- Rationale: 既存 5 導線の名称と動作を変えずに第2フェーズの入口を足せる。画像を変える以上メニューの作り直しは避けられないので、配置の割り直しは許容する
- Trade-offs: #195 が Half に縮めた占有高さが再び増える。代わりに `selected: true` で既定表示にし、レポートの主導線として扱う

### Synthesis（設計）

- Generalization: 3 つのレポートはどれも「オーナーの確定店舗を解決し、最新の日次集計を読み、正規化して組み立てる」同じ流れの変種である。店舗の解決（1 店は即応答・複数は選択・集合外は再提示）と、データ状態の分岐（行なし・失敗・正常）を 1 つの handler に集め、組立だけを種類ごとに分ける
- Build vs Adopt: 未評価の正規化と整形は #266 のモジュールを採る。LINE の型は `@line/bot-sdk` を実行時依存に入れず、既存どおり局所的な型で組む（line-webhook と delivery-job の既存方針）。棒グラフの描画は作らない
- Simplification: メニューのリンク状態を DB に持たない（LINE の実状態を照会する）。旧来の日次カードへ戻す分岐を持たない（差し替え前はメニュー照合で通知が止まる）。推移の棒は描かず、要約 1 行と表にする

### Risks & Mitigations（設計）

- 差し替えの前にコードが本番へ出ると、差し替えまでの間は通知が 1 通も出ない — 本番のオーナーはまだ検証用だけである。差し替えをデプロイの直後に行う手順にする
- 帰属表示の書体が細則と異なる — 既知の逸脱として記録し、ロゴへの切り替えを別 Issue で判断する
- LIFF の `?storeId=` が `liff.state` 経由で届かない — 届かなくても、単一店舗は正しく表示され、複数店舗は選択画面に着地する。実機確認の項目に入れる
- 第2フェーズの統合で router と conversation.ts が衝突する — 第2フェーズの委譲は router の分岐として足すことを design に記録する
- 既存の LIFF は口コミを Google Maps への導線なしで表示している（規約の "must always have access"） — 本 spec の境界外（既存詳細画面）。別 Issue を提案する
- 投稿者の画像（Google のプロフィール画像 URL）を LINE の画像部品が描けない（HTTPS の JPEG か PNG を要求する） — 描く設計にし、本番の実機確認で確かめる。描けなければ外して名前とリンクだけにし、Req 8.6 の判断を記録し直す
- design.md が 1000 行に達した — 応答・通知・メニュー移行・Go の保存項目・文書整合を横断するためである。実装タスクは PR 単位（共有パッケージ／line-webhook／delivery-job と migration／Go／スクリプトと運用／文書）に分けて並行できる境界にした

### References（設計）

- [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies) — 地図なしの帰属、テキストの帰属の細則、口コミの投稿者の帰属と `googleMapsUri`
- [Places API reference（places）](https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places) — Review と AuthorAttribution の項目
- `.claude/skills/messaging-api/references/rich-menu.md` / `action-objects.md` / `flex-message.md` / `message-objects.md` — リッチメニューの上限・postback の displayText・Flex の Text・クイックリプライの上限
- Issue #255 のコメント（2026-09-13T02:10Z）と PR #266 — 未評価の扱い

---

## 設計レビュー（2026-09-13・/kiro-validate-design）

判定は NO-GO（初版のまま）で、次の 3 点を design へ反映した。いずれも design の中で閉じる修正で、要件の改訂は要らない。レビューの時点で PR #266 は main へマージ済み（2026-09-13T03:36Z）で、最終修正（f21b113）は公開 API を変えていないことを確かめた。

### 指摘 1: 順位変動の比較対象

- 初版は当日の行の `rank_prev`（Go が当日の競合集合で前日の値を計算し直したもの）と比べていた。Req 1.2 は「前日の日次集計で確認できる自店の順位」と比べると定めている
- 競合の一時的な取得失敗などで集合が日によって違うと、`rank_prev` と前日の行の `rank` は食い違う。その場合、オーナーが前日のレポートで見た順位と通知の起点が合わない
- 利用者の選択（2026-09-13）: 前日の行の `rank` と当日の `rank` を、両日とも比較可能なときに比べる。集合が変わった日と復帰した日の両方で通知が出うるが、レポートの表示と食い違わない事実なので許容する

### 指摘 2: env の変更とイメージの自動デプロイの順序

- CI はイメージだけを差し替え（`.github/workflows/deploy.yml` の `gcloud run jobs update --image`）、env は Terraform が持つ（`infra/modules/delivery-job/main.tf` は image を `ignore_changes`）
- 初版の移行手順では、新しいイメージが `LINE_RICHMENU_COMPLETED_ID` を必須にしてマージで出た瞬間から、`tf apply` までの間、配信ジョブが毎時 `MissingConfigError` で落ちていた。`LIFF_URL` を先に外せば旧イメージが落ちる。まだマージしていない migration を本番へ当てる段取りも含んでいた
- 反映: Step A（migration と env の追加だけの PR をマージして適用）→ Step B（コード）→ Step C（差し替え）→ Step D（`LIFF_URL` の撤去）に分けた。env を足す変更はイメージより先、外す変更はイメージより後に出す

### 指摘 3: 張り替えの「全員確認」とブロック中のオーナー

- LINE はブロック中・友だち解除・退会済みのユーザーへのリンクを 200/202 で受理して黙って失敗する（`.claude/skills/messaging-api/references/rich-menu.md` の Link conditions）。初版の「全員を確かめたときに限り削除」は、ブロック中のオーナーが 1 人いるだけで永久に満たせなかった
- router の照合は会話の段階が completed でないときだけで、ブロックを解除したオーナーは通知が来るまで既定の面（登録を再開）を見続けた
- 反映: 張り替えの結果を `verified`・`unreachable`（プロフィールの照会が 404）・`mismatch`・`error` に分け、`mismatch` と `error` が 0 件なら削除できるようにした。router は友だち追加と再開の postback でも、段階によらずメニューを張る

---

## タスク生成時の design の手直し（2026-09-13・/kiro-spec-tasks）

タスク計画を独立の審査役に 2 回かけ（1 回目 8 件・2 回目 4 件の指摘）、そのうち design 側の食い違いを次のとおり直した。いずれも局所的で、要件と境界は変えていない。2 回目の指摘を反映したあとの 3 回目の審査は、規則（修正と再審査は各 1 回まで）に従って行っていない。

- ビルダーの試験を 1 ファイルからビルダーごとに分けた。並行に実装する 3 つのビルダーが同じ試験ファイルを書き合わないようにするため。30KB の検証と正規化済みの行の型は `report/format.ts` に置いた
- 準備判定を「通知すべき店舗が現れた時点」から「対象の有無によらず実行ごとに 1 回」に改め、実行サマリーの `reportMenuReady` に毎回出すようにした。本番で変化の無い日にも、差し替えの前後を確かめられるようにするため
- DB の読み出しの上限を種類ごとにした（新着と比較は 4 回、推移は 5 回）。推移は最新の集計の日付を終点に範囲を読むため 1 回多い
- レポート用の読み出しに基準日（日本時間の日付 `asOf`）の引数を足した。Go の言語間試験は固定日（2026-07-12）で行を書くので、DB の `now()` から窓を切ると試験で 1 行も読めない（`go/internal/batch/crossruntime_test.go:155`）。store-detail の読み出しと同じ形である
- 本番の読み取り確認（`scripts/run-e2e-prod-checks.sh:267`）は「対象をすべて送信した」を合格にしており、変化の無い日が普通になると恒常的に FAIL する。判定を「失敗と上限超過が 0 件、準備判定が true、対象が送信か理由つきの見送りに数えられている」に改め、注入口と自己試験のケースを足すことを Modified Files に書いた。Req 9.1 の「旧来の配信の振る舞いを固定している自動テスト」に当たる
- 張り替えスクリプトはトークンの発行を自前で持つ（`setup-rich-menus.ts` の非公開関数を import しない）
