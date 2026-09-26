import { test, expect } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';

import { ACTION_RESULT_SURFACES, DASHBOARD_SURFACES, OVERLAY_SURFACES } from './fixtures/api';

// 管理ダッシュボード 8 面の自動 a11y 監査（Issue #53・Issue #179 で QR パネルを、
// Issue #259 で利用者の編集パネルを追加）と、一覧の上に重なる後続状態の監査（Issue #252 で
// 停止の確認ダイアログを、Issue #342 で操作失敗 Toast を追加）。
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

// 一覧の上に重なる後続状態（Issue #252）。面全体の監査に加えて、**重なった部品だけに絞った監査**
// も当てる。面全体の「規則が 0 件でない」は下の一覧だけでも満たされるため、部品の中で規則が
// 1 件も走っていない状態（部品が空・監査の対象から外れた）を区別できない。絞った監査の側の
// 「規則が 0 件でない」が、部品そのものを監査したことの証拠になる。
for (const surface of OVERLAY_SURFACES) {
  test(`${surface.where}が WCAG A/AA の自動監査を通る`, async ({ page }) => {
    await surface.open(page);
    await expectNoAxeViolations(page);
    await expectNoAxeViolations(page, { selector: surface.selector });
  });
}

// 操作結果の通知状態（Issue #342）。面全体に加えて Toast 自体へ絞った監査も当て、通知の
// 前提 assert と合わせて「失敗状態が出ていない空振り」を成功として扱わない。
for (const surface of ACTION_RESULT_SURFACES) {
  test(`${surface.where}が WCAG A/AA の自動監査を通る`, async ({ page }) => {
    await surface.open(page);
    await expectNoAxeViolations(page);
    await expectNoAxeViolations(page, { selector: surface.selector });
  });
}

// 面の追加時に a11y 監査だけ取りこぼす事故を防ぐ。DASHBOARD_SURFACES が空になれば
// 上のループは 1 件もテストを生成せず、スイートは「0 件成功」で緑になる。
test('監査対象の面が 1 件も生成されていない状態で緑にならない', () => {
  expect(DASHBOARD_SURFACES.length).toBeGreaterThan(0);
});

test('重なる後続状態の監査が 1 件も生成されていない状態で緑にならない', () => {
  expect(OVERLAY_SURFACES.length).toBeGreaterThan(0);
});

test('操作結果の通知状態の監査が 1 件も生成されていない状態で緑にならない', () => {
  expect(ACTION_RESULT_SURFACES.length).toBeGreaterThan(0);
});
