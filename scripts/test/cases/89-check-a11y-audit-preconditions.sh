# scripts/check-a11y-audit-preconditions.sh の自己テスト（Issue #53）。
#
# 本ガードが守るのは「a11y 監査は面が本体を描けていることを先に固定してから当てる」である。
# 破れたときの症状は**エラーではなく緑**であり（空の画面には違反が出ようがない）、通常の
# テストでは検出できない。したがって検出の各分岐が本当に到達することを、条件を 1 つだけ
# 戻すと緑になる対照付きで固定する。
#
# とくに「fixtures へ移しただけで前提 assert が無い」形（下の 5）を必ず赤にすること。
# 移設は手段であって目的ではない。守りたいのは開く手順と前提 assert が同居していることである。

aap_tree() {
  fx_guard check-a11y-audit-preconditions

  # 規律を満たす面（正常形）。
  fx_write ts/apps/good-face/e2e/a11y-audit.spec.ts <<'EOF'
import { test } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';

import { openSurface } from './fixtures/surfaces';

test('面が WCAG A/AA の自動監査を通る', async ({ page }) => {
  await openSurface(page);
  await expectNoAxeViolations(page);
});
EOF
  fx_write ts/apps/good-face/e2e/fixtures/surfaces.ts <<'EOF'
import { expect, type Page } from '@playwright/test';

export async function openSurface(page: Page): Promise<void> {
  await page.goto('/surface');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
EOF

  # 監査 spec ではない spec。**goto を直書きしている。** 走査対象の絞り込みが効いていない限り、
  # この 1 件だけで正常ツリーが赤くなる（絞り込みの対照として意図的に置いている）。
  fx_write ts/apps/good-face/e2e/other.spec.ts <<'EOF'
import { test } from '@playwright/test';

test('横スクロールが発生しない', async ({ page }) => {
  await page.goto('/surface');
});
EOF

  # e2e を持たないアプリ。対象外として素通りすることの対照。
  fx_write ts/apps/plain-face/next.config.ts <<'EOF'
export default {};
EOF
}

t_begin 'check-a11y-audit-preconditions: 正常なツリーで緑（件数まで照合）'
aap_tree
fx_run check-a11y-audit-preconditions
expect_green
# 「OK」だけでなく件数を照合する。走査が空振りしたまま緑になる経路と区別するため。
expect_output_matches '監査 spec 1 件 / fixtures モジュール 1 件'
t_end

# ---------------------------------------------------------------------------
# 1. 監査 spec への goto 直書き。本ガードを入れた直接の動機（PR #191 の指摘）。

t_begin 'check-a11y-audit-preconditions: 監査 spec が page.goto を直書きすると赤'
aap_tree
fx_write ts/apps/good-face/e2e/a11y-audit.spec.ts <<'EOF'
import { test } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';

import { openSurface } from './fixtures/surfaces';

test('面が WCAG A/AA の自動監査を通る', async ({ page }) => {
  await page.goto('/surface');
  await expectNoAxeViolations(page);
});
EOF
fx_run check-a11y-audit-preconditions
expect_red 'ts/apps/good-face/e2e/a11y-audit.spec.ts が page.goto( を 1 件直書きしています。'
t_end

# ---------------------------------------------------------------------------
# 2. fixtures を経由していない。goto を消しただけでは前提は固定されない。

t_begin 'check-a11y-audit-preconditions: 監査 spec が fixtures を import しないと赤'
aap_tree
fx_write ts/apps/good-face/e2e/a11y-audit.spec.ts <<'EOF'
import { test } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';

test('面が WCAG A/AA の自動監査を通る', async ({ page }) => {
  await expectNoAxeViolations(page);
});
EOF
fx_run check-a11y-audit-preconditions
expect_red 'ts/apps/good-face/e2e/a11y-audit.spec.ts が ./fixtures/ のモジュールを 1 件も import していません。'
t_end

# ---------------------------------------------------------------------------
# 3. import 先が実在しない。名前だけ合っていても中身が無ければ前提は固定されない。

t_begin 'check-a11y-audit-preconditions: import 先の fixtures が存在しないと赤'
aap_tree
fx_write ts/apps/good-face/e2e/a11y-audit.spec.ts <<'EOF'
import { test } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';

import { openSurface } from './fixtures/missing';

test('面が WCAG A/AA の自動監査を通る', async ({ page }) => {
  await openSurface(page);
  await expectNoAxeViolations(page);
});
EOF
fx_run check-a11y-audit-preconditions
expect_red 'が import する ts/apps/good-face/e2e/fixtures/missing.ts が存在しません。'
t_end

# ---------------------------------------------------------------------------
# 4. fixtures が面を開いていない。経由しているのに開かないなら、開く手順は別の場所にある。

t_begin 'check-a11y-audit-preconditions: fixtures が面を開かないと赤'
aap_tree
fx_write ts/apps/good-face/e2e/fixtures/surfaces.ts <<'EOF'
import { expect, type Page } from '@playwright/test';

export async function openSurface(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
EOF
fx_run check-a11y-audit-preconditions
expect_red 'ts/apps/good-face/e2e/fixtures/surfaces.ts に page.goto( がありません'
t_end

# ---------------------------------------------------------------------------
# 5. **移設しただけで前提 assert が無い形。** ここが本ガードの核心である。
#    goto を fixtures へ移すだけなら 1〜4 をすべて通過してしまい、守りたい性質
#    （空の画面を監査対象と取り違えない）は 1 ミリも満たされない。

t_begin 'check-a11y-audit-preconditions: fixtures に前提 assert が無いと赤'
aap_tree
fx_write ts/apps/good-face/e2e/fixtures/surfaces.ts <<'EOF'
import { type Page } from '@playwright/test';

export async function openSurface(page: Page): Promise<void> {
  await page.goto('/surface');
}
EOF
fx_run check-a11y-audit-preconditions
expect_red 'ts/apps/good-face/e2e/fixtures/surfaces.ts に expect( がありません'
t_end

# ---------------------------------------------------------------------------
# 6. 空振り防止。監査 spec が 0 件なら緑ではなく赤。

t_begin 'check-a11y-audit-preconditions: 監査 spec が 1 件も無いと赤（空振り防止）'
aap_tree
fx_write ts/apps/good-face/e2e/a11y-audit.spec.ts <<'EOF'
import { test } from '@playwright/test';

import { openSurface } from './fixtures/surfaces';

test('面が描ける', async ({ page }) => {
  await openSurface(page);
});
EOF
fx_run check-a11y-audit-preconditions
expect_red 'expectNoAxeViolations を呼ぶ spec が 1 件もありません。ガードが空振りしています。'
t_end

# ---------------------------------------------------------------------------
# 7. 走査対象の絞り込みの対照。監査 spec **以外**の goto は本ガードの守備範囲ではない。
#    ここが効いていないと、横スクロール実測の spec を足しただけで CI が赤くなる。

t_begin 'check-a11y-audit-preconditions: 監査 spec 以外の goto は増やしても緑'
aap_tree
fx_write ts/apps/good-face/e2e/other.spec.ts <<'EOF'
import { test } from '@playwright/test';

test('横スクロールが発生しない', async ({ page }) => {
  await page.goto('/surface');
  await page.goto('/another');
  await page.goto('/yet-another');
});
EOF
fx_run check-a11y-audit-preconditions
expect_green
# 緑であることだけでは、走査そのものが消えた状態と区別できない。件数まで照合する。
expect_output_matches '監査 spec 1 件 / fixtures モジュール 1 件'
t_end
