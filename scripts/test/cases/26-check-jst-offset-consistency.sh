# shellcheck shell=bash  # scripts/test/run.sh から source される断片（shebang は持たない）
# scripts/check-jst-offset-consistency.sh の自己テスト（Issue #299）。
#
# 値の一致だけでなく、宣言と実装の双方向照合を固定する。宣言表から 1 行を消す変異でも赤になる
# ことを確かめ、新しい実装を足したときに「ガードの母数が古いまま緑」を許さない。

jst_sources() {
  fx_write ts/apps/store-detail/lib/data.ts <<'EOF'
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function defaultAsOf(): string {
  return new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 10);
}
EOF

  fx_write ts/apps/delivery-job/src/index.ts <<'EOF'
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function resolveJstNow(now: Date) {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const year = jst.getUTCFullYear();
  const month = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jst.getUTCDate()).padStart(2, '0');
  return { hour: jst.getUTCHours(), date: `${year}-${month}-${day}` };
}
EOF

  fx_write ts/apps/line-webhook/src/report/handler.ts <<'EOF'
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstToday(now: Date): string {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const month = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jst.getUTCDate()).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${month}-${day}`;
}
EOF

  fx_write ts/apps/line-webhook/src/report/builders/new-reviews.ts <<'EOF'
const MINUTE_MS = 60_000;
const JST_OFFSET_MINUTES = 9 * 60;

function formatPublishTimeJst(wallClock: number, offsetMinutes: number): string {
  const jst = new Date(wallClock + (JST_OFFSET_MINUTES - offsetMinutes) * MINUTE_MS);
  return `${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日 ${pad2(jst.getUTCHours())}:${pad2(jst.getUTCMinutes())}`;
}
EOF

  fx_write go/internal/batch/run.go <<'EOF'
package batch

import "time"

var jst = time.FixedZone("JST", 9*60*60)

func jstDateAsUTC(t time.Time) time.Time {
	local := t.In(jst)
	return time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
}
EOF

  fx_write ts/packages/db/src/tallies.ts <<'EOF'
const PERIOD_MONTH_SQL =
  "date_trunc('month', now() AT TIME ZONE 'Asia/Tokyo')::date";
EOF
}

jst_tree() {
  fx_guard check-jst-offset-consistency
  jst_sources
}

t_begin 'check-jst-offset-consistency: 5つの固定値・整形方式・SQL zone が揃えば緑'
jst_tree
fx_run check-jst-offset-consistency
expect_green
expect_output_matches '固定オフセット 5 実装 / SQL zone 1 実装 / 候補 6 ファイル'
t_end

t_begin 'check-jst-offset-consistency: TypeScript のミリ秒オフセットが +08:00 なら赤'
jst_tree
sed -i.bak 's/9 \* 60 \* 60 \* 1000/8 * 60 * 60 * 1000/' "${FX}/ts/apps/store-detail/lib/data.ts"
rm -f "${FX}/ts/apps/store-detail/lib/data.ts.bak"
fx_run check-jst-offset-consistency
expect_red 'JST の +09:00（32400 秒）と一致しません'
expect_output_matches 'store-detail/lib/data\.ts の固定オフセットは 28800 秒'
t_end

t_begin 'check-jst-offset-consistency: TypeScript の分オフセットが +08:00 なら赤'
jst_tree
sed -i.bak 's/JST_OFFSET_MINUTES = 9 \* 60/JST_OFFSET_MINUTES = 8 * 60/' \
  "${FX}/ts/apps/line-webhook/src/report/builders/new-reviews.ts"
rm -f "${FX}/ts/apps/line-webhook/src/report/builders/new-reviews.ts.bak"
fx_run check-jst-offset-consistency
expect_red 'JST の +09:00（32400 秒）と一致しません'
expect_output_matches 'new-reviews\.ts の固定オフセットは 28800 秒'
t_end

t_begin 'check-jst-offset-consistency: Go の秒オフセットが +08:00 なら赤'
jst_tree
sed -i.bak 's/9\*60\*60/8*60*60/' "${FX}/go/internal/batch/run.go"
rm -f "${FX}/go/internal/batch/run.go.bak"
fx_run check-jst-offset-consistency
expect_red 'JST の +09:00（32400 秒）と一致しません'
expect_output_matches 'go/internal/batch/run\.go の固定オフセットは 28800 秒'
t_end

t_begin 'check-jst-offset-consistency: 宣言された実装ファイルが消えれば赤'
jst_tree
rm -f "${FX}/ts/apps/delivery-job/src/index.ts"
fx_run check-jst-offset-consistency
expect_red '宣言された JST 実装が存在しません: ts/apps/delivery-job/src/index.ts'
t_end

t_begin 'check-jst-offset-consistency: UTC getter がローカル getter へ変われば赤'
jst_tree
sed -i.bak 's/jst\.getUTCDate()/jst.getDate()/' "${FX}/ts/apps/line-webhook/src/report/handler.ts"
rm -f "${FX}/ts/apps/line-webhook/src/report/handler.ts.bak"
fx_run check-jst-offset-consistency
expect_red 'UTC 日の読取は 1 件であるべきですが、0 件です'
t_end

t_begin 'check-jst-offset-consistency: SQL の Asia/Tokyo が UTC へ変われば赤'
jst_tree
sed -i.bak "s/Asia\/Tokyo/UTC/" "${FX}/ts/packages/db/src/tallies.ts"
rm -f "${FX}/ts/packages/db/src/tallies.ts.bak"
fx_run check-jst-offset-consistency
expect_red 'Asia/Tokyo 月境界は 1 件であるべきですが、0 件です'
t_end

t_begin 'check-jst-offset-consistency: 新しい固定オフセット実装の列挙漏れは赤'
jst_tree
fx_write ts/apps/new-surface/src/today.ts <<'EOF'
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function today(): string {
  return new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 10);
}
EOF
fx_run check-jst-offset-consistency
expect_red '宣言されていない JST 実装候補があります: ts/apps/new-surface/src/today.ts'
t_end

t_begin 'check-jst-offset-consistency: 定数名の無い +08:00 直書きも列挙漏れなら赤'
jst_tree
fx_write ts/apps/new-surface/src/today.ts <<'EOF'
export function today(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
EOF
fx_run check-jst-offset-consistency
expect_red '宣言されていない JST 実装候補があります: ts/apps/new-surface/src/today.ts'
t_end

t_begin 'check-jst-offset-consistency: tzdata 依存の新実装も列挙漏れなら赤'
jst_tree
fx_write ts/apps/new-surface/src/today.ts <<'EOF'
export const formatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
});
EOF
fx_run check-jst-offset-consistency
expect_red '宣言されていない JST 実装候補があります: ts/apps/new-surface/src/today.ts'
t_end

t_begin 'check-jst-offset-consistency: 宣言表から既存実装を外す変異でも双方向照合が赤にする'
fx_guard_mutate check-jst-offset-consistency \
  -e "/^  'ts-review-time|ts\/apps\/line-webhook\/src\/report\/builders\/new-reviews\.ts|/d"
jst_sources
fx_run check-jst-offset-consistency
expect_red '宣言されていない JST 実装候補があります: ts/apps/line-webhook/src/report/builders/new-reviews.ts'
t_end

t_begin 'check-jst-offset-consistency: テスト内の異なる TZ・オフセットは本番実装として数えない'
jst_tree
fx_write ts/apps/new-surface/test/today.test.ts <<'EOF'
const JST_OFFSET_MS = 8 * 60 * 60 * 1000;
const formatter = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo' });
EOF
fx_write ts/apps/new-surface/src/today.spec.ts <<'EOF'
const JST_OFFSET_MINUTES = 7 * 60;
EOF
fx_write go/internal/batch/other_test.go <<'EOF'
package batch

import "time"

var testJST = time.FixedZone("JST", 8*60*60)
EOF
fx_run check-jst-offset-consistency
expect_green
expect_output_matches '候補 6 ファイル'
t_end

t_begin 'check-jst-offset-consistency: grep が評価不能なら無一致として緑へ倒さない'
jst_tree
jst_real_grep="$(PATH="$FX_BASE_PATH" command -v grep)"
cat > "${STUB_DIR}/grep" <<STUB
#!/usr/bin/env bash
echo 'grep-stub: simulated read error' >&2
exit 2
STUB
chmod +x "${STUB_DIR}/grep"
fx_run check-jst-offset-consistency
expect_red '走査できません（grep exit=2'
# スタブの実在だけでなく、元の grep を保存できたことも確認し、PATH 前提の空振りを防ぐ。
[ -x "$jst_real_grep" ] || _t_fail "実 grep を解決できませんでした: ${jst_real_grep}"
t_end
