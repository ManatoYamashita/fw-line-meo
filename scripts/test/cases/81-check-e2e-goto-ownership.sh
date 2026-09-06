# scripts/check-e2e-goto-ownership.sh の自己テスト（Issue #53）。
#
# 本ガードが守るのは「面を開く手順の所有者は e2e/fixtures/ ただ 1 つ」である。破れたときの
# 症状は赤ではなく**前提の複写**で、複写された前提は片側だけが古びる —— しかもその劣化は
# 「テストが通り続ける」形で進むため、差分にも CI にも痕跡が出ない。検出の各分岐が本当に
# 到達することを、条件を 1 つだけ戻すと緑になる対照付きで固定する。

ego_tree() {
  fx_guard check-e2e-goto-ownership

  # --- grep スタブ -------------------------------------------------------
  # 既定は実物へ委譲し、EGO_GREP_FAIL の子プロセスでだけ exit 2 を返す。**どの grep を
  # 落とすかを引数で指定する。** 一律に落とすと最初の grep で必ず赤くなり、後続の経路の
  # exit 2 分岐を 1 件も検査しないまま「覆った」と誤認する（#161 で実際に踏んだ形）。
  # chmod は使えない（CI は --require-full で skip を失敗として扱うため、uid 依存の
  # 再現は作れない）。実物の場所は PATH へスタブを差し込む前の解決結果を焼き込む。
  ego_real_grep="$(PATH="$FX_BASE_PATH" command -v grep)"
  cat > "${STUB_DIR}/grep" <<STUB
#!/usr/bin/env bash
if [ -n "\${EGO_GREP_FAIL:-}" ]; then
  case "\$*" in
    *"\${EGO_GREP_FAIL}"*) echo "grep-stub: simulated read error" >&2; exit 2 ;;
  esac
fi
exec "${ego_real_grep}" "\$@"
STUB
  chmod +x "${STUB_DIR}/grep"

  # 規律を満たす面（正常形）。
  fx_write ts/apps/good-face/e2e/surface.spec.ts <<'EOF'
import { test } from '@playwright/test';

import { openSurface } from './fixtures/surfaces';

test('面が描ける', async ({ page }) => {
  await openSurface(page);
});
EOF
  fx_write ts/apps/good-face/e2e/fixtures/surfaces.ts <<'EOF'
import { expect, type Page } from '@playwright/test';

export async function openSurface(page: Page): Promise<void> {
  await page.goto('/surface');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
EOF
  # spec ではない e2e 配下のモジュール。**ここも走査対象である**（所有者を 1 種類に絞るため）。
  fx_write ts/apps/good-face/e2e/stubs/liff.ts <<'EOF'
export default { init: async () => {} };
EOF

  # e2e を持たないアプリ。対象外として素通りすることの対照。
  fx_write ts/apps/plain-face/next.config.ts <<'EOF'
export default {};
EOF
}

ego_run_grepfail() {
  # $1 = exit 2 を返させる grep の引数に含まれる文字列。
  # env はガードの子プロセスへだけ渡すので、ハーネス自身の grep -cE は影響を受けない。
  [ -d "${FX}/.git" ] || fx_track_now
  OUT=''
  RC=0
  OUT="$(cd "$FX" && EGO_GREP_FAIL="$1" bash scripts/check-e2e-goto-ownership.sh 2>&1)" || RC=$?
}

t_begin 'check-e2e-goto-ownership: 正常なツリーで緑（件数まで照合）'
ego_tree
fx_run check-e2e-goto-ownership
expect_green
# 「OK」だけでなく件数を照合する。走査が空振りしたまま緑になる経路と区別するため。
expect_output_matches '走査 2 ファイル / fixtures 側の goto 1 件・WHITELIST 0 件'
t_end

t_begin 'check-e2e-goto-ownership: spec が goto を持つと赤'
ego_tree
fx_write ts/apps/good-face/e2e/surface.spec.ts <<'EOF'
import { test } from '@playwright/test';

test('面が描ける', async ({ page }) => {
  await page.goto('/surface');
});
EOF
fx_run check-e2e-goto-ownership
expect_red 'ts/apps/good-face/e2e/surface.spec.ts が page.goto( を 1 件持っています'
t_end

# spec だけを見るガードにすると、helper へ 1 段隠した goto が素通りする。
t_begin 'check-e2e-goto-ownership: spec 以外（stub/helper）の goto も赤'
ego_tree
fx_write ts/apps/good-face/e2e/stubs/liff.ts <<'EOF'
import { type Page } from '@playwright/test';

export async function warmUp(page: Page): Promise<void> {
  await page.goto('/surface');
}
EOF
fx_run check-e2e-goto-ownership
expect_red 'ts/apps/good-face/e2e/stubs/liff.ts が page.goto( を 1 件持っています'
t_end

# 対照: fixtures 側は所有者なので、増やしても緑でなければならない。
# これが効いていないと、規律を守った移設そのものが赤くなる。
t_begin 'check-e2e-goto-ownership: fixtures 側の goto は増やしても緑'
ego_tree
fx_write ts/apps/good-face/e2e/fixtures/surfaces.ts <<'EOF'
import { expect, type Page } from '@playwright/test';

export async function openSurface(page: Page): Promise<void> {
  await page.goto('/surface');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

export async function openOther(page: Page): Promise<void> {
  await page.goto('/other');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
EOF
fx_run check-e2e-goto-ownership
expect_green
expect_output_matches 'fixtures 側の goto 2 件'
t_end

t_begin 'check-e2e-goto-ownership: WHITELIST に載せた例外は通る'
ego_tree
fx_write ts/apps/good-face/e2e/surface.spec.ts <<'EOF'
import { test } from '@playwright/test';

test('面が描ける', async ({ page }) => {
  await page.goto('/surface');
});
EOF
fx_guard_mutate check-e2e-goto-ownership \
  -e "s|^WHITELIST=()|WHITELIST=('ts/apps/good-face/e2e/surface.spec.ts\|一度きりの URL（Issue #999）')|"
fx_run check-e2e-goto-ownership
expect_green
t_end

# 載っているのに違反が無くなった項目は、一覧を実態から乖離させ続ける。
t_begin 'check-e2e-goto-ownership: 不活性な WHITELIST 項目は警告される'
ego_tree
fx_guard_mutate check-e2e-goto-ownership \
  -e "s|^WHITELIST=()|WHITELIST=('ts/apps/good-face/e2e/surface.spec.ts\|一度きりの URL（Issue #999）')|"
fx_run check-e2e-goto-ownership
expect_green
expect_output_matches 'WHITELIST に載っていますが違反として検出されませんでした'
t_end

t_begin 'check-e2e-goto-ownership: 走査対象が 1 件も無いと赤（空振り防止）'
ego_tree
fx_guard_mutate check-e2e-goto-ownership -e "s|^SCAN_EXTS=.*|SCAN_EXTS='NOPE'|"
fx_run check-e2e-goto-ownership
expect_red '走査対象のファイルが 1 件もありません。ガードが空振りしています。'
t_end

# **これが最も重要な空振り防止である。** 「誰も面を開かなくなった」状態は、禁止が守られている
# 状態と区別が付かないまま緑を返す。所有者が実在することまで要求して初めて検査になる。
t_begin 'check-e2e-goto-ownership: fixtures 側に goto が無いと赤（所有者の不在）'
ego_tree
fx_write ts/apps/good-face/e2e/fixtures/surfaces.ts <<'EOF'
import { expect, type Page } from '@playwright/test';

export async function openSurface(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
EOF
fx_run check-e2e-goto-ownership
expect_red 'e2e/fixtures/ に page.goto( が 1 件もありません'
t_end

# ---------------------------------------------------------------------------
# 走査が評価不能（grep exit 2）だったときに、それを「違反 0 件」と読まないこと。
#
# **判定を関数の中で立ててはならない。** 抽出関数はコマンド置換（副シェル）で呼ばれるため、
# 関数内の `fail=1` は親へ戻らない。PR #192 のレビューで実測した症状は、ERROR を stderr へ
# 出しながら **OK / exit 0** を返す偽の緑だった。expect_red は exit != 0 を要求するので、
# この形の再発はここで止まる。chmod ではなく grep スタブで作るのは uid 非依存にするため。

t_begin 'check-e2e-goto-ownership: spec の走査が評価不能（exit 2）なら赤'
ego_tree
ego_run_grepfail 'surface.spec.ts'
expect_red 'ts/apps/good-face/e2e/surface.spec.ts を走査できなかったため判定できません。'
t_end

# **fixtures 側が読めない場合はさらに危険である。** 件数へ負値が混ざると
# 「fixtures 側の goto が 0 件」の空振り防止（-eq 0）まですり抜ける。件数表示も汚染される。
t_begin 'check-e2e-goto-ownership: fixtures の走査が評価不能（exit 2）なら赤（負値を件数へ混ぜない）'
ego_tree
ego_run_grepfail 'fixtures/surfaces.ts'
expect_red 'ts/apps/good-face/e2e/fixtures/surfaces.ts を走査できなかったため判定できません。'
expect_absent 'goto -1 件'
t_end

# ---------------------------------------------------------------------------
# 所有者の実在は**アプリ単位**で要求する。
#
# 合算で数えると、あるアプリの fixtures が goto を失っても別アプリの分で埋まり、
# 「そのアプリでは誰も面を開かなくなった」状態が緑のまま通る。

t_begin 'check-e2e-goto-ownership: 1 アプリの fixtures が goto を失うと他アプリが持っていても赤'
ego_tree
# 2 つ目のアプリ。こちらの fixtures は goto を持つ（合算なら 1 件で埋まってしまう）。
fx_write ts/apps/other-face/e2e/surface.spec.ts <<'SPEC'
import { test } from '@playwright/test';

import { openSurface } from './fixtures/surfaces';

test('面が描ける', async ({ page }) => {
  await openSurface(page);
});
SPEC
fx_write ts/apps/other-face/e2e/fixtures/surfaces.ts <<'FIXTURE'
import { expect, type Page } from '@playwright/test';

export async function openSurface(page: Page): Promise<void> {
  await page.goto('/surface');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
FIXTURE
# good-face の所有者から goto を抜く。
fx_write ts/apps/good-face/e2e/fixtures/surfaces.ts <<'EMPTIED'
import { expect, type Page } from '@playwright/test';

export async function openSurface(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
EMPTIED
fx_run check-e2e-goto-ownership
expect_red 'ts/apps/good-face に走査対象 2 件がありますが、その e2e/fixtures/ に page.goto( が 1 件もありません'
t_end

# ---------------------------------------------------------------------------
# 走査面は Playwright が収集しうる拡張子すべてへ及ぶ。
#
# `.ts` だけに絞ると、`.spec.mts` や `.spec.tsx` へ 1 段隠した goto は **Playwright には
# 収集されつつ本ガードからは見えない**。禁止の抜け道が拡張子ひとつで開く。

t_begin 'check-e2e-goto-ownership: .ts 以外（.mts）の spec が goto を持っても赤'
ego_tree
fx_write ts/apps/good-face/e2e/late.spec.mts <<'LATE'
import { test } from '@playwright/test';

test('面が描ける', async ({ page }) => {
  await page.goto('/surface');
});
LATE
fx_run check-e2e-goto-ownership
expect_red 'ts/apps/good-face/e2e/late.spec.mts が page.goto( を 1 件持っています'
t_end
