import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';
import { openStructuredSurvey } from './fixtures/structured';

for (const failed of [false, true]) {
  test(`処理中から${failed ? '生成失敗' : '成功・コピー'}のToastへ進む（#450）`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openStructuredSurvey(page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let requests = 0;
    await page.route('**/api/responses', async (route) => {
      requests++;
      await pending;
      await route.fulfill({ json: { generation: failed ? 'failed' : 'ok', draft: failed ? null : '料理の味と量が良かったです。', sessionToken: 'test-session', regenerationsLeft: 3 } });
    });
    await page.getByRole('button', { name: '星3' }).click();
    const positive = page.getByRole('region', { name: '良かったところ（任意）' });
    await positive.getByRole('button', { name: '料理' }).click();
    await positive.getByRole('checkbox', { name: '味', exact: true }).first().click();
    await positive.getByRole('checkbox', { name: '量', exact: true }).first().click();
    await page.getByRole('button', { name: '口コミ文を作る' }).click();
    const button = page.getByRole('button', { name: '口コミ文を作成しています…' });
    try {
      await expect(button).toBeDisabled();
      await expect(button.locator('[data-slot="spinner"]')).toBeVisible();
      await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
      expect(requests).toBe(1);
    } finally { release(); }
    const toast = page.locator('[data-sonner-toast]').filter({ hasText: failed ? '下書きの生成に失敗しました' : '口コミ文を作成しました' });
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute('data-type', failed ? 'error' : 'success');
    await expect(page.getByRole('link', { name: 'Google のクチコミを書く' })).toBeVisible();
    if (!failed) {
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }));
      await page.getByRole('button', { name: 'コピーして投稿する' }).click();
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: '自動コピーできませんでした' })).toBeVisible();
      await expect(page.getByLabel('口コミ下書き')).toBeFocused();
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } }));
      await page.getByRole('button', { name: 'コピーして投稿する' }).click();
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'コピーしました。投稿画面に貼り付けてください。' })).toBeVisible();
    }
    await expectNoAxeViolations(page);
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const toaster = page.locator('[data-sonner-toaster]');
    await expect(toaster).toHaveAttribute('data-y-position', 'bottom');
    await expect(toaster).toHaveAttribute('data-x-position', 'right');
  });
}
