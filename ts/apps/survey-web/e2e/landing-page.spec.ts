import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';
import { expectNoHorizontalScroll, readOverflowMetrics } from '@fwlm/e2e-support/viewport';
import { openComponentCatalog, openLandingPage } from './fixtures/surfaces';

test('認証もJavaScriptもなくサービス概要とQRの案内を読める', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  try {
    await openLandingPage(page);
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
  await openLandingPage(page);
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

  await openLandingPage(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '本文へスキップ' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
});

test('320px幅からデスクトップ、文字200%でも本文とリンクが欠けない', async ({ page }) => {
  await openLandingPage(page);
  for (const width of [320, 390, 768, 1280]) {
    await page.evaluate(() => { document.documentElement.style.fontSize = '100%'; });
    await page.setViewportSize({ width, height: 900 });

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
  await openLandingPage(page);
  await expectNoAxeViolations(page);
});

test('検索用情報と運営・開発の情報がJavaScriptなしのHTMLに含まれる', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  try {
    await openLandingPage(page);
    await expect(page).toHaveTitle('飲食店のGoogle口コミ・QRアンケート支援 | Firstweb 集客AIアシスタント');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /飲食店.*Google口コミ/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow');
    const ogUrl = await page.locator('meta[property="og:url"]').getAttribute('content');
    expect(new URL(ogUrl!).href).toBe('https://review.firstweb-works.com/');
    await expect(page.locator('meta[property="og:image"]').first()).toHaveAttribute('content', 'https://review.firstweb-works.com/ogp.jpg');
    await expect(page.getByText('運営: Firstweb', { exact: true })).toBeVisible();
    await expect(page.getByText('開発: 新卒グルメ', { exact: true })).toBeVisible();
    const schema = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!);
    expect(schema['@context']).toBe('https://schema.org');
    expect(schema['@graph']).toEqual(expect.arrayContaining([
      expect.objectContaining({ '@type': 'WebSite', url: 'https://review.firstweb-works.com/' }),
      expect.objectContaining({
        '@type': 'SoftwareApplication',
        publisher: expect.objectContaining({ name: 'Firstweb' }),
        creator: expect.objectContaining({ name: '新卒グルメ' }),
      }),
    ]));
  } finally {
    await context.close();
  }
});

test('クローラは公開LPを発見でき、検証面は検索対象にならない', async ({ request, page }) => {
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  const rules = await robots.text();
  expect(rules).toContain('Allow: /');
  expect(rules).toContain('Sitemap: https://review.firstweb-works.com/sitemap.xml');
  // noindexを読むためのクロールまで禁止しない。
  expect(rules).not.toMatch(/Disallow: \/(?:s\/|ui-check)/);
  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()['content-type']).toContain('xml');
  const locations = [...(await sitemap.text()).matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
  expect(locations).toEqual(['https://review.firstweb-works.com/']);
  await openComponentCatalog(page);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
});
