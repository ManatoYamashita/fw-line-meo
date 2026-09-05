import { test, expect } from '@playwright/test';
import { expectNoHorizontalScroll } from '@fwlm/e2e-support/viewport';

import { DETAIL_RESPONSE, STORE_NAME } from './fixtures/detail';

// 店舗詳細（LIFF 面）の実描画検証（Issue #53 完了条件 3）。
//
// 要件 3.3（モバイル端末で横スクロールを発生させずに閲覧・操作できる）を、この面で初めて
// 機械検証する。これまで担保は globals.css の `overflow-x: clip` だけ、すなわち
// 「隠しているので見えない」状態だった。clip は scrollWidth 系の検査を構造的に無効化するため、
// 面の溢れを捕らえる網は要素の実測右端（maxRight）1 本しかない。
//
// 前提: `E2E_STUB_IDP=1` を立ててビルドしたものに対して走らせる（playwright.config.ts の説明）。

/** 詳細データを固定 fixture で供給する。DB も LINE の検証エンドポイントも起こさない。 */
async function stubDetailApi(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/detail*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(DETAIL_RESPONSE),
    });
  });
}

/**
 * 面が「エラー画面ではなく本体」を描いていることを先に固定する。
 *
 * これが無いと、LIFF の差し替えが効かずエラー文言だけの画面になったときに、横スクロールの
 * assert は当然のように緑を返す。**測る対象が消えたことを緑と読まないための前置きである。**
 */
async function openStoreSurface(page: import('@playwright/test').Page): Promise<void> {
  await stubDetailApi(page);
  await page.goto('/store');
  await expect(page.getByRole('heading', { level: 1, name: STORE_NAME })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(DETAIL_RESPONSE.trend.length + 1);
}

test('モバイルビューポートの店舗詳細で横スクロールが発生しない', async ({ page }) => {
  await openStoreSurface(page);
  // 捲れる領域は 0。推移表はまだ素の `<table>` で `TableContainer` を通っておらず、この面は
  // 記入欄・押しボタン・選択のいずれも描画しないため（4.2 の no-write 契約）、
  // textarea 由来の領域も存在しない。**実測して 0 と確認した値であり、推測ではない。**
  //
  // ui-airbnb-surfaces の task 3.3 が推移表を容器へ移した時点で、この 0 は実測と食い違って
  // 赤くなり、宣言の更新が強制される。それが件数宣言の本来の働きである。
  await expectNoHorizontalScroll(page, '店舗詳細', 0);
});
