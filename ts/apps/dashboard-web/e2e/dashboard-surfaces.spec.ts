import { test, expect, type Page } from '@playwright/test';
import { deviceWidthOf, expectNoHorizontalScroll, readOverflowMetrics } from '@fwlm/e2e-support/viewport';

import { AGENCIES, stubDashboardApi } from './fixtures/api';

// 管理ダッシュボードの実描画検証（Issue #53）。
//
// 要件 3.3（モバイル端末で横スクロールを発生させずに閲覧・操作できる）を、この面で初めて
// 機械検証する。これまで担保は globals.css の `overflow-x: clip` だけ、すなわち
// 「隠しているので見えない」状態だった。clip は scrollWidth 系の検査を構造的に無効化するため、
// 面の溢れを捕らえる網は要素の実測右端（maxRight）1 本しかない。
//
// 前提: `E2E_STUB_IDP=1` と `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3199` を与えて
// ビルドしたものに対して走らせる（playwright.config.ts の説明）。
//
// 捲れる領域の宣言件数は 6 面すべて 0 である。実面の表はまだ素の `<table>` で `TableContainer`
// を通っておらず、`<select>` の計算済み overflow-x は `visible` のため免除対象にならない
// （どちらも実測して 0 と確認した。推測ではない）。`ui-airbnb-surfaces` の task 2.3 / 3.3 が
// 表を容器へ移した時点でこの 0 は実測と食い違って赤くなり、宣言の更新が強制される。
// **それが件数宣言の本来の働きである。**

/** 未ログイン状態で開く（既定はログイン済み）。ログイン画面そのものを測るために使う。 */
async function startSignedOut(page: Page): Promise<void> {
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
 * これが無いと、認証の差し替えが効かず「読み込み中...」だけの画面になったときに、
 * 横スクロールの assert は当然のように緑を返す。測る対象が消えたことを緑と読まないための前置き。
 */
async function openListSurface(
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

// --- 溢れていない面 --------------------------------------------------------------------

test('モバイルビューポートの店舗一覧で横スクロールが発生しない', async ({ page }) => {
  await openListSurface(page, '/stores', '店舗一覧', 3);
  await expectNoHorizontalScroll(page, '店舗一覧', 0);
});

test('モバイルビューポートの代理店管理で横スクロールが発生しない', async ({ page }) => {
  await openListSurface(page, '/admin/agencies', '代理店管理', 2);
  await expectNoHorizontalScroll(page, '代理店管理', 0);
});

test('モバイルビューポートのログイン画面で横スクロールが発生しない', async ({ page }) => {
  await startSignedOut(page);
  await stubDashboardApi(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Google でログイン' })).toBeEnabled();
  await expectNoHorizontalScroll(page, 'ログイン', 0);
});

// --- 既知の溢れ（Issue #186）------------------------------------------------------------
//
// 素の `<select>` が幅の制約を持たず、最長の選択肢の幅まで伸びる（実測 472px > 393px）。
// 正しい是正は @fwlm/ui の `Select`（`w-full min-w-0` を持つ）へ移すことで、それは
// ui-airbnb-surfaces の task 2.4 / 2.5 / 5.2 が指定済みの作業である。本 spec の守備範囲は
// 「測れるようにすること」であり、意匠の適用ではない。
//
// 記録の仕方には 2 枚の網を掛ける。`test.fail()` だけでは**偽緑になる**ためである。
// `test.fail()` は「何らかの理由で落ちたこと」しか要求しないので、差し替えが壊れて面が
// 描画できずに落ちた実行も、溢れが是正されて別の assert が落ちた実行も、等しく緑に見える。
//
//   網 1（下の緑のテスト）: 3 面が管理データを実描画できており、**かつ溢れの主が SELECT で
//        あること**を固定する。是正されれば widest が変わってこのテストが赤くなる。
//   網 2（test.fail のテスト）: 本番の判定 `expectNoHorizontalScroll` をそのまま当てる。
//        是正されれば「期待に反して通った」として赤くなり、宣言の削除が強制される。

interface KnownOverflowSurface {
  readonly where: string;
  readonly path: string;
  readonly heading: string;
  /** 表が現れるまでに必要な操作（無い面もある）。 */
  readonly open: (page: Page) => Promise<void>;
}

const KNOWN_OVERFLOW_SURFACES: readonly KnownOverflowSurface[] = [
  {
    where: '招待コード',
    path: '/invite-codes',
    heading: '招待コード',
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
    path: '/admin/users',
    heading: '利用者管理',
    open: async (page) => {
      await openListSurface(page, '/admin/users', '利用者管理', 3);
    },
  },
  {
    where: '店舗登録',
    path: '/stores/new',
    heading: '店舗登録',
    open: async (page) => {
      await stubDashboardApi(page);
      await page.goto('/stores/new');
      await expect(page.getByRole('heading', { level: 1, name: '店舗登録' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'オーナー選択' })).toBeVisible();
      await expect(page.getByRole('combobox').first()).toBeVisible();
    },
  },
];

// 網 1。**この 1 件が緑であることが、下の test.fail 3 件を「既知の溢れ」と読んでよい根拠である。**
test('既知の溢れを持つ 3 面が実描画できており、溢れの主が選択要素である（Issue #186）', async ({ page }) => {
  const observed: string[] = [];

  for (const surface of KNOWN_OVERFLOW_SURFACES) {
    await surface.open(page);
    const deviceWidth = deviceWidthOf(page);
    const metrics = await readOverflowMetrics(page, 'scroll-container');
    observed.push(`${surface.where}: ${metrics.widest} right=${metrics.maxRight}`);

    expect(
      metrics.maxRight,
      `${surface.where}: 溢れが解消している。是正されたなら test.fail の宣言 3 件を外し、` +
        `宣言件数を実測へ合わせること（Issue #186 の完了条件）`,
    ).toBeGreaterThan(deviceWidth + 1);
    expect(
      metrics.widest,
      `${surface.where}: 溢れの主が選択要素でなくなった（実測 ${metrics.widest}）。` +
        `別の原因の溢れを「既知の溢れ」として見逃さないための固定である`,
    ).toMatch(/^SELECT\[/);
  }

  // 走査対象が 1 件も無い状態で緑にならないようにする。
  expect(observed.length, `実測: ${observed.join(' / ')}`).toBe(KNOWN_OVERFLOW_SURFACES.length);
});

// 網 2。本番の判定をそのまま当てる。是正されれば「期待に反して通った」として赤くなる。
for (const surface of KNOWN_OVERFLOW_SURFACES) {
  test(`モバイルビューポートの${surface.where}で横スクロールが発生しない`, async ({ page }) => {
    test.fail(
      true,
      `素の <select> が幅の制約を持たず端末幅を超える（Issue #186）。` +
        `@fwlm/ui の Select へ移せば解消する。解消したらこの宣言を外すこと`,
    );
    await surface.open(page);
    await expectNoHorizontalScroll(page, surface.where, 0);
  });
}
