import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';
import { expectNoHorizontalScroll } from '@fwlm/e2e-support/viewport';

import { openStructuredSurvey } from './fixtures/structured';

// structured survey の客向け画面（Issue #438）の実ブラウザ検証。QR → 携帯（Pixel 5 相当・projects の既定）を想定し、
// 星 → 料理を開く → Target → facet → 気になったところ → 一言 → 送信 → 回答済み（Google の投稿導線）を通す。
// 送信は実際の /api/responses（実 DB・e2e/structured-seed.sql の店舗）へ届き、サーバーが版・指紋を照合して受け付ける。
// 面を開く手順と前提の assert は fixtures/structured.ts が持つ。

// 捲れる領域は一言の <textarea> の 1 つ（legacy の回答画面と同じ・ui-foundation.spec.ts）。
const SCROLL_REGIONS = 1;

const positive = (page: Page) => page.getByRole('region', { name: '良かったところ（任意）' });
const concern = (page: Page) => page.getByRole('region', { name: '気になったところ（任意）' });

test.describe('structured survey（客向け）', () => {
  test('星・料理・Target・facet・気になったところ・一言を選んで送信し、回答済みの画面へ進む', async ({ page }) => {
    await openStructuredSurvey(page);
    await page.getByRole('button', { name: '星4' }).click();

    // 良かったところ: 料理を開く → 料理全体の「量」・刺身盛り合わせ → 味・焼き鳥5種盛り（Target だけ）。
    await positive(page).getByRole('button', { name: '料理' }).click();
    const food = positive(page).getByRole('group', { name: '料理' });
    await food.getByRole('checkbox', { name: '量' }).click();
    await food.getByRole('checkbox', { name: '刺身盛り合わせ' }).click();
    await food.getByText('刺身盛り合わせについて').locator('..').getByRole('checkbox', { name: '味' }).click();
    await food.getByRole('checkbox', { name: '焼き鳥5種盛り' }).click();
    // 別のカテゴリを開くと料理は折り畳まれ、選んだ内容の要約が出る。
    await positive(page).getByRole('button', { name: '接客・提供' }).click();
    await expect(positive(page).getByRole('list', { name: '良かったところで選んだ内容' })).toHaveText(
      '✓ 料理：料理全体：量／刺身盛り合わせ：味／焼き鳥5種盛り',
    );

    // 気になったところ: 同じ刺身盛り合わせ → 味（矛盾として扱わない）。
    await concern(page).getByRole('button', { name: '料理' }).click();
    const concernFood = concern(page).getByRole('group', { name: '料理' });
    await concernFood.getByRole('checkbox', { name: '刺身盛り合わせ' }).click();
    await concernFood.getByText('刺身盛り合わせについて').locator('..').getByRole('checkbox', { name: '温度・状態' }).click();

    await page.getByRole('textbox', { name: /その他、伝えたいこと/ }).fill('少しぬるかった');

    const request = page.waitForRequest((r) => r.url().endsWith('/api/responses') && r.method() === 'POST');
    const response = page.waitForResponse((r) => r.url().endsWith('/api/responses'));
    await page.getByRole('button', { name: '送信する' }).click();
    const body = (await request).postDataJSON() as Record<string, unknown>;
    expect(body).toMatchObject({
      star: 4,
      positiveSelections: [
        { categoryCode: 'food', facetCodes: ['volume'] },
        { categoryCode: 'food', targetId: expect.any(String), facetCodes: ['taste'] },
        { categoryCode: 'food', targetId: expect.any(String), facetCodes: [] },
      ],
      concernSelections: [{ categoryCode: 'food', targetId: expect.any(String), facetCodes: ['temperature_condition'] }],
      comment: '少しぬるかった',
    });
    // Target は UUID で送る（名前では送らない）。
    expect(JSON.stringify(body)).not.toContain('刺身盛り合わせ');
    expect((await response).status()).toBe(200);

    await expect(page.getByText(/へのご回答ありがとうございました。/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Google のクチコミを書く' })).toBeVisible();
  });

  test('カテゴリを開いて閉じただけなら、星だけの回答として送る', async ({ page }) => {
    await openStructuredSurvey(page);
    await page.getByRole('button', { name: '星2' }).click();
    await positive(page).getByRole('button', { name: '料理' }).click();
    await positive(page).getByRole('button', { name: '料理' }).click();
    await concern(page).getByRole('button', { name: '接客・提供' }).click();
    const request = page.waitForRequest((r) => r.url().endsWith('/api/responses') && r.method() === 'POST');
    await page.getByRole('button', { name: '送信する' }).click();
    expect((await request).postDataJSON()).toMatchObject({ star: 2, positiveSelections: [], concernSelections: [] });
    await expect(page.getByRole('link', { name: 'Google のクチコミを書く' })).toBeVisible();
  });

  test('携帯の幅と 320px で、料理と Target を開いた状態でも横スクロールしない', async ({ page }) => {
    await openStructuredSurvey(page);
    await expectNoHorizontalScroll(page, 'structured の回答画面（初期）', SCROLL_REGIONS);
    await positive(page).getByRole('button', { name: '料理' }).click();
    await positive(page).getByRole('group', { name: '料理' }).getByRole('checkbox', { name: '刺身盛り合わせ' }).click();
    await expectNoHorizontalScroll(page, 'structured の回答画面（料理と Target を開いた）', SCROLL_REGIONS);
    await page.setViewportSize({ width: 320, height: 720 });
    await expectNoHorizontalScroll(page, 'structured の回答画面（320px）', SCROLL_REGIONS);
  });

  test('自動 a11y 監査（初期と、料理と Target を開いた状態）', async ({ page }) => {
    await openStructuredSurvey(page);
    await expectNoAxeViolations(page);
    await positive(page).getByRole('button', { name: '料理' }).click();
    await positive(page).getByRole('group', { name: '料理' }).getByRole('checkbox', { name: '刺身盛り合わせ' }).click();
    await expectNoAxeViolations(page);
  });
});
