# Technology Stack

## Architecture

**GCP 単一帝国上のマルチテナント・サーバレス構成。**
運営保有の **単一 LINE 公式アカウント** に全オーナーが友だち登録するマルチテナント型。客向け機能（機能3）は LINE を経由しない。

リアルタイム応答層（TypeScript）と日次バッチ層（Go）を **言語で役割分離する二刀流**。両者は同一 Cloud SQL を共有するため、**書き込み境界の規律**（後述）が最重要。

## Core Technologies

- **言語**: TypeScript（リアルタイム応答層）＋ Go（日次バッチ層）
- **プラットフォーム**: LINE Messaging API（公式アカウント／Bot）＋ 必要箇所のみ LIFF。客向けは通常 Web（LIFF ではない）。
- **クラウド**: GCP
  - **Cloud Run**: Webhook／客向け Web／ダッシュボード API（ゼロスケール）
  - **Cloud Scheduler**: 日次バッチ起動
  - **Cloud SQL (PostgreSQL)**: 単一 DB（2 言語が共有）
  - **Identity Platform = Firebase Auth**: ダッシュボードの Google ログイン（パスワードを自前管理しない）
- **生成AI**: Gemini API（口コミ下書き生成）
- **外部データ**: Google Places API（競合データ・従量課金許容。スクレイピング禁止）

## 二刀流の役割分担

- **TypeScript = リアルタイム応答層**: LINE Webhook・リッチメニュー・Flex Message 組立・客向けアンケート Web・Gemini オーケストレーション。LINE 公式 SDK が充実し、客向け Web と型を共有できる。
- **Go = 日次バッチ層**: 全店舗 × 競合5店の Places API を毎朝 goroutine で並行取得。低コスト・安定。

## Key Technical Decisions

- **書き込み境界（最重要運用規律）**: 同一 Cloud SQL を 2 言語から触るため、**どの言語がどのテーブルを書くか** を厳格に定義する。新テーブル追加時は必ず書込責任言語を明記。共有定数（カテゴリ定義等）の同期も二重化リスクとして管理する。
- **4階層データモデルを初期から確定**: `運営 → 代理店(Agency) → オーナー(Owner) → 来店客(Customer)※匿名`。後からの階層挿入は不可。スキーマ変更時もこの4階層を壊さない。
- **RBAC によるロール分離**: 運営（全店閲覧）と代理店（担当店のみ）は同一ダッシュボードにログインし権限分離。
- **MINI App 不採用**: 審査が重く初期不要。客向けは通常 Web、LINE 内入力は LIFF に限定。
- **GBP OAuth は第2フェーズ**: MVP に OAuth 連携を持ち込まない（審査リスク回避）。
- **Next.js `NEXT_PUBLIC_*` はビルド時 build-arg 必須**: `NEXT_PUBLIC_*` は `next build` 時にクライアントバンドルへインライン化される値。Cloud Run のランタイム env 注入はサーバー側にしか効かず、クライアントバンドルには一切反映されない。standalone アプリで使う `NEXT_PUBLIC_*` は必ず Dockerfile の `ARG`+`ENV`（`next build` 前）でビルド時に渡し、`scripts/push-images.sh` の `BUILD_ARGS` にも対応エントリを足すこと。CI の `scripts/check-next-public-buildargs.sh` が「ソースで参照する `NEXT_PUBLIC_X` に対応する `ARG` が Dockerfile に在るか」を機械強制する。CI 自動デプロイ（`.github/workflows/deploy.yml`・`ts-ci` 緑後に image-only 反映・Direct WIF）は `vars.NEXT_PUBLIC_LIFF_ID`（= tfvars `liff_id`）を build-arg として渡す。出典: 2026-07-14 の本番 LIFF 起動障害（`.kiro/specs/competitive-daily-summary/tasks.md` Implementation Notes 参照）。
- **デプロイの成否は「稼働実態」で判定する（Issue #91）**: `deploy-prod` は `workflow_run` 起動のため PR のチェック欄に現れず、かつ**マージ契機でしか動かない**。2026-08-02〜09 の課金失効では、失効期間中に main へのマージが無かったため run 自体が生成されず、本番が 7 日間旧イメージで放置された（同型の見落としは #33 / #35 に続き 3 度目で、原因は毎回違うが気づけない構造は同じ）。対策は 2 つ。(1) `prod-image-drift` が 6 時間ごとに稼働イメージのタグを git オブジェクトへ解決して `origin/main` と照合する（read-only・`scripts/check-prod-image-drift.sh`）。猶予は「**未デプロイコミットのうち最も古いものの経過時間**」で判定する（main HEAD の経過時間で見ると、停止中に新規マージが入った瞬間に緑へ戻る穴がある）。(2) `deploy-prod` に失敗通知ジョブを持たせる。通知はいずれも `scripts/report-ci-issue.sh` がラベル単位の追跡 Issue を 1 本だけ維持し、復旧で自動クローズする。**対象集合の正典は `scripts/check-deploy-image-coverage.sh --print-targets`**（サービスは tf の run-services、ジョブはその差集合として導出。列挙を二重管理しない）。
- **通知は症状側と原因側の両方に置く（Issue #118）**: #91 で入れた `prod-image-drift` は「本番が古い」という症状を見る遅行指標であり、原因（main の ts-ci が赤い）を指さない。しかも `deploy-prod` の失敗通知は、main が赤いと `deploy` ジョブごと skip されるため発火しない（skip を失敗として扱わないのは正しい判断である）。結果として**最も直接的で最も早い信号だけが通知経路を持っていなかった**。2026-08-09 の赤化は 3 時間 53 分後に症状側が拾い、そこから 2 日放置され、本番が約 2 日 16 時間停滞した。よって `ts-ci.yml` に `notify` ジョブを置き、main への push に限って `scripts/ts-ci-notify.sh` が状態を判定し、同じ追跡 Issue 基盤へ流す。規律は 3 点。(1) **判定は `cancelled` / `skipped` を red へ倒さない**（偽の障害通知は通知そのものの信頼を壊す）。PR イベント限定の `docker-build` を `needs` に入れないのも同じ理由である。(2) 通知ジョブ自身の失敗は ts-ci を赤にする（結果として deploy-prod も止まる）。通知装置が壊れているのに緑を返すのは、この Issue が塞いだ構造をそのまま一段上へ移すだけである。(3) 監視対象が job 一覧から漏れる事故は `scripts/test/cases/73-ts-ci-notify.sh` が `ts-ci.yml` と機械照合する。

- **シークレットの「実値が入っている」ことはリポジトリ内の宣言で正典化する（Issue #63）**: Secret Manager の枠は Terraform が作るが、**値（version）は tf が一切作らない**（`google_secret_manager_secret_version` は git 史上ゼロ件）。値は `infra/README.md` §1 項目 5 の `gcloud secrets versions add` で人間が out-of-band 投入するため、「tf 成功・デプロイ成功・CI 全緑、しかし値がプレースホルダーのまま」という無音障害が構造的に起き得る（gemini-api-key が 2026-07-05〜08-02 の 4 週間この状態で、機能A は go-live 以降一度も成功していなかった）。正典は `infra/secrets-provisioned.tsv`（`<secret_id>` / `<version>` / `<投入日>` / `<Issue-PR>`）。GCP の annotation ではなくリポジトリ内に置くのは、**tf へ新しい枠を足した PR の時点で「宣言に無い」を ts-ci が即座に赤にできる**ためで、投入漏れを本番へ出す前に捕まえられる。検証は二層。層1 `scripts/check-secret-declaration-coverage.sh`（ts-ci・gcloud 不要・tf ↔ 宣言 ↔ README ↔ 消費側配線を両方向照合）、層2 `scripts/check-secret-version-drift.sh`（`secret-version-drift` ワークフロー・6 時間ごと・**メタデータのみ**）。**「versions が 1 件だけなら未投入」という heuristic は採用しない** — `survey-session-key` は version 1 件のみで実値であり誤検出になる（本番実測）。層2 は「宣言 version が DESTROYED でない最大番号であり、かつ唯一の ENABLED である」ことを要求する。Cloud Run は `version = "latest"` でマウントし pin を持たないため、この条件なら `latest` の解決規則がどちらの解釈でも宣言 version へ解決し、規則の解釈に依存しない。CI へ付与するのは **secret 単位の `roles/secretmanager.viewer`** のみで、このロールは `secretmanager.versions.access` を含まない（実測確認済み）＝ CI は値を読めない。project 単位の付与は Req 5.4 で禁止であり、その帰結として CI は `gcloud secrets list` を打てない（検証は宣言された secret を 1 件ずつ describe / versions list する）。**値そのものの正当性（失効キー・別プロジェクトのキー）はこの二層では原理的に検出できない。** これは Issue #125 の層3 が引き取った（次項）。

- **外部 API の実疎通は人手で行い、記録をリポジトリ内の宣言で正典化する（Issue #125・#63 の層3）**: 値の正当性へ到達する手段は「実際に叩いて成功を観測する」ことしかない。だが **その行為を CI へ持ち込んではならない**。CI の責務はイメージ更新であり外部 API 呼出ではないので、CI へ `roles/secretmanager.secretAccessor` を付けることは Req 5.4（各実行環境は自身の責務に必要なシークレットのみ読み取り可能）に反し、#63 の再発防止のために #63 より広いブラストラディウス（third-party action・PR 経由実行を含む GitHub Actions ランナー）を開くことになる。したがって #63 と同じ形を採る — **out-of-band の人手作業をリポジトリ内の宣言で正典化し、CI は宣言の構造と鮮度だけを両方向照合する。新しい IAM 付与はゼロ。** 正典は `infra/external-api-smoke.tsv`（`<secret_id>` / `<api>` / `<最終確認日>` / `<証拠>` / `<Issue-PR>` / `<説明>`）で、secret 正典と 1:1 に対応する行を持ち、各行が `api` か `-`（対象外）かを**必ず宣言させる**（棚卸しの漏れが「行が無い」という不可視の形にならないようにするため）。実行は `scripts/run-external-api-smoke.sh`（運用者の資格情報・手順は `infra/README.md` §8）。
  - **層1 `scripts/check-external-api-smoke.sh`（ts-ci）は `date` を 1 箇所も持たない。** ts-ci が時間依存になると、何も触っていない PR がある日突然赤くなり、そのとき人間が取る最も安い行動は「実疎通せずに日付だけ更新する」ことで、規律そのものが空洞化する。この分界はコメントの約束ではなく **コードに `date` が無いという構造** で担保し、自己テストが機械検証する。鮮度は層2 `scripts/check-external-api-smoke-freshness.sh`（`external-api-smoke-freshness` ワークフロー・日次・有効期間 14 日・GCP へ一切アクセスしない）が持ち、ブロックしない追跡 Issue へ流す。
  - **日付で判定するガードは、記録側と判定側の TZ を明示的に同一へ固定する（PR #130 レビュー）**: 記録（`infra/external-api-smoke.tsv` の最終確認日）は JST だが、GitHub の runner は UTC である。素の `date` を使うと両者が最大 1 日ずれ、本ワークフローの cron は 21:07 UTC ＝ **JST 翌 06:07** に当たるため、JST 00:00〜06:07 に実疎通して記録を更新した当日、正当な記録が未来日（＝叩かずに日付だけ埋めた捏造）と誤判定される。手順どおり叩いた運用者を追跡 Issue で名指しする形になり、**偽の障害通知は通知そのものの信頼を壊す**（#118 で確立した規律に真正面から反する）。逆向きにも 1 日ぶんの甘さが出て有効期間 14 日が実効 15 日になる。よって判定側（`check-external-api-smoke-freshness.sh`）も記録側（`run-external-api-smoke.sh` が押す日付と証拠の刻）も `TZ=Asia/Tokyo date` で固定する。**tzdata が無い環境では `TZ=Asia/Tokyo` はエラーにならず黙って UTC へ落ちる**ため、`+%z` が `+0900` であることを確かめてから判定へ進む（落ちたまま緑を返さない）。自己テストは「ある TZ で緑」ではなく **基準日が実行環境の TZ に依らず一定であること** を UTC-12 / UTC / UTC+14 の 3 点で照合する（JST から見てどの瞬間でも少なくとも 1 つは日付が食い違うため、単一 TZ で固定すると時刻帯によって赤にも緑にも転ぶ時間依存テストになる）。
  - **api の語彙をガードへ列挙しない。** 語彙の正典は `infra/README.md` §8 の見出し（`### 8-<番号>. <api>: <説明>`）であり、宣言と README が互いの正典になる（片側の綴り間違いは必ずもう片方向で落ちる）。ガードへ配列を置くと 3 箇所目の二重管理になる。
  - **無害な最小呼び出しに限る。** gemini = 出力 1 トークン上限の `generateContent`、places = フィールドマスク `id` のみの Place Details（最安 Essentials SKU）、line-messaging = トークン発行 → `GET /v2/bot/info`。**LINE の push / multicast / broadcast を実疎通に使ってはならない**（実送信は受信者への迷惑であり無料メッセージ通数枠を消費する）。`/v2/bot/info` は read-only でチャネル資格情報の正当性を証明できる。
  - **実疎通の出力は allowlist にする。** 出すのは PASS/FAIL・HTTP ステータス・API が返した `status`（`[A-Z_]` のみ受理）だけで、応答本文を出さない。Google の 400 応答はリクエスト URL を本文へ含むことがあり、素朴に出すと鍵がターミナル履歴や貼り付け先へ漏れる。同じ理由で `set -x` を使わず、curl のヘッダと POST 本文は 600 の一時ファイル経由で渡す（コマンドラインに置くと同一ホストの他ユーザーが `ps` で読める）。
  - **Cloud Run Job の execution 成否を実疎通の証拠に採ってはならない。** `go/cmd/daily-batch/main.go` が非0終了するのは `result.StoresTotal > 0 && result.FetchOK == 0 && result.FetchFailed > 0` のときだけで、**対象店舗 0 件なら Places キーが死んでいても exit 0** になる（`summary-delivery` も対象 0 件なら同型）。これを証拠に採ると「成功しているように見えるが一度も実際には動いていない」という #63 とまったく同じ無音障害を一段上で再生産する。`fetch_ok > 0` のような**実際の成功回数**を見る恒常観測は別途要るが、ログベースメトリクスと `roles/monitoring.viewer` の付与判断を伴うため独立した課題として切り出す。
  - **既知の限界を隠さない**: このガードは人間の実施を強制できず、記録の鮮度しか見ていない。日付だけ更新すれば緑になる。`<証拠>` 欄は「本当に叩いたのか」を第三者が後から辿るための唯一の手掛かりであり、空欄と `-` は層1 が赤にする。
  - **未消費の枠は宣言から外すのではなく撤去する（Issue #141・2026-08-23 実施）**: #125 の棚卸しで `line-channel-access-token` が **コードから一切読まれていない**ことが判明した。LINE 送信は 3 実装（`ts/apps/delivery-job/src/line.ts` / `ts/apps/line-webhook/src/line/client.ts` / `ts/apps/line-webhook/scripts/setup-rich-menus.ts`）がすべてチャネル ID とシークレットから `client_credentials` で stateless token を都度発行する方式に一本化されており、長期トークンを Secret Manager へ置く理由が消えていた。枠には accessor binding だけが残り、env へは一度もマウントされていなかった。**未消費の長期 credential は資産ではなく負債である** — Messaging API のフル権限を持ち、誰も使わないのでローテーションされず、**漏洩しても業務影響として現れない**（気づく経路が無い）。#63 の二層検証と #125 の層3 は「宣言どおり存在するか」「叩いて生きているか」を見るが、**「そもそも要るのか」は誰も問わない**。宣言に載り続ける限り 3 つのガードは永久にそれを守る。したがって棚卸しで未消費が出たら `api='-'` で分類して終わりにせず、**撤去まで持っていく**。
  - **撤去は 1 PR で原子的に行う。** `locals.secret_ids` が 3 ガード（`check-secret-declaration-coverage.sh` / `check-external-api-smoke.sh` / `check-secret-version-drift.sh`）の母数の源泉であり、いずれも両方向照合なので片側だけ消せば必ず赤くなる（fail-closed で正しい挙動）。**順序も逆にしてはならない** — リポジトリ側を先に消してマージし、その後に `terraform apply` で枠を destroy する。逆順にすると枠が消えた状態で宣言が残り、6 時間ごとの `check-secret-version-drift.sh` が「宣言はあるが本番に無い」で赤化して追跡 Issue が立つ。`google_secret_manager_secret.frames` に `prevent_destroy` は無いため apply は不可逆だが、失われるのは「その値」であって「能力」ではない（LINE Developers コンソールから再発行できる）。

- **Terraform の `for_each` には plan 時点で確定する値しか渡さない（Issue #63・PR #124 レビュー）**: module output が `{ name => resource.id }` の形をしていても、**`values()` を `for_each` の集合へ渡してはならない**。`.id` は computed であり、リソースが 1 件でも新規なら apply 前に確定しない。確定しない要素を含む set は `Invalid for_each argument` になり、**その env の plan ごと落ちる**。厄介なのは既存分が state にある限り緑で通ることで、**次に 1 件足した PR で初めて出る遅延型**である点。`terraform validate` は素通りし、ts-ci は terraform を走らせないため、人間が apply するまで発覚しない。渡すのは `keys()`（＝ `locals` の静的なリスト）か、鍵を静的に固定した map にする。IAM binding の `secret_id` / `service_account_id` などは短い名前と `project` の併記で解決できるので、フルパスの `.id` を運ぶ必要はない。実測（terraform 1.15.7）: 既存の枠だけなら plan 成功、枠を 1 件足すと `Invalid for_each argument`、`keys()` へ変えると同じ追加が通る。

## Development Standards

### LINE Messaging API 実装規律
- `.claude/skills/messaging-api/` スキルを使う。**LINE API を記憶で答えない**（頻繁に更新される）。
- Webhook 署名検証・Flex Message・リッチメニュー実装時は同スキルの references を必ず参照。

### ライブラリ方針
- 外部ライブラリは必要性を吟味して最小限に。LINE/GCP/Gemini の公式 SDK を基軸とする。

### Type Safety / Code Quality / Testing
- 実装着手時に確立する（現状ルール未策定）。確立後に本ファイルへ追記すること。

### シェルガードの実装規律（`scripts/`）

ガードは実装コードではなく **「緑が信用できるか」を守る装置** である。装置が静かに壊れると、
壊れたこと自体を誰も検出できない。以下はいずれも実測で踏んだ形なので、再発時の症状まで残す。

- **`git ls-files` には `-c core.quotePath=false` を必ず併用する。** 既定（true）は非 ASCII を
  含むパスを `"docs/\346\227\245..."` の形（引用符 ＋ 8 進エスケープ）で返す。行末が引用符に
  なるため拡張子の `$` アンカーに一致せず**列挙から丸ごと消え**、パスとして開けないので
  **黙って走査対象から落ちる**。実測（PR #99）: 日本語ファイル名の違反を base は exit 1 で
  検出し、head は exit 0 で緑になった。しかも空振り防止の件数表示は増えたままだった。
  `find` からの移行で生じる、対象の集合ではなく**対象の表現**が変わる型の退行である。
- **`set -euo pipefail` の下で、入力を読み切らない consumer をパイプ終端へ置かない。**
  `head -n N` や `grep -q` は途中で抜けるため上流が EPIPE を受け、`pipefail` により
  **スクリプトごと exit 141 で中断する**（OK も NG も出ないまま赤になる）。さらに上流が
  書き込める量は consumer の buffer 2 杯分あるので、**入力サイズ依存で赤にも緑にも転ぶ**。
  `if` 条件下では `set -e` が働かず中断しない。その場合 141 は「無一致」と**同義に読まれる**ので、
  転ぶ向きは条件の極性で決まる。無一致が ERROR 側なら偽の赤、スキップ側なら**黙って緑へ倒れる**。
  後者は「ガードが対象を静かに飛ばす」形であり、壊れたことを誰も検出できない。
  **入力が単一行なら発火しない。** grep は行単位で判定するため、1 行しか来ない入力では行末まで
  読まざるを得ず早期終了できない（実測: 200KB の 1 行で 3/3 が 0、多行 20,000 行では 3/3 が 141、
  多行 2,000 行では 3/3 が 0）。したがって「今は転ばない」は**入力の形という外部条件**に依存した
  安全であって、コードの性質ではない。振る舞いテストで守れるのは多行入力の箇所だけなので、
  構文そのものは `scripts/check-shell-pipe-consumers.sh` が静的に禁じている。
  - 件数は `grep -c`（入力を最後まで読むので SIGPIPE が起きない）、先頭数件の抽出は `q` を
    持たない `sed -n '1,Np'` を使う。
  - **`grep -c` を素で代入してはならない。** 無一致では exit 1 を返すため、
    `n="$(... | grep -c ...)"` は**違反ゼロという正常系でスクリプトごと中断する**。
  - **`|| true` で潰すのも誤りである。** 評価できない ERE に対する exit 2 まで飲み込み、標準
    出力が空のまま `${n:-0}` が 0 と読むため、**壊れたパターンのアサーションが PASS へ化ける**
    （PR #101 実測。健全な実行と件数まで一致し、痕跡は stderr の 1 行だけだった）。終了コードを
    捕捉し、無一致（exit 1）と評価不能（exit 2 以上）を分けること。正典は
    `scripts/test/run.sh` の `expect_output_matches` である。
  - **検出結果を文字列で受ける形のほうが危険である**（Issue #120 実測）。`hits="$(grep ...)"` を
    潰すと空文字になり、`[ -n "$hits" ]` が「違反なし」と**同義になる**。件数受けは極性しだいで
    偽の赤にも倒れるが、文字列受けは一方向に偽 PASS へ倒れる。実測 2 件:
    `check-design-tokens.sh` は違反を置いたまま「生パレット色クラスゼロ」で exit 0 を返し、
    `2>/dev/null` の併用により**痕跡が 1 行も残らなかった**。`check-workflow-step-names.sh` は
    「5 ファイル / 42 件の name: を検証」と**件数まで健全な実行と一致**させて exit 0 を返した。
    空振り防止の後ろ盾があるかで結果が割れるため、同じファイル内でも守られている行と
    守られていない行が混在する。行ごとに見るしかない。
  - **`2>/dev/null` は評価不能の診断ごと捨てる。** 走査対象の不在を抑止したいなら、対象の
    存在を先に確かめて `2>/dev/null` を外すこと。抑止と握り潰しを同じ手段で兼ねない。
  - **コマンド置換の中の `exit` は `if` の条件文脈では効かない。** 関数内で `exit` しても
    subshell が終わるだけで、`if [ -n "$(f ...)" ]` の形では `set -e` も働かない。いったん
    変数へ代入して受けること（`check-prod-image-drift.sh` の `snapshot_lookup` で実測）。
  - 機械強制は `scripts/check-shell-pipe-consumers.sh`（Issue #117）。追跡下の `scripts/**/*.sh`
    を走査し、`head` / `grep` の quiet・max-count 系 / `q` を持つ `sed` がパイプの下流に
    現れる行を弾く。除外は 3 つある。行頭 `#` のコメント行は**全ファイル**、`WHITELIST=(` の
    宣言行と配列要素の引用符行は**ガード自身のファイルに限定**して除外する。規律を説明する注記や、
    除外した違反行の内容そのものがガード本体へ現れるため、除外しないと永久に赤くなる。
  - **データ行の除外を全ファイルへ広げてはならない。** 引用符で始まる行を一律で飛ばすと、
    複数行の `awk` / `sed` で残りのコマンドが続く閉じ引用符行 — 本リポジトリに 3 箇所実在する
    形である — に置かれた違反が、ERROR も SKIP も出さずに消えた（PR #119 レビュー実測）。
    **除外の広さは「入れた理由」ではなく「外したら赤くなるか」で測る。** 当該除外は削除しても
    実リポジトリ緑・Tier A 全 PASS のままで、1 件のケースにも守られていなかった。除外を足す
    PR は、その除外を外すと赤くなる対照ケースを必ず同時に置くこと。
  - 後半（後置 `true` の禁止）の機械強制は `scripts/check-grep-exit-codes.sh`（Issue #120）。
    同じく `scripts/**/*.sh` を走査し、`grep` を含む行が後置 `true` で失敗を潰していないかを見る。
    導入時に 43 箇所を変換済み。**`grep` と後置 `true` が別の行に分かれた複数行パイプラインは
    検出できない**ため、そこは人手の規律のまま残る。
- **出力サイズに依存する自己テストは、閾値へ十分な倍率を取り、複数回実行で決定性を確かめる。**
  buffer 1 杯（64KB）で組んだケースは 5 回中 1 回緑になった（PR #99 実測）。上限は 2 杯分ある
  ため、総量が 128KB を大きく超える設計にする。フレークな赤ケースは、無いより悪い。
- **走査・列挙の機構を差し替える PR は、機構名を含む stderr 文字列まで棚卸しする。**
  `find` と prune 一覧を撤去したのに空振り時の診断が「prune 一覧か find の式を疑え」と案内し
  続け、**存在しない機構の調査へ誘導していた**（PR #99 のレビューで検出）。コメントだけでなく、
  利用者が読む出力を `grep` で全件確認すること。
- **同一ガードを対象とする改修 PR は直列化する。** ガードは「消えても誰も気づけない」からこそ
  価値がある。並走した #99 と #100 は追記位置の衝突だけで済んだが、同じ関数を書き換えていれば
  競合解決の過程で片方の防御が黙って消えていた。着手前に他ブランチの差分を確認すること。

## Development Environment

### 現状
**実装コード・`package.json`・`go.mod` はまだ存在しない**（要件定義・提案フェーズ完了直後）。
`.gitignore` は Node/TS + Go + GCP/Terraform を想定済み。

### Common Commands
```bash
# DB スキーマ（four-tier-data-model で確立。ランタイムは apple/container 既定、CONTAINER_CMD で差替可）
make db-migrate   # BUILD: 一時postgresへ db/migrations/*.sql をクリーン適用
make db-smoke     # SMOKE: 適用後 db/test/smoke/*.sql を実行
make db-test      # TEST:  適用後 db/test/assertions/*.sql を実行（網羅スイート）
make db-verify-docs # DOCS: ERD/write-boundary と実スキーマの整合・書込境界単一所有を機械検証
# アプリ層（TS/Go）のビルド・lint・テストは各層導入時に確立し追記する。推測で書かない。
```

---
_Document standards and patterns, not every dependency_
_一次情報源: `requirements.md` 2章／`README.md`／`CLAUDE.md`_
_created_at: 2026-06-28_
