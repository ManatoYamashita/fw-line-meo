# 開発スキルの同梱とクラウドでの利用

このプロダクトに関連するインストール済みスキル68件をリポジトリに同梱している。
個人PCのスキルディレクトリを取得せずに、手順・参照文書・補助スクリプトを読める。
導入の追跡は [Issue #449](https://github.com/ManatoYamashita/fw-line-meo/issues/449)。

## 配置

正典は `.agents/skills/<name>/SKILL.md`。LINEの `messaging-api` だけは、既存の
`.claude/skills/messaging-api` へリポジトリ内の相対symlinkを張り、参照資料の二重管理を避ける。
共通の環境差分は `.agents/skills/_shared/runtime.md`、プロジェクト規則の入口は
ルートの `AGENTS.md` に置く。Kiroの設定・テンプレートは既存の `.kiro/settings/` を使う。

## 対象一覧

| 領域 | 件数 | 同梱スキル |
|---|---:|---|
| LINE | 1 | messaging-api |
| HTTP API | 1 | hono |
| Next.js | 8 | next-best-practices, next-cache-components, next-upgrade, next-dev-loop, next-cache-components-adoption, next-cache-components-optimizer, next-partial-prefetching-adoption, next-partial-prefetching-optimizer |
| React | 3 | vercel-react-best-practices, vercel-composition-patterns, vercel-react-view-transitions |
| UI・アクセシビリティ | 17 | frontend-design, building-components, shadcn, migrate-radix-to-base, modern-web-guidance, web-design-guidelines, better-accessibility, better-colors, better-interface, better-layout, better-typography, better-ui, better-writing, break, explain-interface, interface-review, variant |
| GCP・Gemini・認証・運用 | 15 | cloud-run-basics, cloud-sql-basics, firebase-basics, gcloud, gemini-api, google-cloud-networking-observability, google-cloud-recipe-auth, google-cloud-recipe-onboarding, google-cloud-waf-cost-optimization, google-cloud-waf-operational-excellence, google-cloud-waf-performance-optimization, google-cloud-waf-reliability, google-cloud-waf-security, google-cloud-waf-sustainability, iam-recommendations-fetcher |
| PostgreSQL | 1 | supabase-postgres-best-practices |
| 仕様駆動開発 | 17 | kiro-discovery, kiro-spec-init, kiro-spec-quick, kiro-spec-requirements, kiro-spec-design, kiro-spec-tasks, kiro-spec-batch, kiro-spec-status, kiro-steering, kiro-steering-custom, kiro-validate-gap, kiro-validate-design, kiro-impl, kiro-review, kiro-debug, kiro-validate-impl, kiro-verify-completion |
| PRレビュー | 4 | review3, review2, pr-critical-review, pr-review-e2e |
| ブラウザ検証 | 1 | agent-browser |

選定根拠は `README.md`、`CLAUDE.md`、`.kiro/steering/tech.md`、実際の
`ts/**/package.json` と `go/go.mod`。Next.js 16 / React 19 / Base UI / Hono、
Cloud Run / Cloud SQL / Firebase Auth / Gemini、LINEと仕様・検証フローに対応する。
実装言語がGoである日次バッチも、GCP・DB・検証・レビューの共通スキルを使用する。

未採用のVercelホスティング、Supabaseサービス、GKE、AlloyDB、BigQuery、Bigtable、
Agent Platform専用構成、React Native、GSAP、個人アカウントでの食べログ操作、
メール・カレンダー・スプレッドシート等のスキルは対象外。
Asideはログイン済みの個人環境に依存するため同梱せず、共通規則に任意の手段として記載する。
Vercel名のReactスキルとSupabase名のPostgreSQLスキルは、サービス移行用ではなく
フレームワークとSQLのガイドとして選定した。

## 使用方法

この変更が含まれるブランチ・コミットを取得した環境で、使うスキルを明示する。
スキル呼出しを提供するCodexの画面では、例えば次のように依頼する。

```text
$review3 PR #123 を図解付きでレビューして
$next-best-practices survey-web の実装を確認して
```

クラウドのタスク入力がスキルの補完・呼出し構文を提供していない場合も、ファイルを指定できる。

```text
.agents/skills/review3/SKILL.md とそこから参照される資料を読んで、PR #123 をレビューして。
最初に AGENTS.md と .agents/skills/_shared/runtime.md に従って環境を確認して。
```

リポジトリを取得するだけでは、CLI・ブラウザ・MCP・資格情報はインストールされない。
特に `next-dev-loop` は上流のNext.js / agent-browser最低バージョンを確認し、
要件を満たさない場合はプロジェクト既存のE2Eを使う。
本変更によるクラウド実機の起動・ツール接続は未検証。
default branchを使用するクラウドタスクには、この変更の取り込み後に新しいタスクで反映する。

review3は公開ツールが無くても検証済み単体HTMLを出力できる。URLは実際に発行できた場合だけ提示する。
非公開のレビュー評価コーパス、認証情報、個人PCの絶対パスは同梱しない。

## 出典と更新

各スキルの出典・インストール時のハッシュ・同梱版のハッシュ・調整内容は
`manifest.json` に記録する。上流のfrontmatterにCodexの検証対象外の項目があった場合は
`metadata` 内へ保存し、明示呼出し限定のKiroスキルは `agents/openai.yaml` にポリシーを残す。
review3の依存資料は同じsnapshotから取得する。

同梱時に取得できた上流のライセンス本文は `licenses/` に保存し、元のスキル内の
ライセンス・帰属も維持する。ライセンス取得URLはmanifestに記録する。
上流のrootにライセンス本文が無いスキルは、元の宣言を維持し、本文の存在を仮定しない。
`frontend-design` はローカルの導入元記録が無いため、その事実を出典に記録した。

更新するときは必要なスキルの本体と依存資料を同時に更新し、共通実行規則への参照と
Codex向け調整を維持する。出典・調整内容・配布ハッシュを更新し、以下を実行する。

```bash
python3 scripts/check-agent-skills.py
python3 -m unittest discover -s .agents/skills/review2/scripts/tests
python3 .agents/skills/pr-critical-review/scripts/build-html.py self-check
```

`check-agent-skills.py` は追加依存なしで実行でき、CIの `ts-ci` でも実行する。
登録漏れ、ファイル欠落、内部リンク切れ、個人PCへの固定参照、リポジトリ外symlink、
manifestと配布内容の乖離を検出する。
内容の技術的な正しさ、外部リンクの生存、実行環境のツール接続や資格情報は検証しない。
外部スキルの文書は既存LINEスキルと同じく、プロジェクト固有の文章表記チェックから外す。
自作の `_shared/` とスキル以外のプロジェクト文書は引き続きチェックする。
