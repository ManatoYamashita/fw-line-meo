import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll } from '@fwlm/e2e-support/viewport';

import { openStoreSurface } from './fixtures/detail';

// 店舗詳細（LIFF 面）の実描画検証（Issue #53 完了条件 3）。
//
// 要件 3.3（モバイル端末で横スクロールを発生させずに閲覧・操作できる）を、この面で初めて
// 機械検証する。これまで担保は globals.css の `overflow-x: clip` だけ、すなわち
// 「隠しているので見えない」状態だった。clip は scrollWidth 系の検査を構造的に無効化するため、
// 面の溢れを捕らえる網は要素の実測右端（maxRight）1 本しかない。
//
// 面を開く手順（と「本体が描けていること」の前提 assert）は fixtures/detail.ts が持つ。
// 自動 a11y 監査（a11y-audit.spec.ts）も同じ手順を使う。
//
// 前提: `E2E_STUB_IDP=1` を立ててビルドしたものに対して走らせる（playwright.config.ts の説明）。

// 推移表を `@fwlm/ui` の `TableContainer` へ移したので、捲れる領域が 1 件ある
// （ui-airbnb-surfaces task 3.3）。要件 2.5 が「一覧の内部だけを横にたどれる状態にし、
// ページ全体を横に溢れさせない」と定めており、これは事故ではなく設計どおりの 1 件である。
// 容器は表の外側にあり、内側を免除しても容器自身の右端は依然として端末幅と比べられる。
//
// **この 1 は実測である。** task 3.3 の着手前は 0 で緑、推移を容器へ移した直後に
// 「捲れる領域の実測件数 1 が宣言 0 と食い違う（実測: table-container(直近30日の推移)）」で
// 赤くなることを確かめてから、この宣言を更新した。それが件数宣言の本来の働きであり、
// PR #190 がこのファイルへ 0 を書いたときに「task 3.3 の時点で更新が強制される」と
// 予告していた更新そのものである。
//
// この面は帯を持たない（管理ダッシュボードの `NAV_SCROLL_REGIONS` に相当するものが無い）。
// 書込の手段となる要素（フォーム・押しボタン・複数行入力・選択欄）を描画しないため（4.2 の no-write 契約）、
// textarea 由来の領域も無い。Issue #265 で改定した構造契約により、入力は競合の検索欄と、期間・指標の
// 選択肢（隠し radio）の 2 種類に限られる（正典は test/store-page.test.tsx の「構造契約（許可リスト方式）」）。
// これらが捲れる領域を増やしていないことも、この宣言が確かめる（増えれば件数が食い違って赤になる）。
// つまり店舗詳細の捲れる領域は、この表の 1 件が全部である。
const TABLE_SCROLL_REGIONS = 1;

test('モバイルビューポートの店舗詳細で横スクロールが発生しない', async ({ page }) => {
  await openStoreSurface(page);
  await expectNoHorizontalScroll(page, '店舗詳細', TABLE_SCROLL_REGIONS);
});

test('320px 幅でも指標・競合比較・推移要約がクリップされない', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await openStoreSurface(page);
  await expectNoHorizontalScroll(page, '店舗詳細（320px）', TABLE_SCROLL_REGIONS);

  await expect(page.getByText('近隣24店中')).toBeVisible();
  await expect(page.getByText('Google 評価')).toBeVisible();
  await expect(page.getByText('クチコミの前日比')).toBeVisible();
  await expect(page.getByText('近隣の競合店舗としては最も名前の長いケース 丸の内本店')).toBeVisible();
  await expect(page.getByText('表示期間の変化')).toBeVisible();
});

test('主要数値と競合の比較軸を説明リストとして描く', async ({ page }) => {
  await openStoreSurface(page);

  const summary = page
    .getByRole('heading', { level: 2, name: /今日のポジション/ })
    .locator('xpath=ancestor::section[1]');
  await expect(summary.locator('dl')).toHaveCount(2);
  await expect(summary.locator('dt')).toHaveText([
    '近隣24店中',
    'Google 評価',
    'クチコミ',
    '評価の前日比',
    'クチコミの前日比',
  ]);

  const competitors = page
    .getByRole('heading', { level: 2, name: '競合との比較' })
    .locator('xpath=ancestor::section[1]');
  await expect(competitors.locator('li')).toHaveCount(5);
  await expect(competitors.locator('li').first().locator('dt')).toHaveText(['評価', 'クチコミ', '星差']);

  const trend = page
    .getByRole('heading', { level: 2, name: '直近30日の推移' })
    .locator('xpath=ancestor::section[1]');
  await expect(trend.locator('dl dt')).toHaveText(['順位', '評価', 'クチコミ増減']);
  await expect(trend.locator('dl dd')).toHaveText(['3位 → 4位', '4.0 → 4.9', '+203件']);
});

test('今日のポジションは見出しと内容を近接させ、各グループを明確に離す', async ({ page }) => {
  await openStoreSurface(page);

  const summary = page
    .getByRole('heading', { level: 2, name: /今日のポジション/ })
    .locator('xpath=ancestor::section[1]');
  const groups = summary.locator(':scope > div');
  await expect(groups).toHaveCount(3);

  const spacing = await summary.evaluate((section) => {
    const groupElements = Array.from(section.children);
    return {
      outerGap: Number.parseFloat(getComputedStyle(section).rowGap),
      innerGaps: groupElements.map((group) => Number.parseFloat(getComputedStyle(group).rowGap)),
      renderedInnerGaps: groupElements.map((group) => {
        const [heading, content] = Array.from(group.children);
        return content!.getBoundingClientRect().top - heading!.getBoundingClientRect().bottom;
      }),
      renderedOuterGaps: groupElements.slice(1).map((group, index) => {
        return group.getBoundingClientRect().top - groupElements[index]!.getBoundingClientRect().bottom;
      }),
    };
  });

  expect(spacing.outerGap).toBe(24);
  expect(spacing.innerGaps).toEqual([8, 8, 8]);
  expect(spacing.renderedInnerGaps).toEqual([8, 8, 8]);
  expect(spacing.renderedOuterGaps).toEqual([24, 24]);
});
