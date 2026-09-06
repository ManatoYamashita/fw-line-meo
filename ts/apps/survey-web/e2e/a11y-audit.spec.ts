import { test } from '@playwright/test';
import { expectNoAxeViolations } from '@fwlm/e2e-support/a11y';

import { openComponentCatalog, openDraftingSurface, openSurveySurface } from './fixtures/surfaces';

// 汎用の自動 a11y 監査（Issue #53）。
//
// 既存の e2e/ui-foundation.spec.ts は「あらかじめ書いた項目」を実測で厳しく確かめる。
// こちらは逆に「誰も書かなかった項目」を axe の汎用規則で拾うのが役目である。両者は
// 置き換え関係ではなく補完関係で、axe が緑でも ui-foundation の実測は必要であり続ける
// （とくにフォーカス指標の視認性は axe に自動規則が無い。理由は @fwlm/e2e-support/a11y に記す）。
//
// 監査対象は 3 面。
//   /ui-check   … @fwlm/ui の全部品を実描画する検証面。部品由来の欠陥はここで出る。
//   /s/{storeId} の回答フェーズ … 実際に客が触る回答画面。面の組み立て方に由来する欠陥が出る。
//   /s/{storeId} の下書きフェーズ … 客が文章を読んで編集し、投稿へ進む画面。
// 部品を足したら /ui-check にも足す規律（同ページ冒頭のコメント）が、この監査の網羅性を支えている。
//
// **下書きフェーズは Issue #179 まで監査対象に入っていなかった。** 同一 URL の後続状態であり、
// `openSurveySurface` は `answering` のままで返すため `DraftPanel` が描画されない。
// 客が最も長く読む画面が、部品カタログにも回答画面にも含まれていなかったことになる。
//
// 面を開く手順と「本体が描けていること」の前提 assert は fixtures/surfaces.ts が持つ。
// **空の画面・エラー画面には違反が出ようがない**ため、a11y 監査こそ前提の固定が要る
// （前提を欠いた版が unavailable 分岐で緑を返すことを実測で確認した。PR #191 のレビュー指摘 1）。

test('部品カタログ面が WCAG A/AA の自動監査を通る', async ({ page }) => {
  await openComponentCatalog(page);
  await expectNoAxeViolations(page);
});

test('客向け回答画面が WCAG A/AA の自動監査を通る', async ({ page }) => {
  await openSurveySurface(page);
  await expectNoAxeViolations(page);
});

test('客向け下書き画面が WCAG A/AA の自動監査を通る', async ({ page }) => {
  await openDraftingSurface(page);
  await expectNoAxeViolations(page);
});
