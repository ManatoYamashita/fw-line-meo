import { test, expect } from '@playwright/test';
import { expectNoHorizontalScroll } from '@fwlm/e2e-support/viewport';

import { DASHBOARD_SURFACES } from './fixtures/api';
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
// 捲れる領域の宣言件数は面ごとに異なる。帯を描く 6 面は帯の案内リストで 1 件（task 2.1）、
// 店舗一覧・招待コード・代理店管理・利用者管理はさらに表の容器で 1 件（task 2.3 / 2.4 / 2.5）、
// 帯も表も持たないログイン画面は 0 件である。**店舗登録は表を持たない**ので帯の 1 件だけである
// （候補一覧は押しボタンの並びであって表ではない）。
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
// **面ごとに足す。** 表を持たない面（ログイン・店舗登録）はこれを足さない。
const TABLE_SCROLL_REGIONS = 1;

test('モバイルビューポートの店舗一覧で横スクロールが発生しない', async ({ page }) => {
  await surfaceByName('店舗一覧').open(page);
  // 帯 1 件 + 表 1 件。
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
  // 同じ面の後続状態なので、捲れる領域は帯 1 件 + 表 1 件のまま。**掲示面は領域を増やさない**
  // （QR 画像は `max-w-full` で端末幅に収まり、文言は折り返す）。増えればここが赤くなる。
  await expectNoHorizontalScroll(
    page,
    '店舗一覧の QR パネル',
    NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS,
  );
});

test('モバイルビューポートの代理店管理で横スクロールが発生しない', async ({ page }) => {
  await surfaceByName('代理店管理').open(page);
  // 帯 1 件 + 表 1 件（task 2.4 で `TableContainer` へ移った）。
  await expectNoHorizontalScroll(page, '代理店管理', NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS);
});

// 招待コードは task 2.4 まで下の「既知の溢れ」に登録されていた。素の `<select>` を
// `@fwlm/ui` の `Select`（`w-full min-w-0` を持つ）へ移して溢れが解消したため、通常の面へ戻した。
// **移動は自発ではなく強制である。** 是正した状態で走らせると 網 1 が
// 「招待コード: 溢れが解消している（Expected: > 394 / Received: 393）」と赤を出し、
// 宣言の更新を要求した。
test('モバイルビューポートの招待コードで横スクロールが発生しない', async ({ page }) => {
  await surfaceByName('招待コード').open(page);
  // 帯 1 件 + 表 1 件。
  await expectNoHorizontalScroll(page, '招待コード', NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS);
});

// 利用者管理は task 2.5 まで「既知の溢れ」（Issue #186）に登録されていた。素の `<select>` 2 つを
// `@fwlm/ui` の `Select`（`w-full min-w-0` を持つ）へ移して溢れが解消したため、通常の面へ戻した。
// **移動は自発ではなく強制である。** 是正した状態で走らせると、溢れの理由を固定していた網が
// 「利用者管理: 溢れが解消している（Expected: > 394 / Received: 393）」と赤を出し、宣言の更新を要求した。
test('モバイルビューポートの利用者管理で横スクロールが発生しない', async ({ page }) => {
  await surfaceByName('利用者管理').open(page);
  // 帯 1 件 + 表 1 件。
  await expectNoHorizontalScroll(page, '利用者管理', NAV_SCROLL_REGIONS + TABLE_SCROLL_REGIONS);
});

// 店舗登録は Issue #186 の**最後の 1 面**であり、task 5.2 が `@fwlm/ui` の `Select` へ移して
// 是正した。是正前は素の `<select>` が最長の選択肢の幅まで伸びて 472px（端末幅 393px）だった。
//
// **この面には表が無い。** 候補一覧は押しボタンの並びであって `TableContainer` を通らないので、
// 捲れる領域は帯の 1 件だけである。task 2.3 / 2.4 / 2.5 と件数が違うのはそのためであり、
// 書き写しの誤りではない。
//
// 是正を検出したのは「既知の溢れ」の 2 枚の網の**両方**である（下の「畳んだ理由」を参照）。
test('モバイルビューポートの店舗登録で横スクロールが発生しない', async ({ page }) => {
  await surfaceByName('店舗登録').open(page);
  // 帯 1 件のみ（表を持たない）。
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
