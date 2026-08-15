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

- **シークレットの「実値が入っている」ことはリポジトリ内の宣言で正典化する（Issue #63）**: Secret Manager の枠は Terraform が作るが、**値（version）は tf が一切作らない**（`google_secret_manager_secret_version` は git 史上ゼロ件）。値は `infra/README.md` §1 項目 5 の `gcloud secrets versions add` で人間が out-of-band 投入するため、「tf 成功・デプロイ成功・CI 全緑、しかし値がプレースホルダーのまま」という無音障害が構造的に起き得る（gemini-api-key が 2026-07-05〜08-02 の 4 週間この状態で、機能A は go-live 以降一度も成功していなかった）。正典は `infra/secrets-provisioned.tsv`（`<secret_id>` / `<version>` / `<投入日>` / `<Issue-PR>`）。GCP の annotation ではなくリポジトリ内に置くのは、**tf へ新しい枠を足した PR の時点で「宣言に無い」を ts-ci が即座に赤にできる**ためで、投入漏れを本番へ出す前に捕まえられる。検証は二層。層1 `scripts/check-secret-declaration-coverage.sh`（ts-ci・gcloud 不要・tf ↔ 宣言 ↔ README ↔ 消費側配線を両方向照合）、層2 `scripts/check-secret-version-drift.sh`（`secret-version-drift` ワークフロー・6 時間ごと・**メタデータのみ**）。**「versions が 1 件だけなら未投入」という heuristic は採用しない** — `survey-session-key` は version 1 件のみで実値であり誤検出になる（本番実測）。層2 は「宣言 version が DESTROYED でない最大番号であり、かつ唯一の ENABLED である」ことを要求する。Cloud Run は `version = "latest"` でマウントし pin を持たないため、この条件なら `latest` の解決規則がどちらの解釈でも宣言 version へ解決し、規則の解釈に依存しない。CI へ付与するのは **secret 単位の `roles/secretmanager.viewer`** のみで、このロールは `secretmanager.versions.access` を含まない（実測確認済み）＝ CI は値を読めない。project 単位の付与は Req 5.4 で禁止であり、その帰結として CI は `gcloud secrets list` を打てない（検証は宣言された secret を 1 件ずつ describe / versions list する）。**値そのものの正当性（失効キー・別プロジェクトのキー）はこの二層では原理的に検出できない。** 外部 API に依存する機能は「本番で一度実際に叩いて成功を確認する」ことを go-live の完了条件に含めること（残件は Issue #125 が引き継ぐ）。

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
  `if` 条件下では `set -e` が働かず中断しないが、その場合は 141 が「無一致」と同義に読まれて
  **黙って緑へ倒れる**ため、むしろ質が悪い。
  - 件数は `grep -c`（入力を最後まで読むので SIGPIPE が起きない）、先頭数件の抽出は `q` を
    持たない `sed -n '1,Np'` を使う。
  - **`grep -c` を素で代入してはならない。** 無一致では exit 1 を返すため、
    `n="$(... | grep -c ...)"` は**違反ゼロという正常系でスクリプトごと中断する**。
  - **`|| true` で潰すのも誤りである。** 評価できない ERE に対する exit 2 まで飲み込み、標準
    出力が空のまま `${n:-0}` が 0 と読むため、**壊れたパターンのアサーションが PASS へ化ける**
    （PR #101 実測。健全な実行と件数まで一致し、痕跡は stderr の 1 行だけだった）。終了コードを
    捕捉し、無一致（exit 1）と評価不能（exit 2 以上）を分けること。正典は
    `scripts/test/run.sh` の `expect_output_matches` である。
  - 現状 `scripts/` には未変換の `grep -q` が 4 件残る（`check-design-tokens.sh`、
    `check-deploy-image-coverage.sh`、`check-test-code-coverage.sh` の 2 箇所）。入力はいずれも
    1 行〜数百バイトで pipe buffer に遠く、現時点では転ばない。**規律の例外ではなく未着手**で
    あり、同一ファイルを開いている PR #103 のマージ後に直列で片付ける（Issue #117）。
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
