# shellcheck shell=bash  # run.sh から source される断片（shebang は持たない）
# db/test/check_no_optional_capabilities.sh の自己テスト（Issue #158 (a)・PR #161 レビュー指摘）。
#
# このガードが守るのは Requirement 1.4（競合リストの再抽出・追加・削除の手段を提供しない）と
# Requirement 3.10（配信停止＝オプトアウト手段を提供しない）という **能力の不在** である。
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
    if [ -f "${stub_dir}/psql-bad-columns" ]; then echo 'opted_out'; else echo ''; fi ;;
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

  for d in ts/packages/db/src ts/apps/delivery-job/src ts/apps/store-detail/lib ts/apps/line-webhook/src; do
    fx_write "${d}/index.ts" <<'EOF'
export const noop = 0;
EOF
  done
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

# ---------------------------------------------------------------------------
# 緑（他の全ケースの対照。ここが緑でなければ以下の赤は原因を特定できない）
# ---------------------------------------------------------------------------

t_begin 'check-no-optional-capabilities: 走査面が揃い違反が無ければ緑（件数を出す）'
cnoc_fixture
cnoc_run
expect_green
expect_output_matches 'PASS \(A0\): owners テーブルが存在する'
expect_output_matches 'PASS \(B1\): .*（参照 2 件）'
expect_output_matches 'PASS \(B2\): .*（走査 5 ディレクトリ）'
expect_output_matches 'PASS \(B3\): .*（route\.ts 1 件）'
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
expect_red 'owners にオプトアウト相当の列が見つかりました: opted_out'
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
expect_red 'owners テーブルがありません'
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
