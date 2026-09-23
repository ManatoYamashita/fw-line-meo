#!/usr/bin/env bash
# 「能力の不在」検証（competitive-daily-summary task 7.1・Requirements 1.4, 3.10／
# store-suspension task 6.1・Requirements 6.4, 8.1, 8.3, 8.4, 8.5）。
#
# 通常の assertion SQL（db/test/assertions/*.sql）は「存在すべきものが存在すること」を検証する。
# 本スクリプトはその裏返しで「MVP では意図的に提供しない能力が、コード上もスキーマ上も
# 存在しないこと」を機械的に検証する:
#   - Requirement 1.4: 固定した競合リストの再抽出・追加・削除の手段を MVP では提供しない
#   - Requirement 3.10（2026-09-23・Issue #252 で改訂）: オーナー自身が配信を停止する手段を
#     提供しない。運営・代理店による店舗の利用停止は store-suspension が定める
#   - store-suspension Requirement 8.1: オーナー自身が配信や店舗の利用を停止する手段を、LINE 上にも
#     Web 上にも提供しない。同 8.4: 運営・代理店による停止（stores.suspended_at を dashboard-api
#     から書く）は、オーナー自身による配信停止と区別して許容する
#
# 「無いことの証明」は原理的に悉皆的ではあり得ない（未知の実装経路を全て網羅できない）ため、
# 本スクリプトは design.md/requirements.md の記述から具体的に導ける2系統のチェックに絞る:
#   (A) スキーマ: owners・stores テーブルにオプトアウト相当の列が存在しないこと（列 allowlist の裏返し）。
#       stores.suspended_at は照合語に当たらない（運営・代理店による停止であり、オーナーの
#       オプトアウトを表す語ではない）。
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
# --- Issue #158 (a) で CI へ載せるにあたっての是正 -------------------------------
# 本スクリプトは #158 まで **どのワークフローからも実行されていなかった**（唯一の呼出元は
# cross_runtime_steps.sh:46 で、その入口は `make cross-runtime-test` という手動操作だった）。
# ts-ci の lint-build-test へ載せるにあたり、「読めなかったから緑」の経路をすべて塞いだ。
#
#   1. **走査の前提を明示的に赤にする。** migrations が当たっていない DB では (A) は
#      「列 0 件・テーブル 0 件」で緑を返す。owners の存在を先に要求する。同様に (B) は
#      走査対象ディレクトリの存在を要求する。`ts/apps/delivery-job` をリネームしただけで
#      ガードが黙って緑になる状態を残さない。
#   2. **grep の終了コードを分ける。** 無一致（exit 1）と評価不能・読めない（exit 2 以上）を
#      同一視すると、走査面が壊れた瞬間に「違反 0 件」へ倒れる。`|| true` も同じ理由で使わない。
#      これは scripts/check-grep-exit-codes.sh が scripts/ 配下へ課している規律と同じものだが、
#      同ガードの走査対象は `scripts/` のみで db/test/*.sh は機械強制の外にある（#158 に記録）。
#   3. **件数 0 を赤にする。** ExtractAndFix の参照 0 件・route.ts 0 件は「違反が無い」ではなく
#      「走査の前提が崩れている」である。
#   4. パイプの下流に consumer を置かない（`--exclude` と case の接尾辞照合へ畳んだ）。
#
# --- store-suspension（Issue #252・task 6.1）での改訂 ----------------------------------
# 停止（stores.suspended_at と、それを書く setStoreSuspension）を実装した状態で**改訂前の**本検査を
# 流すと、全項目が PASS した（store-suspension Requirement 8.5 の記録。出力は同 spec の tasks.md
# の実施記録と PR 本文にある）。改訂前は (A1) が owners しか照合せず、(B2) が survey-web を走査せず、
# 停止を書く識別子をどの面が参照するかを一切見ていなかったためである。改訂で次を足した:
#   - (A1) の照合先に stores を加える（店舗へ「配信しない」旗を足す形のオプトアウトを検出する）
#   - (B2) の走査面に ts/apps/survey-web/src を加える
#   - (B4) を新設し、オーナー・客向けの面が停止を書く識別子を参照しないことを検査する
# 名前を変えて足された書込の経路は、DB の列単位の権限（db/test/check_store_suspension_privileges.sh）
# が別の層で検出する（同 8.3）。本検査はコード上の形を見る側である。
#
# 使い方: DATABASE_URL を設定して実行する（with-test-db.sh 等が export した接続情報を利用する想定）。
#   db/test/check_no_optional_capabilities.sh
# CI では scripts/run-db-test-suites.sh の RUN 表から呼ばれる（追加の env は不要）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

: "${DATABASE_URL:?ERROR: DATABASE_URL が未設定です（with-test-db.sh 経由で実行してください）}"

fail() {
    echo "FAIL: $1" >&2
    exit 1
}

# ---------------------------------------------------------------------------
# (A0) 走査の前提: スキーマが適用済みであること
# ---------------------------------------------------------------------------
# これが無いと、空の DB に対して (A1)(A2) が「該当 0 件」で緑を返す。CI で本チェックが
# `apply migrations` より前へ動かされた場合も、ここで鳴る。
echo ">> [absence-check] (A0) 検査対象スキーマが適用済みであること（走査の前提）"
# (A1) の照合先はどちらも存在を要求する。片方が消える（リネームされる）と、そのテーブルの照合が
# 「該当 0 件」で緑へ倒れるためである。
schema_ready="$(psql "$DATABASE_URL" -tA -v ON_ERROR_STOP=1 -c "SELECT to_regclass('public.owners') IS NOT NULL AND to_regclass('public.stores') IS NOT NULL;")"
if [ "$schema_ready" != 't' ]; then
    fail "owners または stores のテーブルがありません。migrations 未適用の DB では (A1)(A2) が「該当 0 件」で緑を返します（走査の前提が崩れています）"
fi
echo "PASS (A0): owners と stores のテーブルが存在する（スキーマ適用済み）"

echo ">> [absence-check] (A1) owners・stores テーブルにオプトアウト相当の列が存在しないこと（R3.10・store-suspension 8.1, 8.3）"
# 照合先へ stores を足したのは store-suspension で店舗単位の停止が入ったためである。オーナーの
# オプトアウトは owners の旗としてだけでなく、店舗ごとの「配信しない」旗としても足しうる。
FORBIDDEN_OPTOUT_COLUMNS_SQL="
SELECT string_agg(table_name || '.' || column_name, ', ' ORDER BY table_name, column_name)
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('owners', 'stores')
  AND column_name IN (
    'delivery_enabled','opted_out','opt_out','delivery_disabled',
    'unsubscribed','delivery_stopped','notifications_enabled','subscription_status'
  );
"
bad_columns="$(psql "$DATABASE_URL" -tA -v ON_ERROR_STOP=1 -c "$FORBIDDEN_OPTOUT_COLUMNS_SQL")"
if [ -n "$bad_columns" ]; then
    fail "オプトアウト相当の列が見つかりました: ${bad_columns}（R3.10・store-suspension 8.1 違反の疑い）"
fi
echo "PASS (A1): owners・stores にオプトアウト相当の列は存在しない"

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
GO_DIR="${ROOT}/go"
[ -d "$GO_DIR" ] || fail "走査面 go/ がありません（走査の前提が崩れています）"

listener_rc=0
listeners="$(grep -rEn 'http\.ListenAndServe|http\.HandleFunc|http\.NewServeMux' \
    "$GO_DIR" --include='*.go' --exclude='*_test.go')" || listener_rc=$?
if [ "$listener_rc" -gt 1 ]; then
    fail "go/ を走査できません（grep exit=${listener_rc}）。無一致と評価不能を取り違えないため赤にします"
fi
if [ -n "$listeners" ]; then
    fail "go/ に HTTP リスナーが見つかりました（競合再抽出が外部から起動可能になっていないか要確認・R1.4）: ${listeners}"
fi

caller_rc=0
extract_callers="$(grep -rln 'ExtractAndFix(' "$GO_DIR" --include='*.go' --exclude='*_test.go')" || caller_rc=$?
if [ "$caller_rc" -gt 1 ]; then
    fail "go/ を走査できません（grep exit=${caller_rc}）。無一致と評価不能を取り違えないため赤にします"
fi

# 期待される呼出元は extract.go 自身の定義行と batch/run.go の1箇所のみ。
caller_count=0
unexpected_callers=''
while IFS= read -r caller_path; do
    [ -n "$caller_path" ] || continue
    caller_count=$((caller_count + 1))
    case "$caller_path" in
        */internal/competitor/extract.go | */internal/batch/run.go) ;;
        *) unexpected_callers="${unexpected_callers}${caller_path} " ;;
    esac
done <<EOF
$extract_callers
EOF

# **件数 0 は「違反 0 件」ではない。** 関数名が変わった・走査面が壊れたのどちらかであり、
# そのまま緑を返すとこのチェックは「常に緑の装置」と区別できなくなる。
if [ "$caller_count" -eq 0 ]; then
    fail "go/ に ExtractAndFix( の参照が 1 件もありません（関数名の変更か走査面の破壊。走査の前提が崩れています）"
fi
if [ -n "$unexpected_callers" ]; then
    fail "ExtractAndFix の呼出元が batch/run.go 以外に見つかりました（想定外の再抽出経路の疑い・R1.4）: ${unexpected_callers}"
fi
echo "PASS (B1): 競合再抽出（ExtractAndFix）は日次バッチ内部の自己修復ロジックからのみ呼ばれる（参照 ${caller_count} 件）"

echo ">> [absence-check] (B2) TS 側にオプトアウト・競合調整のエクスポート関数/HTTPルートが存在しないこと（R1.4, R3.10）"
FORBIDDEN_IDENTIFIER_PATTERN='optOut|opt_out|unsubscribe|disableDelivery|updateDeliveryEnabled|reExtractCompetitors|refreshCompetitors|adjustCompetitors|removeCompetitor|addCompetitor|updateCompetitorList'

# **走査面は ts/ 全体ではない。** ts/ 全体へ広げると dashboard-web の Firebase
# `onAuthStateChanged` が返す `unsubscribe`（auth-context.tsx）が誤検出になり、除外規則を
# 持った時点で「除外の広さ」を別途担保する必要が出る。したがって「オプトアウト導線が実際に
# 生えうる層」に絞って列挙する。line-webhook を含めるのは、配信停止の postback / リッチメニュー
# 導線が最も生えそうな場所がそこだから（#158 (a) で追加。追加時点のヒットは 0 件）。
# survey-web を含めるのは store-suspension 8.1（Web 上にも提供しない）による（Issue #252 で追加。
# 追加時点のヒットは 0 件）。dashboard-web / dashboard-api は運営・代理店の面なので走査しない。
# packages 配下（@fwlm/db 以外）が未走査である事実は Issue #158 に記録してある。広げるときは
# 誤検出の除外設計とセットで行うこと。
TS_SCAN_DIRS=(
    'ts/packages/db/src'
    'ts/apps/delivery-job/src'
    'ts/apps/store-detail/app'
    'ts/apps/store-detail/lib'
    'ts/apps/line-webhook/src'
    'ts/apps/survey-web/src'
)
ts_scan_paths=()
for scan_dir in ${TS_SCAN_DIRS[@]+"${TS_SCAN_DIRS[@]}"}; do
    [ -d "${ROOT}/${scan_dir}" ] || fail "走査面 ${scan_dir} がありません（走査の前提が崩れています）"
    ts_scan_paths=(${ts_scan_paths[@]+"${ts_scan_paths[@]}"} "${ROOT}/${scan_dir}")
done

ts_rc=0
ts_hits="$(grep -rEni "$FORBIDDEN_IDENTIFIER_PATTERN" ${ts_scan_paths[@]+"${ts_scan_paths[@]}"})" || ts_rc=$?
if [ "$ts_rc" -gt 1 ]; then
    fail "TS ソースを走査できません（grep exit=${ts_rc}）。無一致と評価不能を取り違えないため赤にします"
fi
if [ -n "$ts_hits" ]; then
    fail "オプトアウト/競合調整を示唆する識別子が TS ソースに見つかりました（R1.4/R3.10 違反の疑い）: ${ts_hits}"
fi
echo "PASS (B2): TS ソースにオプトアウト・競合調整のエクスポート関数/識別子は存在しない（走査 ${#TS_SCAN_DIRS[@]} ディレクトリ）"

echo ">> [absence-check] (B3) store-detail の app/api 配下に detail 以外の（＝書込の疑いがある）ルートが無いこと（R4.2 の構造的担保の再確認）"
API_DIR="${ROOT}/ts/apps/store-detail/app/api"
[ -d "$API_DIR" ] || fail "走査面 ts/apps/store-detail/app/api がありません（走査の前提が崩れています）"

api_routes="$(find "$API_DIR" -name 'route.ts')"
route_count=0
unexpected_routes=''
while IFS= read -r route_path; do
    [ -n "$route_path" ] || continue
    route_count=$((route_count + 1))
    case "$route_path" in
        */api/detail/route.ts) ;;
        *) unexpected_routes="${unexpected_routes}${route_path} " ;;
    esac
done <<EOF
$api_routes
EOF

if [ "$route_count" -eq 0 ]; then
    fail "ts/apps/store-detail/app/api 配下に route.ts が 1 件もありません（走査の前提が崩れています）"
fi
if [ -n "$unexpected_routes" ]; then
    fail "store-detail に /api/detail 以外のルートが見つかりました（読取専用の前提が崩れていないか要確認）: ${unexpected_routes}"
fi
echo "PASS (B3): store-detail の API ルートは読取専用の /api/detail のみ（route.ts ${route_count} 件）"

echo ">> [absence-check] (B4) オーナー・客向けの面が店舗の停止を書く識別子を参照しないこと（store-suspension 6.4, 8.1, 8.4）"
# 店舗の停止を書いてよいのは運営・代理店の面（dashboard-api）だけである。オーナー・客向けの面が
# 停止を書くと、それはオーナー自身（または客）が配信・利用を止める手段になる（8.1）。LINE 応答の
# follow / unfollow から停止を切り替えるのもこの形である（6.4・ブロックで自動停止しない）。
# 書込を行う DAL（@fwlm/db の setStoreSuspension）と dashboard-api は走査しない（8.4）。
#
# 照合は大小を区別しない（SQL の `SET SUSPENDED_AT = ...` を取り逃さないため）。suspended_at は
# 読む（`IS NULL`・`===`/`!==`/`==` の比較）のは正当なので、代入の形（`=` の直後が `=` でない）
# だけを書込として数える。試験（各アプリの test/）は SQL で停止時刻を直接立てるので、走査面を
# 各アプリの実装ディレクトリに限る。
SUSPENSION_WRITE_PATTERN='setStoreSuspension|suspendStore|resumeStore|suspended_at[[:space:]]*=([^=]|$)'
OWNER_FACING_SCAN_DIRS=(
    'ts/apps/line-webhook/src'
    'ts/apps/store-detail/app'
    'ts/apps/store-detail/lib'
    'ts/apps/survey-web/src'
)
owner_scan_paths=()
owner_file_count=0
for scan_dir in ${OWNER_FACING_SCAN_DIRS[@]+"${OWNER_FACING_SCAN_DIRS[@]}"}; do
    [ -d "${ROOT}/${scan_dir}" ] || fail "走査面 ${scan_dir} がありません（走査の前提が崩れています）"
    # **走査したファイル数 0 は「違反 0 件」ではない。** 実装がディレクトリごと移っただけで、
    # 空のディレクトリを見て緑を返す状態を残さない。ディレクトリ単位で数える。
    dir_file_count=0
    dir_files="$(find "${ROOT}/${scan_dir}" -type f)"
    while IFS= read -r scanned_file; do
        [ -n "$scanned_file" ] || continue
        dir_file_count=$((dir_file_count + 1))
    done <<EOF
$dir_files
EOF
    if [ "$dir_file_count" -eq 0 ]; then
        fail "走査面 ${scan_dir} にファイルが 1 件もありません（走査の前提が崩れています）"
    fi
    owner_file_count=$((owner_file_count + dir_file_count))
    owner_scan_paths=(${owner_scan_paths[@]+"${owner_scan_paths[@]}"} "${ROOT}/${scan_dir}")
done

owner_rc=0
owner_hits="$(grep -rEni "$SUSPENSION_WRITE_PATTERN" ${owner_scan_paths[@]+"${owner_scan_paths[@]}"})" || owner_rc=$?
if [ "$owner_rc" -gt 1 ]; then
    fail "オーナー・客向けの面を走査できません（grep exit=${owner_rc}）。無一致と評価不能を取り違えないため赤にします"
fi
if [ -n "$owner_hits" ]; then
    fail "オーナー・客向けの面に店舗の停止を書く識別子が見つかりました（停止を書けるのは運営・代理店の面だけ・store-suspension 8.1 違反の疑い）: ${owner_hits}"
fi
echo "PASS (B4): オーナー・客向けの面に店舗の停止を書く識別子は存在しない（走査 ${#OWNER_FACING_SCAN_DIRS[@]} ディレクトリ・${owner_file_count} ファイル）"

echo "OK: 能力の不在（競合リスト再抽出・調整手段／オーナー自身による配信停止の手段のいずれも存在しない）を確認しました（R1.4, R3.10・store-suspension 8.1）"
