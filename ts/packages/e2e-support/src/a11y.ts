// 実描画に対する自動 a11y 監査の共有ヘルパ（Issue #53）。
//
// なぜ入れるか: UI 基盤の a11y 検証は手書きの assert しか無く、「書いた項目は守られるが、
// 書かなかった項目は永久に検出されない」構造だった。実際、Issue #49（フォーカス可視性の喪失）と
// Issue #50（アルファ合成色の AA 未達）は CI 全緑のまま main へ入った。axe は「書いていない項目」を
// 汎用規則で拾うのが役目であり、手書きの assert を置き換えるものではない（両者は補完関係）。
//
// **axe の守備範囲を正しく理解して使うこと。** axe が自動で判定できるのは規則化された一部だけで、
// WCAG の全項目を機械判定できるわけではない。とくに本リポジトリで実際に踏んだ 2 件について:
//
//   - Issue #50（コントラスト AA 未達）は axe の `color-contrast` 規則が検出する。
//     axe は算出スタイルではなく**合成後の実効色**を見るため、`/90` のような不透明度付きの
//     指定も対象になる。
//   - Issue #49（フォーカス可視性の喪失）は **axe では検出できない**。フォーカス指標の
//     視認性（WCAG 2.4.7 / 2.4.11）は axe が「手動確認」に分類している領域で、自動規則が無い。
//     この面の担保は e2e/ui-foundation.spec.ts の実測（getComputedStyle で outline を読む）が
//     引き続き負う。**axe を入れたことを理由にその実測を削ってはならない。**
//
// 上の 2 点は推測ではなく、是正前のコードへ実際に当てて確かめた結果である（Issue #53 の
// 完了条件「導入した仕組みが実際に検出できることを実証する」）。
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** 監査対象とする規則群。WCAG 2.1 の A / AA に限定する（AAA は本プロジェクトの目標水準ではない）。 */
const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

/** axe の 1 件の違反（報告に必要な最小形）。 */
interface Violation {
  readonly id: string;
  readonly impact?: string | null;
  readonly help: string;
  readonly nodes: readonly { readonly target: readonly unknown[] }[];
}

/** 違反を人が追える形へ整形する。要素セレクタまで出さないと、どこを直せばよいか分からない。 */
function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) => {
      const targets = v.nodes.map((n) => `      - ${n.target.join(' ')}`).join('\n');
      return `  [${v.impact ?? 'unknown'}] ${v.id}: ${v.help}\n${targets}`;
    })
    .join('\n');
}

/**
 * ページ（または `selector` 配下）へ axe を当て、WCAG A/AA の違反がゼロであることを表明する。
 *
 * `disableRules` は「今は直せないが検出はされている」ものを通すための逃げ道になりうるため、
 * 使う場合は必ず理由と追跡 Issue をコメントで残すこと。既定では 1 件も無効化しない。
 */
export async function expectNoAxeViolations(
  page: Page,
  options: { readonly selector?: string; readonly disableRules?: readonly string[] } = {},
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags([...WCAG_AA_TAGS]);
  if (options.selector !== undefined) builder = builder.include(options.selector);
  if (options.disableRules !== undefined && options.disableRules.length > 0) {
    builder = builder.disableRules([...options.disableRules]);
  }

  const results = await builder.analyze();
  const violations = results.violations as unknown as readonly Violation[];

  expect(
    violations,
    violations.length === 0
      ? 'axe 違反なし'
      : `axe が WCAG A/AA 違反を ${violations.length} 件検出しました:\n${formatViolations(violations)}`,
  ).toHaveLength(0);

  // 0 件が「違反が無い」なのか「そもそも 1 つも規則が走っていない」のかを区別する。
  // include() のセレクタが外れる・スクリプト注入が失敗するといった経路では、axe は
  // 例外ではなく**空の結果**を返しうる。その 0 件を「合格」と読むと、監査していないことが
  // 監査に合格したことと同義になる（本 Issue が問題にした「静かな空振り」そのもの）。
  expect(
    results.passes.length + results.incomplete.length + violations.length,
    'axe の規則が 1 件も評価されていない（監査が空振りしている）',
  ).toBeGreaterThan(0);
}
