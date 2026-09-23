# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# db/test/check_no_optional_capabilities.sh の自己テスト（Issue #158 (a)・PR #161 レビュー指摘）。
#
# このガードが守るのは Requirement 1.4（競合リストの再抽出・追加・削除の手段を提供しない）と
# Requirement 3.10（オーナー自身が配信を停止する手段を提供しない・2026-09-23 Issue #252 で改訂）
# という **能力の不在** である。store-suspension（Issue #252）で運営・代理店による店舗の利用停止
# （stores.suspended_at）が入ったため、同 spec の Requirement 8.1・8.3・8.4 に合わせて
# (A1) の照合先へ stores を、(B2) の走査面へ survey-web を足し、(B4) を新設した。
# #158 (a) で ts-ci へ載せた際、「読めなかったから緑」の経路を塞ぐ fail-closed 分岐を 5 系統
# 新設した。ところが **その分岐には回帰テストが無かった**。手動注入で一度発火を確認しただけで、
# `|| true` や `2>/dev/null` が再導入されても、`[ -d ]` が消えても、`--exclude` が外れても、
# ガードは緑を返し続ける。実リポジトリでは走査面が壊れないので、誰も気づけない。
#
# `check-guard-selftest-coverage.sh` は `scripts/check-*.sh` にしかケースを要求しないため
# （`db/test/*.sh` は対象外・Issue #162）、機械強制も掛からない。ここが唯一の後ろ盾になる。
#
# 実 DB は要らない。`psql` をスタブへ差し替え、`-c` のクエリ本文で応答を決める。
# grep の exit 2（走査面は在るが読めない）は **uid に依存せず**再現する必要があるため
# （CI は `--require-full` で skip を失敗として扱う）、chmod ではなく grep スタブで作る。

cnoc_fixture() {
  fx_copy db/test/check_no_optional_capabilities.sh

  # --- psql スタブ -------------------------------------------------------
  # 3 つのクエリだけを模擬し、制御ファイルの有無でケースが応答を切り替える。
  # **未知のクエリは exit 3 で落とす。** ガードが問い合わせを増やしたのにスタブが
  # 黙って空を返すと、増えた検査を「該当 0 件」として素通りさせることになる。
  #
  # (A1) の列は **クエリ本文がそのテーブル名を照合先に含むときだけ** 返す。制御ファイルだけで
  # 応答を決めると、ガードが照合先から stores を落としても stores の列を「検出」してしまい、
  # 変異が照合先の広さを何も確かめない。返したことは served-* の印で呼び出し側が確かめる。
  cat > "${STUB_DIR}/psql" <<'STUB'
#!/usr/bin/env bash
set -u
stub_dir="${STUB_DIR:-}"
sql=''
prev=''
for a in "$@"; do
  if [ "$prev" = '-c' ]; then sql="$a"; fi
  prev="$a"
done
case "$sql" in
  *to_regclass*)
    if [ -f "${stub_dir}/psql-owners-missing" ]; then echo 'f'; else echo 't'; fi ;;
  *information_schema.columns*)
    cols=''
    case "$sql" in
      *"'owners'"*)
        if [ -f "${stub_dir}/psql-bad-columns" ]; then
          cols='owners.opted_out'; : > "${stub_dir}/served-owners-column"
        fi ;;
    esac
    case "$sql" in
      *"'stores'"*)
        if [ -f "${stub_dir}/psql-bad-store-columns" ]; then
          cols="${cols:+${cols}, }stores.delivery_enabled"; : > "${stub_dir}/served-stores-column"
        fi ;;
    esac
    echo "$cols" ;;
  *information_schema.tables*)
    if [ -f "${stub_dir}/psql-bad-tables" ]; then echo 'competitor_overrides'; else echo ''; fi ;;
  *)
    echo "psql-stub: 未知のクエリです（スタブの更新漏れ）: ${sql}" >&2; exit 3 ;;
esac
exit 0
STUB
  chmod +x "${STUB_DIR}/psql"

  # --- grep スタブ -------------------------------------------------------
  # 既定は実物へ委譲し、CNOC_GREP_FAIL=1 の子プロセスでだけ exit 2 を返す。env は
  # ガードの起動時にだけ渡すので、ハーネス自身の `grep -cE`（expect_output_matches）は
  # 影響を受けない。実物の場所は PATH へスタブを差し込む前の解決結果を焼き込む。
  # **どの grep を落とすかを指定できる形にする。** 一律に落とすと最初の grep（B1 の
  # リスナー走査）で必ず赤くなり、後続の 2 経路（B1 の呼出元・B2 の TS 走査）の exit 2 分岐を
  # 1 件も検査しないまま「grep exit 2 を覆った」と誤認する（実際に変異テストで踏んだ）。
  cnoc_real_grep="$(PATH="$FX_BASE_PATH" command -v grep)"
  cat > "${STUB_DIR}/grep" <<STUB
#!/usr/bin/env bash
if [ -n "\${CNOC_GREP_FAIL:-}" ]; then
  case "\$*" in
    *"\${CNOC_GREP_FAIL}"*) echo "grep-stub: simulated read error" >&2; exit 2 ;;
  esac
fi
exec "${cnoc_real_grep}" "\$@"
STUB
  chmod +x "${STUB_DIR}/grep"

  # --- 合成ソースツリー --------------------------------------------------
  # 期待される ExtractAndFix の呼出元 2 件。
  fx_write go/internal/competitor/extract.go <<'EOF'
package competitor

func ExtractAndFix(ctx int) error { return nil }
EOF
  fx_write go/internal/batch/run.go <<'EOF'
package batch

func Run() error { return ExtractAndFix(0) }
EOF
  # **--exclude='*_test.go' の対照。** テストファイルには HTTP リスナーと ExtractAndFix を
  # 両方置いてある。除外が外れると緑ケースが落ちるので、除外の実効性がここで固定される。
  fx_write go/internal/batch/run_test.go <<'EOF'
package batch

// テストファイルは走査対象外である（本番の HTTP リスナーではない）。
func TestServe() { _ = "http.ListenAndServe"; _ = ExtractAndFix }
EOF

  for d in ts/packages/db/src ts/apps/delivery-job/src ts/apps/store-detail/lib ts/apps/line-webhook/src ts/apps/survey-web/src; do
    fx_write "${d}/index.ts" <<'EOF'
export const noop = 0;
EOF
  done
  # **運営・代理店による停止は許容する（store-suspension Requirement 8.4）ことの対照。**
  # 停止を書く DAL（@fwlm/db）と、それを呼ぶ dashboard-api は (B4) の走査面ではない。ここへ
  # 停止を書く識別子を置いても緑でなければならない。@fwlm/db は (B2) の走査面なので、(B2) の
  # 語彙がこれを誤検出しないことも同時に固定される。
  fx_write ts/packages/db/src/stores.ts <<'EOF'
export async function setStoreSuspension(db: unknown, input: { storeId: string; suspend: boolean }) {
  return `UPDATE stores SET suspended_at = CASE WHEN $2 THEN now() ELSE NULL END`;
}
EOF
  fx_write ts/apps/dashboard-api/src/index.ts <<'EOF'
import { setStoreSuspension } from '@fwlm/db';
export const setSuspension = setStoreSuspension;
EOF
  # **読むだけの参照は (B4) に当たらないことの対照。** オーナー・客向けの面は停止中の店舗を
  # 除くために suspended_at を読む（IS NULL・比較）。書込の形（代入）だけを検出する。
  fx_write ts/apps/survey-web/src/store.ts <<'EOF'
export const sql = 'SELECT id FROM stores WHERE id = $1 AND suspended_at IS NULL';
export const isSuspended = (row: { suspended_at: Date | null }) => row.suspended_at !== null || row.suspended_at == undefined;
EOF
  fx_write ts/apps/store-detail/app/page.tsx <<'EOF'
export default function Page() { return null; }
EOF
  fx_write ts/apps/store-detail/app/api/detail/route.ts <<'EOF'
export async function GET() { return new Response('ok'); }
EOF

  CNOC_DB_URL='postgres://stub@127.0.0.1:5432/stub'
}

cnoc_run() {
  # ケース自前 runner（60-check-prod-image-drift.sh の pid_run と同型）。
  # $1 が 'grepfail' なら、$2 を含む引数で呼ばれた grep だけが exit 2 を返す。
  # env はガードの子プロセスへだけ渡すので、ハーネス自身の grep は影響を受けない。
  OUT=''
  RC=0
  if [ "${1:-}" = 'grepfail' ]; then
    OUT="$(cd "$FX" && CNOC_GREP_FAIL="$2" DATABASE_URL="$CNOC_DB_URL" bash db/test/check_no_optional_capabilities.sh 2>&1)" || RC=$?
  else
    OUT="$(cd "$FX" && DATABASE_URL="$CNOC_DB_URL" bash db/test/check_no_optional_capabilities.sh 2>&1)" || RC=$?
  fi
}

cnoc_expect_mutated() {
  # 変異が合成ツリーへ実際に当たったことを確かめる（$1 = 合成ツリー相対パス / $2 = 固定文字列）。
  # 書いたつもりの変異が空だと、無改変のツリーを検査して「赤にならない」を誤読する。
  assert_count=$((assert_count + 1))
  cem_rc=0
  cem_n="$(grep -cF -- "$2" "${FX}/$1")" || cem_rc=$?
  if [ "$cem_rc" -gt 1 ] || [ "${cem_n:-0}" -eq 0 ]; then
    _t_fail "変異が合成ツリーへ当たっていません（${1} に ${2} が無い・grep exit=${cem_rc}）"
  fi
}

cnoc_expect_served() {
  # psql スタブが (A1) の列を実際に返したことを確かめる（$1 = スタブが立てる印のファイル名）。
  # 赤の原因がスタブの別経路（未知のクエリの exit 3 など）ではないことの担保でもある。
  assert_count=$((assert_count + 1))
  if [ ! -f "${STUB_DIR}/$1" ]; then
    _t_fail "psql スタブが列を返していません（${1} が無い）。照合先にそのテーブルが含まれていない疑いがあります"
  fi
}

# ---------------------------------------------------------------------------
# 緑（他の全ケースの対照。ここが緑でなければ以下の赤は原因を特定できない）
# ---------------------------------------------------------------------------

t_begin 'check-no-optional-capabilities: 走査面が揃い違反が無ければ緑（件数を出す）'
cnoc_fixture
cnoc_run
expect_green
expect_output_matches 'PASS \(A0\): owners と stores のテーブルが存在する'
expect_output_matches 'PASS \(A1\): owners・stores にオプトアウト相当の列は存在しない'
expect_output_matches 'PASS \(B1\): .*（参照 2 件）'
expect_output_matches 'PASS \(B2\): .*（走査 6 ディレクトリ）'
expect_output_matches 'PASS \(B3\): .*（route\.ts 1 件）'
expect_output_matches 'PASS \(B4\): .*（走査 4 ディレクトリ・6 ファイル）'
t_end

t_begin 'check-no-optional-capabilities: DATABASE_URL が無ければ無言終了しない'
# **subshell で unset する。** 98-run-db-test-suites.sh の fixture が DATABASE_URL を
# export しており、同じシェルで source される以降のケースへ漏れる。素で起動すると
# 「未設定を検出できた」ではなく「設定済みで正常終了した」を観測してしまう。
cnoc_fixture
OUT=''; RC=0
OUT="$(unset DATABASE_URL; cd "$FX" && bash db/test/check_no_optional_capabilities.sh 2>&1)" || RC=$?
expect_red 'DATABASE_URL'
t_end

# ---------------------------------------------------------------------------
# 契約本体（R1.4 / R3.10 の違反を実際に検出できること）
# ---------------------------------------------------------------------------

t_begin 'check-no-optional-capabilities: owners にオプトアウト列が生えると赤（R3.10）'
cnoc_fixture
: > "${STUB_DIR}/psql-bad-columns"
cnoc_run
expect_red 'オプトアウト相当の列が見つかりました: owners.opted_out'
cnoc_expect_served 'served-owners-column'
t_end

t_begin 'check-no-optional-capabilities: stores にオプトアウト列が生えると赤（store-suspension 8.3・照合先が stores まで広い証拠）'
# **(A1) を stores へ広げたことの直接の対照である。** 照合先が owners だけに戻ると、スタブは
# stores の列を返さず、ここが緑へ倒れる。
cnoc_fixture
: > "${STUB_DIR}/psql-bad-store-columns"
cnoc_run
expect_red 'オプトアウト相当の列が見つかりました: stores.delivery_enabled'
cnoc_expect_served 'served-stores-column'
t_end

t_begin 'check-no-optional-capabilities: 競合調整テーブルが生えると赤（R1.4）'
cnoc_fixture
: > "${STUB_DIR}/psql-bad-tables"
cnoc_run
expect_red '競合調整/配信設定オプトアウトを示唆するテーブルが見つかりました'
t_end

t_begin 'check-no-optional-capabilities: Go に HTTP リスナーが生えると赤（R1.4）'
cnoc_fixture
fx_write go/cmd/server/main.go <<'EOF'
package main

import "net/http"

func main() { _ = http.ListenAndServe(":8080", nil) }
EOF
cnoc_run
expect_red 'go/ に HTTP リスナーが見つかりました'
t_end

t_begin 'check-no-optional-capabilities: ExtractAndFix の想定外の呼出元があると赤（R1.4）'
cnoc_fixture
fx_write go/internal/api/handler.go <<'EOF'
package api

func Handle() error { return ExtractAndFix(0) }
EOF
cnoc_run
expect_red 'ExtractAndFix の呼出元が batch/run.go 以外に見つかりました'
t_end

t_begin 'check-no-optional-capabilities: TS にオプトアウト識別子が生えると赤（R3.10・line-webhook が実際に走査されている証拠）'
# **走査面へ line-webhook を足した（#158 (a)）ことの直接の対照である。** 走査対象から外れると
# ここが緑へ倒れる。列挙に足しただけで実際には見ていない、を起こさない。
cnoc_fixture
fx_write ts/apps/line-webhook/src/index.ts <<'EOF'
export function optOut(userId: string) { return userId; }
EOF
cnoc_run
expect_red 'オプトアウト/競合調整を示唆する識別子が TS ソースに見つかりました'
t_end

t_begin 'check-no-optional-capabilities: survey-web にオプトアウト識別子が生えると赤（R3.10・survey-web が (B2) で実際に走査されている証拠）'
cnoc_fixture
fx_write ts/apps/survey-web/src/optout.ts <<'EOF'
export function unsubscribeOwner(ownerId: string) { return ownerId; }
EOF
cnoc_expect_mutated ts/apps/survey-web/src/optout.ts 'unsubscribeOwner'
cnoc_run
expect_red 'オプトアウト/競合調整を示唆する識別子が TS ソースに見つかりました'
expect_output_matches 'survey-web/src/optout\.ts'
t_end

t_begin 'check-no-optional-capabilities: LINE 応答が停止を書く DAL を呼ぶと赤（store-suspension 8.1・6.4）'
# **follow / unfollow の処理から店舗の停止を切り替える実装の形そのものである。** ブロックで
# 自動停止すると、オーナー自身が配信を止める手段になる（Requirement 3.10 の趣旨を覆す）。
cnoc_fixture
fx_write ts/apps/line-webhook/src/handlers/unfollow.ts <<'EOF'
import { setStoreSuspension } from '@fwlm/db';
export async function onUnfollow(pool: unknown, storeId: string) {
  await setStoreSuspension(pool, { storeId, suspend: true });
}
EOF
cnoc_expect_mutated ts/apps/line-webhook/src/handlers/unfollow.ts 'setStoreSuspension(pool'
cnoc_run
expect_red 'オーナー・客向けの面に店舗の停止を書く識別子が見つかりました'
expect_output_matches 'line-webhook/src/handlers/unfollow\.ts'
expect_output_matches 'PASS \(B3\)'
t_end

t_begin 'check-no-optional-capabilities: 客向け Web が suspended_at へ代入すると赤（store-suspension 8.1・書込の形は SQL でも検出する）'
cnoc_fixture
fx_write ts/apps/survey-web/src/resume.ts <<'EOF'
export const sql = 'UPDATE stores SET SUSPENDED_AT = NULL WHERE id = $1';
EOF
cnoc_expect_mutated ts/apps/survey-web/src/resume.ts 'SET SUSPENDED_AT = NULL'
cnoc_run
expect_red 'オーナー・客向けの面に店舗の停止を書く識別子が見つかりました'
expect_output_matches 'survey-web/src/resume\.ts'
t_end

t_begin 'check-no-optional-capabilities: store-detail が停止・再開の関数を呼ぶと赤（store-suspension 8.1）'
cnoc_fixture
fx_write ts/apps/store-detail/lib/pause.ts <<'EOF'
export const pause = (id: string) => suspendStore(id);
export const unpause = (id: string) => resumeStore(id);
EOF
cnoc_expect_mutated ts/apps/store-detail/lib/pause.ts 'suspendStore(id)'
cnoc_run
expect_red 'オーナー・客向けの面に店舗の停止を書く識別子が見つかりました'
expect_output_matches 'store-detail/lib/pause\.ts'
t_end

t_begin 'check-no-optional-capabilities: store-detail に detail 以外のルートが生えると赤（R4.2）'
cnoc_fixture
fx_write ts/apps/store-detail/app/api/optout/route.ts <<'EOF'
export async function POST() { return new Response('ok'); }
EOF
cnoc_run
expect_red 'store-detail に /api/detail 以外のルートが見つかりました'
t_end

# ---------------------------------------------------------------------------
# 空振り防止（#158 (a) で新設した fail-closed 分岐。実リポジトリでは発火しない）
# ---------------------------------------------------------------------------

t_begin 'check-no-optional-capabilities: スキーマ未適用の DB では赤（空の DB を「該当 0 件」で緑にしない）'
cnoc_fixture
: > "${STUB_DIR}/psql-owners-missing"
cnoc_run
expect_red 'owners または stores のテーブルがありません'
t_end

t_begin 'check-no-optional-capabilities: go/ が消えると赤'
cnoc_fixture
rm -rf "${FX}/go"
cnoc_run
expect_red '走査面 go/ がありません'
t_end

t_begin 'check-no-optional-capabilities: ExtractAndFix の参照が 0 件になると赤（件数 0 は「違反 0 件」ではない）'
cnoc_fixture
rm -f "${FX}/go/internal/competitor/extract.go" "${FX}/go/internal/batch/run.go"
cnoc_run
expect_red 'ExtractAndFix( の参照が 1 件もありません'
t_end

t_begin 'check-no-optional-capabilities: TS の走査面が 1 つ消えると赤（列挙とツリーの乖離を黙って緑にしない）'
cnoc_fixture
rm -rf "${FX}/ts/apps/line-webhook/src"
cnoc_run
expect_red '走査面 ts/apps/line-webhook/src がありません'
t_end

t_begin 'check-no-optional-capabilities: survey-web の走査面が消えると赤（(B2) の列挙とツリーの乖離）'
cnoc_fixture
rm -rf "${FX}/ts/apps/survey-web/src"
cnoc_run
expect_red '走査面 ts/apps/survey-web/src がありません'
t_end

t_begin 'check-no-optional-capabilities: (B4) の走査面が空なら赤（走査したファイル数 0 は「違反 0 件」ではない）'
# ディレクトリは残し中身だけを消す。(B2) は存在だけを要求するので通り、(B4) の件数判定だけが
# 鳴ることを確かめる（前ケースとは別の分岐である）。
cnoc_fixture
rm -f "${FX}/ts/apps/survey-web/src/"*
cnoc_run
expect_red '走査面 ts/apps/survey-web/src にファイルが 1 件もありません'
expect_output_matches 'PASS \(B2\)'
t_end

t_begin 'check-no-optional-capabilities: app/api が消えると赤'
cnoc_fixture
rm -rf "${FX}/ts/apps/store-detail/app/api"
cnoc_run
expect_red '走査面 ts/apps/store-detail/app/api がありません'
t_end

t_begin 'check-no-optional-capabilities: route.ts が 0 件になると赤'
cnoc_fixture
rm -f "${FX}/ts/apps/store-detail/app/api/detail/route.ts"
cnoc_run
expect_red 'route.ts が 1 件もありません'
t_end

# **ここが「読めなかったから緑」を塞ぐ分岐の本体である。** 走査面は在るが読めない状態を、
# uid に依存しない形（chmod ではなく grep スタブ）で決定論的に再現する。exit 2 を返す grep は
# 3 経路あるので **1 本ずつ独立に落とす**。まとめて落とすと最初の 1 本しか検査できない。

t_begin 'check-no-optional-capabilities: B1 リスナー走査が評価不能（exit 2）なら赤'
cnoc_fixture
cnoc_run grepfail 'ListenAndServe'
expect_red 'go/ を走査できません（grep exit=2）'
t_end

t_begin 'check-no-optional-capabilities: B1 呼出元走査が評価不能（exit 2）なら赤'
# リスナー走査は通し、呼出元走査だけを落とす（前ケースと違う分岐であることの担保）。
cnoc_fixture
cnoc_run grepfail 'ExtractAndFix'
expect_red 'go/ を走査できません（grep exit=2）'
expect_output_matches 'PASS \(A2\)'
t_end

t_begin 'check-no-optional-capabilities: B2 の TS 走査が評価不能（exit 2）なら赤'
cnoc_fixture
cnoc_run grepfail 'optOut'
expect_red 'TS ソースを走査できません（grep exit=2）'
expect_output_matches 'PASS \(B1\)'
t_end

t_begin 'check-no-optional-capabilities: B4 の走査が評価不能（exit 2）なら赤'
cnoc_fixture
cnoc_run grepfail 'setStoreSuspension'
expect_red 'オーナー・客向けの面を走査できません（grep exit=2）'
expect_output_matches 'PASS \(B3\)'
t_end
