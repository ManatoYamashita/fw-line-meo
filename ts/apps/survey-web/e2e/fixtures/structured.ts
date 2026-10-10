import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

// structured survey（Issue #438）の E2E の面を開く手順と、店舗の id。
//
// 店舗は e2e/structured-seed.sql が作る（seed.sql の確定店舗とは別の店舗で、structured を有効にしてある）。
// id と店名は **その SQL から読む**。ここへ値を写すと、seed を直したときに片側だけが古び、別の面を開いたまま
// 前提の assert まで通りうる（seed.sql の店舗を 4 箇所で照合しているのと同じ理由）。

const here = dirname(fileURLToPath(import.meta.url));
const SEED = readFileSync(resolve(here, '../structured-seed.sql'), 'utf8');
const STORE_ROW = /INSERT INTO stores[^;]*VALUES \('([0-9a-f-]{36})', '[0-9a-f-]{36}', '([^']+)'/.exec(SEED);
if (!STORE_ROW) throw new Error('e2e/structured-seed.sql から店舗の id と店名を読めません');

export const STRUCTURED_STORE_ID = STORE_ROW[1]!;
export const STRUCTURED_STORE_NAME = STORE_ROW[2]!;

/**
 * structured の回答画面（/s/{storeId}）を開き、legacy の画面や「ご利用いただけません」ではなく structured の画面が
 * 描けていることを固定してから返す（seed の当て忘れ・structured の無効化で別の面を測らないため）。
 */
export async function openStructuredSurvey(page: Page): Promise<void> {
  await page.goto(`/s/${STRUCTURED_STORE_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: STRUCTURED_STORE_NAME })).toBeVisible();
  await expect(page.getByRole('group', { name: '今回の満足度（必須）' })).toBeVisible();
  await expect(page.getByRole('region', { name: '良かったところ（任意）' })).toBeVisible();
  await expect(page.getByRole('region', { name: '気になったところ（任意）' })).toBeVisible();
  // legacy のフォーム（「良かった点」）は出ていない。
  await expect(page.getByRole('group', { name: '良かった点' })).toHaveCount(0);
}
