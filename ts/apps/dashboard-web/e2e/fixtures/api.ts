// 管理ダッシュボード E2E の固定データ（Issue #53）。
//
// dashboard-api も DB も起こさず page.route() で供給する。実データに寄せるのではなく、
// **面を最も横へ広げる値**を意図的に置いている。横スクロールの検証は「最悪ケースで溢れない
// こと」を測るものであり、短い名前のシードでたまたま緑になっても何も担保しない。
//
// ロールは operator を使う。agency には見えない「担当代理店」列が加わり、店舗一覧が
// 最も列数の多い状態になるためである（BASE_COLUMN_COUNT + 1）。

import type { Page } from '@playwright/test';

/**
 * API のベースオリジン。**面自身（127.0.0.1:3110）と必ず別にする。**
 *
 * 同一オリジンにすると `**\/stores` のような横取り規則が `/stores` への文書要求まで掴み、
 * ページ遷移そのものが壊れる。ビルド時の NEXT_PUBLIC_API_BASE_URL と同値でなければ
 * 取得が失敗し、各テストの前提 assert が落ちる（fail-closed）。
 */
export const API_ORIGIN = 'http://127.0.0.1:3199';

/** 実在しうる長さの上限側を置く。列幅を決めるのはここである。 */
const LONG_STORE_NAME = 'スターバックス コーヒー リザーブ ロースタリー 東京 中目黒店';
const LONG_AGENCY_NAME = '株式会社ロングネームマーケティングパートナーズ 首都圏支社';

export const ME = {
  id: '00000000-0000-0000-0000-0000000000aa',
  role: 'operator',
  agencyId: null,
  agencyName: null,
  displayName: '運営ユーザー',
} as const;

export const STORES = [
  {
    id: '44444444-4444-4444-4444-444444444444',
    name: LONG_STORE_NAME,
    placeStatus: 'confirmed',
    competitorConfigured: true,
    ownerId: '33333333-3333-3333-3333-333333333333',
    ownerDisplayName: 'オーナー太郎',
    agencyId: '22222222-2222-2222-2222-222222222222',
    agencyName: LONG_AGENCY_NAME,
    createdAt: '2026-08-01T09:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-4444-444444444445',
    name: '喫茶 短名',
    placeStatus: 'pending',
    competitorConfigured: false,
    ownerId: '33333333-3333-3333-3333-333333333334',
    ownerDisplayName: null,
    agencyId: '22222222-2222-2222-2222-222222222222',
    agencyName: LONG_AGENCY_NAME,
    createdAt: '2026-08-02T09:00:00.000Z',
  },
] as const;

export const AGENCIES = [
  {
    id: '22222222-2222-2222-2222-222222222222',
    operatorId: '11111111-1111-1111-1111-111111111111',
    name: LONG_AGENCY_NAME,
    createdAt: '2026-07-15T09:00:00.000Z',
  },
] as const;

export const DASHBOARD_USERS = [
  {
    id: ME.id,
    role: 'operator',
    operatorId: '11111111-1111-1111-1111-111111111111',
    agencyId: null,
    email: 'operator-with-a-long-address@example.co.jp',
    displayName: '運営ユーザー',
    disabled: false,
    createdAt: '2026-07-01T09:00:00.000Z',
  },
  {
    id: '00000000-0000-0000-0000-0000000000bb',
    role: 'agency',
    operatorId: '11111111-1111-1111-1111-111111111111',
    agencyId: '22222222-2222-2222-2222-222222222222',
    email: 'agency-member-with-a-long-address@example.co.jp',
    displayName: '代理店ユーザー',
    disabled: true,
    createdAt: '2026-07-20T09:00:00.000Z',
  },
] as const;

export const INVITE_CODES = [
  {
    id: '55555555-5555-5555-5555-555555555551',
    agencyId: '22222222-2222-2222-2222-222222222222',
    code: 'ABCD-EFGH-IJKL',
    disabled: false,
    createdAt: '2026-08-10T09:00:00.000Z',
  },
  {
    id: '55555555-5555-5555-5555-555555555552',
    agencyId: '22222222-2222-2222-2222-222222222222',
    code: 'MNOP-QRST-UVWX',
    disabled: true,
    createdAt: '2026-08-11T09:00:00.000Z',
  },
] as const;

export const OWNERS = [
  {
    id: '33333333-3333-3333-3333-333333333333',
    displayName: 'オーナー太郎',
    onboardingStatus: 'store_identified',
    createdAt: '2026-08-01T09:00:00.000Z',
  },
] as const;

export const CATEGORIES = [
  { code: 'cafe', label: 'カフェ・喫茶店' },
  { code: 'ramen', label: 'ラーメン' },
] as const;

/** パス（クエリを除く）ごとの 200 応答。ここに無いパスは 404 で返し、黙って素通りさせない。 */
const RESPONSES: Record<string, unknown> = {
  '/me': { user: ME },
  '/stores': { stores: STORES },
  '/owners': { owners: OWNERS },
  '/agencies': { agencies: AGENCIES },
  '/dashboard-users': { users: DASHBOARD_USERS },
  '/invite-codes': { inviteCodes: INVITE_CODES },
  '/categories': { categories: CATEGORIES },
};

/**
 * dashboard-api への呼び出しを固定 fixture で置き換える。
 *
 * 未知のパスは 404 のエラー封筒で返す。素通りさせると実在しないサーバーへ出て行って
 * ネットワークエラーになり、原因が「fixture の取りこぼし」だと読み取れなくなる。
 */
export async function stubDashboardApi(page: Page): Promise<void> {
  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = RESPONSES[path];
    if (body === undefined) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'e2e_fixture_missing', message: `fixture 未定義のパス: ${path}` },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}
