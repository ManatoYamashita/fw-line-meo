#!/usr/bin/env bash
# クロスランタイム契約検証（task 7.1）の実処理本体。
#
# 呼出元（cross_runtime_integration.sh 経由の ts/scripts/with-test-db.sh）が単一の native postgres
# インスタンスを起動し、migrations 適用後に DATABASE_URL / PGHOST / PGUSER / PGDATABASE を export
# した状態で本スクリプトを実行する。本スクリプトはその「同一の生きた postgres」に対して、
# Go の実バッチオーケストレーション（batch.Run・cmd/daily-batch/main.go が使うのと同じ関数）を
# 先に実行して daily_summaries を書き込ませ、直後に TS の実配信オーケストレーション
# （runDeliveryJob・index.ts の main() が使うのと同じ関数）でその行を読み・配信させる。
#
# 「言語間の結合は SQL スキーマのみ」（design.md）を、モックではなく実 DB 越しの2プロセス実行で
# 証明することが本スクリプトの唯一の目的。Places・LINE の外部 API のみをフェイクし、postgres
# 自体は実物（with-test-db.sh の native postgres）を使う。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

: "${DATABASE_URL:?ERROR: DATABASE_URL が未設定です（ts/scripts/with-test-db.sh 経由で実行してください）}"

echo "=================================================================="
echo ">> [cross-runtime 1/3] Go: 実バッチオーケストレーション（batch.Run）を"
echo "   フェイク Places + 実 postgres（${DATABASE_URL}）に対して実行し daily_summaries を書き込む"
echo "=================================================================="
# crossruntime_test.go はプレーンな `go test ./...`（make go-test）実行時に他テストファイルの
# unscoped クエリ（例: run_test.go の TestRun_EndToEnd_MixedStores の StoresTotal 集計）を
# 汚染しないよう、通常はテスト終了時に自分が seed した行を t.Cleanup で片付ける。しかし本フロー
# （cross-runtime 契約テスト）では直後の 2/3 ステップ（TS）がまさにその行を読んで配信する必要が
# あるため、ここで CROSS_RUNTIME_SKIP_CLEANUP=1 を export してクリーンアップを抑制する。
# Go の test バイナリが完全終了（＝全 t.Cleanup 完了）してから逐次シェルで 2/3 が起動するため、
# 抑制しても TS 側が読むタイミングとの競合は生じない。
export CROSS_RUNTIME_SKIP_CLEANUP=1
(cd "$ROOT/go" && go test ./internal/batch/... -run '^TestCrossRuntimeContract_GoWritesReadableSummaries$' -v)

echo "=================================================================="
echo ">> [cross-runtime 2/3] TS: 実配信オーケストレーション（runDeliveryJob）を"
echo "   フェイク LINE + 同一 postgres に対して実行し、Go が書いた行を読み配信する"
echo "=================================================================="
# @fwlm/db は dist（ビルド済み JS）を経由して解決される（package.json exports）。他パッケージが
# 未ビルドのまま参照した場合に古い dist を掴まないよう明示的にビルドしてから実行する。
(cd "$ROOT/ts" && pnpm --filter @fwlm/db run build)
(cd "$ROOT/ts" && CROSS_RUNTIME_GO_SEEDED=1 pnpm --filter @fwlm/delivery-job exec vitest run test/cross-runtime.e2e.test.ts)

echo "=================================================================="
echo ">> [cross-runtime 3/3] 能力の不在チェック（Requirements 1.4, 3.10）"
echo "=================================================================="
"$ROOT/db/test/check_no_optional_capabilities.sh"

echo "OK: cross-runtime contract validation complete"
