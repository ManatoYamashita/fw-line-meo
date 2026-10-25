import { test, expect } from '@playwright/test';
import {
  OWNERS,
  SEARCH_CANDIDATES,
  openStoreRegistrationOwners,
  openStoreSearchResults,
} from './fixtures/api';
import { openAgencyRegistration } from './fixtures/pr490-evidence';

// PR #490 の検証証跡用。一時的に既存の surfaces 実行へ追加する。
for (const viewport of [
  { name: 'desktop-1280', width: 1280, height: 900 },
  { name: 'mobile-320', width: 320, height: 800 },
]) {
  test(`PR490 evidence: operator ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openStoreRegistrationOwners(page);
    await page.screenshot({ path: testInfo.outputPath(`operator-owners-${viewport.name}.png`), fullPage: true, scale: 'css' });
    await openStoreSearchResults(page);
    const registered = SEARCH_CANDIDATES[1];
    await expect(page.getByRole('button', { name: `${registered.name}（${registered.address}）`, exact: true })).toHaveCount(0);
    await expect(page.getByText('登録先のオーナー:', { exact: false })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`operator-search-${viewport.name}.png`), fullPage: true, scale: 'css' });
    await page.getByRole('button', { name: 'オーナーを選び直す', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'オーナー選択', exact: true })).toBeFocused();
    await expect(page.getByRole('table')).toBeVisible();
  });
}

test('PR490 evidence: agency desktop-1280', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openAgencyRegistration(page);
  await expect(page.getByRole('region', { name: 'オーナー一覧', exact: true })).toBeVisible();
  await expect(page.locator('details')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('agency-owners-desktop-1280.png'), fullPage: true, scale: 'css' });
  await page.getByRole('button', { name: `${OWNERS[0].displayName}を選ぶ`, exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: '店名検索' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('agency-search-desktop-1280.png'), fullPage: true, scale: 'css' });
});
