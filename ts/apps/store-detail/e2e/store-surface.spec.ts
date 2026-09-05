import { test } from '@playwright/test';
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

test('モバイルビューポートの店舗詳細で横スクロールが発生しない', async ({ page }) => {
  await openStoreSurface(page);
  // 捲れる領域は 0。推移表はまだ素の `<table>` で `TableContainer` を通っておらず、この面は
  // 記入欄・押しボタン・選択のいずれも描画しないため（4.2 の no-write 契約）、
  // textarea 由来の領域も存在しない。**実測して 0 と確認した値であり、推測ではない。**
  //
  // ui-airbnb-surfaces の task 3.3 が推移表を容器へ移した時点で、この 0 は実測と食い違って
  // 赤くなり、宣言の更新が強制される。それが件数宣言の本来の働きである。
  await expectNoHorizontalScroll(page, '店舗詳細', 0);
});
