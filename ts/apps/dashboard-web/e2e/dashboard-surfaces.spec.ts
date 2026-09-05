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
// 捲れる領域の宣言件数は面ごとに異なる。帯を描く 5 面は帯の案内リストで 1 件（task 2.1）、
// 店舗一覧・招待コード・代理店管理はさらに表の容器で 1 件（task 2.3 / 2.4）、帯も表も持たない
// ログイン画面は 0 件である。残る利用者管理の表はまだ素の `<table>` で `TableContainer` を
// 通っておらず、`<select>` の計算済み overflow-x は `visible` のため免除対象にならない
// （どちらも実測して確認した。推測ではない）。
// `ui-airbnb-surfaces` の task 2.5 / 3.3 が表を容器へ移した時点でその面の件数は実測と
// 食い違って赤くなり、宣言の更新が強制される。**それが件数宣言の本来の働きである。**
// （task 2.3 と 2.4 では実際にそう起きた: 宣言 1 に対して実測 2 で赤くなり、下の宣言を書き足した。）

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

/**
 * 招待コードを開き、表が描かれるところまで進める。
 *
 * 他の一覧面と違い、operator は代理店を選ぶまで一覧を出さない（Req 5.4）。選択を経由するため
 * `openListSurface` に載らない。ラベルから選択要素を掴んでいるので、ラベルと選択の結び付きが
 * 切れれば（例: id が包む要素へ移れば）ここが赤くなる。
 */
async function openInviteCodes(page: Page): Promise<void> {
  await stubDashboardApi(page);
  await page.goto('/invite-codes');
  await expect(page.getByRole('heading', { level: 1, name: '招待コード' })).toBeVisible();
  await page.getByLabel('代理店').selectOption(AGENCIES[0].id);
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(3);
}

// --- 溢れていない面 --------------------------------------------------------------------

// 帯（components/top-nav.tsx）の案内リストは捲れる領域である（ui-airbnb-surfaces task 2.1）。
// 携帯端末幅にワードマーク・案内 5 件・ロール・ログアウトは収まらず、要件 3.3 がリンクと
// 押しボタンの個数を固定しているためハンバーガーへ畳むこともできない。溢れをリストの内部へ
// 閉じてページ全体を溢れさせない形（要件 2.5 と同型）が唯一の解であり、**意図的な 1 件**である。
//
// 宣言を 1 にしても網は生きている。`expectNoHorizontalScroll` は捲れる領域そのものの右端を
// 端末幅と比べるため、帯が面を押し広げれば依然として赤くなる。免除されるのは領域の**内側**だけである。
// 帯を描かない面（ログイン）は 0 のままであり、その差自体が「帯の有無」を測っている。
const NAV_SCROLL_REGIONS = 1;

// 一覧を `@fwlm/ui` の `TableContainer` へ移した面は、表 1 つにつき捲れる領域が 1 件増える
// （ui-airbnb-surfaces task 2.3）。要件 2.5 が「一覧の内部だけを横にたどれる状態にし、
// ページ全体を横に溢れさせない」と定めており、これは事故ではなく設計どおりの 1 件である。
// 容器は表の外側にあり、内側を免除しても容器自身の右端は依然として端末幅と比べられる。
//
// **面ごとに足す。** 素の `<table>` のまま残っている面（利用者管理）は帯の 1 件だけであり、
// task 2.5 が容器へ移した時点でその面の宣言が赤くなって更新を強制する。
const TABLE_SCROLL_REGIONS = 1;

test('モバイルビューポートの店舗一覧で横スクロールが発生しない', async ({ page }) => {
  await openListSurface(page, '/stores', '店舗一覧', 3);
  // 帯 1 件 + 表 1 件。
  await expectNoHorizontalScroll(page, '店舗一覧', NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS);
});

test('モバイルビューポートの代理店管理で横スクロールが発生しない', async ({ page }) => {
  await openListSurface(page, '/admin/agencies', '代理店管理', 2);
  // 帯 1 件 + 表 1 件（task 2.4 で `TableContainer` へ移った）。
  await expectNoHorizontalScroll(page, '代理店管理', NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS);
});

// 招待コードは task 2.4 まで下の「既知の溢れ」に登録されていた。素の `<select>` を
// `@fwlm/ui` の `Select`（`w-full min-w-0` を持つ）へ移して溢れが解消したため、通常の面へ戻した。
// **移動は自発ではなく強制である。** 是正した状態で走らせると 網 1 が
// 「招待コード: 溢れが解消している（Expected: > 394 / Received: 393）」と赤を出し、
// 宣言の更新を要求した。
test('モバイルビューポートの招待コードで横スクロールが発生しない', async ({ page }) => {
  await openInviteCodes(page);
  // 帯 1 件 + 表 1 件。
  await expectNoHorizontalScroll(page, '招待コード', NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS);
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
// ui-airbnb-surfaces の task 2.5 / 5.2 が指定済みの作業である。本 spec の守備範囲は
// 「測れるようにすること」であり、意匠の適用ではない。
//
// **招待コードは task 2.4 で是正され、ここから外れて上の通常の面へ移った。** 移動は自発では
// なく、網 1 が「溢れが解消している」と赤を出して強制したものである（下の 2 枚の網が
// 設計どおり働いた実例）。残る 2 面は task 2.5 / 5.2 が同じ経路をたどる。
//
// 記録の仕方には 2 枚の網を掛ける。`test.fail()` だけでは**偽緑になる**ためである。
// `test.fail()` は「何らかの理由で落ちたこと」しか要求しないので、差し替えが壊れて面が
// 描画できずに落ちた実行も、溢れが是正されて別の assert が落ちた実行も、等しく緑に見える。
// （task 2.4 でこれが現実に起きた。招待コードの溢れは解消したのに、表の容器が捲れる領域を
// 1 つ増やしたせいで `expectNoHorizontalScroll` は件数の食い違いで落ち続け、網 2 は `✘` の
// まま「想定内の失敗」に見えていた。**赤を出したのは網 1 だけである。**）
//
//   網 1（下の緑のテスト）: 登録された面が管理データを実描画できており、**かつ溢れの主が
//        SELECT であること**を固定する。是正されれば widest が変わってこのテストが赤くなる。
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

// 網 1。**この 1 件が緑であることが、下の test.fail 群を「既知の溢れ」と読んでよい根拠である。**
// 題も失敗メッセージも件数を literal で持たない（宣言を 1 件減らしたときに題だけが古びる）。
test('既知の溢れを持つ面が実描画できており、溢れの主が選択要素である（Issue #186）', async ({ page }) => {
  const observed: string[] = [];

  for (const surface of KNOWN_OVERFLOW_SURFACES) {
    await surface.open(page);
    const deviceWidth = deviceWidthOf(page);
    const metrics = await readOverflowMetrics(page, 'scroll-container');
    observed.push(`${surface.where}: ${metrics.widest} right=${metrics.maxRight}`);

    expect(
      metrics.maxRight,
      `${surface.where}: 溢れが解消している。是正されたなら KNOWN_OVERFLOW_SURFACES から` +
        `この面を外して通常の面へ移し、捲れる領域の宣言件数を実測へ合わせること（Issue #186 の完了条件）`,
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
    // 帯の捲れる領域は意図的な 1 件（上の NAV_SCROLL_REGIONS の説明）。この 3 面も帯を描く。
    await expectNoHorizontalScroll(page, surface.where, NAV_SCROLL_REGIONS);
  });
}
