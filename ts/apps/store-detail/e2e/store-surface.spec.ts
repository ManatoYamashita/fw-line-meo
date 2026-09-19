import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, readOverflowMetrics } from '@fwlm/e2e-support/viewport';

import { STORE_SURFACE_STATES, openStoreSurface } from './fixtures/detail';

// 店舗詳細（LIFF 面）の実描画検証（Issue #53 完了条件 3）。
//
// 要件 3.3（モバイル端末で横スクロールを発生させずに閲覧・操作できる）を、この面で初めて
// 機械検証する。これまで担保は globals.css の `overflow-x: clip` だけ、すなわち
// 「隠しているので見えない」状態だった。clip は scrollWidth 系の検査を構造的に無効化するため、
// 面の溢れを捕らえる網は要素の実測右端（maxRight）1 本しかない。
//
// 推移の選択肢と競合の検索欄を足したあと（store-detail-trend-dashboard・Issue #265）は、次も実測する
// （同 spec のタスク 5.2）。
// - 4 つの表示状態 × 2 つの幅（Pixel 5 相当と 320px）の横スクロール（要件 6.1〜6.4・9.4）
// - 検索欄から期間の群へのキーボード操作と、焦点の輪郭（要件 2.7・5.5）
// - 札の行と検索欄の Field の高さ（要件 5.6）
// - グラフの文字の寸法が幅によって変わらないこと（要件 6.5）
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
//
// **ただし「1 件」は推移を描けているときの値である**（Issue #286）。推移の点が 1 つも無い応答では表ごと
// 描かれず、捲れる領域は 0 件になる。状態ごとの値は fixtures/detail.ts の `structure.tableScrollRegions`
// が持つ。この定数は、既定の応答で 1 度だけ開く下の 3 つの検査のために残す。
const TABLE_SCROLL_REGIONS = 1;

// 表示状態の一覧（fixtures/detail.ts の STORE_SURFACE_STATES）を 2 つの幅で回った数の宣言
// （store-detail-trend-dashboard の要件 9.4・Issue #265。状態を 8 つへ広げた・Issue #286）。
// 9 つの状態を、Pixel 5 相当と 320px の 2 つの幅で回る。
// 一覧の長さや幅の数から導かずに数で書く。導くと、状態か幅を 1 つ消したときに宣言も一緒に減り、
// 検査が緑のまま測る範囲が減ったことを見逃すためである。
const STATE_WIDTH_VISIT_COUNT = 18;

// 回った先で照合が通った捲れる領域の件数の総和（Issue #286）。
//
// **上の巡回数の宣言だけでは足りない。** 状態ごとの期待値は fixture が持つので、全状態の宣言を 0 に
// する改変（容器から横の捲りを失わせ、併せて宣言も 0 にする）は、per-state の照合も巡回数の宣言も
// 素通りする。総和をここへ数で書くことが、その改変を赤にする。
// 内訳: 「推移 0 件」を除く 8 状態が 1 件ずつ、それを 2 つの幅で回る。
const SCROLL_REGION_VISIT_TOTAL = 16;

/** 狭い幅の表示領域。高さは、下の既存の 320px の検査にそろえる。 */
const NARROW_VIEWPORT = { width: 320, height: 720 } as const;

/**
 * 実測する 2 つの幅を順に回る。Pixel 5 相当は project の既定の表示領域（devices['Pixel 5']）をそのまま使い、
 * 320px は表示領域を差し替えて測る。面を開き直すのは `run` の責務である（表示領域を変えただけでは、前の幅で
 * 操作した状態が残る）。
 */
async function forEachWidth(page: Page, run: (widthName: string) => Promise<void>): Promise<void> {
  const pixel5 = page.viewportSize();
  if (pixel5 === null) {
    throw new Error('Playwright の viewport が未設定（Pixel 5 相当の project で実行すること）');
  }
  // 2 つの幅が同じになると、半分の回は同じ幅を測り直すだけになる。project の端末を変えたときに
  // 黙ってそうならないよう、ここで止める。
  expect(pixel5.width, 'Pixel 5 相当の幅が 320px より広くない（2 つの幅を測れていない）').toBeGreaterThan(
    NARROW_VIEWPORT.width,
  );
  const widths = [
    { name: `Pixel 5 相当（${pixel5.width}px）`, viewport: pixel5 },
    { name: `${NARROW_VIEWPORT.width}px`, viewport: NARROW_VIEWPORT },
  ];
  for (const { name, viewport } of widths) {
    await page.setViewportSize(viewport);
    await run(name);
  }
}

/**
 * 捲れる領域が推移の表の容器であることを確かめる（要件 6.3）。件数は expectNoHorizontalScroll が宣言と照合するので、
 * ここでは中身を見る。領域の名前が推移の節の見出しと同じ文言であり、その領域の中に表があることを求める。
 *
 * 領域が 0 件の状態（推移 0 件）では、このループは 1 周も回らない。**中身を見ない形が許されるのは、
 * 件数そのものを expectNoHorizontalScroll が状態ごとの宣言と照合し、さらに呼び出し側が総和を
 * 数で固定しているからである**（Issue #286）。件数の網が無ければ、これは「0 件を正しく不在と読む」
 * 空振りになる。
 */
async function expectScrollRegionsAreTrendTable(page: Page, where: string): Promise<void> {
  const { scrollRegions } = await readOverflowMetrics(page, 'scroll-container');
  for (const region of scrollRegions) {
    expect(region.slot, `${where}: 捲れる領域 ${region.slot}(${region.label}) が表の容器ではない`).toBe(
      'table-container',
    );
    await expect(
      page.getByRole('heading', { level: 2, name: region.label, exact: true }),
      `${where}: 捲れる領域の名前「${region.label}」が、推移の節の見出しと一致しない`,
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: region.label, exact: true }).getByRole('table'),
      `${where}: 捲れる領域「${region.label}」の中に推移の表が無い`,
    ).toHaveCount(1);
  }
}

test('9 つの表示状態を 2 つの幅で回り、どれもページ全体が横に溢れず、捲れる領域は状態ごとの宣言と一致する', async ({
  page,
}) => {
  // 各状態の入口は、操作後の表示と、詳細の取得がちょうど 1 回だったことを自分で確かめてから返る。
  // 検索 0 件の状態は長い英字列を入れるので、長い検索語を入れた状態（要件 6.4）も兼ねる。
  // 9 状態 × 2 幅なので、既定の制限時間（30 秒）では足りない。
  test.setTimeout(180_000);

  const visited: string[] = [];
  let scrollRegionTotal = 0;
  await forEachWidth(page, async (widthName) => {
    for (const state of STORE_SURFACE_STATES) {
      const where = `店舗詳細（${state.name}・${widthName}）`;
      const regions = state.structure.tableScrollRegions;
      await state.open(page);
      await expectNoHorizontalScroll(page, where, regions);
      await expectScrollRegionsAreTrendTable(page, where);
      scrollRegionTotal += regions;
      visited.push(`${state.name}・${widthName}`);
    }
  });
  expect(visited.length, `回った状態と幅: ${visited.join('、')}`).toBe(STATE_WIDTH_VISIT_COUNT);
  expect(scrollRegionTotal, '回った先で照合した捲れる領域の総数が宣言と食い違う').toBe(
    SCROLL_REGION_VISIT_TOTAL,
  );
});

// --- キーボード操作と焦点の輪郭（要件 2.7・5.5） ----------------------------------------

/** 競合の検索欄の見えるラベル。入力欄の名前にもなる。 */
const SEARCH_LABEL = '店名で絞り込む';

/** 輪郭の外周と、はみ出しを切り取る祖先の内側を比べるときの許容（サブピクセルの丸め分だけ）。 */
const SUBPIXEL_TOLERANCE_PX = 0.5;

/** 透明の色。算出値は `transparent` か、アルファが 0 の `rgba(…)` になる。 */
const TRANSPARENT_COLOR = /^transparent$|^rgba\([^)]*,\s*0\)$/;

/** 表示領域の座標の箱（CSS ピクセル）。 */
interface ViewportRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** はみ出しを切り取る祖先 1 つの、1 つの軸の範囲。 */
interface ClippingAncestor {
  readonly element: string;
  readonly axis: 'x' | 'y';
  /** 切り取る範囲（祖先の枠の内側）。 */
  readonly start: number;
  readonly end: number;
}

/** 焦点を持つ要素の、焦点の輪郭の実測値。 */
interface FocusRingMeasure {
  readonly element: string;
  readonly focusVisible: boolean;
  readonly outlineStyle: string;
  readonly outlineColor: string;
  readonly outlineWidth: number;
  readonly outlineOffset: number;
  /** 輪郭の外周の箱。要素の箱を、輪郭の離れと太さの分だけ広げたもの。 */
  readonly ring: ViewportRect;
  readonly clippingAncestors: readonly ClippingAncestor[];
}

/**
 * 焦点を持つ要素の輪郭を、算出スタイルと幾何から読む。焦点が body へ抜けているときは null を返す。
 * 輪郭の帯を撮り比べるので、先に要素を表示領域の中央へ寄せる（撮る範囲が表示領域の外へ出ないように）。
 */
function readFocusRing(page: Page): Promise<FocusRingMeasure | null> {
  return page.evaluate((): FocusRingMeasure | null => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element === document.body) return null;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });

    const describe = (node: Element): string => `${node.tagName}[data-slot="${node.getAttribute('data-slot') ?? ''}"]`;
    const style = getComputedStyle(element);
    const outlineWidth = Number.parseFloat(style.outlineWidth);
    const outlineOffset = Number.parseFloat(style.outlineOffset);
    const reach = outlineOffset + outlineWidth;
    const box = element.getBoundingClientRect();

    // 祖先のうち、はみ出しを切り取るもの。overflow は軸ごとに見る（html と body は横だけを clip する）。
    // contain の paint は両方の軸を切り取る。
    const clippingAncestors: ClippingAncestor[] = [];
    for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      const paintContained = /\b(paint|strict|content)\b/.test(ancestorStyle.contain);
      const rect = ancestor.getBoundingClientRect();
      const inner = {
        left: rect.left + Number.parseFloat(ancestorStyle.borderLeftWidth),
        right: rect.right - Number.parseFloat(ancestorStyle.borderRightWidth),
        top: rect.top + Number.parseFloat(ancestorStyle.borderTopWidth),
        bottom: rect.bottom - Number.parseFloat(ancestorStyle.borderBottomWidth),
      };
      if (paintContained || ancestorStyle.overflowX !== 'visible') {
        clippingAncestors.push({ element: describe(ancestor), axis: 'x', start: inner.left, end: inner.right });
      }
      if (paintContained || ancestorStyle.overflowY !== 'visible') {
        clippingAncestors.push({ element: describe(ancestor), axis: 'y', start: inner.top, end: inner.bottom });
      }
    }

    return {
      element: `${describe(element)}[role="${element.getAttribute('role') ?? ''}"]`,
      focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
      outlineWidth,
      outlineOffset,
      ring: {
        left: box.left - reach,
        top: box.top - reach,
        right: box.right + reach,
        bottom: box.bottom + reach,
      },
      clippingAncestors,
    };
  });
}

/** 輪郭の 4 辺の帯。帯の太さは輪郭の太さで、外周の箱の縁に沿う。 */
function ringStrips(measure: FocusRingMeasure): ReadonlyArray<{
  readonly side: string;
  readonly clip: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}> {
  const { ring, outlineWidth } = measure;
  const width = ring.right - ring.left;
  const height = ring.bottom - ring.top;
  return [
    { side: '上', clip: { x: ring.left, y: ring.top, width, height: outlineWidth } },
    { side: '下', clip: { x: ring.left, y: ring.bottom - outlineWidth, width, height: outlineWidth } },
    { side: '左', clip: { x: ring.left, y: ring.top, width: outlineWidth, height } },
    { side: '右', clip: { x: ring.right - outlineWidth, y: ring.top, width: outlineWidth, height } },
  ];
}

async function captureStrips(page: Page, strips: ReturnType<typeof ringStrips>): Promise<Buffer[]> {
  const images: Buffer[] = [];
  for (const strip of strips) {
    images.push(await page.screenshot({ clip: strip.clip, animations: 'disabled', caret: 'hide' }));
  }
  return images;
}

/**
 * 焦点を持つ要素に、焦点の輪郭が実際に描かれ、切れていないことを実測する（要件 5.5）。3 つの面から見る。
 * 1. 算出スタイル: `:focus-visible` に一致し、輪郭の線が有効で、太さが 0 でなく、色が透明でない。
 * 2. 幾何: 輪郭の外周が、はみ出しを切り取るすべての祖先の枠の内側に収まる。
 * 3. 画素: 輪郭の 4 辺の帯を、焦点があるときと外したときで撮り比べ、4 辺とも絵が変わる。算出スタイルは
 *    「描くと宣言した」ことしか示さない。上に重なった要素に隠れた輪郭や、overflow 以外（clip-path など）で
 *    切り取られた辺は、撮り比べでしか捕まらない。ただし撮り比べは辺ごとに「絵が変わったか」だけを見るので、
 *    捕まるのは辺がまるごと隠れた場合に限る。辺の一部だけが隠れた場合は素通りする（overflow による一部の
 *    切り取りは、2 の幾何が見る）。
 * 撮り比べのために最後に焦点を外す。呼び出し側は、続けて操作するなら焦点を置き直すこと。
 */
async function expectFocusRingDrawnAndUnclipped(page: Page, where: string): Promise<void> {
  const measure = await readFocusRing(page);
  if (measure === null) {
    throw new Error(`${where}: 焦点を持つ要素が無い（焦点が body へ抜けている）`);
  }
  const detail = JSON.stringify(measure);

  expect(measure.focusVisible, `${where}: ${measure.element} が :focus-visible に一致しない（${detail}）`).toBe(true);
  expect(measure.outlineStyle, `${where}: 焦点の輪郭の線が無効になっている（${detail}）`).not.toBe('none');
  expect(measure.outlineWidth, `${where}: 焦点の輪郭の太さが 0（${detail}）`).toBeGreaterThan(0);
  expect(TRANSPARENT_COLOR.test(measure.outlineColor), `${where}: 焦点の輪郭が透明（${detail}）`).toBe(false);

  // 走査の空振りを先に止める。html と body は横方向を clip する（globals.css）ので、祖先の走査が効いていれば
  // 少なくともそれらが見つかる。0 件なら、切り取りの検査は何も比べずに緑になる。
  expect(
    measure.clippingAncestors.length,
    `${where}: はみ出しを切り取る祖先を 1 つも読めていない（html と body の overflow-x も拾えていない）`,
  ).toBeGreaterThan(0);
  for (const clipper of measure.clippingAncestors) {
    const [start, end] =
      clipper.axis === 'x' ? [measure.ring.left, measure.ring.right] : [measure.ring.top, measure.ring.bottom];
    const message =
      `${where}: 焦点の輪郭（${clipper.axis} 軸 ${start}〜${end}px）が、${clipper.element} の枠の内側` +
      `（${clipper.start}〜${clipper.end}px）からはみ出して切り取られる`;
    expect(start, message).toBeGreaterThanOrEqual(clipper.start - SUBPIXEL_TOLERANCE_PX);
    expect(end, message).toBeLessThanOrEqual(clipper.end + SUBPIXEL_TOLERANCE_PX);
  }

  const strips = ringStrips(measure);
  const focused = await captureStrips(page, strips);
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  // 焦点が外れたことを確かめる。外れていなければ 2 回とも輪郭のある絵を撮るので、同じ絵どうしを比べて、
  // 原因を取り違えた赤になる。
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  const blurred = await captureStrips(page, strips);
  strips.forEach((strip, index) => {
    expect(
      focused[index]?.equals(blurred[index] ?? Buffer.alloc(0)),
      `${where}: 輪郭の${strip.side}の帯が、焦点を外しても変わらない（輪郭が描かれていないか、切り取られている）`,
    ).toBe(false);
  });
}

test('検索欄から Tab で期間の群へ移り、矢印キーで 7日 を選ぶと、見出しが追随し、焦点の輪郭が切れずに描かれる', async ({
  page,
}) => {
  await forEachWidth(page, async (widthName) => {
    await openStoreSurface(page);

    // 検索欄に焦点を置く。文字の入力欄は、プログラムから焦点を置いても :focus-visible の対象になる。
    const search = page.getByRole('searchbox', { name: SEARCH_LABEL });
    await search.focus();
    await expect(search).toBeFocused();
    await expectFocusRingDrawnAndUnclipped(page, `検索欄（${widthName}）`);
    // 輪郭の撮り比べで焦点を外したので、置き直してから Tab を押す。
    await search.focus();
    await expect(search).toBeFocused();

    // Tab 1 回で、期間の群の、選ばれている札（既定の 30日）へ移る。群の中で Tab が止まるのは、選ばれている
    // 札の 1 つだけである。間に別の焦点の止まり先があれば、ここで赤になる。
    await page.keyboard.press('Tab');
    const periods = page.getByRole('radiogroup', { name: '期間', exact: true });
    await expect(periods.getByRole('radio', { name: '30日', exact: true })).toBeFocused();

    // 矢印キーで 7日 を選ぶ。焦点と選択が一緒に移る。
    await page.keyboard.press('ArrowLeft');
    const sevenDays = periods.getByRole('radio', { name: '7日', exact: true });
    await expect(sevenDays).toBeFocused();
    await expect(sevenDays).toBeChecked();

    // 見出しが追随する（要件 3.2）。前の期間の見出しは残らない。
    await expect(page.getByRole('heading', { level: 2, name: '直近7日の推移', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: '直近30日の推移', exact: true })).toHaveCount(0);

    await expectFocusRingDrawnAndUnclipped(page, `期間の札「7日」（${widthName}）`);
  });
});

// --- 操作領域（要件 5.6） ------------------------------------------------------------------

/**
 * 操作領域の高さの下限（px）。既存部品の寸法区分で定められた下限であり、札と検索欄はラベルの行で満たす
 * （ui-a11y-gaps の要件 4.7。部品の側では FieldLabel の最小高が持つ）。
 */
const TOUCH_TARGET_MIN_PX = 44;

/** 期間と指標の札の名前（期間の群、指標の群の順）。 */
const CHIP_NAMES = ['7日', '30日', '順位', '評価', 'クチコミ数'] as const;

/**
 * 札を押す位置の、行の上端からの距離（px）。radio と題より上の、行の内側の余白に当たる。
 * 行の高さのうち、部品の見た目の外側の部分も押せることを確かめるための位置である。
 */
const CHIP_EDGE_OFFSET_PX = 3;

/**
 * 札の行（radio を包む label）。`data-slot="field-label"` は、札の題と群の名前（div）に加えて検索欄の
 * ラベル（label）も持つので、名前で指した radio を包む label に絞る。
 */
function chipRow(page: Page, name: string): Locator {
  return page
    .locator('label[data-slot="field-label"]')
    .filter({ has: page.getByRole('radio', { name, exact: true }) });
}

async function heightOf(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().height);
}

test('期間と指標の札の行と、検索欄の Field が 44px 以上の高さを持ち、その領域を押すと部品が反応する', async ({
  page,
}) => {
  await forEachWidth(page, async (widthName) => {
    await openStoreSurface(page);

    // 札の行。名前の一覧から漏れた札が測られないまま残らないよう、札の数も照合する。
    await expect(page.getByRole('radio')).toHaveCount(CHIP_NAMES.length);
    for (const name of CHIP_NAMES) {
      const row = chipRow(page, name);
      await expect(row, `札「${name}」の行（radio を包む label）が 1 つに定まらない（${widthName}）`).toHaveCount(1);
      const height = await heightOf(row);
      expect(
        height,
        `札「${name}」の行の高さが ${height}px（${widthName}・下限 ${TOUCH_TARGET_MIN_PX}px）`,
      ).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);
    }

    // 検索欄の Field。ラベルの行と入力欄を縦に積んだ全体で下限を満たす（入力欄だけでは届かない）。
    const search = page.getByRole('searchbox', { name: SEARCH_LABEL });
    const field = page.locator('[data-slot="field"]').filter({ has: search });
    await expect(field, `検索欄を含む Field が 1 つに定まらない（${widthName}）`).toHaveCount(1);
    const label = field.locator('label', { hasText: SEARCH_LABEL });
    await expect(label, `検索欄の Field がラベルの行を持たない（${widthName}）`).toHaveCount(1);
    const fieldHeight = await heightOf(field);
    expect(
      fieldHeight,
      `検索欄の Field の高さが ${fieldHeight}px（${widthName}・下限 ${TOUCH_TARGET_MIN_PX}px）`,
    ).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX);

    // 高さだけでは操作領域にならない。ラベルを押すと入力欄へ焦点が移ることを確かめる
    // （jsdom はラベルを押しても焦点を移さないので、部品テストでは確かめられない）。
    await label.click();
    await expect(search, `検索欄のラベルを押しても入力欄へ焦点が移らない（${widthName}）`).toBeFocused();

    // 札の行も、radio と題の外側（行の上端の余白）を押して選べることを確かめる。
    const reviewCountRow = chipRow(page, 'クチコミ数');
    const box = await reviewCountRow.boundingBox();
    if (box === null) {
      throw new Error(`札「クチコミ数」の行が描かれていない（${widthName}）`);
    }
    await reviewCountRow.click({ position: { x: box.width / 2, y: CHIP_EDGE_OFFSET_PX } });
    await expect(
      page.getByRole('radio', { name: 'クチコミ数', exact: true }),
      `札「クチコミ数」の行の上端の余白を押しても選ばれない（${widthName}）`,
    ).toBeChecked();
  });
});

// --- グラフの文字の寸法（要件 6.5） --------------------------------------------------------

/** グラフの文字 1 つの実測値。 */
interface ChartText {
  readonly kind: '目盛り' | '日付' | '現在値';
  readonly text: string;
  /** 算出した文字の大きさ（`getComputedStyle().fontSize`）。 */
  readonly fontSize: string;
  /** 描かれた箱の幅と高さ。transform による縮小は算出の fontSize に現れないので、箱でも比べる。 */
  readonly width: number;
  readonly height: number;
}

/**
 * グラフの文字（目盛り・日付・現在値）を読む。どれも読み上げからは隠してある（aria-hidden。同じ内容を
 * グラフの名前と推移の表が持つため）。描き方は 2 通りあり、種類は部品の組み立てから次のように分ける。
 * - 現在値: 点の層（SVG）の中に `text` として描く文字。2026-09-16 の改定で、HTML の文字から移した
 *   （地色の縁取りを字の下に敷き、線が後ろを通っても読めるようにするため）。
 * - 目盛り: HTML の帯の中で、位置を style の top で与えた文字
 * - 日付: HTML の帯の中の、それ以外の文字（横軸の始点と終点）
 */
function readChartTexts(page: Page): Promise<ChartText[]> {
  return page.locator('figure').evaluate((figure): ChartText[] => {
    const texts: ChartText[] = [];
    const add = (kind: ChartText['kind'], element: Element): void => {
      const text = (element.textContent ?? '').trim();
      if (text === '') return;
      const box = element.getBoundingClientRect();
      texts.push({
        kind,
        text,
        fontSize: getComputedStyle(element).fontSize,
        width: box.width,
        height: box.height,
      });
    };

    for (const root of Array.from(figure.querySelectorAll('[aria-hidden="true"]'))) {
      // 点の層（SVG）。現在値の文字はこの中にある。
      if (root instanceof SVGElement) {
        for (const svgText of Array.from(root.querySelectorAll('text'))) {
          add('現在値', svgText);
        }
        continue;
      }
      if (!(root instanceof HTMLElement)) continue;
      const leaves =
        root.children.length === 0
          ? [root]
          : Array.from(root.querySelectorAll<HTMLElement>('*')).filter((element) => element.children.length === 0);
      for (const leaf of leaves) {
        add(leaf.style.top !== '' ? '目盛り' : '日付', leaf);
      }
    }
    return texts;
  });
}

test('グラフの文字（目盛り・日付・現在値）の算出サイズが、320px と Pixel 5 相当で等しい', async ({ page }) => {
  const measured: Array<{ readonly widthName: string; readonly texts: ChartText[] }> = [];
  await forEachWidth(page, async (widthName) => {
    await openStoreSurface(page);
    await expect(page.locator('figure'), `推移のグラフが 1 つに定まらない（${widthName}）`).toHaveCount(1);
    measured.push({ widthName, texts: await readChartTexts(page) });
  });

  const [wide, narrow] = measured;
  if (wide === undefined || narrow === undefined) {
    throw new Error(`2 つの幅を測れていない（測った幅: ${measured.map((entry) => entry.widthName).join('、')}）`);
  }
  // 走査の空振りを止める。目盛りは 1 つ以上、日付は始点と終点の 2 つ、現在値は 1 つ描かれている（要件 1.11・1.12）。
  const summary = JSON.stringify(wide.texts);
  expect(wide.texts.filter((text) => text.kind === '目盛り').length, `目盛りの文字を読めていない: ${summary}`).toBeGreaterThan(0);
  expect(wide.texts.filter((text) => text.kind === '日付'), `日付の文字が始点と終点の 2 つでない: ${summary}`).toHaveLength(2);
  expect(wide.texts.filter((text) => text.kind === '現在値'), `現在値の文字が 1 つでない: ${summary}`).toHaveLength(1);

  // 文字ごとに、算出サイズと描かれた箱が、2 つの幅で同じである。
  expect(narrow.texts, `グラフの文字の寸法が ${narrow.widthName} と ${wide.widthName} で違う`).toEqual(wide.texts);
});

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
  await expect(trend.locator('dl dt')).toHaveText(['順位', '評価', 'クチコミ数の増減']);
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
