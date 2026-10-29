import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

// 全店公開（SURVEY_FORCE_STRUCTURED=1・Issue #441）の E2E の店舗。
//
// 店舗は e2e/global-rollout-seed.sql が作る。id と店名は **その SQL から読む**（structured.ts と同じ理由。
// 値を写すと、seed を直したときに片側だけが古び、別の面を開いたまま前提の assert まで通りうる）。

const here = dirname(fileURLToPath(import.meta.url));
const SEED = readFileSync(resolve(here, '../global-rollout-seed.sql'), 'utf8');
const STORE_ROWS = [...SEED.matchAll(/INSERT INTO stores[^;]*VALUES \('([0-9a-f-]{36})', '[0-9a-f-]{36}', '([^']+)'/g)];
if (STORE_ROWS.length !== 2) throw new Error('e2e/global-rollout-seed.sql から店舗 2 件の id と店名を読めません');

/** 設定行の無い店舗（既存店舗・新規店舗の大半と同じ状態）。 */
export const NO_CONFIG_STORE = { id: STORE_ROWS[0]![1]!, name: STORE_ROWS[0]![2]! };
/** structured を個別に OFF にした店舗（料理名「日替わり定食」を登録済み）。 */
export const DISABLED_STORE = { id: STORE_ROWS[1]![1]!, name: STORE_ROWS[1]![2]! };

/**
 * 全店公開のサーバーで回答画面（/s/{storeId}）を開き、legacy ではなく structured の画面が描けていることと、
 * 折り畳みの初期状態（良かったところは開き、気になったところは入口だけ）を固定してから返す。
 * 店名を渡したときは見出しも確かめる（seed の当て忘れで別の店舗の面を測らないため）。
 */
export async function openForcedSurvey(page: Page, storeId: string, storeName?: string): Promise<void> {
  await page.goto(`/s/${storeId}`);
  if (storeName !== undefined) {
    await expect(page.getByRole('heading', { level: 1, name: storeName })).toBeVisible();
  }
  await expect(page.getByRole('group', { name: '今回の満足度（必須）' })).toBeVisible();
  const concernToggle = page.getByRole('button', { name: /^気になったところ（任意）/ });
  // 良かったところは最初から開いている。
  await expect(page.getByRole('region', { name: '良かったところを教えてください' }).getByRole('button', { name: '料理' })).toBeVisible();
  // 気になったところは入口だけが見え、畳まれている。
  await expect(concernToggle).toBeVisible();
  await expect(concernToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('region', { name: '気になったところ（任意）' }).getByRole('button', { name: '料理' })).toHaveCount(0);
  // legacy のフォーム（「良かった点」）は出ていない。
  await expect(page.getByRole('group', { name: '良かった点' })).toHaveCount(0);
}
