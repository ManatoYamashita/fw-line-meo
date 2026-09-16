import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';

import { STORE_SURFACE_STATES } from './fixtures/detail';

// 店舗詳細（LIFF 面）の自動 a11y 監査（Issue #53。store-detail-trend-dashboard で、既定の表示だけから
// 4 つの表示状態へ広げた・Issue #265）。
//
// 横スクロール実測（store-surface.spec.ts）と同じ状態の一覧（fixtures/detail.ts の STORE_SURFACE_STATES）を
// 使う。各状態の入口は、面を開き、操作し、操作後の表示（選択状態・見出し・行数・件数の文言）と、詳細の
// 取得がちょうど 1 回だったことを自分で確かめてから返る。面が本体を描けていることの前提 assert も
// そこにある ——「空の画面には違反が出ようがない」ため、a11y 監査こそ前提の固定が要る。
//
// 既定の表示は一覧の先頭の状態である。以前この spec が単独で当てていた監査は、その回に含まれる
// （監査する面も状態も減っていない。増えたのは操作で入る 3 つの状態である）。
//
// 違反 0 件の assert と、「規則が 1 件以上評価された」assert は、どちらも expectNoAxeViolations が
// 状態ごとに行う（@fwlm/e2e-support/a11y）。axe は include が外れる・注入が失敗する経路で例外ではなく
// 空の結果を返すので、その 0 件を合格と読まないための assert である。アプリ側で axe を直に掴むと
// この区別ごと失われるため、入口はヘルパの 1 本に保つ（scripts/check-a11y-audit-preconditions.sh が機械強制する）。
//
// axe の守備範囲と限界（とくにフォーカス指標は自動検出できないこと）は @fwlm/e2e-support/a11y に記す。
// 焦点の輪郭の実測は store-surface.spec.ts が引き続き負う。
//
// 前提: `E2E_STUB_IDP=1` を立ててビルドしたものに対して走らせる（playwright.config.ts の説明）。

// 監査を当てた状態の数の宣言（要件 9.4）。一覧の長さから導かずに数で書く。導くと、状態を 1 つ消したときに
// 宣言も一緒に減り、監査が緑のまま測る範囲が減ったことを見逃す。
const AUDITED_STATE_COUNT = 4;

// 監査の対象に、Issue #265 で足した構造が実際に含まれていることの宣言。
//
// 札（TrendControls）の Field は、ラベルの内側に `role="group"` を描き、その中に radio がある
// （label > group > radio の入れ子）。検索欄（CompetitorSearch）の Field は、名前の無い `role="group"` を
// 描く。どちらも構造契約の操作系の role には入っておらず、部品テストは role では数えない。つまり
// **この入れ子が監査の対象から抜け落ちても、他のどの検査も赤くならない。** そのため状態ごとにここで数える。
//
// 数は、期間 2 つと指標 3 つの札である。一覧から導かずに数で書く理由は上と同じ。
const TREND_CHIP_NESTING_COUNT = 5;
const SEARCH_FIELD_GROUP_COUNT = 1;

/** 札の入れ子（ラベルの中の group、その中の radio）。 */
const CHIP_NESTING_SELECTOR = 'label:has([role="group"] [role="radio"])';

/**
 * 監査した DOM に、期間・指標の札と競合の検索欄の構造が含まれていることを確かめる。
 *
 * 空振り防止である。札や検索欄が描かれない状態へ落ちても、残りの面に違反が無ければ axe は緑を返す。
 * 「違反が無い」と「そもそも監査していない」を、面の側でも分ける。
 */
async function expectAuditedStructures(page: Page, where: string): Promise<void> {
  await expect(
    page.locator(CHIP_NESTING_SELECTOR),
    `${where}: 札の入れ子（label の中の group、その中の radio）が監査の対象に入っていない`,
  ).toHaveCount(TREND_CHIP_NESTING_COUNT);
  await expect(
    page.getByRole('group').filter({ has: page.getByRole('searchbox') }),
    `${where}: 検索欄の group が監査の対象に入っていない`,
  ).toHaveCount(SEARCH_FIELD_GROUP_COUNT);
}

test('4 つの表示状態が WCAG A/AA の自動監査を通る', async ({ page }) => {
  // 4 状態それぞれで、面を開き直し（各状態の入口が goto する）、axe を注入して全規則を回す。
  // playwright.config.ts の既定の制限時間は 1 状態を監査していた頃の値なので、状態の数に見合う値を
  // 明示で与える。実行装置は重く、負荷が高いと axe の page.evaluate が延びることも織り込む
  // （tasks.md の Implementation Notes）。
  test.setTimeout(120_000);

  const visited: string[] = [];
  for (const state of STORE_SURFACE_STATES) {
    // 失敗した状態を報告で見分けられるようにする（expectNoAxeViolations は状態の名前を知らない）。
    await test.step(`表示状態: ${state.name}`, async () => {
      await state.open(page);
      await expectAuditedStructures(page, state.name);
      await expectNoAxeViolations(page);
      visited.push(state.name);
    });
  }
  expect(visited.length, `監査を当てた状態: ${visited.join('、')}`).toBe(AUDITED_STATE_COUNT);
});
