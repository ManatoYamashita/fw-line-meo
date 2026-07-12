#!/usr/bin/env bash
# 「能力の不在」検証（task 7.1・Requirements 1.4, 3.10）。
#
# 通常の assertion SQL（db/test/assertions/*.sql）は「存在すべきものが存在すること」を検証する。
# 本スクリプトはその裏返しで「MVP では意図的に提供しない能力が、コード上もスキーマ上も
# 存在しないこと」を機械的に検証する:
#   - Requirement 1.4: 固定した競合リストの再抽出・追加・削除の手段を MVP では提供しない
#   - Requirement 3.10: 配信停止（オプトアウト）手段を MVP では提供しない
#
# 「無いことの証明」は原理的に悉皆的ではあり得ない（未知の実装経路を全て網羅できない）ため、
# 本スクリプトは design.md/requirements.md の記述から具体的に導ける2系統のチェックに絞る:
#   (A) スキーマ: owners テーブルにオプトアウト相当の列が存在しないこと（列 allowlist の裏返し）。
#       db/test/assertions/30_compliance.sql の「allowlist で増加を検出する」思想を踏襲するが、
#       あちらは「未知テーブル/列の混入＝匿名性リスク」の検出、本チェックは
#       「特定の機能（オプトアウト）に対応する列が一切無いこと」の検出という異なる目的のため
#       独立したスクリプトとする（30_compliance.sql の allowlist は改変しない）。
#   (B) コード: 再抽出・オプトアウトを外部から起動できる経路（HTTP ルート・エクスポート関数）が
#       ソースツリー上に存在しないこと。Go 側は task 7.1 実装時点で HTTP サーバーそのものを
#       持たない（cmd/daily-batch は Cloud Run Job・net/http はクライアントとしてのみ使用）ため
#       「ExtractAndFix を外部から再トリガーする経路が無い」ことは「HTTP リスナーが無い」ことと
#       同値になる。将来 Go 側に HTTP サーバーが追加された場合はこのチェックが機械的に破綻し
#       レビューを強制する（意図的な「壊れることで気づく」設計）。
#
# 使い方: DATABASE_URL を設定して実行する（with-test-db.sh 等が export した接続情報を利用する想定）。
#   db/test/check_no_optional_capabilities.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

: "${DATABASE_URL:?ERROR: DATABASE_URL が未設定です（with-test-db.sh 経由で実行してください）}"

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

echo ">> [absence-check] (A) owners テーブルにオプトアウト相当の列が存在しないこと（R3.10）"
FORBIDDEN_OWNER_COLUMNS_SQL="
SELECT string_agg(column_name, ', ')
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'owners'
  AND column_name IN (
    'delivery_enabled','opted_out','opt_out','delivery_disabled',
    'unsubscribed','delivery_stopped','notifications_enabled','subscription_status'
  );
"
bad_columns="$(psql "$DATABASE_URL" -tA -v ON_ERROR_STOP=1 -c "$FORBIDDEN_OWNER_COLUMNS_SQL")"
if [ -n "$bad_columns" ]; then
    fail "owners にオプトアウト相当の列が見つかりました: ${bad_columns}（R3.10 違反の疑い）"
fi
echo "PASS (A1): owners にオプトアウト相当の列は存在しない"

echo ">> [absence-check] (A2) 競合の調整・上書きを目的とした専用テーブルが存在しないこと（R1.4）"
FORBIDDEN_TABLES_SQL="
SELECT string_agg(table_name, ', ')
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  AND table_name ~* '(competitor.*(override|request|adjust)|delivery.*(preference|opt))';
"
bad_tables="$(psql "$DATABASE_URL" -tA -v ON_ERROR_STOP=1 -c "$FORBIDDEN_TABLES_SQL")"
if [ -n "$bad_tables" ]; then
    fail "競合調整/配信設定オプトアウトを示唆するテーブルが見つかりました: ${bad_tables}（R1.4/R3.10 違反の疑い）"
fi
echo "PASS (A2): 競合調整・配信オプトアウト専用テーブルは存在しない"

echo ">> [absence-check] (B1) Go 側に競合再抽出を外部起動できる HTTP リスナーが存在しないこと（R1.4）"
# cmd/daily-batch は Cloud Run Job（HTTP を listen しない）。competitor.ExtractAndFix の唯一の
# 呼出元は batch.Run（日次バッチ内部・「競合未固定の店舗はまず抽出」の自己修復ロジックのみ）。
if grep -rEn 'http\.ListenAndServe|http\.HandleFunc|http\.NewServeMux' "$ROOT/go" --include='*.go' | grep -v '_test\.go'; then
    fail "go/ に HTTP リスナーが見つかりました（競合再抽出が外部から起動可能になっていないか要確認・R1.4）"
fi
extract_callers="$(grep -rln 'ExtractAndFix(' "$ROOT/go" --include='*.go' | grep -v '_test\.go' || true)"
# 期待される呼出元は extract.go 自身の定義行と batch/run.go の1箇所のみ。
unexpected_callers="$(echo "$extract_callers" | grep -v 'internal/competitor/extract\.go$' | grep -v 'internal/batch/run\.go$' || true)"
if [ -n "$unexpected_callers" ]; then
    fail "ExtractAndFix の呼出元が batch/run.go 以外に見つかりました（想定外の再抽出経路の疑い・R1.4）: $unexpected_callers"
fi
echo "PASS (B1): 競合再抽出（ExtractAndFix）は日次バッチ内部の自己修復ロジックからのみ呼ばれる"

echo ">> [absence-check] (B2) TS 側にオプトアウト・競合調整のエクスポート関数/HTTPルートが存在しないこと（R1.4, R3.10）"
FORBIDDEN_IDENTIFIER_PATTERN='optOut|opt_out|unsubscribe|disableDelivery|updateDeliveryEnabled|reExtractCompetitors|refreshCompetitors|adjustCompetitors|removeCompetitor|addCompetitor|updateCompetitorList'
if grep -rEni "$FORBIDDEN_IDENTIFIER_PATTERN" \
    "$ROOT/ts/packages/db/src" "$ROOT/ts/apps/delivery-job/src" "$ROOT/ts/apps/store-detail/app" "$ROOT/ts/apps/store-detail/lib" \
    2>/dev/null; then
    fail "オプトアウト/競合調整を示唆する識別子が TS ソースに見つかりました（R1.4/R3.10 違反の疑い）"
fi
echo "PASS (B2): TS ソースにオプトアウト・競合調整のエクスポート関数/識別子は存在しない"

echo ">> [absence-check] (B3) store-detail の app/api 配下に detail 以外の（＝書込の疑いがある）ルートが無いこと（R4.2 の構造的担保の再確認）"
api_routes="$(find "$ROOT/ts/apps/store-detail/app/api" -name 'route.ts' 2>/dev/null || true)"
unexpected_routes="$(echo "$api_routes" | grep -v '/api/detail/route\.ts$' || true)"
if [ -n "$unexpected_routes" ]; then
    fail "store-detail に /api/detail 以外のルートが見つかりました（読取専用の前提が崩れていないか要確認）: $unexpected_routes"
fi
echo "PASS (B3): store-detail の API ルートは読取専用の /api/detail のみ"

echo "OK: 能力の不在（競合リスト再抽出・調整手段／配信オプトアウト手段のいずれも存在しない）を確認しました（R1.4, R3.10）"
