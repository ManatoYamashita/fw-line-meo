// 管理ダッシュボード E2E の固定データ（Issue #53）。
//
// dashboard-api も DB も起こさず page.route() で供給する。実データに寄せるのではなく、
// **面を最も横へ広げる値**を意図的に置いている。横スクロールの検証は「最悪ケースで溢れない
// こと」を測るものであり、短い名前のシードでたまたま緑になっても何も担保しない。
//
// ロールは operator を使う。agency には見えない「担当代理店」列が加わり、店舗一覧が
// 最も列数の多い状態になるためである（BASE_COLUMN_COUNT + 1）。

import { expect, type Page } from '@playwright/test';

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

// --- 面を開く手順 ----------------------------------------------------------------------
//
// 横スクロール実測（dashboard-surfaces.spec.ts）と自動 a11y 監査（a11y-audit.spec.ts）の
// 双方が同じ定義を使う。複写にしないのは、前提 assert が片方だけ古びても誰も検出できない
// ためで、これは @fwlm/e2e-support を切り出したのと同じ理由による（Issue #53）。

/** 未ログイン状態で開く（既定はログイン済み）。ログイン画面そのものを測るために使う。 */
export async function startSignedOut(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('e2e-auth-signed-out', '1');
    } catch {
      // 保存領域が使えない文脈（about:blank 等）では何もしない。
    }
  });
}

/**
 * 一覧面を開き、**表が実際に描かれている**ことを先に固定する。
 *
 * これが無いと、認証の差し替えが効かず「読み込み中...」だけの画面になったときに、後続の
 * assert は当然のように緑を返す。測る対象が消えたことを緑と読まないための前置きである。
 * a11y 監査にとっても同じで、空の画面には違反が出ようがない。
 */
export async function openListSurface(
  page: Page,
  path: string,
  heading: string,
  expectedRows: number,
): Promise<void> {
  await stubDashboardApi(page);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(expectedRows);
}

export interface DashboardSurface {
  readonly where: string;
  /** 表や主要部品が現れるまでの操作と、本体が描けていることの前提 assert。 */
  readonly open: (page: Page) => Promise<void>;
  /**
   * 素の `<select>` 由来の既知の溢れを持つ面か（Issue #186）。
   * 横スクロールの spec はこの印で `test.fail` 側と通常側を振り分ける。
   */
  readonly knownOverflow: boolean;
}

/**
 * 管理ダッシュボードの検証対象 6 面。**面を足したらここへ足す**（両 spec が自動で拾う）。
 */
export const DASHBOARD_SURFACES: readonly DashboardSurface[] = [
  {
    where: '店舗一覧',
    knownOverflow: false,
    open: async (page) => {
      await openListSurface(page, '/stores', '店舗一覧', 3);
    },
  },
  {
    where: '代理店管理',
    knownOverflow: false,
    open: async (page) => {
      await openListSurface(page, '/admin/agencies', '代理店管理', 2);
    },
  },
  {
    where: 'ログイン',
    knownOverflow: false,
    open: async (page) => {
      await startSignedOut(page);
      await stubDashboardApi(page);
      await page.goto('/login');
      await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeEnabled();
    },
  },
  {
    where: '招待コード',
    knownOverflow: true,
    open: async (page) => {
      await stubDashboardApi(page);
      await page.goto('/invite-codes');
      await expect(page.getByRole('heading', { level: 1, name: '招待コード' })).toBeVisible();
      // operator は代理店を選ぶまで一覧を出さない（Req 5.4）。選択して初めて表が現れる。
      await page.getByLabel('代理店').selectOption(AGENCIES[0].id);
      await expect(page.getByRole('table')).toBeVisible();
      await expect(page.getByRole('row')).toHaveCount(3);
    },
  },
  {
    where: '利用者管理',
    knownOverflow: true,
    open: async (page) => {
      await openListSurface(page, '/admin/users', '利用者管理', 3);
    },
  },
  {
    where: '店舗登録',
    knownOverflow: true,
    open: async (page) => {
      await stubDashboardApi(page);
      await page.goto('/stores/new');
      await expect(page.getByRole('heading', { level: 1, name: '店舗登録' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'オーナー選択' })).toBeVisible();
      await expect(page.getByRole('combobox').first()).toBeVisible();
    },
  },
];
