import { expect, test, type Page } from '@playwright/test';

import { DISABLED_STORE, NO_CONFIG_STORE, openForcedSurvey } from './fixtures/global-rollout';
import { STORE_ID as LEGACY_SEED_STORE_ID } from './fixtures/surfaces';

// 全店公開（SURVEY_FORCE_STRUCTURED=1・Issue #441）の実ブラウザ検証。playwright.config.ts の
// `mobile-chromium-global-rollout` だけが流し、フラグを付けて起動した別のサーバー（3101）へ繋ぐ。
//
// 対象は、フラグの無いサーバーでは legacy になる店舗である（seed.sql の確定店舗・global-rollout-seed.sql の 2 店）。
// 同じ店舗がフラグの無いサーバーで legacy のまま出ることは survey-flow.spec.ts 等が固定するので、2 つの
// プロジェクトが揃って緑であることが「フラグを戻せば従来の画面に戻る」ことの確認にもなる。
//
// 画面の形は main の折り畳みデザインのまま確かめる: 良かったところは最初から開き、気になったところは
// 「気になったところ（任意）」の入口だけを出して畳む。星の値では何も出し分けない。

// 回答と再生成の API は送信元ごとに 1 分 20 件の流量制限を持つ（structured-behavior.spec.ts と同じ理由）。
test.beforeEach(async ({ page }, testInfo) => {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': `e2e-global-rollout-${testInfo.testId}` });
});

const positive = (page: Page) => page.getByRole('region', { name: '良かったところを教えてください' });
const concern = (page: Page) => page.getByRole('region', { name: '気になったところ（任意）' });
const concernToggle = (page: Page) => page.getByRole('button', { name: /^気になったところ（任意）/ });
const regenerateButton = (page: Page) => page.getByRole('button', { name: /^別の文章を生成（残り\d+回）$/ });

// 画面を開く手順と前提の assert（structured が描けている・折り畳みの初期状態）は fixtures/global-rollout.ts が持つ。

test.describe('全店公開（SURVEY_FORCE_STRUCTURED=1）', () => {
  test('設定行の無い既存店舗（seed.sql の確定店舗）も新アンケートになる', async ({ page }) => {
    await openForcedSurvey(page, LEGACY_SEED_STORE_ID);
  });

  test('個別 OFF の店舗も新アンケートになり、登録済みの料理名が出る', async ({ page }) => {
    await openForcedSurvey(page, DISABLED_STORE.id, DISABLED_STORE.name);
    await positive(page).getByRole('button', { name: '料理' }).click();
    await expect(positive(page).getByRole('group', { name: '料理' }).getByRole('checkbox', { name: '日替わり定食' })).toBeVisible();
  });

  for (const star of [1, 5]) {
    test(`星${star}: 気になったところを開いて良かったところと両方選び、下書き・コピー・再生成・Google の導線まで進む`, async ({ page }) => {
      await openForcedSurvey(page, NO_CONFIG_STORE.id, NO_CONFIG_STORE.name);
      await page.getByRole('button', { name: `星${star}` }).click();

      // 星を選んでも、気になったところは畳まれたまま（星の値で出し分けない）。
      await expect(concernToggle(page)).toHaveAttribute('aria-expanded', 'false');

      // 良かったところ: 料理全体の「量」。設定の無い店舗なので Target（料理名）は無い。
      await positive(page).getByRole('button', { name: '料理' }).click();
      const food = positive(page).getByRole('group', { name: '料理' });
      await food.getByRole('checkbox', { name: '量' }).click();

      // 気になったところ: 入口を押して開き、良かったところと同じ部品で選ぶ。
      await concernToggle(page).click();
      await expect(concernToggle(page)).toHaveAttribute('aria-expanded', 'true');
      await concern(page).getByRole('button', { name: 'ドリンク' }).click();
      await concern(page).getByRole('group', { name: 'ドリンク' }).getByRole('checkbox', { name: '種類' }).click();

      const request = page.waitForRequest((r) => r.url().endsWith('/api/responses') && r.method() === 'POST');
      const response = page.waitForResponse((r) => r.url().endsWith('/api/responses'));
      await page.getByRole('button', { name: '口コミ文を作る' }).click();
      const body = (await request).postDataJSON() as Record<string, unknown>;
      // 両側の選択が生成の材料として送られる。
      expect(body).toMatchObject({
        star,
        positiveSelections: [{ categoryCode: 'food', facetCodes: ['volume'] }],
        concernSelections: [{ categoryCode: 'drink', facetCodes: ['variety'] }],
      });
      expect((await response).status()).toBe(200);

      // 下書き（Gemini は mock-gemini.mjs）に、良かったところと気になったところの両方が反映される。
      // mock は回答の行ごとに「〇〇の<項目>が良かったです / 気になりました。」を作る。
      const draft = page.getByLabel('口コミ下書き');
      await expect(draft).toHaveValue(/量が良かったです。/);
      await expect(draft).toHaveValue(/種類が気になりました。/);

      // Google の投稿導線は星の値に関係なく同じ（店舗の Place ID だけから作る）。
      await expect(page.getByRole('link', { name: 'Google のクチコミ欄を開く' })).toHaveAttribute(
        'href',
        'https://search.google.com/local/writereview?placeid=ChIJ_e2e_global_rollout_no_config',
      );

      // コピー（クリップボードは成功する形に差し替える。Google への投稿はしない）。
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } }));
      await page.getByRole('button', { name: '文章をコピー' }).click();
      await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'コピーしました。' })).toBeVisible();

      // 再生成は実際の /api/drafts（Gemini は mock-gemini.mjs）へ届き、成功する。
      const regenerated = page.waitForResponse((r) => r.url().endsWith('/api/drafts'));
      await regenerateButton(page).click();
      expect((await regenerated).status()).toBe(200);
      // 再生成でも、気になったところの回答は落ちない。
      await expect(draft).toHaveValue(/量が良かったです。/);
      await expect(draft).toHaveValue(/種類が気になりました。/);
    });
  }
});
