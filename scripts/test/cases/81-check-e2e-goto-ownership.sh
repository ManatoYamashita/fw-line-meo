# scripts/check-e2e-goto-ownership.sh の自己テスト（Issue #53）。
#
# 本ガードが守るのは「面を開く手順の所有者は e2e/fixtures/ ただ 1 つ」である。破れたときの
# 症状は赤ではなく**前提の複写**で、複写された前提は片側だけが古びる —— しかもその劣化は
# 「テストが通り続ける」形で進むため、差分にも CI にも痕跡が出ない。検出の各分岐が本当に
# 到達することを、条件を 1 つだけ戻すと緑になる対照付きで固定する。

ego_tree() {
  fx_guard check-e2e-goto-ownership

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
fx_guard_mutate check-e2e-goto-ownership -e "s|-name '\*\.ts'|-name '*.NOPE'|"
fx_run check-e2e-goto-ownership
expect_red '走査対象の .ts が 1 件もありません。ガードが空振りしています。'
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
