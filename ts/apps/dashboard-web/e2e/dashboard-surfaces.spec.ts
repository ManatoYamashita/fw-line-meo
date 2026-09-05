import { test, expect } from '@playwright/test';
import { deviceWidthOf, expectNoHorizontalScroll, readOverflowMetrics } from '@fwlm/e2e-support/viewport';

import { DASHBOARD_SURFACES } from './fixtures/api';

// 管理ダッシュボードの実描画検証（Issue #53）。
//
// 要件 3.3（モバイル端末で横スクロールを発生させずに閲覧・操作できる）を、この面で初めて
// 機械検証する。これまで担保は globals.css の `overflow-x: clip` だけ、すなわち
// 「隠しているので見えない」状態だった。clip は scrollWidth 系の検査を構造的に無効化するため、
// 面の溢れを捕らえる網は要素の実測右端（maxRight）1 本しかない。
//
// 6 面の定義（開く手順と「本体が描けていること」の前提 assert）は fixtures/api.ts が持つ。
// 自動 a11y 監査（a11y-audit.spec.ts）も同じ定義を使うため、面を足せば双方が自動で拾う。
//
// 前提: `E2E_STUB_IDP=1` と `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:3199` を与えて
// ビルドしたものに対して走らせる（playwright.config.ts の説明）。
//
// 捲れる領域の宣言件数は 6 面すべて 0 である。実面の表はまだ素の `<table>` で `TableContainer`
// を通っておらず、`<select>` の計算済み overflow-x は `visible` のため免除対象にならない
// （どちらも実測して 0 と確認した。推測ではない）。`ui-airbnb-surfaces` の task 2.3 / 3.3 が
// 表を容器へ移した時点でこの 0 は実測と食い違って赤くなり、宣言の更新が強制される。
// **それが件数宣言の本来の働きである。**

const OVERFLOWING = DASHBOARD_SURFACES.filter((s) => s.knownOverflow);
const CLEAN = DASHBOARD_SURFACES.filter((s) => !s.knownOverflow);

// --- 溢れていない面 --------------------------------------------------------------------

for (const surface of CLEAN) {
  test(`モバイルビューポートの${surface.where}で横スクロールが発生しない`, async ({ page }) => {
    await surface.open(page);
    await expectNoHorizontalScroll(page, surface.where, 0);
  });
}

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

// 網 1。**この 1 件が緑であることが、下の test.fail 3 件を「既知の溢れ」と読んでよい根拠である。**
test('既知の溢れを持つ 3 面が実描画できており、溢れの主が選択要素である（Issue #186）', async ({ page }) => {
  const observed: string[] = [];

  for (const surface of OVERFLOWING) {
    await surface.open(page);
    const deviceWidth = deviceWidthOf(page);
    const metrics = await readOverflowMetrics(page, 'scroll-container');
    observed.push(`${surface.where}: ${metrics.widest} right=${metrics.maxRight}`);

    expect(
      metrics.maxRight,
      `${surface.where}: 溢れが解消している。是正されたなら knownOverflow の宣言を外し、` +
        `宣言件数を実測へ合わせること（Issue #186 の完了条件）`,
    ).toBeGreaterThan(deviceWidth + 1);
    expect(
      metrics.widest,
      `${surface.where}: 溢れの主が選択要素でなくなった（実測 ${metrics.widest}）。` +
        `別の原因の溢れを「既知の溢れ」として見逃さないための固定である`,
    ).toMatch(/^SELECT\[/);
  }

  // 走査対象が 1 件も無い状態で緑にならないようにする。
  expect(observed.length, `実測: ${observed.join(' / ')}`).toBe(OVERFLOWING.length);
});

// 網 2。本番の判定をそのまま当てる。是正されれば「期待に反して通った」として赤くなる。
for (const surface of OVERFLOWING) {
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
