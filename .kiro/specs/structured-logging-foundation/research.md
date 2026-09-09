# Gap Analysis: structured-logging-foundation

調査日: 2026-09-06 / 基準コミット: `c7c7c01` / 対応 Issue: #228（親 #227）

## 1. 現状調査

### 1.1 実行面ごとのログの実態（棚卸し）

デプロイ対象は 5 サービス + 2 ジョブだが、**ログを出しているのは 6 面**である（`dashboard-web` は出力ゼロ）。

| 実行面 | 事象名 | 項目名の流儀 | 例外の扱い |
|---|---|---|---|
| `survey-web` | あり（`generation_failed` ほか 6 種） | camelCase・**allowlist sink 経由** | 種別＋状態コードのみ |
| `store-detail` | あり（`store-detail.*` 4 種） | camelCase・sink なし | **本文を載せる**（`error`） |
| `delivery-job` | あり（`delivery-job.*` 4 種） | camelCase・sink なし | **本文を載せる**（`error`/`message`） |
| `line-webhook` | **なし**（メッセージ文字列で識別） | camelCase（`error`/`requestId`） | **本文を載せる** |
| `dashboard-api` | **なし** | ほぼ項目なし | 本文も識別子も無い箇所あり |
| `go`（daily-batch） | **なし**（`msg` 文字列で識別） | **snake_case**（`store_id`/`fetch_ok`） | `error` 属性に本文 |
| `dashboard-web` | 出力なし | — | — |

### 1.2 再利用できる資産

| 資産 | 何に使えるか |
|---|---|
| `ts/apps/survey-web/src/lib/structured-log.ts` | allowlist sink と鍵集合の型表明。**そのまま共有パッケージへ昇格できる**（Req 2 の中核） |
| `ts/apps/survey-web/test/structured-log.test.ts` | 余剰項目の遮断を **`JSON.stringify` の完全一致**で実測する手法。部分一致ではないため項目が 1 つ増えれば落ちる（Req 2 の検証手法） |
| `scripts/check-spec-env-names.sh` | **宣言表（markdown 表）を正典とし、第 2 列の「出典」で両方向照合が表の中で閉じる**型。Req 4-1/4-4 に直接使える |
| `scripts/check-design-tokens.sh` | ソースの書き方を禁止する型。BSD grep 対応（`\b` を使わない）・除外を「種別を前置した参照だけ」に絞る設計（Req 7-1） |
| `scripts/check-next-public-buildargs.sh` | 「実装側の参照」と「宣言側の記載」を突き合わせる型（Req 4-3） |
| `scripts/check-typecheck-coverage.sh` | `pnpm-workspace.yaml` の glob を走査するため、**新パッケージを自動で捕捉する**（列挙不要） |
| `scripts/test/run.sh` の assert 群 + `check-guard-selftest-coverage.sh` | 新ガードに自己テストを **2 段で強制**（`run.sh:648` が実行前に必ず呼ぶ） |

### 1.3 パッケージ追加の型

- 名前空間は `@fwlm/<name>`、`private: true` / `type: module` / `version: 0.0.0` が 5 パッケージ共通
- **dist を持つ型**（`db` / `store-identification` / `design-tokens`）: `main`/`types`/`exports` が `./dist/*`、`build: tsc -p tsconfig.json`、`tsconfig.typecheck.json` を別に持つ（build 用は `rootDir: src` で test を含められないため・Issue #70）
- **dist を持たない型**（`ui` / `e2e-support`）: ソース直参照の `exports`。消費者がバンドラ（Next.js / Playwright）である前提
- CI は `pnpm -r` で再帰処理するため **ワークフローの編集は不要**。ただし `package.json` に `typecheck` スクリプトが無いと `check-typecheck-coverage.sh` が赤くなる

## 2. 要件 ↔ 資産の対応表

| 要件 | 既存資産 | 判定 |
|---|---|---|
| 1-1/1-2 事象名を含む機械可読な出力・項目名の一致 | survey-web の sink | **Constraint**: Go は `event` を持たず `msg` で識別。TS 内でも `line-webhook`/`dashboard-api` に事象名が無い |
| 1-3 重大度が集約側の重大度として解釈される | なし | **Missing**: アプリの `level` は集約側の重大度へ写らない（`guardrails/main.tf:113-116` の本番実測）。是正方法は **Research Needed** |
| 1-4 店舗識別子による絞り込み | survey-web の `storeId` | **Constraint**: 本番の指標が `EXTRACT(jsonPayload.storeId)` を参照（`guardrails/main.tf:151`）。**camelCase を変更できない** |
| 2-1/2-2 許可された項目のみ | survey-web の sink と型表明 | **再利用可**。昇格するだけ |
| 2-3/2-4/2-6 客の入力・オーナー識別子・横断識別子を出さない | sink が構造的に保証 | **再利用可** |
| 2-5 例外の本文を出さない | survey-web のみ準拠 | **Missing**: `store-detail` / `delivery-job` / `line-webhook` の 3 面が本文を載せている。置き換えが要る |
| 3-1 握り潰しの記録 | なし | **Missing**: `conversation.ts:435-441`。`ConversationDeps` にロガーを注入する必要 |
| 3-2/3-3 記録の失敗が業務を止めない | 既存の握り潰し方針と同型 | **再利用可**（`survey-web` の `tally_failed` は `.catch()` で握って記録する形が既にある） |
| 4-1/4-2 項目名の正典化 | `check-spec-env-names.sh` の型 | **Constraint**: 下記 §3 の非対称により、全面で同一文字列とする統一は不可。**本分析を受けて要件側を是正済み**（2026-09-07・正典＝意味と各面の表記の対応） |
| 4-4 直接利用できない面の機械照合 | `check-spec-env-names.sh` の型 | **再利用可** |
| 5-1/5-2 相関識別子の受け皿 | `line-webhook` に `requestId` あり | **Unknown**: その値は `x-line-request-id`（`app.ts:29`）で **LINE 側が付与する ID**。#229 が扱う実行基盤側の相関 ID とは別物。両者の関係が **Research Needed** |
| 6-1/6-2 稼働中の観測を壊さない | — | **Constraint**: §3 の一覧が変更不可の文字列 |
| 6-4 実行サマリーの固定項目 | `delivery-job` 9 項目 / Go 8 属性 | **Constraint**: e2e テストが返り値を項目ごとに assert、spec design.md が要求仕様として名指し。**削除・改名は壊すが追加は壊さない**（2026-09-07 の実測で訂正・§3） |
| 7-1 共有基盤を経由しない出力の検出 | `check-design-tokens.sh` の型 | **Missing**: ガード新設。自己テストケースが必須 |
| 7-2 宣言したのに出力されない状態の検出 | 型表明（`Exclude<keyof ...>`） | **再利用可**。昇格すれば維持される |
| 7-3/7-4 検査の健全性と実行 | `run.sh` の 2 段強制 | **再利用可** |

## 3. 最大の制約: 項目名の非対称と、その両側にある下流依存

**応答層と日次バッチ層で項目名の流儀が異なり、しかも双方に「変更できない理由」がある。**

| 文字列 | 流儀 | 参照している下流 | 変更可否 |
|---|---|---|---|
| `survey_page_viewed` / `survey_response_submitted` | 事象名 | 本番の集計指標のフィルタ（`guardrails/main.tf:128,133`） | **不可**（指標が静かに 0 になる） |
| `storeId` | camelCase | 本番の指標のラベル抽出（`:151`） | **不可**（同上） |
| `stores_total` / `fetch_ok` / `fetch_failed` / `summaries_written` / `purged` | snake_case | `competitive-daily-summary` の design.md:454 が要求仕様として名指し、tasks.md:177 が実行ログを引用、steering `tech.md:51` が判定式に言及 | **不可**（仕様と運用判断の根拠が指す先を失う） |
| `delivery-job.run` の 9 項目 | camelCase | e2e テストが**関数の返り値を項目ごとに** assert（`index.e2e.test.ts:246-254`） | 項目の削除・改名はテストを壊すが、**追加は壊さない** |

したがって「すべての面で同一の文字列へ統一する」という読み方は、実装可能な解を一つも持たない。

**本分析を受けて Requirement 4 は 2026-09-07 に是正された。** 見出し（「一致」→「正典化」）・Objective・受入条件 4-1〜4-4 を、正典を「意味 → 各実行面での項目名」の対応として定義する形へ改めてある。面ごとの表記差を**許容した上で照合する**この形は、`check-spec-env-names.sh` が採った「表の中で両方向照合が閉じる」型とちょうど同じである。

なお本節の非対称そのもの（どの文字列がなぜ動かせないか）は是正後も有効な制約であり、設計はこの表を前提に組む必要がある。

## 4. 実装方針の選択肢

### Option A: dist を持つ共有パッケージ + 宣言表で日次バッチ層を照合（一括導入）

TS 5 面が `@fwlm/observability`（仮）を import。Go は既存の `slog` のまま、項目名の正典表に対して機械照合する。

- **触るもの**: 新パッケージ / TS 5 面の呼び出し箇所 12 件 / `ConversationDeps` へのロガー注入 / 正典表 1 枚 / ガード 2 本（経路逸脱・正典照合）/ 自己テストケース 2 本 / **依存する各アプリの Dockerfile に 3 行ずつ**
- ✅ 既存の流儀（`@fwlm/db` と同型）にそのまま乗る。Node 直実行の 3 面（`line-webhook` / `dashboard-api` / `delivery-job`）でも使える
- ✅ Go の既存属性に一切触らないため §3 の制約を踏まない
- ❌ **Dockerfile の COPY 網羅を検証するガードが存在しない**（調査で確認）。deps ステージの漏れは `pnpm install --frozen-lockfile` が落とすが、build/runner ステージの漏れは**イメージが作れてしまう**

### Option B: Option A + 日次バッチ層にも事象名を追加して形を揃える（段階導入）

Go 側に `event` 相当の属性を**追加**する（既存の `msg` と attrs は残す）。

- ✅ 面をまたいだ検索式が事象名だけで書けるようになり、Req 1-2 が最も素直に満たされる
- ❌ Go の実行サマリーは spec と steering が名指ししているため、追加であっても**記述側の更新が波及する**。#232（保持の振り分け）が Go 側でも事象名で書けるようになる利点と引き換え
- ❌ 工数が増える。段階導入（TS を先に、Go を後に）を前提にしないと 1 タスクが大きくなりすぎる

### Option C: 共有パッケージを作らず、正典表と照合ガードだけで縛る

各面は自前の出力のまま、正典表に対する照合で規約を強制する。

- ✅ **Dockerfile を一切触らない**（最大のリスク源を回避）
- ✅ structure.md の「codegen は持たず、手動同期を機械検証で固める」という既存方針と整合する
- ❌ allowlist 機構と型表明が面ごとに重複する。#62 の再発（宣言したのに出ない）を型で防ぐ仕組みが 6 箇所に分散し、**Req 2-1/7-2 の保証が弱くなる**
- ❌ 「共有基盤を経由しない出力の検出」（Req 7-1）が定義できない。経由すべき基盤が存在しないため

## 5. 工数とリスク

| 案 | 工数 | リスク | 一行の根拠 |
|---|---|---|---|
| A | **M**（3〜7 日） | **Medium** | 既存パターンの踏襲だが、Dockerfile の網羅が人手頼みで機械検証が無い |
| B | **L**（1〜2 週間） | **Medium-High** | Go への追加が spec / steering / 運用手順の記述へ波及し、変更面が言語をまたぐ |
| C | **M**（3〜7 日） | **Medium** | 実装は軽いが、要件 2-1 / 7-1 / 7-2 の保証水準が構造的に下がる |

## 6. 設計フェーズへの申し送り

### 推奨

**Option A を基点とし、Dockerfile の網羅を検証するガードを同時に新設する。** Option A の唯一の弱点が「ガードの無い人手作業」であり、このリポジトリはまさにその型の欠落（#33 / #51 / #63 / #156）を繰り返し埋めてきた。新パッケージが増えるこの機会に、`check-deploy-image-coverage.sh` と同じ発想で「共有パッケージの依存宣言」と「Dockerfile の 3 ステージ」を両方向照合するガードを置けば、今回だけでなく次のパッケージ追加も守られる。

Option B の「Go にも事象名を足す」は、#232（保持の振り分け）が事象名を必要とした時点で再検討する独立課題として切り出すのが妥当。

### 設計で決めるべきこと

1. **正典表の形式と置き場所** — 「意味 → 応答層の項目名 → 日次バッチ層の項目名」の 3 列以上。`check-spec-env-names.sh` に倣い、出典列で両方向照合を閉じる
2. **パッケージ形態** — dist を持つ型（Node 直実行の 3 面が消費するため、ソース直参照は採れない）
3. **相関識別子の項目名と、`x-line-request-id` との関係** — 別項目にするか、意味を包含させるか
4. **例外の記録形式** — 「種別＋状態コード」の具体的な表現。3 面の既存 `error`（本文）を何に置き換えるか
5. **ロガーの注入経路** — `ConversationDeps` ほか、依存注入の既存形に合わせる

### Research Needed

| 項目 | 状態 |
|---|---|
| 重大度が集約側へ写る条件（1.3） | **解決**（§7.1）。`severity` を出せば解釈される |
| `x-line-request-id` と実行基盤側の相関識別子の関係（5.1） | **解決**（§7.2）。別項目として併存させる |
| コンテナ定義の COPY 漏れの失敗時点 | **未解決**。design.md の Open Questions に残す。ガードは本 spec の範囲外としたため、判断は別 Issue へ |
| ログ量の増加（#232 と連動） | **未解決**。保持設計の費用見積もりで扱う |

---

## 7. 設計フェーズの調査（2026-09-07）

`/kiro-spec-design` の discovery（Extension・light）で行った調査と、そこから確定した設計判断を記録する。

### 7.1 集約基盤が特別扱いする項目名（一次情報）

出典: Cloud Logging の構造化ログに関する公式ドキュメント（2026-09-07 取得）。

| 意味 | 項目名 | 集約側の扱い |
|---|---|---|
| 重大度 | `severity` | 重大度として解釈される。値の列挙は `DEBUG` / `INFO` / `NOTICE` / `WARNING` / `ERROR` / `CRITICAL` / `ALERT` / `EMERGENCY`。**警告は `WARNING` であって `WARN` ではない**（2026-09-09 に一次情報で確認。標準ライブラリの既定表記と異なるため写し替えが要る） |
| 相関識別子 | `logging.googleapis.com/trace` | `[TRACE_ID]` または `projects/[PROJECT_ID]/traces/[TRACE_ID]` の形式を受ける |
| スパン | `logging.googleapis.com/spanId` | 16 進文字列 |
| サンプリング | `logging.googleapis.com/trace_sampled` | 真偽値 |
| **本文** | **`message`** | **`textPayload` へ移され、`jsonPayload` から消える** |
| その他 | 任意 | `jsonPayload` に残る |

**含意 1**: 現行の `level` 項目は特別扱いされない。`guardrails/main.tf:113-116` の本番実測（重大度が未設定である）と一致し、**是正は `severity` を出すことである**と確定した。

**含意 2**: `delivery-job` が現に `message` 項目を使っている（`src/index.ts:125,135`）。この項目は集約側で `textPayload` へ吸われるため、**すでに `jsonPayload` から消えている**。項目検索で引けない状態が本 spec 以前から存在していたことになる。改名が必要。確認された範囲でこの項目を参照する下流は無い（§2 の対応表）。

### 7.2 相関識別子の扱い（設計判断）

`line-webhook` の `requestId` は `x-line-request-id`（`src/app.ts:29`）であり、外部プラットフォームが付与する識別子である。実行基盤が付与する相関識別子とは出所も寿命も異なる。

**判断: 別項目として併存させる。** 前者は外部プラットフォームへの問い合わせに使う業務上の識別子であり、後者は 1 回の操作に属する記録を束ねるための識別子である。片方へ寄せると、どちらかの用途で使えない値になる。正典には両方を登録する。

### 7.3 設計統合の結果

- **一般化**: `survey-web` の許可制 sink と鍵集合の型表明は、6 実行面へそのまま一般化できる。新規に発明する要素は無い
- **作るか採るか**: 外部の記録ライブラリは採らない。要件の中核が「許可制（fail-closed）」であり、汎用ライブラリは任意の項目を出せることを前提に作られているため、要件 2.1 を満たさない。標準出力への 1 行書き込みに外部依存は不要
- **単純化**: 応答層と日次バッチ層で共有コードを持つ案（生成による同期など）は採らない。steering `structure.md` の「codegen は持たず、手動同期を機械検証で固める」に従い、正典 + 検査で担保する。言語をまたぐコード共有は同期の二重化リスクを生む
- **却下した案**: 項目名を全実行面で同一へ統一する案は §3 の制約により却下。既存の分岐は正典で固定し、新規項目のみ統一する（要件 4.5・2026-09-07 に要件へ追加）

### 7.4 設計フェーズで確定したリスク

- コンテナ定義の網羅が人手依存である点は本 spec の範囲外としたが、実装は 5 面のコンテナ定義に手を入れる。**別 Issue の起票を推奨**（design.md の Open Questions に記載）
- 集約側が受け付ける重大度の文字列表記は、一次情報が「一般的な重大度文字列に対応する」と述べるに留まる。実装時に出力を実測して確かめる
