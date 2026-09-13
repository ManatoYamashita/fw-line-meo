#!/usr/bin/env bash
# クロスランタイム契約検証（task 7.1）の実処理本体。
#
# 呼出元（cross_runtime_integration.sh 経由の ts/scripts/with-test-db.sh）が単一の native postgres
# インスタンスを起動し、migrations 適用後に DATABASE_URL / PGHOST / PGUSER / PGDATABASE を export
# した状態で本スクリプトを実行する。本スクリプトはその「同一の生きた postgres」に対して、
# Go の実バッチオーケストレーション（batch.Run・cmd/daily-batch/main.go が使うのと同じ関数）を
# 先に実行して daily_summaries を書き込ませ、直後に TS の実配信オーケストレーション
# （runDeliveryJob・index.ts の main() が使うのと同じ関数）でその行を読み・配信させる。
# さらに詳細画面の読込（store-detail の queryStoreDetail・/api/detail が使うのと同じ関数）でも
# 同じ行を読む（Issue #255 で追加。評価の無い競合を含む行の読み方を配信と詳細画面の両方で確かめる）。
#
# 「言語間の結合は SQL スキーマのみ」（design.md）を、モックではなく実 DB 越しの2プロセス実行で
# 証明することが本スクリプトの唯一の目的。Places・LINE の外部 API のみをフェイクし、postgres
# 自体は実物（with-test-db.sh の native postgres）を使う。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

: "${DATABASE_URL:?ERROR: DATABASE_URL が未設定です（ts/scripts/with-test-db.sh 経由で実行してください）}"

echo "=================================================================="
echo ">> [cross-runtime 1/4] Go: 実バッチオーケストレーション（batch.Run）を"
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
echo ">> [cross-runtime 2/4] TS: 実配信オーケストレーション（runDeliveryJob）を"
echo "   フェイク LINE + 同一 postgres に対して実行し、Go が書いた行を読み配信する"
echo "=================================================================="
# delivery-job が依存する workspace パッケージは dist（ビルド済み JS）を経由して解決される
# （package.json の main / exports）。未ビルドのまま参照した場合に古い dist を掴まないよう、
# 明示的にビルドしてから実行する。`<pkg>^...` は「そのパッケージの依存だけ（自分自身は含まない）」を
# 選ぶ pnpm のフィルタで、現在は @fwlm/db と @fwlm/design-tokens が該当する。
#
# **`@fwlm/db` だけを名指ししていた版はクリーン checkout で落ちる**（Issue #158 (b) で実測）。
# delivery-job の src/flex.ts は @fwlm/design-tokens も import しており、そちらは
# main: ./dist/index.js を持つのに dist が無い。しかも vitest はこれを
# `Test Files 1 failed (1)` / `Tests  no tests` と報告するため、**「テストが 0 件で終わった」と
# 読み違えやすい**（実体は import 解決の失敗である）。ローカルで長く通っていたのは、作業ツリーに
# 過去のビルド成果物が残っていたからにすぎない。依存が増えるたびの追記を避けるため、名指しでは
# なくフィルタで再帰的に解決する。
(cd "$ROOT/ts" && pnpm --filter '@fwlm/delivery-job^...' run build)
(cd "$ROOT/ts" && CROSS_RUNTIME_GO_SEEDED=1 pnpm --filter @fwlm/delivery-job exec vitest run test/cross-runtime.e2e.test.ts)

echo "=================================================================="
echo ">> [cross-runtime 3/4] TS: 詳細画面の読込（queryStoreDetail）で、Go が書いた行を読む"
echo "=================================================================="
# 評価の無い競合（Issue #255）を含む行を、詳細画面の読込が画面の単体テストと同じ形で返すことを確かめる。
# 描画は store-page.test.tsx が同じ fixture（test/fixtures/unrated-competitor.ts）で受け持つ。依存の
# ビルドは上と同じ理由でフィルタにより再帰的に解決する（@fwlm/db の dist をサブパスごと作る）。
(cd "$ROOT/ts" && pnpm --filter '@fwlm/store-detail^...' run build)
(cd "$ROOT/ts" && CROSS_RUNTIME_GO_SEEDED=1 pnpm --filter @fwlm/store-detail exec vitest run test/cross-runtime.e2e.test.ts)

echo "=================================================================="
echo ">> [cross-runtime 4/4] 能力の不在チェック（Requirements 1.4, 3.10）"
echo "=================================================================="
"$ROOT/db/test/check_no_optional_capabilities.sh"

echo "OK: cross-runtime contract validation complete"
