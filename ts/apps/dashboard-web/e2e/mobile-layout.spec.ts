import { test, expect, type Page } from '@playwright/test';

import { DASHBOARD_SURFACES, openStoreListAsAgency } from './fixtures/api';
import {
  CUE_DELTA_THRESHOLD,
  CUE_MIN_OVERFLOW_PX,
  describeCell,
  expectLayoutWidth,
  markPannableContainers,
  measureCueBands,
  readCellWrapping,
  readNavReach,
  round,
  verticalCells,
} from './support/layout-probes';
import {
  expectPanelInsideScrollport,
  partsOutsideScrollport,
  readPanelPlacement,
  STORE_QR_PANEL,
  USER_EDIT_PANEL,
  type PanelProbe,
} from './support/panel-placement';

// 携帯端末の幅で管理ダッシュボードが実用に耐えることの実測（Issue #283）。
//
// 既存の網が見ていない 4 つを測る。
//   R1 一覧表のセルが 1〜2 文字ずつ縦に並んでいないこと
//   R2 帯の案内リンクとログアウトに、捲らずに届くこと
//   R3 表が見える幅に収まらないとき、まだ捲れる側の端に手がかりが描かれていること
//   R4 行の直下に開くパネルが、捲り容器の見えている矩形に収まること
//
// `expectNoHorizontalScroll`（dashboard-surfaces.spec.ts）は捲り容器の**内側**を免除するので、
// R1・R3・R4 はどれも緑のまま通る。axe は捲り容器の外へ出た要素を黙って対象から外すので、
// R2 も緑のまま通る。**免除の外側にある性質を、この spec が受け持つ。**

/** 測る幅。393 は project の既定（Pixel 5）と同じ値だが、模擬が効いていることを毎回確かめる。 */
const WIDTHS = [393, 320] as const;
type Width = (typeof WIDTHS)[number];

const VIEWPORT_HEIGHT = 727;

/**
 * 縦に並んでいると見なす行数の下限。
 *
 * Issue #283 の実測は「3 行以上」で数えたが、2 行でも（「有 / 効」のような 2 字の値では）
 * 読めない。**下限を 2 にすると 3 行の場合も必ず含む**ので、網としては 2 の方が強い。
 */
const MIN_VERTICAL_LINES = 2;

/**
 * 手がかりが「描かれている」と見なす画素数の下限（端の帯に対する割合）。
 *
 * 濃淡は端から 1rem で薄れるので、12px の帯のうち閾値を超えるのは 7〜9px ぶんである。
 * 文字が載っている画素は両方の画像で同じ色になり差が出ないため、帯の全面は埋まらない。
 */
const CUE_MIN_CHANGED_RATIO = 0.2;

/**
 * 手がかりが「描かれていない」と見なす画素数の上限（装置の画素の列数）。
 *
 * **捲り切った端には、装置の画素 1 列ぶんの継ぎ目が残る**（実測: 幅 393・装置比 2.75 で
 * 最端の 1 列だけに差 12/255）。中身と一緒に動く覆いの位置が装置の画素へ丸められるためで、
 * 人の目には見えない（0.36 CSS px）。ここを 0 に固定すると、この丸めを「手がかりが消えていない」
 * と読んで永久に赤くなる。一方、実際の手がかりは 7〜9px ぶん（20 列以上）に及ぶので、
 * 2 列を上限にしても、出ている手がかりを見落とすことはない。
 */
const CUE_ABSENT_MAX_COLUMNS = 2;

interface SurfaceLayout {
  /** 帯の中のリンクと押しボタンの数（帯を描かない面は 0）。 */
  readonly navControls: number;
  /** R1 が測るセルの数（**literal で持つ**。走査が空振りしたときに 0 件で緑にしない）。 */
  readonly measuredCells: number;
  /** 行の直下のパネルのセルの数（R1 の対象外にした件数。外しすぎの検出用）。 */
  readonly panelCells: number;
  /** その幅で**必ず溢れている**捲り容器の名前。実測の部分集合であることを主張する。 */
  readonly mustOverflow: Readonly<Record<Width, readonly string[]>>;
}

/**
 * 面ごとの宣言。**値は実測に合わせた literal である**（配列の長さから導くと、走査が
 * 空になったときに 0 = 0 で緑になる）。
 *
 * `mustOverflow` は Issue #283 の修正後の姿を書く。折り返しの規則を当てると、店舗一覧の表は
 * 見える幅に収まらなくなり、帯の案内リストは捲れる領域ではなくなる。
 */
const LAYOUT: Readonly<Record<string, SurfaceLayout>> = {
  店舗一覧: {
    navControls: 6,
    measuredCells: 18,
    panelCells: 0,
    mustOverflow: { 393: ['店舗一覧'], 320: ['店舗一覧'] },
  },
  '店舗一覧の QR パネル': {
    navControls: 6,
    measuredCells: 18,
    panelCells: 1,
    mustOverflow: { 393: ['店舗一覧'], 320: ['店舗一覧'] },
  },
  代理店管理: {
    navControls: 6,
    measuredCells: 4,
    panelCells: 0,
    mustOverflow: { 393: [], 320: [] },
  },
  ログイン: {
    navControls: 0,
    measuredCells: 0,
    panelCells: 0,
    mustOverflow: { 393: [], 320: [] },
  },
  招待コード: {
    navControls: 6,
    measuredCells: 11,
    panelCells: 0,
    mustOverflow: { 393: ['招待コード'], 320: ['招待コード'] },
  },
  利用者管理: {
    navControls: 6,
    measuredCells: 18,
    panelCells: 0,
    mustOverflow: { 393: ['利用者一覧'], 320: ['利用者一覧'] },
  },
  '利用者管理の編集パネル': {
    navControls: 6,
    measuredCells: 18,
    panelCells: 1,
    mustOverflow: { 393: ['利用者一覧'], 320: ['利用者一覧'] },
  },
  店舗登録: {
    navControls: 6,
    measuredCells: 0,
    panelCells: 0,
    mustOverflow: { 393: [], 320: [] },
  },
};

test('宣言の面が検証面の一覧と一致する', () => {
  expect(
    DASHBOARD_SURFACES.map((surface) => surface.where),
    '面を足したら LAYOUT にも足す（宣言の無い面は beforeEach で止まる）',
  ).toEqual(Object.keys(LAYOUT));
  // 面の数は literal で持つ。配列の長さどうしを比べると、両方が空でも緑になる。
  expect(Object.keys(LAYOUT)).toHaveLength(8);
});

for (const surface of DASHBOARD_SURFACES) {
  for (const width of WIDTHS) {
    const layout = LAYOUT[surface.where]!;

    test.describe(`${surface.where}（幅 ${width}）`, () => {
      test.use({ viewport: { width, height: VIEWPORT_HEIGHT } });

      test.beforeEach(async ({ page }) => {
        // 幅の確認は**面を開いた後**に行う。読み込み前（about:blank）のレイアウト幅は、
        // viewport の meta が無い既定の 980px であり、模擬の効きを測れない。
        await surface.open(page);
        await expectLayoutWidth(page, width);
      });

      test(`[R1] ${surface.where}（幅 ${width}）: 一覧表のセルが縦に並んでいない`, async ({
        page,
      }) => {
        const report = await readCellWrapping(page);
        expect(
          report.measured.length,
          `測ったセルの数が宣言と違う（実測 ${report.measured.length} 件・空のセル ${report.emptyCells} 件・` +
            `表 ${report.tables} 個）。走査が空振りしているか、面の列が変わっている`,
        ).toBe(layout.measuredCells);
        expect(
          report.panelCells,
          `行の直下のパネルのセルの数が宣言と違う（実測 ${report.panelCells} 件）。R1 の対象から` +
            '外しすぎている可能性がある',
        ).toBe(layout.panelCells);

        const vertical = verticalCells(report, MIN_VERTICAL_LINES);
        expect(
          vertical.map(describeCell),
          `幅 ${width} で、内容が 1.6 文字ぶんに満たない幅へ縮み、${MIN_VERTICAL_LINES} 行以上に` +
            '折り返されたセルがある（日本語はどの文字の間でも折り返せるので、規則を持たない列は' +
            '表が容器より広いとき 1 文字まで細る）',
        ).toEqual([]);
      });

      test(`[R2] ${surface.where}（幅 ${width}）: 帯の操作要素すべてに捲らずに届く`, async ({
        page,
      }) => {
        const report = await readNavReach(page, width);
        expect(
          report.controls.length,
          `帯の操作要素の数が宣言と違う（実測 ${report.controls.length} 件・帯 ${report.navs} 個）`,
        ).toBe(layout.navControls);

        const unreachable = report.controls
          .filter((control) => !control.inside)
          .map(
            (control) =>
              `${control.name} [${round(control.left)}, ${round(control.right)}]` +
              `（切り取り: ${control.clippedBy ?? '端末の幅'}）`,
          );
        expect(
          unreachable,
          `幅 ${width} で、捲らないと届かない帯の操作要素がある（捲れる手がかりの無い帯では、` +
            '画面の外のリンクは存在しないように見える）',
        ).toEqual([]);

        expect(
          report.controls.filter((control) => !control.insideNav).map((control) => control.name),
          '帯の箱からはみ出した操作要素がある（段を増やしたのに高さを固定したままだと、下の見出しに重なる）',
        ).toEqual([]);
        expect(
          report.controls.filter((control) => !control.hit).map((control) => control.name),
          '見えている位置を指しても当たらない操作要素がある（上に何かが載っている）',
        ).toEqual([]);
        expect(
          report.texts.filter((text) => !text.inside).map((text) => text.text),
          '帯の中で切れている文字がある（ワードマーク・ロールの表示）',
        ).toEqual([]);
        // 交差の検査が空振りしていないこと。帯のある面では、操作要素に加えてワードマークの文字 2 つと
        // アイコン・ロールの表示を数える。帯の無い面（ログイン）では調べる項目が 0 件であるのが正しい。
        if (report.navs === 0) {
          expect(report.overlapItems, '帯が無いのに交差を調べた項目がある').toBe(0);
        } else {
          expect(report.overlapItems, '交差を調べた項目が少なすぎる（走査が空振りしている）').toBeGreaterThanOrEqual(
            layout.navControls + 3,
          );
        }
        expect(
          report.overlaps,
          `幅 ${width} で、帯の中の要素どうしが重なっている（長いワードマークがロールやログアウトに載ると、` +
            '「届く」「帯の中にある」の検査は緑のまま読めなくなる）',
        ).toEqual([]);
      });

      test(`[R3] ${surface.where}（幅 ${width}）: 溢れた捲り容器の端に捲れる手がかりがある`, async ({
        page,
      }, testInfo) => {
        const containers = await markPannableContainers(page);
        const overflowing = containers.filter((container) => container.overflowing);
        for (const name of layout.mustOverflow[width]) {
          expect(
            overflowing.map((container) => container.label),
            `幅 ${width} で「${name}」が溢れていない（宣言と実態が食い違う。実測: ` +
              `${containers.map((c) => `${c.label}=${c.scrollWidth}/${c.clientWidth}`).join(', ') || '(捲れる容器なし)'}）`,
          ).toContain(name);
        }

        const stats: unknown[] = [];
        /**
         * 手がかりの濃さを問わずに飛ばした容器（下の `continue`）。
         *
         * **飛ばした事実を残さないと、飛ばす対象が増えても誰も気づかない。** この spec は
         * `measuredCells` と `navControls` を面ごとに実数で宣言して「走査が空になったときに
         * 0 件どうしで緑になる」のを防いでいるが、手がかりの検査だけがその規律の外にあった。
         * 実測では、閾値を大きくして**全容器を飛ばす状態にしても 17 本すべて緑**だった
         * （PR #284 のレビュー）。
         */
        const skippedForThinOverflow: string[] = [];
        for (const container of containers) {
          const start = await measureCueBands(page, container.probeId, 'start');
          const end = container.overflowing
            ? await measureCueBands(page, container.probeId, 'end')
            : start;
          stats.push({ label: container.label, overflowing: container.overflowing, start, end });

          const where = `${container.label}（${container.scrollWidth}/${container.clientWidth}px・` +
            `捲り位置 0 で見えない操作 ${container.hiddenControls.length} 件: ` +
            `${container.hiddenControls.join(', ') || 'なし'}）`;

          // 決定性。同じ状態で 2 回撮った画像が違うなら、比較の土台が成り立っていない。
          expect(start.maxSelfDelta, `${where}: 描画が安定していない（同じ状態の 2 枚に差がある）`).toBe(0);

          const cueOf = (band: { changed: number; total: number }) =>
            band.total > 0 && band.changed >= band.total * CUE_MIN_CHANGED_RATIO;
          /** 差が「装置の画素 2 列ぶん以下」かどうか（丸めの継ぎ目を手がかりと読まないため）。 */
          const noCueOf = (band: { changed: number; total: number; columns: number }) =>
            band.columns === 0 || band.changed <= (band.total / band.columns) * CUE_ABSENT_MAX_COLUMNS;

          if (container.overflowing && !container.cueExpected) {
            // 覆いの幅より小さくしか捲れない容器。捲り位置 0 でも反対側の覆いが端へ掛かるので、
            // 手がかりの濃さを問わない（CI の字幅では代理店一覧がこの状態になる）。
            // 中身が隠れている量もわずかなので、実害の側でも要求しない。
            skippedForThinOverflow.push(container.label);
            continue;
          }

          if (container.overflowing) {
            expect(
              `${start.right.changed}/${start.right.total}`,
              `${where}: 捲り位置 0 で右端に手がかりが描かれていない（まだ右に中身があるのに、` +
                `見た目では捲れることが分からない。画素差の最大 ${start.right.maxDelta}・閾値 ${CUE_DELTA_THRESHOLD}）`,
            ).toBe(cueOf(start.right) ? `${start.right.changed}/${start.right.total}` : '手がかりあり');
            expect(
              noCueOf(start.left),
              `${where}: 捲り位置 0 の左端に手がかりが出ている（これ以上左には捲れない。` +
                `差 ${start.left.changed}/${start.left.total} 画素）`,
            ).toBe(true);
            expect(
              `${end.left.changed}/${end.left.total}`,
              `${where}: 捲り切ったときに左端の手がかりが描かれていない`,
            ).toBe(cueOf(end.left) ? `${end.left.changed}/${end.left.total}` : '手がかりあり');
            expect(
              noCueOf(end.right),
              `${where}: 捲り切ったのに右端の手がかりが残っている（覆いが濃淡を隠していない。` +
                `差 ${end.right.changed}/${end.right.total} 画素）`,
            ).toBe(true);
          } else {
            expect(
              [noCueOf(start.left), noCueOf(start.right)],
              `${where}: 捲れないのに端へ手がかりが描かれている（差 左 ${start.left.changed} / ` +
                `右 ${start.right.changed} 画素）`,
            ).toEqual([true, true]);
          }

          // 中央に差が出るのは、手がかりが中身の上まで及んでいるときである。帯を取れない
          // 狭い容器（中央が 0 画素）では測らない。
          if (start.center.total > 0) {
            expect(
              start.center.changed,
              `${where}: 容器の中央にも手がかりが描かれている（中央は覆いも濃淡も届かない位置である）`,
            ).toBe(0);
          }
        }

        // **宣言した容器は、必ず手がかりの検査を通る。** 飛ばす条件は溢れ量なので、折り返しの
        // 規則を少し緩める変更で主要な表の溢れが 32px を切ると、宣言は「溢れている」まま通り、
        // 手がかりの検査だけが静かに消える。件数の literal ではなく名前で縛るのは、飛ばす対象が
        // **字幅（＝環境）で変わる**ためである。CI の Linux では代理店一覧が 9px だけ溢れて
        // この条件に入り、手元の macOS では入らない。件数を固定すると、環境の差そのもので赤くなる。
        expect(
          skippedForThinOverflow.filter((label) => layout.mustOverflow[width].includes(label)),
          `幅 ${width} で、必ず溢れると宣言した容器が手がかりの検査を飛ばされた` +
            `（溢れ量が ${CUE_MIN_OVERFLOW_PX}px 未満に縮んでいる。飛ばした容器: ` +
            `${skippedForThinOverflow.join(', ') || 'なし'}）`,
        ).toEqual([]);

        await testInfo.attach('r3-cue.json', {
          body: JSON.stringify({ stats, skippedForThinOverflow }, null, 1),
          contentType: 'application/json',
        });
      });
    });
  }
}

// --- R4: 行の直下に開くパネル -----------------------------------------------------------
//
// 利用者の編集パネル（幅 393）は dashboard-surfaces.spec.ts が既に測っている（tasks 3.5）。
// ここは Issue #283 で新しくこの経路を持った QR パネルと、まだ測っていない幅 320 を足す。

const PANEL_CASES: readonly { readonly probe: PanelProbe; readonly widths: readonly Width[] }[] = [
  { probe: STORE_QR_PANEL, widths: [393, 320] },
  { probe: USER_EDIT_PANEL, widths: [320] },
];

for (const { probe, widths } of PANEL_CASES) {
  for (const width of widths) {
    test.describe(`${probe.where}（幅 ${width}）`, () => {
      test.use({ viewport: { width, height: VIEWPORT_HEIGHT } });

      test(`[R4] ${probe.where}（幅 ${width}）: 捲り位置によらず捲り容器の見えている矩形に収まる`, async ({
        page,
      }) => {
        const surface = DASHBOARD_SURFACES.find((candidate) => candidate.where === probe.where);
        if (surface === undefined) throw new Error(`fixture 未定義の面: ${probe.where}`);
        await surface.open(page);
        await expectLayoutWidth(page, width);

        const opened = await readPanelPlacement(page, probe);
        // 前提: 表が容器より広い。収まっているなら、この実測は何も測っていない。
        expect(
          opened.scrollWidth,
          '表が捲り容器に収まっている（捲れた状態を作れないので、この実測は成り立たない）',
        ).toBeGreaterThan(opened.clientWidth);
        expectPanelInsideScrollport(opened, `${probe.where}: 開いた直後`, probe);

        const scrollTo = async (position: 'start' | 'end') => {
          await probe.region(page).evaluate((container, pos: 'start' | 'end') => {
            container.scrollLeft = pos === 'start' ? 0 : container.scrollWidth - container.clientWidth;
          }, position);
        };

        await scrollTo('end');
        const scrolled = await readPanelPlacement(page, probe);
        expect(scrolled.scrollLeft, '捲り切れていない').toBeGreaterThan(0);
        expectPanelInsideScrollport(scrolled, `${probe.where}: 捲り切った状態`, probe);

        await scrollTo('start');
        const initial = await readPanelPlacement(page, probe);
        expect(initial.scrollLeft, '捲り位置を 0 へ戻せていない').toBe(0);
        expectPanelInsideScrollport(initial, `${probe.where}: 捲り位置 0 の状態`, probe);

        // Tab で焦点を載せた状態。焦点の当たった操作が見えていなければ WCAG 2.4.7 に反する。
        const target = probe.focusTarget.locate(probe.region(page));
        await probe.trigger(page).focus();
        for (let presses = 0; presses < 12; presses += 1) {
          if (await target.evaluate((element) => element === document.activeElement)) break;
          await page.keyboard.press('Tab');
        }
        await expect(
          target,
          `Tab を 12 回押しても ${probe.focusTarget.part} へ焦点が届かない`,
        ).toBeFocused();
        expectPanelInsideScrollport(
          await readPanelPlacement(page, probe),
          `${probe.where}: Tab で ${probe.focusTarget.part} へ焦点を載せた状態`,
          probe,
        );
      });
    });
  }
}

// --- 代理店ロールの帯（1 段目が最も広い状態）---------------------------------------------
//
// 検証面の fixture は運営ロールで開く。案内リンクは運営が 5 本・代理店が 3 本なので 2 段目は
// 運営が最悪値だが、**1 段目は代理店の方が広い**（ロールの表示が「運営」より 1 字長い）。
// 包含関係にならないので、代理店ロールの帯も測る。

for (const width of WIDTHS) {
  test.describe(`代理店ロールの店舗一覧（幅 ${width}）`, () => {
    test.use({ viewport: { width, height: VIEWPORT_HEIGHT } });

    test(`[R2] 代理店ロールの帯（幅 ${width}）: 操作要素すべてに捲らずに届く`, async ({ page }) => {
      await openStoreListAsAgency(page);
      await expectLayoutWidth(page, width);

      const report = await readNavReach(page, width);
      // ロールの表示が「代理店」であることで、役割の差し替えが効いたことを裏取りする。
      expect(
        report.texts.map((text) => text.text),
        '代理店ロールで開けていない（ロールの表示が「代理店」でない）',
      ).toContain('代理店');
      // 管理メニュー 2 件が消えるので、リンク 3 本 + ログアウト 1 件。
      expect(report.controls.length, '帯の操作要素の数が宣言と違う').toBe(4);
      expect(
        report.controls.filter((control) => !control.inside).map((control) => control.name),
        `幅 ${width} で、捲らないと届かない帯の操作要素がある`,
      ).toEqual([]);
      expect(
        report.texts.filter((text) => !text.inside).map((text) => text.text),
        '帯の中で切れている文字がある',
      ).toEqual([]);
    });
  });
}

// --- 空振り対照 -------------------------------------------------------------------------
//
// 検出そのものが働いていることを、**実行時に欠陥を注入して**確かめる。製品コードへフックは
// 作らない（@fwlm/ui の token-scales が採る注入対照と同じ思想）。
//
// 幅 1280 で行うのは、この幅では製品が是正の前後どちらでも健全であり（帯は 1 段・表は容器に
// 収まる）、**対照が製品の状態に依存しない**ためである。注入は先頭と末尾の 2 箇所で試す。

test.describe('検出の空振り対照', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  const openUsers = async (page: Page) => {
    const surface = DASHBOARD_SURFACES.find((candidate) => candidate.where === '利用者管理')!;
    await surface.open(page);
  };

  test('[R1 対照] 列を細らせると、その列のセルだけが縦並びとして検出される', async ({ page }) => {
    await openUsers(page);
    const clean = verticalCells(await readCellWrapping(page), MIN_VERTICAL_LINES);
    expect(clean, '広い幅では縦に並ぶセルが無いこと（対照の前提）').toEqual([]);

    for (const column of [1, 6]) {
      await page.addStyleTag({
        content: `table tr > *:nth-child(${column}) { max-width: 6px !important; white-space: normal !important; word-break: break-all !important; }`,
      });
      const detected = verticalCells(await readCellWrapping(page), MIN_VERTICAL_LINES);
      expect(
        detected.length,
        `${column} 列目を細らせても縦並びとして検出されない（検出が空振りしている）`,
      ).toBeGreaterThan(0);
      await page.reload();
      await openUsers(page);
    }
  });

  test('[R2 対照] 帯のリンクを押し出すと届かないと判定され、覆いを載せると当たらなくなる', async ({
    page,
  }) => {
    await openUsers(page);
    const clean = await readNavReach(page, 1280);
    expect(
      clean.controls.filter((control) => !control.inside || !control.hit),
      '広い幅では帯の操作要素すべてに届くこと（対照の前提）',
    ).toEqual([]);

    for (const position of ['first', 'last'] as const) {
      await page.addStyleTag({
        content: `nav[aria-label="メインナビゲーション"] li:${position}-child { margin-left: 4000px !important; }`,
      });
      const pushed = await readNavReach(page, 1280);
      expect(
        pushed.controls.filter((control) => !control.inside).length,
        `${position} のリンクを押し出しても、届かないと判定されない`,
      ).toBeGreaterThan(0);
      await page.reload();
      await openUsers(page);
    }

    // 幾何とは別の式での裏取り。透明な覆いは矩形を動かさないので、当たり判定だけが落ちる。
    await page.addStyleTag({
      content:
        'body::after { content: ""; position: fixed; inset: 0; z-index: 9999; background: transparent; }',
    });
    const covered = await readNavReach(page, 1280);
    expect(
      covered.controls.filter((control) => control.hit).length,
      '透明な覆いを載せても当たり判定が落ちない（elementFromPoint の裏取りが働いていない）',
    ).toBe(0);
    expect(
      covered.controls.filter((control) => !control.inside),
      '透明な覆いは矩形を動かさないので、幾何の判定は変わらないこと',
    ).toEqual([]);
  });

  test('[R3 対照] 端に描いた背景だけが、その端の帯の差として現れる', async ({ page }) => {
    await openUsers(page);
    // 広い幅では表が収まるので、対照のために容器を溢れさせる。
    await page.addStyleTag({ content: 'table { min-width: 2400px !important; }' });

    for (const side of ['right', 'left'] as const) {
      await page.addStyleTag({
        content:
          `[data-slot="table-container"] { background-image: linear-gradient(to ${side === 'right' ? 'left' : 'right'}, ` +
          'rgba(0,0,0,0.25), transparent) !important; background-size: 16px 100% !important; ' +
          `background-position: ${side} center !important; background-repeat: no-repeat !important; ` +
          'background-attachment: scroll !important; }',
      });
      const containers = await markPannableContainers(page);
      const table = containers.find((container) => container.label === '利用者一覧');
      expect(table?.overflowing, '対照のために溢れさせた容器が見つからない').toBe(true);
      const bands = await measureCueBands(page, table!.probeId, 'start');
      expect(
        bands[side].changed,
        `${side} 端に描いた背景が、その端の帯の差として現れない（比較が向きを取り違えている）`,
      ).toBeGreaterThan(0);
      expect(
        bands[side === 'right' ? 'left' : 'right'].changed,
        `${side} 端に描いた背景が、反対側の帯にも差として現れる`,
      ).toBe(0);
      expect(bands.center.changed, '端に描いた背景が中央にも現れる').toBe(0);
      await page.reload();
      await openUsers(page);
      await page.addStyleTag({ content: 'table { min-width: 2400px !important; }' });
    }
  });
});

test.describe('行直下のパネルの検出の空振り対照', () => {
  test.use({ viewport: { width: 393, height: VIEWPORT_HEIGHT } });

  test('[R4 対照] 包みの追従を外すと、捲り切った状態で見えない部分が現れる', async ({ page }) => {
    const surface = DASHBOARD_SURFACES.find(
      (candidate) => candidate.where === USER_EDIT_PANEL.where,
    )!;
    await surface.open(page);

    await page.addStyleTag({
      content: '[data-slot="card"] { position: static !important; }',
    });
    // 包みそのものの追従を外す（sticky を与えているのは包みで、カードではない）。
    await page.evaluate(() => {
      for (const element of Array.from(document.querySelectorAll('td > div'))) {
        (element as HTMLElement).style.position = 'static';
      }
    });
    await USER_EDIT_PANEL.region(page).evaluate((container) => {
      container.scrollLeft = container.scrollWidth - container.clientWidth;
    });

    // **判定は本番と同じ関数を通す。** 以前はこの式をここへ書き写していたため、本番の判定を
    // 潰しても対照が緑のまま通った（PR #284 のレビューで実測）。対照が守れていたのは計測だけで、
    // 判定は誰にも守られていなかった。
    const placement = await readPanelPlacement(page, USER_EDIT_PANEL);
    const outside = partsOutsideScrollport(placement);
    expect(
      outside.length,
      '包みの追従を外して捲り切っても、見えている矩形の外へ出た部分が検出されない（検出が空振りしている）',
    ).toBeGreaterThan(0);
  });
});
