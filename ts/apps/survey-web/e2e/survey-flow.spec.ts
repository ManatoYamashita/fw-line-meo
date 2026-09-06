import { test, expect } from '@playwright/test';

import { openSurveySurface } from './fixtures/surfaces';

// 面を開く手順（と「本体が描けていること」の前提 assert・storeId の受け取り）は
// fixtures/surfaces.ts が単一の定義を持つ。ここで goto を書き直すと、同じ既定値と同じ前提が
// 2 箇所に生まれ、片方だけが古びる日が来る（Issue #53・PR #191 のレビューで実際に踏んだ形）。

const WRITEREVIEW = /search\.google\.com\/local\/writereview/;

// Issue #3 完了条件の機械化: QR URL → 回答 → 下書き → 編集 → コピー → writereview 遷移リンク。
test('客が回答し下書きをコピーして Google 投稿画面リンクへ到達する', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openSurveySurface(page);

  await page.getByRole('button', { name: '星5' }).click();
  await page.getByRole('button', { name: '送信する' }).click();

  const draft = page.getByLabel('口コミ下書き');
  await expect(draft).toBeVisible();

  // 下書きの由来と推敲の促しが**実ブラウザで見えている**こと（Issue #179）。
  //
  // unit は DOM の構造（読み上げ領域の外・aria-describedby）を固定するが、「画面に出ているか」は
  // 別の軸である。実測: 説明へ `display:none` を与えると unit は 29/29 緑のまま、この行だけが赤くなる。
  //
  // **ここが見るのは寸法と可視性であって色ではない。** `toBeVisible` は要素の外接矩形と
  // 可視状態しか見ないため、`--muted-foreground` を面の背景色へ向け直すような改変は通す。
  // 色の劣化を受け持つのは a11y-audit の下書き画面の監査（axe の color-contrast）である。
  // 本 PR より前、その監査は**回答フェーズしか開いていなかった**ため、この面は色を含めて
  // どこからも測られていなかった（PR #218 のレビュー指摘）。
  await expect(page.getByText(/あなたの回答をもとに作成した下書きです。/)).toBeVisible();
  await expect(page.getByText(/ご自身の言葉に直してから投稿してください。/)).toBeVisible();

  await page.getByRole('button', { name: /コピー/ }).click();
  await expect(page.getByText(/コピーしました/)).toBeVisible();

  const link = page.getByRole('link', { name: /クチコミを書く/ });
  await expect(link).toHaveAttribute('href', WRITEREVIEW);
});

// 低評価でも同一の投稿導線（レビューゲーティング不在の証明）。
test('低評価（星1）でも同一の投稿導線が表示される', async ({ page }) => {
  await openSurveySurface(page);
  await page.getByRole('button', { name: '星1' }).click();
  await page.getByRole('button', { name: '送信する' }).click();

  await expect(page.getByLabel('口コミ下書き')).toBeVisible();
  await expect(page.getByRole('link', { name: /クチコミを書く/ })).toHaveAttribute('href', WRITEREVIEW);
});

// 回答完了後の再訪は回答済み画面＋投稿導線（localStorage・24h）。
test('回答済みで再訪すると回答済み画面と投稿導線が出る', async ({ page }) => {
  await openSurveySurface(page);
  await page.getByRole('button', { name: '星4' }).click();
  await page.getByRole('button', { name: '送信する' }).click();
  await expect(page.getByLabel('口コミ下書き')).toBeVisible();

  await page.reload();
  await expect(page.getByText(/ご回答ありがとうございました/)).toBeVisible();
  await expect(page.getByRole('link', { name: /クチコミを書く/ })).toHaveAttribute('href', WRITEREVIEW);
});
