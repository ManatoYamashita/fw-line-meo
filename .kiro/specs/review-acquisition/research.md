# Research & Design Decisions — review-acquisition

## Summary
- **Feature**: `review-acquisition`
- **Discovery Scope**: Extension（既存 DB/インフラ基盤の上に初のアプリ層を構築。外部依存 3 点は Web 検証を実施）
- **Key Findings**:
  - Google クチコミ投稿 URL `https://search.google.com/local/writereview?placeid=<PLACE_ID>` は 2026 年 7 月現在有効だが、Google が形式を保証する公式文書は存在しない（事実上の標準）。Place ID は stale 化し得る。
  - Gemini 2.5/3 系は **safetySettings のデフォルトが Off**。口コミ生成では HARASSMENT / HATE_SPEECH の明示ブロックが必須。推奨モデルは `gemini-3.1-flash-lite`（stable・低コスト・1 下書き $0.001 未満）。
  - iOS Safari のクリップボードは「ユーザージェスチャー内の同期呼び出し」必須。本設計は下書きを**事前に画面 state に保持**し、コピー押下時に同期 `writeText` する形で自然に制約を満たす。
  - 既存基盤との整合: survey-web の書込対象（tallies 2 表）は grants.sql で付与済み・`dashboard_users.auth_subject` が Identity Platform UID を受ける設計済み。**新テーブル不要**。

## Research Log

### Google クチコミ投稿 URL（Req 4.3）
- **Context**: Place ID から投稿画面を直接開く導線の URL 形式の現行有効性。
- **Sources Consulted**: support.google.com/business/answer/16816815、developers.google.com（Place IDs）、EmbedSocial/martech.zone 等の 2026 年時点の案内。
- **Findings**:
  - `https://search.google.com/local/writereview?placeid=<PLACE_ID>` は長年安定稼働。投稿ダイアログが直接開く。
  - 公式ヘルプは GBP 管理画面からの取得手順（`g.page/r/<code>/review` 短縮リンク）のみ記載し、placeid 直組み形式は明文保証なし。
  - 投稿には客の Google アカウントサインインが必須（本プロダクトの「客本人が投稿」原則と整合）。
  - Place ID は失効・変更され得る（Places API ドキュメントは定期リフレッシュを推奨。ID のみの Place Details は無料）。
  - インセンティブ付きレビュー依頼は規約違反（fake engagement）。本プロダクトの導線は依頼のみで報酬なし＝適合。
- **Implications**: URL 組立は単一モジュールに閉じ込め、形式変更時に 1 箇所で追随。Place ID リフレッシュは本 spec の境界外（日次バッチ／オンボーディング側）としてリスク登録。

### Gemini API（@google/genai・API キー・Req 3.1〜3.5）
- **Context**: 下書き生成のモデル選定・構造化出力・多様性・安全設定・レート制限。
- **Sources Consulted**: ai.google.dev（models / pricing / structured-output / safety-settings / api-key / rate-limits）、googleapis/js-genai、プロジェクト内 `gemini-api` スキル。
- **Findings**:
  - SDK は統一 `@google/genai` 一択（レガシー SDK 禁止・プロジェクトスキルの Core Directive）。`GEMINI_API_KEY` env を自動検出（インフラは既にこの名前でマウント済み）。
  - モデル: `gemini-3.1-flash-lite`（stable、$0.25/$1.50 per 1M tokens、2.5 Flash 相当品質・低レイテンシ）が第一候補。最安は `gemini-2.5-flash-lite`（$0.10/$0.40）。preview 系は 2026-07-09 廃止予定のものがあり不使用。
  - 構造化出力: `responseMimeType: 'application/json'` + `responseSchema`（`Type` enum）で `{draft: string}` を強制。
  - 多様性: temperature 0.9〜1.2・seed 非固定に加え、**プロンプト側への変動要素注入**（文体・書き出し・切り口をサーバー側でランダム選択）が「客ごとに語彙を変える」要件への実務解。
  - **safetySettings はデフォルト Off**。HARASSMENT / HATE_SPEECH（＋SEXUALLY_EXPLICIT / DANGEROUS_CONTENT）を BLOCK_MEDIUM_AND_ABOVE で明示指定する。safetySettings は有害性ブロックであり「嘘・誇張の排除」は systemInstruction ＋素材限定で担保。
  - レート制限はモデル別固定表の公開が廃止され AI Studio でプロジェクト実効値を確認する方式。429 には指数バックオフが定石。
- **Implications**: モデル ID は env（`GEMINI_MODEL`）で差替可能にする。生成呼び出しは 1 モジュールに集約し、安全設定・スキーマ・バックオフを一体で所有。

### クリップボード・QR・Next.js（Req 4.2, 4.6, 1.1, 2.8）
- **Context**: コピー導線の端末制約、QR 生成手段、客向け Web のフレームワーク現行版。
- **Sources Consulted**: webkit.org（Async Clipboard API）、web.dev、npm registry（qrcode/uqr/qr）、nextjs.org（output config）。
- **Findings**:
  - `navigator.clipboard.writeText` は HTTPS 必須・iOS Safari はジェスチャー内**同期**呼び出し必須（await を挟むと NotAllowedError）。失敗時は「選択可能テキスト＋再コピー」フォールバックが定石（2 度目は純ジェスチャーで成功）。
  - 本設計は下書きを表示済み state から同期コピーするため制約に自然適合。`document.execCommand('copy')` を最終フォールバックに残す。
  - QR: npm `qrcode@1.5.4`（MIT・PNG/SVG・依存 3・枯れて安定）が実質標準。zero-dep 代替 `uqr` は PNG 非対応。印刷用途（非 IT の代理店・チラシ）には PNG が安全。
  - Next.js 最新安定は **16.2.x**。`output: 'standalone'` は現役の推奨セルフホスト構成（Cloud Run の `PORT` 注入と整合。Dockerfile で `public/`・`.next/static` の明示コピーが必要）。
- **Implications**: コピー UI は「生成完了後のみ活性」設計とし、非同期後の writeText を構造的に排除する。

### 既存基盤との統合契約（grants / infra / スキーマ）
- **Context**: 本 spec が従う既存契約の確認（推測禁止）。
- **Sources Consulted**: `infra/envs/prod/main.tf`、`infra/sql/grants.sql`、`db/migrations/0001..0002`、`db/write-boundary.md`。
- **Findings**:
  - survey-web: `GEMINI_API_KEY`（Secret）＋ `CLOUDSQL_CONNECTION_NAME` マウント済み・public・IAM DB 認証（`sa-survey-web@<project>.iam`）。
  - dashboard-api: public・cloudsql・Secret なし。TS 層 3 SA は tallies 2 表＋stores 等へ DML 付与済み。`survey_aspects` は seed 所有・runtime read-only（コード内に選択肢を二重定義しない）。
  - `dashboard_users.auth_subject`（UNIQUE）が Identity Platform UID の受け皿。RBAC 連鎖は `stores.owner_id → owners.agency_id ⟷ dashboard_users.agency_id`（operator は全店）。
  - `stores.ck_place_confirmed`: `confirmed ⇔ place_id 非 NULL`。QR 発行可否・投稿導線の前提条件に直結。
  - tallies の粒度は **store_id × period_month（月初日）× star/aspect_code** の UNIQUE。UPSERT 加算で実装可能。
- **Implications**: 新テーブル・スキーマ変更なしで全要件を実装可能。インフラへの追加は「secret 1 枠＋plain env 2 個」のみ（下記 Decision 参照）。

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| QR エンドポイントを survey-web に同居 | 客向けアプリ内に代理店認証 API を置く | アプリ 1 個で完結 | 客向けとダッシュボード文脈の混在（攻撃面・デプロイ結合）。後で移設＝契約変更 | 不採用 |
| **QR エンドポイントを dashboard-api 種アプリに配置（採用）** | 既存 Cloud Run `dashboard-api` に最小 API を実装 | 文脈分離が構造で守られる。Issue #5 が同じ器を拡張 | dashboard-api の起動を本 spec が負う | インフラは hello イメージで稼働済み・置換するだけ |
| QR を共有モジュールのみ提供（配布は Issue #5 へ全面委譲） | 本 spec は URL スキームとライブラリだけ | 実装最小 | R1 の受け入れ基準を本 spec で E2E 検証できない | 不採用 |

## Design Decisions

### Decision: TS モノレポ（pnpm workspace）を `ts/` トップレベルに確立
- **Context**: 実装コード未着手。structure.md「言語ごとにトップレベルを分離」。survey-web と dashboard-api が DB アクセスを共有する。
- **Alternatives Considered**:
  1. アプリごとに独立リポジトリ構成（ルート直下に並置）— 共有 DB 層が二重化
  2. `ts/` 配下 pnpm workspace（apps/ + packages/db）— 共有を構造化
- **Selected Approach**: 2。`ts/{apps/survey-web, apps/dashboard-api, packages/db}`。Go は将来 `go/` を新設。
- **Rationale**: 書き込み境界（TS 層）とディレクトリ境界が一致。型共有は tech.md の二刀流方針どおり。
- **Trade-offs**: workspace ツーリングの初期コスト。以後の全 TS spec が恩恵を受ける。
- **Follow-up**: lint/test 規約確立後に `tech.md` へ追記（steering 更新）。

### Decision: 再生成上限のステートレス強制＝HMAC 署名セッショントークン
- **Context**: 3.8（再生成 3 回まで）・5.3（個別回答を永続保存しない）。公開エンドポイントからの Gemini 呼び出しはコスト濫用面。サーバーは無状態（ゼロスケール）。
- **Alternatives Considered**:
  1. クライアント側のみで回数制御 — 改ざん自由・コスト濫用に無力
  2. DB にセッション保存 — 個別回答の永続保存に近づき 5.3 と緊張
  3. HMAC 署名トークン（素材＋attempt＋exp を封入しクライアントへ往復）— サーバー無状態のまま強制可能
- **Selected Approach**: 3。Node `crypto` の HMAC-SHA256（外部ライブラリ不使用）。exp 30 分。
- **Rationale**: サーバーに個別回答を置かず（5.3 適合）、attempt を偽造不能にする。
- **Trade-offs**: 署名鍵 Secret（`survey-session-key`）のインフラ追加が必要 → gcp-infra-foundation の規約（secrets 枠＋consumer 側 accessor）に従い小拡張。素材がトークンとして客の端末を往復する（サーバー保存はしない）。
- **Follow-up**: インフラ変更は infra 規約（frame は secrets モジュール・accessor は run-services）どおりに実施。

### Decision: 集計加算は下書き生成と並行・失敗を客に転嫁しない
- **Context**: 5.4（集計失敗が客体験を中断させない）・5.2（月次 UPSERT）。
- **Selected Approach**: POST /api/responses で tallies UPSERT（1 トランザクション・rating 1 行＋aspect N 行）と Gemini 呼び出しを並行実行。応答は生成結果のみに依存し、集計失敗はログ記録に留める。`period_month` は **Asia/Tokyo 基準の月初日**を SQL 側で確定。
- **Rationale**: 体験最優先・集計はベストエフォート（匿名集計の性質上、僅少な欠落は許容）。
- **Trade-offs**: 送信リトライで二重加算の可能性 → クライアント送信ボタンの無効化＋localStorage 回答済みフラグで実用上抑止（厳密な冪等性は非目標）。

### Decision: 重複回答抑止はブラウザ localStorage のみ（2.9/2.10）
- **Selected Approach**: 回答完了時に `storeId＋完了時刻` を localStorage へ記録。24 時間以内の再訪は回答済み画面（投稿導線つき）を表示。サーバー側の端末識別・フィンガープリントは行わない。
- **Rationale**: 個人特定手段ゼロで要件の「軽量対策」に一致。消去すれば回答できるが、匿名性優先の設計判断（要件どおり）。

### Decision: Build vs Adopt（依存最小方針の適用）
| 課題 | 判断 | 理由 |
|------|------|------|
| 客向け Web | **Adopt: Next.js 16（standalone）** | ユーザー指定スキル（next-best-practices）・SSR で 3 秒要件・Cloud Run 実績 |
| dashboard-api | **Adopt: Hono** | 最小 API に適した軽量 TS ファースト。生 http は保守性で劣後 |
| Gemini | **Adopt: @google/genai** | プロジェクトスキルの Core Directive（統一 SDK） |
| QR 生成 | **Adopt: qrcode@1.5.4** | PNG 必須（印刷用途）・MIT・実質標準。zero-dep 代替は PNG 非対応 |
| DB 接続 | **Adopt: pg + @google-cloud/cloud-sql-connector** | IAM DB 認証（パスワードレス）はコネクタ経由が公式路線 |
| ダッシュボード認証検証 | **Adopt: firebase-admin** | Identity Platform ID トークン検証の公式手段 |
| 入力検証 | **Build（手書き）** | 検証対象は 4 フィールドのみ。zod 導入は過剰 |
| 署名トークン | **Build（Node crypto）** | HMAC 1 本にライブラリ不要 |

### Decision: 一般化の抑制（Gemini クライアントの共有パッケージ化はしない）
- **Context**: 第 2 フェーズ（機能2 投稿文・返信文生成）も Gemini を使う見込み。
- **Selected Approach**: 生成呼び出しは survey-web 内 `lib/draft/` に閉じるが、`DraftGenerator` インターフェース（素材入力→検証済み下書き出力）として切る。共有パッケージ化は 2 個目の消費者が現れた時点で行う。
- **Rationale**: design-synthesis の原則（インターフェースを一般化し実装は現要件に留める）。

### Decision: 設計レビュー指摘の反映（validate-design・2026-07-05）
- **Context**: レビューで Critical 2 件＋Minor 1 件を検出（ユーザー承認のうえ全件反映）。
- **反映内容**:
  1. **pageToken 導入**: /api/responses に SSR 発行の短寿命（5 分）HMAC トークンを必須化。ページ非経由の直接 POST による集計汚染・Gemini コスト濫用の敷居上げ。既存 SESSION_SIGNING_KEY を共用し kind で相互流用を拒否。
  2. **生成失敗時も sessionToken を必ず発行**: 失敗応答を 5xx から `200 generation:'failed'` に変更し、再試行を集計非接触の /api/drafts に一本化。再試行による tallies 二重加算経路を構造的に排除。attempt は生成成功時のみ消費。
  3. **回答済み判定はクライアント側**: localStorage は SSR から読めないため、シーケンス図を客側分岐に修正。
- **Trade-offs**: pageToken は本格的 bot 対策（CAPTCHA 等）ではない（匿名・摩擦ゼロ原則を優先した敷居上げ）。監視（生成失敗率・集計異常）で補完。

## Risks & Mitigations
- **writereview URL 形式が非保証** — URL 組立を単一モジュールに隔離し変更を 1 箇所化。E2E で実 URL 到達を smoke 確認。
- **Place ID の stale 化** — 本 spec 境界外（競合バッチ／オンボーディングが Places API を保有）。リスクとして境界メモに記録し、投稿導線は store の `place_id` を毎回 DB から読む（キャッシュしない）。
- **safetySettings デフォルト Off** — 生成モジュールで 4 カテゴリ明示ブロックを必須実装・ユニットテストで設定漏れを検知。
- **プロンプトインジェクション（自由記述）** — 素材をデリミタで隔離し systemInstruction で役割固定、構造化出力＋出力長上限＋出力後検証で影響を限定。
- **Cloud Run コールドスタート vs 3 秒表示** — standalone 最小イメージ・クライアント JS 最小化。実測で未達なら min-instances 検討（コスト判断は運用へ）。
- **公開エンドポイントの Gemini コスト濫用** — 署名トークン（生成は正規回答フローのみ・再生成上限）＋インスタンス内簡易レート制限（ベストエフォート）。
- **Issue #5（ダッシュボード）未実装期間の QR 取得** — ID トークンを直接取得して API を呼ぶ運用手順を README に記載（UI は Issue #5 が提供）。

## References
- https://ai.google.dev/gemini-api/docs/structured-output — 構造化出力
- https://ai.google.dev/gemini-api/docs/safety-settings — 安全設定（デフォルト Off の根拠)
- https://ai.google.dev/gemini-api/docs/models / pricing — モデル・単価
- https://webkit.org/blog/10855/async-clipboard-api/ — Safari クリップボード制約
- https://nextjs.org/docs/app/api-reference/config/next-config-js/output — standalone
- https://support.google.com/business/answer/16816815 — レビューリンク公式ヘルプ（規約含む）
- https://developers.google.com/maps/documentation/places/web-service/place-id — Place ID stale 化
- `.claude/skills/gemini-api/SKILL.md` — 統一 SDK 規律
- `~/.claude/skills/next-best-practices/` — Next.js 実装規約（実装時参照）
- `.claude/skills/google-cloud-recipe-auth/SKILL.md` — API キー制限・Secret Manager 運用
