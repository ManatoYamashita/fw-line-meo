import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';
import { expectNoHorizontalScroll, readOverflowMetrics } from '@fwlm/e2e-support/viewport';

test('認証もJavaScriptもなくサービス概要とQRの案内を読める', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    const response = await page.goto(`${baseURL}/`);
    expect(response?.status()).toBe(200);
    expect(response?.request().redirectedFrom()).toBeNull();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('お客様の声を、お店の次の一歩に。');
    await expect(page.getByRole('heading', { name: 'アンケートに回答したいお客様へ' })).toBeVisible();
    await expect(page.getByText('アンケートへの回答に、会員登録やLINEログインは必要ありません。')).toBeVisible();
    await expect(page.getByText('Googleへの投稿にはGoogleアカウントが必要です。口コミが自動で投稿されることはありません。')).toBeVisible();
    await expect(page.getByRole('link', { name: '導入について相談する' })).toHaveAttribute('href', 'https://firstweb-works.com/contact/');
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(new URL(canonical!).href).toBe('https://review.firstweb-works.com/');

    // スクリプトが動かない環境でも、本文中の案内へ移動できる。
    await page.getByRole('link', { name: '使い方を見る' }).click();
    await expect(page).toHaveURL(/\/#how-it-works$/);
    await expect(page.getByRole('heading', { name: '感想を伝える、3つのステップ。' })).toBeInViewport();
  } finally {
    await context.close();
  }
});

test('公開LPの全リンクをキーボードでたどれ、フォーカスが見える', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const links = page.getByRole('link');
  const count = await links.count();
  expect(count).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Tab');
    const link = links.nth(index);
    await expect(link).toBeFocused();
    await expect(link).toBeInViewport();
    const outline = await link.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: parseFloat(style.outlineWidth), style: style.outlineStyle, color: style.outlineColor };
    });
    expect(outline.width).toBeGreaterThanOrEqual(2);
    expect(outline.style).toBe('solid');
    expect(outline.color).not.toBe('rgba(0, 0, 0, 0)');
  }

  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '本文へスキップ' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
});

test('320px幅からデスクトップ、文字200%でも本文とリンクが欠けない', async ({ page }) => {
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    for (const fontSize of ['100%', '200%']) {
      await page.evaluate((value) => { document.documentElement.style.fontSize = value; }, fontSize);
      if (width <= 480) {
        await expectNoHorizontalScroll(page, `${width}px / 文字${fontSize}`, 0);
      } else {
        // 共通のアサーションはモバイル専用。広い画面でも同じ測定実装を使う。
        const metrics = await readOverflowMetrics(page, 'scroll-container');
        expect(metrics.scrollRegions).toHaveLength(0);
        expect(metrics.maxRight).toBeLessThanOrEqual(width + 1);
        expect(metrics.docScrollWidth).toBeLessThanOrEqual(metrics.docClientWidth);
        expect(metrics.innerWidth).toBeLessThanOrEqual(width + 1);
      }
      // 全体の overflow-x: clip が隠してしまう、個々の文字の欠けも検出する。
      const clipped = await page.locator('h1, h2, h3, p, a:not(.sr-only)').evaluateAll((elements) =>
        elements.filter((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return [...range.getClientRects()].some((rect) => rect.left < -1 || rect.right > window.innerWidth + 1);
        }).map((element) => element.textContent),
      );
      expect(clipped, `${width}px / 文字${fontSize}`).toEqual([]);
    }
  }
});

test('公開LPがWCAG A/AAの自動監査を通る', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('お客様の声を、お店の次の一歩に。');
  await expectNoAxeViolations(page);
});
