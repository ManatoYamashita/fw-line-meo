import { test, expect } from '@playwright/test';
import { deviceWidthOf, expectNoHorizontalScroll } from '@fwlm/e2e-support/viewport';

import { DASHBOARD_SURFACES } from './fixtures/api';
import {
  expectPanelInsideScrollport,
  readPanelPlacement,
  USER_EDIT_PANEL,
} from './support/panel-placement';
// 文言の実値は面にもテストにも書かない。**実物の正典を読む**（写すと片方だけが古びる）。
import { POSTER_INVITATION, PROHIBITED_EXAMPLES } from '../src/lib/qr-poster-text';

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
// 捲れる領域の宣言件数は面ごとに異なる。表を持つ 5 面は表の容器で 1 件（task 2.3 / 2.4 / 2.5）、
// 表を持たない面（ログイン・店舗登録）は 0 件である（店舗登録の候補一覧は押しボタンの並びであって
// 表ではない）。**帯はどの面でも 0 件である**（Issue #283 で 2 段へ改めた・下の宣言を参照）。
// 宣言と実測が食い違えば赤くなり、宣言の更新が強制される。**それが件数宣言の本来の働きである。**
// （task 2.3 / 2.4 / 2.5 では実際にそう起きた: 宣言 1 に対して実測 2 で赤くなり、下の宣言を書き足した。）

/**
 * 面の起動と描画前提は fixtures/api.ts が単一所有する。
 *
 * 面名の誤りはテスト定義の不整合なので、未知の面を黙ってスキップせず即時に失敗させる。
 */
function surfaceByName(where: string) {
  const surface = DASHBOARD_SURFACES.find((candidate) => candidate.where === where);
  if (!surface) {
    throw new Error(`fixture 未定義の面: ${where}`);
  }
  return surface;
}

// --- 溢れていない面 --------------------------------------------------------------------

// 帯（components/top-nav.tsx）は捲れる領域を持たない（Issue #283）。
//
// task 2.1 の時点では、携帯端末幅にワードマーク・案内 5 件・ロール・ログアウトが 1 段で収まらず、
// 溢れを案内リストの内部へ閉じる形を「唯一の解」として選んでいた。**それは誤りだった。**
// リストの中の捲りには手がかりが無く、画面の外の案内リンク（実測で幅 393 のとき 389px・
// 320 のとき 418px 分）は利用者にとって存在しないのと同じだった。狭い画面で 2 段に組み、
// リンクを折り返して全部見せる形へ改めた（docs/design/design-language.md 7.8 節）。
//
// 宣言を 0 にすることが、捲りが戻ってきたときに赤くなる網である。帯のリンクが画面の中にあることの
// 実測は mobile-layout.spec.ts の R2 が受け持つ（帯の有無も、そちらが操作要素の数で測る）。
const NAV_SCROLL_REGIONS = 0;

// 一覧を `@fwlm/ui` の `TableContainer` へ移した面は、表 1 つにつき捲れる領域が 1 件増える
// （ui-airbnb-surfaces task 2.3）。要件 2.5 が「一覧の内部だけを横にたどれる状態にし、
// ページ全体を横に溢れさせない」と定めており、これは事故ではなく設計どおりの 1 件である。
// 容器は表の外側にあり、内側を免除しても容器自身の右端は依然として端末幅と比べられる。
//
// **面ごとに足す。** 表を持たない面（ログイン・店舗登録）はこれを足さない。
const TABLE_SCROLL_REGIONS = 1;

test('モバイルビューポートの店舗一覧で横スクロールが発生しない', async ({ page }) => {
  await surfaceByName('店舗一覧').open(page);
  // 表の容器 1 件（帯は捲れる領域を持たない）。
  await expectNoHorizontalScroll(page, '店舗一覧', NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS);
});

// --- 店頭掲示の印刷（Issue #179・Requirement 7） --------------------------------------
//
// 印刷の体裁は **CSS が実行時に解決する**ため、クラス名の検証では届かない。`@media print` は
// 画面の描画に一切現れず、単体テストの jsdom も印刷メディアを持たない。実測でしか測れない。
//
// **不可の例が紙に出ないことがこの機能の核心である。** 掲示物に「星5でお願いします」と
// 印刷された紙が生まれると、この機能が防ごうとした違反そのものを製品が配ることになる。
test.describe('店頭掲示の印刷', () => {
  test('印刷時は掲示面だけが残り、不可の例と操作要素は紙に出ない', async ({ page }) => {
    await surfaceByName('店舗一覧の QR パネル').open(page);

    await page.emulateMedia({ media: 'print' });

    // 残るもの: 掲示面と、その中の依頼文。
    await expect(page.locator('[data-print-region]')).toBeVisible();
    await expect(page.getByText(POSTER_INVITATION)).toBeVisible();

    // 消えるもの: 不可の例（全件）と、パネルの操作要素。
    for (const example of PROHIBITED_EXAMPLES) {
      await expect(
        page.getByText(example.text, { exact: false }),
        `不可の例が紙に出ています: ${example.text}`,
      ).toBeHidden();
    }
    await expect(page.getByRole('button', { name: /掲示物を印刷/ })).toBeHidden();
    await expect(page.getByRole('link', { name: /QR 画像を保存/ })).toBeHidden();

    // **対照。** 画面へ戻すと同じ要素が見える。これが無いと「そもそも描画されていないから
    // 隠れて見えるだけ」の状態と区別が付かない（`@media print` を丸ごと消しても、
    // 不可の例を描画しなくすれば上の assert は緑になってしまう）。
    await page.emulateMedia({ media: 'screen' });
    for (const example of PROHIBITED_EXAMPLES) {
      await expect(
        page.getByText(example.text, { exact: false }),
        `不可の例が画面にも出ていません: ${example.text}`,
      ).toBeVisible();
    }
    await expect(page.getByRole('button', { name: /掲示物を印刷/ })).toBeVisible();
  });

  // **この規則は全ルートへ効く。** globals.css は app/layout.tsx 経由で読み込まれるため、
  // 掲示面を持たない面にも当たる。鍵（`body:has([data-print-region])`）を外すと、
  // それらの面の印刷が**全ページ白紙**になる。実測では `/stores` の PDF の content stream が
  // 107 バイト（描画命令ゼロ）まで落ちた。掲示物を配る機能が無関係な 6 面の印刷を壊す形で、
  // レビューで検出した。**掲示面を開いた状態しか測らないと、この経路には網が無い。**
  test('掲示面を持たない面の印刷を壊さない（規則の入口が閉じている）', async ({ page }) => {
    await surfaceByName('店舗一覧').open(page); // QR パネルを開かない
    await page.emulateMedia({ media: 'print' });

    await expect(
      page.getByRole('heading', { level: 1, name: '店舗一覧' }),
      '掲示面を持たない面の見出しが紙に出ません（全ページ白紙になります）',
    ).toBeVisible();
    await expect(page.getByRole('table'), '掲示面を持たない面の一覧が紙に出ません').toBeVisible();
  });

  // 行の直下のパネルは、画面では捲り容器の見えている幅に留めるために、容器の左端から 1rem の
  // 位置へ sticky で置き、幅も見えている幅から左右 1rem を引いてある（`TableDetailRow`）。
  // **紙の上ではこの包みを外さなければならない。** 印刷の規則が戻すのは祖先の display と余白・枠・
  // 背景だけで、位置と幅には触れないためである。外さないと掲示面が紙の左から 1rem ずれ、幅も
  // 2rem 狭くなる（実測: 幅 393 で left 16 / width 361 ＝ 版面は left 0 / width 393）。
  test('印刷時は掲示面が版面の左端から始まり、幅も版面と一致する', async ({ page }) => {
    await surfaceByName('店舗一覧の QR パネル').open(page);
    await page.emulateMedia({ media: 'print' });

    const geometry = await page.evaluate(() => {
      const region = document.querySelector('[data-print-region]')!.getBoundingClientRect();
      const body = document.body.getBoundingClientRect();
      return {
        left: Math.round((region.left - body.left) * 100) / 100,
        widthGap: Math.round((body.width - region.width) * 100) / 100,
      };
    });

    expect(
      geometry.left,
      '掲示面が紙の左端からずれています（行の直下のパネルの包みが印刷でも効いています）',
    ).toBeLessThanOrEqual(1);
    expect(
      geometry.widthGap,
      '掲示面の幅が版面より狭くなっています（包みの幅指定が印刷でも効いています）',
    ).toBeLessThanOrEqual(1);
  });

  // `visibility: hidden` で隠すと箱が残り、紙は一覧の高さぶん生成されて 2 枚目以降が白紙になる
  // （実測: 店舗 40 件で body 3014px・A4 で 3 ページ）。**畳めていることを高さで測る。**
  test('掲示面のある面では外側が箱ごと畳まれる（白紙のページを後続させない）', async ({ page }) => {
    await surfaceByName('店舗一覧の QR パネル').open(page);

    // **掲示面の祖先は畳まない**（畳むと掲示面ごと消える）。QR パネルは対象行の直下に挿入される
    // ため、`<table>` も `<tbody>` も祖先であり残る。畳まれるのは祖先でない兄弟のほうなので、
    // 主見出し（版面の直下にあり掲示面の祖先ではない）で測る。
    const measure = () =>
      page.evaluate(() => ({
        body: Math.round(document.body.getBoundingClientRect().height),
        heading: getComputedStyle(document.querySelector('h1')!).display,
      }));

    const onScreen = await measure();
    await page.emulateMedia({ media: 'print' });
    const onPaper = await measure();

    expect(onScreen.heading, '画面で主見出しが畳まれています（対照が成立しません）').not.toBe('none');
    expect(
      onPaper.heading,
      '印刷時に主見出しが箱ごと畳まれていません（visibility だけでは箱が残ります）',
    ).toBe('none');
    expect(
      onPaper.body,
      `印刷時に body の高さが縮んでいません（画面 ${onScreen.body}px / 紙 ${onPaper.body}px）。` +
        '高さが残ると、その分だけ白紙のページが後続します',
    ).toBeLessThan(onScreen.body);
  });
});

test('モバイルビューポートの QR パネルで横スクロールが発生しない', async ({ page }) => {
  await surfaceByName('店舗一覧の QR パネル').open(page);
  // 同じ面の後続状態なので、捲れる領域は表の容器 1 件のまま。**掲示面は領域を増やさない**
  // （QR 画像は `max-w-full` で端末幅に収まり、文言は折り返す）。増えればここが赤くなる。
  await expectNoHorizontalScroll(
    page,
    '店舗一覧の QR パネル',
    NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS,
  );
});

test('モバイルビューポートの代理店管理で横スクロールが発生しない', async ({ page }) => {
  await surfaceByName('代理店管理').open(page);
  // 表の容器 1 件（task 2.4 で `TableContainer` へ移った）。
  await expectNoHorizontalScroll(page, '代理店管理', NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS);
});

// 招待コードは task 2.4 まで下の「既知の溢れ」に登録されていた。素の `<select>` を
// `@fwlm/ui` の `Select`（`w-full min-w-0` を持つ）へ移して溢れが解消したため、通常の面へ戻した。
// **移動は自発ではなく強制である。** 是正した状態で走らせると 網 1 が
// 「招待コード: 溢れが解消している（Expected: > 394 / Received: 393）」と赤を出し、
// 宣言の更新を要求した。
test('モバイルビューポートの招待コードで横スクロールが発生しない', async ({ page }) => {
  await surfaceByName('招待コード').open(page);
  // 表の容器 1 件。
  await expectNoHorizontalScroll(page, '招待コード', NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS);
});

// 利用者管理は task 2.5 まで「既知の溢れ」（Issue #186）に登録されていた。素の `<select>` 2 つを
// `@fwlm/ui` の `Select`（`w-full min-w-0` を持つ）へ移して溢れが解消したため、通常の面へ戻した。
// **移動は自発ではなく強制である。** 是正した状態で走らせると、溢れの理由を固定していた網が
// 「利用者管理: 溢れが解消している（Expected: > 394 / Received: 393）」と赤を出し、宣言の更新を要求した。
test('モバイルビューポートの利用者管理で横スクロールが発生しない', async ({ page }) => {
  await surfaceByName('利用者管理').open(page);
  // 表の容器 1 件。
  await expectNoHorizontalScroll(page, '利用者管理', NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS);
});

// 編集パネルを開いた状態（dashboard-user-edit Req 6.9・Issue #259）。
test('モバイルビューポートの利用者管理の編集パネルで横スクロールが発生しない', async ({ page }) => {
  await surfaceByName('利用者管理の編集パネル').open(page);
  // 同じ面の後続状態なので、捲れる領域は表の容器 1 件のまま。パネルは表の捲れる容器の内側へ
  // 挿入されるので、領域を増やさない。増えればここが赤くなる。
  //
  // **この実測が見るのはページ全体のはみ出しだけである。** 容器の内側は免除されるので、
  // パネルの中身（入力の右端など）が容器の内側で画面外へ溢れても、ここは赤にならない。
  // パネルの中身の網は、下の「捲り容器の見えている矩形」の実測が受け持つ。
  await expectNoHorizontalScroll(
    page,
    '利用者管理の編集パネル',
    NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS,
  );
});

// --- 携帯端末の幅での編集パネルの配置（dashboard-user-edit Req 6.8, 6.9・Issue #259）----------
//
// 上の横スクロールの実測は、捲り容器の**内側**を免除する。免除しなければ表の容器を持つ面が
// すべて赤になるからだが、その代わり、容器の内側でパネルが見える幅の外へ出ても、どこも赤にならない。
// 実際、この実測を足す前は、行末の編集を押すと容器が捲れ、保存が画面の左外に出ていた
// （Pixel 5 で表 462px・見える幅 361px）。Tab で保存へ焦点を載せても見えるのは 3px で（WCAG 2.4.7）、
// フォームを使うのに横の捲りが要った（WCAG 1.4.10。データ表の例外はフォームには及ばない）。
//
// そこで、パネルのカードと、その中の見出し・操作要素が、捲り容器の**見えている矩形**
// （スクロールポート）の内側にあることを直接測る。見る状態は 3 つ。編集の押下で容器が捲れた状態・
// 捲り位置 0 の状態・Tab で保存へ焦点を載せた状態である。
//
// あわせて、**カードの子孫（要素と文字列）がカードの内側にあること**も測る。カードは溢れを切り取る
// （`overflow: hidden`）ので、カードが見えていても、中身がカードの縁を越えればその分は読めない。
// 幅を容器の見えている幅に固定したことで、この経路が生まれた。区切りの無いメールアドレスの見出しは、
// grid の項目の最小幅（語の全長）までしか縮まず、カードの外へ出ていた（38 字のアドレスで、Pixel 5 では
// カードの縁を 6px 越え、320px 幅では見えている矩形の外へ 63px 出た）。sticky は捲りに追従するので、
// 容器を捲っても読めない（tasks 3.5 の独立レビュー）。fixture のメールアドレスが区切りを持たないのは、
// この経路を通すためである。
//
// **axe では代用できない。** axe は捲り容器の外へ出た要素を黙って評価の対象から外す
// （捲り位置しだいで、保存のコントラストが評価されていなかった）。パネルが見える幅の外へ出ても、
// 見出しがカードの縁で切れても、a11y 監査は緑のままであることを、配置を壊す変異で実測している
// （dashboard-user-edit tasks 3.5）。

test.describe('モバイルビューポートの利用者管理の編集パネルは捲り容器の見えている矩形に収まる', () => {
  test.beforeEach(async ({ page }) => {
    // 携帯端末の幅で走っていることの前置き（広い幅では表が容器に収まり、捲れた状態を作れない）。
    deviceWidthOf(page);
    await surfaceByName('利用者管理の編集パネル').open(page);
  });

  test('編集の押下で捲れた状態と、捲り位置 0 の状態の両方で、カードと操作要素が見えている', async ({
    page,
  }) => {
    const scrolled = await readPanelPlacement(page, USER_EDIT_PANEL);
    // 前提: 表が容器より広く、編集の押下で容器が実際に捲れている。表が容器に収まるようになると
    // 「捲れた状態」を作れず、この実測は何も測らなくなる。そのときは緑にせず、ここで止める。
    expect(
      scrolled.scrollWidth,
      '表が捲り容器に収まっています（捲れた状態を作れないので、この実測は成り立ちません）',
    ).toBeGreaterThan(scrolled.clientWidth);
    expect(scrolled.scrollLeft, '編集の押下で捲り容器が捲れていません').toBeGreaterThan(0);
    expectPanelInsideScrollport(scrolled, '編集の押下で捲れた状態', USER_EDIT_PANEL);

    await USER_EDIT_PANEL.region(page).evaluate((container) => {
      container.scrollLeft = 0;
    });
    const initial = await readPanelPlacement(page, USER_EDIT_PANEL);
    expect(initial.scrollLeft, '捲り位置を 0 へ戻せていません').toBe(0);
    expectPanelInsideScrollport(initial, '捲り位置 0 の状態', USER_EDIT_PANEL);
  });

  test('Tab で保存へ焦点を載せたとき、保存が見えている', async ({ page }) => {
    // 編集ボタン（パネルを開いた押しボタン）から、キーボードだけで保存まで進む。行の残りの押しボタンと
    // パネルの入力を順に通るので、押す回数は構成で変わる。上限を置き、届かなければ止める。
    const save = USER_EDIT_PANEL.region(page).getByRole('button', { name: '保存', exact: true });
    await USER_EDIT_PANEL.trigger(page).focus();
    for (let presses = 0; presses < 10; presses += 1) {
      if (await save.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(save, 'Tab を 10 回押しても保存へ焦点が届いていません').toBeFocused();

    expectPanelInsideScrollport(
      await readPanelPlacement(page, USER_EDIT_PANEL),
      'Tab で保存へ焦点を載せた状態',
      USER_EDIT_PANEL,
    );
  });
});

// 店舗登録は Issue #186 の**最後の 1 面**であり、task 5.2 が `@fwlm/ui` の `Select` へ移して
// 是正した。是正前は素の `<select>` が最長の選択肢の幅まで伸びて 472px（端末幅 393px）だった。
//
// **この面には表が無い。** 候補一覧は押しボタンの並びであって `TableContainer` を通らないので、
// 捲れる領域は 0 件である。表を持つ面と件数が違うのはそのためであり、書き写しの誤りではない。
//
// 是正を検出したのは「既知の溢れ」の 2 枚の網の**両方**である（下の「畳んだ理由」を参照）。
test('モバイルビューポートの店舗登録で横スクロールが発生しない', async ({ page }) => {
  await surfaceByName('店舗登録').open(page);
  // 0 件（表も捲れる帯も持たない）。
  await expectNoHorizontalScroll(page, '店舗登録', NAV_SCROLL_REGIONS);
});

test('モバイルビューポートのログイン画面で横スクロールが発生しない', async ({ page }) => {
  await surfaceByName('ログイン').open(page);
  await expectNoHorizontalScroll(page, 'ログイン', 0);
});

// --- 「既知の溢れ」の節を畳んだ理由（Issue #186 の完了）--------------------------------
//
// task 2.5 の時点で `KNOWN_OVERFLOW_SURFACES` に残っていたのは店舗登録 1 面だけだった。
// task 5.2 がそれを是正したので、**節ごと削除した**（型・配列・2 枚の網の 4 つ）。
//
// **配列だけを空にして節を残してはならない。** 網 1 の末尾は
// `expect(observed.length).toBe(KNOWN_OVERFLOW_SURFACES.length)` であり、空配列では
// `0 === 0` で緑になる。`for` ループは 1 度も回らず、**何も走査しないまま通る**。
// これは要件 7.4 が塞ごうとしている「走査対象 0 件で緑」そのものであり、
// 節を残すことは網を残すことではない。存在理由が消えた以上、節ごと畳むのが正しい。
//
// **是正時の実測（task 2.4 / 2.5 との差が意味を持つ）。** 宣言を更新しないまま走らせると:
//
//   網 1（溢れの主が SELECT であることの固定）  → 赤。
//       「店舗登録: 溢れが解消している（Expected: > 394 / Received: 393）」
//   網 2（`test.fail` で本番の判定を当てる）    → **赤。「Expected to fail, but passed.」**
//
// task 2.4 / 2.5 では網 2 が `✘` のまま偽緑だった。差の原因は
// **同じ作業で `TableContainer` が捲れる領域を 1 件増やしていたこと**にある。件数の食い違いで
// `expectNoHorizontalScroll` が別の理由で落ち続け、`test.fail` の「何らかの理由で落ちた」を
// 満たしてしまっていた。店舗登録は表を持たず領域が増えないため、判定が素直に通って
// `test.fail` が発火した。
//
// つまり `test.fail` の偽緑は `test.fail` 単独の性質ではなく、**別の失敗が同時に供給されたとき**に
// 起きる。供給源が無ければ発火する。どちらにせよ「既知の失敗を宣言するときは、失敗の**理由**を
// 固定する第 2 の網を対で置く」という規律は変わらない（理由を固定する網だけが、
// 何が直ったのかを名指しできる）。

// --- 幅 320 でのページ全体のはみ出し（Issue #283）--------------------------------------
//
// 上の実測は project の既定（Pixel 5・幅 393）だけで走る。実機には 320px 幅の端末があり、
// 帯を 2 段に組んだことで 1 段目の収まりは**幅に依存する**ようになった（ワードマーク・ロール・
// ログアウトが 1 行に並ぶ）。幅 393 で収まっていることは 320 で収まっていることを含まない。
//
// 面ごとの捲れる領域の件数は上の宣言をそのまま使う。件数の正典を 2 箇所に持たないためであり、
// 幅を変えても領域の数は変わらない（変わるなら、それ自体が見つけるべき退行である）。
test.describe('幅 320 でもページ全体が横へはみ出さない', () => {
  test.use({ viewport: { width: 320, height: 720 } });

  const REGIONS: Readonly<Record<string, number>> = {
    店舗一覧: NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS,
    '店舗一覧の QR パネル': NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS,
    代理店管理: NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS,
    ログイン: 0,
    招待コード: NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS,
    利用者管理: NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS,
    '利用者管理の編集パネル': NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS,
    店舗登録: NAV_SCROLL_REGIONS,
  };

  test('宣言が検証面の一覧と一致する', () => {
    expect(DASHBOARD_SURFACES.map((surface) => surface.where)).toEqual(Object.keys(REGIONS));
    // 面の数は literal で持つ。配列の長さどうしを比べると、両方が空でも緑になる。
    expect(Object.keys(REGIONS)).toHaveLength(8);
  });

  for (const surface of DASHBOARD_SURFACES) {
    test(`幅 320 の${surface.where}で横スクロールが発生しない`, async ({ page }) => {
      await surface.open(page);
      await expectNoHorizontalScroll(page, `${surface.where}（320px）`, REGIONS[surface.where]!);
    });
  }
});
