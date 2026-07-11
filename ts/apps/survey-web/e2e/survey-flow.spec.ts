import { test, expect } from '@playwright/test';

// CI が seed した確定店舗の storeId を env で受け取る（既定はプレースホルダ）。
const STORE_ID = process.env.E2E_STORE_ID ?? '44444444-4444-4444-4444-444444444444';
const WRITEREVIEW = /search\.google\.com\/local\/writereview/;

// Issue #3 完了条件の機械化: QR URL → 回答 → 下書き → 編集 → コピー → writereview 遷移リンク。
test('客が回答し下書きをコピーして Google 投稿画面リンクへ到達する', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/s/${STORE_ID}`);

  await page.getByRole('button', { name: '星5' }).click();
  await page.getByRole('button', { name: '送信する' }).click();

  const draft = page.getByLabel('口コミ下書き');
  await expect(draft).toBeVisible();

  await page.getByRole('button', { name: /コピー/ }).click();
  await expect(page.getByText(/コピーしました/)).toBeVisible();

  const link = page.getByRole('link', { name: /クチコミを書く/ });
  await expect(link).toHaveAttribute('href', WRITEREVIEW);
});

// 低評価でも同一の投稿導線（レビューゲーティング不在の証明）。
test('低評価（星1）でも同一の投稿導線が表示される', async ({ page }) => {
  await page.goto(`/s/${STORE_ID}`);
  await page.getByRole('button', { name: '星1' }).click();
  await page.getByRole('button', { name: '送信する' }).click();

  await expect(page.getByLabel('口コミ下書き')).toBeVisible();
  await expect(page.getByRole('link', { name: /クチコミを書く/ })).toHaveAttribute('href', WRITEREVIEW);
});

// 回答完了後の再訪は回答済み画面＋投稿導線（localStorage・24h）。
test('回答済みで再訪すると回答済み画面と投稿導線が出る', async ({ page }) => {
  await page.goto(`/s/${STORE_ID}`);
  await page.getByRole('button', { name: '星4' }).click();
  await page.getByRole('button', { name: '送信する' }).click();
  await expect(page.getByLabel('口コミ下書き')).toBeVisible();

  await page.reload();
  await expect(page.getByText(/ご回答ありがとうございました/)).toBeVisible();
  await expect(page.getByRole('link', { name: /クチコミを書く/ })).toHaveAttribute('href', WRITEREVIEW);
});
