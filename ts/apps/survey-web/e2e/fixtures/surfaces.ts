import { expect, type Page } from '@playwright/test';

// 客向けアプリの検証面を開く手順（Issue #53）。
//
// 開く手順と「本体が描けていること」の前提 assert を 1 箇所へ置く。a11y 監査にとってこれは
// 体裁ではなく成立条件である —— 空の画面・エラー画面には違反が出ようがないため、前提を
// 置かない監査は、面が壊れたときにこそ最も静かに緑を返す。
//
// 実測（本リポジトリの @axe-core/playwright 4.13.0 + chromium）: `/s/{storeId}` の unavailable
// 分岐が返す 1 段落だけの DOM へ axe を当てると violations 0 / passes 5（aria-hidden-body・
// color-contrast・document-title・html-has-lang・html-lang-valid）となり、
// expectNoAxeViolations の「規則が 1 件も走っていない」検出（passes + incomplete + violations
// > 0）まで満たしてしまう。**回答画面を一度も監査せずに緑になる。** それを止めるのが
// ここの前提 assert である（PR #191 のレビュー指摘 1）。

/** CI が seed した確定店舗の storeId を env で受け取る（既定はプレースホルダ）。 */
export const STORE_ID = process.env.E2E_STORE_ID ?? '44444444-4444-4444-4444-444444444444';

/**
 * 部品カタログ面（/ui-check）を開く。
 *
 * 主見出しだけでなく操作領域の節見出しまで確かめる。PageHeader は部品の描画が落ちても
 * 描けてしまうため、h1 の可視だけでは「部品が 1 つも無い面」を監査対象として通してしまう。
 */
export async function openComponentCatalog(page: Page): Promise<void> {
  await page.goto('/ui-check');
  await expect(page.getByRole('heading', { level: 1, name: 'UI 基盤の検証面' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: '操作領域の検証' })).toBeVisible();
}

/**
 * 客向け回答画面（/s/{storeId}）を開く。
 *
 * 店舗が無い・place_status が confirmed でない・place_id が null のとき、この面は h1 を持たない
 * 1 段落（「このアンケートは現在ご利用いただけません。」）へ落ちる（page-data.ts の unavailable
 * 分岐）。h1 と星ボタンの双方を要求し、その分岐を監査対象と取り違えないようにする。
 */
export async function openSurveySurface(page: Page): Promise<void> {
  await page.goto(`/s/${STORE_ID}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: '星5' })).toBeVisible();
}
