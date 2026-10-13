import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';
import { openSurveySettingsSurface } from './fixtures/survey-settings';

test('遅延中の追加表示からToastへ進み、通信失敗後も入力と再試行を保つ（#450）', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openSurveySettingsSurface(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/survey-settings/targets?*', async (route) => { await pending; await route.fallback(); });
  const food = page.getByRole('region', { name: '料理' });
  const input = food.getByLabel('料理名を追加');
  await input.fill('餃子');
  await food.getByRole('button', { name: '追加する' }).click();
  const button = food.getByRole('button', { name: '追加中…' });
  try {
    await expect(button).toBeDisabled();
    await expect(button.locator('[data-slot="spinner"]')).toBeVisible();
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  } finally { release(); }
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: '「餃子」を追加しました。' })).toBeVisible();
  await page.unroute('**/api/survey-settings/targets?*');
  await page.route('**/api/survey-settings/targets?*', (route) => route.abort('failed'));
  await input.fill('海鮮丼');
  await food.getByRole('button', { name: '追加する' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: '通信に失敗しました' })).toBeVisible();
  await expect(input).toHaveValue('海鮮丼');
  await expect(food.getByRole('button', { name: '追加する' })).toBeEnabled();
  await page.unroute('**/api/survey-settings/targets?*');
  await food.getByRole('button', { name: '追加する' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: '「海鮮丼」を追加しました。' })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect(page.locator('[data-sonner-toaster]')).toHaveAttribute('data-y-position', 'bottom');
});
