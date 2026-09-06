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
// 記入欄・押しボタン・選択も描画しないため（4.2 の no-write 契約）、textarea 由来の領域も無い。
// つまり店舗詳細の捲れる領域は、この表の 1 件が全部である。
const TABLE_SCROLL_REGIONS = 1;

test('モバイルビューポートの店舗詳細で横スクロールが発生しない', async ({ page }) => {
  await openStoreSurface(page);
  await expectNoHorizontalScroll(page, '店舗詳細', TABLE_SCROLL_REGIONS);
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
