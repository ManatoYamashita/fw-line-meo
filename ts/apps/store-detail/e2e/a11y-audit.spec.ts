import { test } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';

import { openStoreSurface } from './fixtures/detail';

// 店舗詳細（LIFF 面）の自動 a11y 監査（Issue #53）。
//
// 横スクロール実測（store-surface.spec.ts）と同じ手順で開く。面が本体を描けていることの
// 前提 assert も openStoreSurface が持つ ——「空の画面には違反が出ようがない」ため、
// a11y 監査こそ前提の固定が要る。
//
// axe の守備範囲と限界（とくにフォーカス指標は自動検出できないこと）は
// @fwlm/e2e-support/a11y に記す。
//
// 前提: `E2E_STUB_IDP=1` を立ててビルドしたものに対して走らせる（playwright.config.ts の説明）。

test('店舗詳細が WCAG A/AA の自動監査を通る', async ({ page }) => {
  await openStoreSurface(page);
  await expectNoAxeViolations(page);
});
