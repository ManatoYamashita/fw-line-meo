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

/**
 * axe の 1 件の「判定不能」（報告と理由の判別に必要な最小形）。
 *
 * 理由は節点ごとの各 check の `data.messageKey` に入る。規則の単位では区別できないので、
 * 節点まで降りて読む。
 */
interface Incomplete {
  readonly id: string;
  readonly nodes: readonly {
    readonly target: readonly unknown[];
    readonly any?: readonly { readonly data?: { readonly messageKey?: string } | null }[];
    readonly all?: readonly { readonly data?: { readonly messageKey?: string } | null }[];
    readonly none?: readonly { readonly data?: { readonly messageKey?: string } | null }[];
  }[];
}

/**
 * 「背景の色を決められなかった」を意味する axe の理由（axe-core 4.13.0 の原文で確認）。
 *
 *   bgImage    — background color could not be determined due to a background image
 *   bgGradient — background color could not be determined due to a background gradient
 *
 * **背景以外の理由（要素の重なり・前景の不透明度など）は入れない。** それらはこの仕掛けとは
 * 無関係の現象で、巻き込むと「関係ない理由で赤い網」になり、いずれ外される。
 */
const BACKGROUND_UNDECIDABLE_KEYS: ReadonlySet<string> = new Set(['bgImage', 'bgGradient']);

/** 背景の画像・グラデーションを理由に判定を降ろされた節点を、規則名つきで列挙する。 */
function undecidableByBackground(incomplete: readonly Incomplete[]): readonly string[] {
  const found: string[] = [];
  for (const entry of incomplete) {
    for (const node of entry.nodes) {
      const checks = [...(node.any ?? []), ...(node.all ?? []), ...(node.none ?? [])];
      if (checks.some((check) => BACKGROUND_UNDECIDABLE_KEYS.has(check?.data?.messageKey ?? ''))) {
        found.push(`${entry.id}: ${node.target.join(' ')}`);
      }
    }
  }
  return found;
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
 * 一覧表の捲れる手がかりの濃淡を、監査の間だけ外す（Issue #283）。
 *
 * **これは監査を緩める操作ではなく、縮んだ網を戻す操作である。** axe の `color-contrast` は、
 * 背景に画像（グラデーションを含む）を持つ祖先の下にある文字を「判定不能」へ回す。表の容器へ
 * 濃淡を入れた結果、それまで評価されていた**表のセルの文字が丸ごと監査の外へ出た**
 * （実測: 幅 393 の店舗一覧で、合格 24 件のうち表のセル 14 件が判定不能へ移った）。
 *
 * 濃淡を外した状態の監査は「文字色そのもの」を評価する。濃淡が最も濃い点に重なったときの
 * 合成後の比は、`ts/packages/ui/test/contrast-usage.test.ts` が静的に固定している
 * （docs/design/design-language.md 7.18）。2 つで、実際に描かれる範囲の両端を押さえる。
 *
 * **表の中へ新しい文字色を足すときは、静的検証の側にもその組を足すこと。** ここで外して
 * いる以上、濃淡の上での比は監査からは見えない。
 *
 * **この関数が効いていることは、下の「判定から外れた節点」の表明だけが守っている。** 外す側と
 * 製品側をつないでいるのは上の属性名の文字列 1 つだけなので、それが無いと改名・移動・注入の失敗が
 * すべて無言で通る（Issue #283 のレビューで実測: 属性名を差し替えても 8 面すべて緑だった）。
 */
async function neutralizeScrollCue(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '[data-slot="table-container"]{background-image:none !important}',
  });
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
  await neutralizeScrollCue(page);
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

  // 上の 2 つは、**網が縮む壊れ方に対して構造的に反応しない**（Issue #283）。
  // 判定を降ろされた節点は違反にも合格にも数えられないので違反 0 件は変わらず、直前の合計は
  // 規則の単位で数えているため、節点が合格から判定不能へ移っても値が動かない。実測では、
  // 幅 393 の店舗一覧でコントラストの判定対象 24 節点のうち 14、利用者管理では 36 のうち 15 が
  // 判定不能へ移った状態で、このファイルの表明が 1 つも反応しなかった。
  //
  // したがって **neutralizeScrollCue が効いていることは、ここでしか確かめられない。** 外す側と
  // 製品側をつないでいるのは属性名の文字列 1 つだけで、改名・移動・注入の失敗のいずれでも黙って
  // 何もしなくなる。結果（判定から外れた節点があるか）を見ることで、原因が何であれ赤くする。
  expect(
    undecidableByBackground(results.incomplete as unknown as readonly Incomplete[]),
    '背景の画像・グラデーションのために、コントラストの判定から外れた要素があります。' +
      '違反 0 件のまま監査の網だけが縮んだ状態です（表の捲れる手がかりを外す neutralizeScrollCue が' +
      '効いていない、または新しい背景が監査対象の上に載っています）',
  ).toEqual([]);
}
