import { test, expect } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';

import { DASHBOARD_SURFACES } from './fixtures/api';

// 管理ダッシュボード 6 面の自動 a11y 監査（Issue #53）。
//
// 横スクロール実測（dashboard-surfaces.spec.ts）と同じ面定義を使う。面が本体を描けている
// ことの前提 assert も各 open が持つ ——「空の画面には違反が出ようがない」ため、a11y 監査
// こそ前提の固定が要る。
//
// 既知の溢れ（Issue #186）を持つ 3 面もここでは通常どおり監査する。溢れは要件 3.3 の話で
// あって a11y 違反ではなく、axe も溢れを違反として報告しない。
//
// axe の守備範囲と限界（とくにフォーカス指標は自動検出できないこと）は
// @fwlm/e2e-support/a11y に記す。
//
// 前提: `E2E_STUB_IDP=1` と `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3199` を与えて
// ビルドしたものに対して走らせる（playwright.config.ts の説明）。

for (const surface of DASHBOARD_SURFACES) {
  test(`${surface.where}が WCAG A/AA の自動監査を通る`, async ({ page }) => {
    await surface.open(page);
    await expectNoAxeViolations(page);
  });
}

// 面の追加時に a11y 監査だけ取りこぼす事故を防ぐ。DASHBOARD_SURFACES が空になれば
// 上のループは 1 件もテストを生成せず、スイートは「0 件成功」で緑になる。
test('監査対象の面が 1 件も生成されていない状態で緑にならない', () => {
  expect(DASHBOARD_SURFACES.length).toBeGreaterThan(0);
});
