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

// 推移表を `@fwlm/ui` の `TableContainer` へ移したので、捲れる領域が 1 件増えた
// （ui-airbnb-surfaces task 3.3）。要件 2.5 が「一覧の内部だけを横にたどれる状態にし、
// ページ全体を横に溢れさせない」と定めており、これは事故ではなく設計どおりの 1 件である。
// 容器は表の外側にあり、内側を免除しても容器自身の右端は依然として端末幅と比べられる。
//
// **この 1 は実測である。** task 3.3 の着手前は 0 で緑、推移を容器へ移した直後に
// 「捲れる領域の実測件数 1 が宣言 0 と食い違う（実測: table-container(直近30日の推移)）」で
// 赤くなることを確かめてから、この宣言を更新した。それが件数宣言の本来の働きである。
//
// この面は帯を持たない（管理ダッシュボードの `NAV_SCROLL_REGIONS` に相当するものが無い）。
// 記入欄・押しボタン・選択も描画しないため（4.2 の no-write 契約）、textarea 由来の領域も無い。
// つまり店舗詳細の捲れる領域は、この表の 1 件が全部である。
const TABLE_SCROLL_REGIONS = 1;

test('モバイルビューポートの店舗詳細で横スクロールが発生しない', async ({ page }) => {
  await openStoreSurface(page);
  await expectNoHorizontalScroll(page, '店舗詳細', TABLE_SCROLL_REGIONS);
});
