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

  # --- grep スタブ -------------------------------------------------------
  # 既定は実物へ委譲し、AAP_GREP_FAIL の子プロセスでだけ exit 2 を返す。**どの grep を
  # 落とすかを引数で指定する**（一律に落とすと最初の経路で必ず赤くなり、以降の分岐を
  # 1 件も検査しないまま覆ったと誤認する・#161 で踏んだ形）。chmod は使えない
  # （CI は --require-full で skip を失敗として扱うため uid 依存の再現を作れない）。
  aap_real_grep="$(PATH="$FX_BASE_PATH" command -v grep)"
  cat > "${STUB_DIR}/grep" <<STUB
#!/usr/bin/env bash
if [ -n "\${AAP_GREP_FAIL:-}" ]; then
  case "\$*" in
    *"\${AAP_GREP_FAIL}"*) echo "grep-stub: simulated read error" >&2; exit 2 ;;
  esac
fi
exec "${aap_real_grep}" "\$@"
STUB
  chmod +x "${STUB_DIR}/grep"

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

  # 監査ヘルパ（検査 6・7 の対象）。**これを置かないと全ケースが検査 6 で赤くなり、
  # 上の 1〜5 を検査する前に落ちる。** 赤の原因を取り違えないためにここへ置く。
  fx_write ts/packages/e2e-support/src/a11y.ts <<'EOF'
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toHaveLength(0);
  expect(
    results.passes.length + results.incomplete.length + results.violations.length,
  ).toBeGreaterThan(0);
}
EOF
}

t_begin 'check-a11y-audit-preconditions: 正常なツリーで緑（件数まで照合）'
aap_tree
fx_run check-a11y-audit-preconditions
expect_green
# 「OK」だけでなく件数を照合する。走査が空振りしたまま緑になる経路と区別するため。
expect_output_matches '監査 spec 1 件 / fixtures モジュール 1 件 / 監査ヘルパ 1 件'
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
expect_output_matches '監査 spec 1 件 / fixtures モジュール 1 件 / 監査ヘルパ 1 件'
t_end

# ---------------------------------------------------------------------------
# 8〜12. 規律のもう半分 —— 「違反 0 件」と「規則 0 件」の区別。
#
# 1〜7 が守るのは「面が描けているか」で、こちらは「規則が実際に走ったか」である。axe は
# include が外れる・注入が失敗する経路で例外ではなく空の結果を返すため、この区別を失うと
# 「監査していないこと」が「監査に合格したこと」と同義になる。

t_begin 'check-a11y-audit-preconditions: 監査ヘルパが消えると赤'
aap_tree
# axe の import を失った版へ差し替える（ヘルパの実体が無くなった状態）。
fx_write ts/packages/e2e-support/src/a11y.ts <<'EOF'
import { expect, type Page } from '@playwright/test';

export async function expectNoAxeViolations(page: Page): Promise<void> {
  expect(page).toBeDefined();
}
EOF
fx_run check-a11y-audit-preconditions
expect_red '監査ヘルパが ts/packages/*/src に 1 件もありません'
t_end

t_begin 'check-a11y-audit-preconditions: 規則件数の項が 1 つ欠けると赤'
aap_tree
# passes を数えるのをやめる。合計は incomplete + violations だけになり、違反 0 件で規則も
# 0 件の状態を検出できなくなる。
fx_write ts/packages/e2e-support/src/a11y.ts <<'EOF'
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toHaveLength(0);
  expect(
    results.incomplete.length + results.violations.length,
  ).toBeGreaterThan(0);
}
EOF
fx_run check-a11y-audit-preconditions
expect_red 'ts/packages/e2e-support/src/a11y.ts に results.passes.length がありません'
t_end

t_begin 'check-a11y-audit-preconditions: 件数の assert 自体が消えると赤'
aap_tree
# 件数を数えてはいるが表明しない。**最も静かな壊れ方**で、diff 上は 1 行の削除にしか見えない。
fx_write ts/packages/e2e-support/src/a11y.ts <<'EOF'
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const evaluated = results.passes.length + results.incomplete.length + results.violations.length;
  void evaluated;
  expect(results.violations).toHaveLength(0);
}
EOF
fx_run check-a11y-audit-preconditions
expect_red 'ts/packages/e2e-support/src/a11y.ts に toBeGreaterThan(0) がありません'
t_end

t_begin 'check-a11y-audit-preconditions: アプリ側が axe を直接掴むと赤（ヘルパの迂回）'
aap_tree
# **これが現実的な迂回路である。** ヘルパの中身をいくら守っても、spec が直に axe を回して
# 違反だけを assert すれば、規則 0 件の区別は最初から存在しない。
fx_write ts/apps/good-face/e2e/direct-axe.spec.ts <<'EOF'
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import { openSurface } from './fixtures/surfaces';

test('面に違反が無い', async ({ page }) => {
  await openSurface(page);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toHaveLength(0);
});
EOF
fx_run check-a11y-audit-preconditions
expect_red 'ts/apps/good-face/e2e/direct-axe.spec.ts が axe を直接掴んでいます'
t_end

t_begin 'check-a11y-audit-preconditions: 監査ヘルパが 2 件あると赤（正典が割れる）'
aap_tree
fx_write ts/packages/other-support/src/a11y.ts <<'EOF'
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toHaveLength(0);
  expect(
    results.passes.length + results.incomplete.length + results.violations.length,
  ).toBeGreaterThan(0);
}
EOF
fx_run check-a11y-audit-preconditions
expect_red '監査ヘルパが 2 件あります（正典が割れています）'
t_end

# ---------------------------------------------------------------------------
# 走査が評価不能（grep exit 2）だったときに、それを「違反 0 件」と読まないこと。
#
# 抽出関数はコマンド置換（副シェル）で呼ばれるため、**関数の中で fail=1 を立てても親へ
# 戻らない**（steering tech.md「シェルガードの実装規律」）。姉妹ガードで実測した症状は
# ERROR を stderr へ出しながら OK / exit 0 を返す偽の緑だった（PR #192 レビュー指摘 1）。

t_begin 'check-a11y-audit-preconditions: 監査 spec の走査が評価不能（exit 2）なら赤'
aap_tree
[ -d "${FX}/.git" ] || fx_track_now
OUT=''
RC=0
OUT="$(cd "$FX" && AAP_GREP_FAIL='a11y-audit.spec.ts' bash scripts/check-a11y-audit-preconditions.sh 2>&1)" || RC=$?
expect_red 'ts/apps/good-face/e2e/a11y-audit.spec.ts を走査できなかったため判定できません。'
t_end
