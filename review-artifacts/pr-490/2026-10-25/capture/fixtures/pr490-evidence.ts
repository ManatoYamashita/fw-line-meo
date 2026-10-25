import { expect, type Page } from '@playwright/test';
import { AGENCY_ME, OWNERS, stubDashboardApi } from './api';

export async function openAgencyRegistration(page: Page): Promise<void> {
  await stubDashboardApi(page, { me: AGENCY_ME });
  await page.goto('/stores/new');
  await expect(page.getByRole('heading', { level: 2, name: 'オーナー選択' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(OWNERS.length + 1);
}
