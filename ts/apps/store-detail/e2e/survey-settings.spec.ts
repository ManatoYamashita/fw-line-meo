import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';
import { expectNoHorizontalScroll } from '@fwlm/e2e-support/viewport';

import { LONGEST_LABEL, openSurveySettingsSurface } from './fixtures/survey-settings';

// アンケート設定画面（Issue #437）の実描画検証。
//
// 完了条件「mobile LIFF 幅で追加・編集・並び替えが操作できる」を、携帯の幅（Pixel 5 相当・projects の既定）と
// 320px で確かめる。面を開く手順と、本体が描けていることの前提 assert は fixtures/survey-settings.ts が持つ。
// API はメモリ上の設定を書き換える偽物で供給する（判定の本物はサーバーの DB テストが確かめる）。
//
// 前提: `E2E_STUB_IDP=1` を立ててビルドしたものに対して走らせる（playwright.config.ts の説明）。

// この面は横へ捲れる領域を持たない（表を描かない）。増えたら宣言との食い違いで赤くなる。
const SCROLL_REGIONS = 0;

test.describe('アンケート設定（LIFF 面）', () => {
  test('携帯の幅と 320px で、40 文字の名前を含めて横スクロールしない', async ({ page }) => {
    await openSurveySettingsSurface(page);
    await expectNoHorizontalScroll(page, 'アンケート設定（既定の幅）', SCROLL_REGIONS);
    // 名前の変更の欄を開いた状態も測る（入力欄と押しボタンが横へ並ぶ）。
    await page.getByRole('button', { name: `「${LONGEST_LABEL}」の名前を変更する` }).click();
    await expect(page.getByLabel('料理名を変更')).toBeVisible();
    await expectNoHorizontalScroll(page, 'アンケート設定（名前の変更中）', SCROLL_REGIONS);
    await page.setViewportSize({ width: 320, height: 720 });
    await expectNoHorizontalScroll(page, 'アンケート設定（320px・名前の変更中）', SCROLL_REGIONS);
  });

  test('携帯の幅で、料理名の追加・並び替え・名前の変更・非表示・再表示ができる', async ({ page }) => {
    const api = await openSurveySettingsSurface(page);
    const food = page.getByRole('region', { name: '料理' });

    await food.getByLabel('料理名を追加').fill('海鮮丼');
    await food.getByRole('button', { name: '追加する' }).click();
    await expect(page.getByRole('status').filter({ hasText: '「海鮮丼」を追加しました。' })).toBeVisible();
    await expect(food.getByText('表示中 3 / 10 件')).toBeVisible();

    await food.getByRole('button', { name: '「海鮮丼」を上へ移動する' }).click();
    await expect(page.getByRole('status').filter({ hasText: '並び順を保存しました。' })).toBeVisible();
    expect(api.activeLabels('food')).toEqual([LONGEST_LABEL, '海鮮丼', '焼き鳥5種盛り']);

    await food.getByRole('button', { name: '「海鮮丼」の名前を変更する' }).click();
    await food.getByLabel('料理名を変更').fill('特製海鮮丼');
    await food.getByRole('button', { name: '保存する' }).click();
    await expect(page.getByRole('status').filter({ hasText: '名前を変更しました。' })).toBeVisible();

    await food.getByRole('button', { name: '「特製海鮮丼」を非表示にする' }).click();
    await expect(food.getByRole('button', { name: '「特製海鮮丼」を再表示する' })).toBeVisible();
    await food.getByRole('button', { name: '「名物もつ煮」を再表示する' }).click();
    await expect(page.getByRole('status').filter({ hasText: '「名物もつ煮」を再表示しました。' })).toBeVisible();
    expect(api.activeLabels('food')).toEqual([LONGEST_LABEL, '焼き鳥5種盛り', '名物もつ煮']);

    // 予約・来店の表示を切り替える。
    const visit = page.getByRole('region', { name: '予約・来店' });
    await visit.getByRole('radio', { name: '表示しない' }).click();
    await expect(page.getByRole('status').filter({ hasText: '予約・来店をアンケートに表示しません。' })).toBeVisible();

    expect(api.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/survey-settings',
      'POST /api/survey-settings/targets',
      'PUT /api/survey-settings/targets/order',
      expect.stringMatching(/^PATCH \/api\/survey-settings\/targets\/[0-9a-f-]+$/),
      expect.stringMatching(/^POST \/api\/survey-settings\/targets\/[0-9a-f-]+\/disable$/),
      expect.stringMatching(/^PATCH \/api\/survey-settings\/targets\/[0-9a-f-]+$/),
      'PATCH /api/survey-settings/categories/reservation_visit',
    ]);
  });

  test('空欄と 41 文字は送らずに、その場で直し方を出す', async ({ page }) => {
    const api = await openSurveySettingsSurface(page);
    const drink = page.getByRole('region', { name: 'ドリンク' });
    await drink.getByRole('button', { name: '追加する' }).click();
    await expect(drink.getByText('名前を入力してください。')).toBeVisible();
    await drink.getByLabel('ドリンク名を追加').fill(`${LONGEST_LABEL}あ`);
    await drink.getByRole('button', { name: '追加する' }).click();
    await expect(drink.getByText('名前は40文字以内で入力してください。')).toBeVisible();
    expect(api.requests).toHaveLength(1);
  });

  test('自動 a11y 監査（既定の表示と、名前の変更中）', async ({ page }) => {
    await openSurveySettingsSurface(page);
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: '「焼き鳥5種盛り」の名前を変更する' }).click();
    await expect(page.getByLabel('料理名を変更')).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
