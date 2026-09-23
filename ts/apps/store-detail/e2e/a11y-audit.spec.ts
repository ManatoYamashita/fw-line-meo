import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';

import { STORE_SURFACE_STATES, type StoreSurfaceState } from './fixtures/detail';

// 店舗詳細（LIFF 面）の自動 a11y 監査（Issue #53。store-detail-trend-dashboard で、既定の表示だけから
// 4 つの表示状態へ広げ・Issue #265、応答で入る 4 状態を足して 8 状態に・Issue #286 項目 6、
// 期間注記の実表示 3 種を含む 11 状態にした・Issue #286）。
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
const AUDITED_STATE_COUNT = 11;

// 状態ごとの構造の件数を回った先で積み上げ、その総和をここで宣言する（Issue #286）。
//
// **per-state の件数だけでは足りない。** 状態ごとの期待値は fixtures/detail.ts の `structure` にあるので、
// 赤を消すために「その状態の宣言を実測へ合わせる」という改変（札を製品ごと消し、併せて全状態の宣言も
// 0 にする、など）は per-state の照合を素通りする。ここへ総和を数で書くことが、その改変を赤にする
// 唯一の網である。一覧から導かずに数で書く理由は、AUDITED_STATE_COUNT と同じである。
//
// 内訳: 札は「推移 0 件」を除く 10 状態で 5 件ずつ。検索欄は「競合 1 店」「競合 0 店」を除く 9 状態で 1 件ずつ。
const AUDITED_CHIP_NESTING_TOTAL = 50;
const AUDITED_SEARCH_FIELD_TOTAL = 9;

// 監査の対象に、Issue #265 で足した構造が実際に含まれていることの宣言。
//
// 札（TrendControls）の Field は、ラベルの内側に並べの箱を描き、その中に radio がある
// （label > 箱 > radio の入れ子）。検索欄（CompetitorSearch）の Field も同じ箱である。どちらも構造契約の
// 操作系の role には入っておらず、部品テストは role では数えない。つまり **この入れ子が監査の対象から
// 抜け落ちても、他のどの検査も赤くならない。** そのため状態ごとにここで数える。
//
// 箱は 2026-09-18 の画面レビューまで `role="group"` を名乗っていた。名前を持たない group を 6 つ、
// radiogroup の内側と検索欄の周りへ増やすだけだったので `role="presentation"` で打ち消してある。
// したがって数える手掛かりは役割ではなく `data-slot` であり、**役割で数えると 0 件になる**。
//
// 期待する件数そのものは状態ごとに違う（推移を描けない状態には札が無く、競合が 2 店に満たない状態には
// 検索欄が無い）。値は fixtures/detail.ts の `structure` が持つ（Issue #286）。

/** 札の入れ子（ラベルの中の並べの箱、その中の radio）。 */
const CHIP_NESTING_SELECTOR = 'label:has([data-slot="field"] [role="radio"])';

/** 状態ごとに照合が通った構造の件数。呼び出し側が総和として積み上げる。 */
interface AuditedStructureCounts {
  readonly chipNesting: number;
  readonly searchField: number;
}

/**
 * 監査した DOM に、期間・指標の札と競合の検索欄の構造が、その状態の宣言どおりに含まれていることを確かめる。
 *
 * 空振り防止である。札や検索欄が描かれない状態へ落ちても、残りの面に違反が無ければ axe は緑を返す。
 * 「違反が無い」と「そもそも監査していない」を、面の側でも分ける。
 *
 * **0 件の宣言も無条件に照合する**（Issue #286）。「件数が 0 より大きいときだけ確かめる」形にすると、
 * 0 件を宣言した状態が強制の外へ出て、そこへ無条件に札や検索欄を描く改変が素通りする。
 * 0 件の側と 1 件以上の側の両方を状態として実在させたうえで、どちらも毎回測る。
 */
async function expectAuditedStructures(page: Page, state: StoreSurfaceState): Promise<AuditedStructureCounts> {
  const { chipNesting, searchField } = state.structure;
  await expect(
    page.locator(CHIP_NESTING_SELECTOR),
    `${state.name}: 札の入れ子（label の中の並べの箱、その中の radio）の件数が宣言と食い違う`,
  ).toHaveCount(chipNesting);
  await expect(
    page.locator('[data-slot="field"]').filter({ has: page.getByRole('searchbox') }),
    `${state.name}: 検索欄の並べの箱の件数が宣言と食い違う`,
  ).toHaveCount(searchField);
  // 名前を持たない group を面へ戻す改変を止める（2026-09-18 の画面レビュー）。axe は名前の無い group を
  // 違反にしないので、この面では検出できない。上の 2 つで「箱がある」ことを、ここで「役割を名乗らない」
  // ことを、対にして固定する。これはどの状態でも 0 件である。
  await expect(page.getByRole('group'), `${state.name}: 名前を持たない group が面に戻っている`).toHaveCount(0);
  return { chipNesting, searchField };
}

test('11 の表示状態が WCAG A/AA の自動監査を通る', async ({ page }) => {
  // 11 状態それぞれで、面を開き直し（各状態の入口が goto する）、axe を注入して全規則を回す。
  // playwright.config.ts の既定の制限時間は 1 状態を監査していた頃の値なので、状態の数に見合う値を
  // 明示で与える。実行装置は重く、負荷が高いと axe の page.evaluate が延びることも織り込む
  // （tasks.md の Implementation Notes）。
  test.setTimeout(240_000);

  const visited: string[] = [];
  let chipNestingTotal = 0;
  let searchFieldTotal = 0;
  for (const state of STORE_SURFACE_STATES) {
    // 失敗した状態を報告で見分けられるようにする（expectNoAxeViolations は状態の名前を知らない）。
    await test.step(`表示状態: ${state.name}`, async () => {
      await state.open(page);
      const counts = await expectAuditedStructures(page, state);
      await expectNoAxeViolations(page);
      chipNestingTotal += counts.chipNesting;
      searchFieldTotal += counts.searchField;
      visited.push(state.name);
    });
  }
  expect(visited.length, `監査を当てた状態: ${visited.join('、')}`).toBe(AUDITED_STATE_COUNT);
  expect(chipNestingTotal, '監査で照合した札の入れ子の総数が宣言と食い違う').toBe(AUDITED_CHIP_NESTING_TOTAL);
  expect(searchFieldTotal, '監査で照合した検索欄の総数が宣言と食い違う').toBe(AUDITED_SEARCH_FIELD_TOTAL);
});
