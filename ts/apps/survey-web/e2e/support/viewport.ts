// 端末幅の取得と横スクロール不発生の判定（spec ui-airbnb-surfaces の requirements 4.6）を、
// 面から独立した位置へ切り出したもの。
//
// ui-foundation.spec.ts に埋まっていた実装をそのまま移した。挙動・メッセージ文言・引数の順序は
// 一切変えていない。管理ダッシュボードと店舗詳細に実描画の足場が入った時点で、同じ関数を
// そのまま適用できるようにするための移設である。
//
// 消費者が 1 つの間は共有パッケージにしない（design.md「新規ファイル」節の判断）。
//
// 以下のコメント中の「要件 3.3」は先行 spec ui-design-foundation の番号である（移設前の記述を
// そのまま保っている）。本 spec では同じ要求が 4.6 にあたる。

import { expect, type Page } from '@playwright/test';

/**
 * 端末幅を Playwright の project 設定（devices['Pixel 5']）から取る。
 *
 * ページ側の `window.innerWidth` を基準に使わない。はみ出したときに自動で広がるため、
 * 「はみ出しているかどうか」の基準としては自己言及になる。
 */
export function deviceWidthOf(page: Page): number {
  const viewport = page.viewportSize();
  if (viewport === null) {
    throw new Error('Playwright の viewport が未設定（モバイル幅の project で実行すること）');
  }
  expect(viewport.width, 'モバイル幅の project で実行されていない').toBeLessThanOrEqual(480);
  return viewport.width;
}

/**
 * `maxRight` の母数から外す「スクロール領域の内側」の判定規則。
 *
 * 本番の検証は `scroll-container` 固定である。残る 3 つは **対照専用** で、規則を広げる改変や
 * 名前で判定する改変が静かに通らないことを固定するためだけに存在する（@fwlm/ui の
 * token-scales が採る「注入対照」と同じ思想。製品コード側にはフックを作らない）。
 *
 * - `scroll-container`: 祖先の計算済み `overflow-x` が **捲れる値**（`auto` / `scroll`）のときだけ免除する
 * - `none`: 免除しない（是正前の挙動）
 * - `data-slot`: 名前で免除する（fail-open の対照）
 * - `any-non-visible`: `visible` 以外をすべて免除する（除外が広すぎる場合の対照）
 */
export type ScrollRegionRule = 'scroll-container' | 'none' | 'data-slot' | 'any-non-visible';

// 免除してよいのは「利用者が捲れる領域の内側」だけである。
//
// **`hidden` と `clip` を入れてはならない。** どちらも捲れる領域を作らず、はみ出した中身は
// 到達不能なまま失われる。面の側の `overflow-x: clip` を免除しないのとまったく同じ理由であり、
// 実際 `card.tsx` と `badge.tsx` は `overflow-hidden` を持つため、`visible` 以外を一律に
// 免除すると Card 配下の全要素が母数から消える（`overflow-x: clip` により scrollWidth 系の
// assert は構造的に常に真なので、そのとき面の溢れを検出する網は 1 本も残らない）。
//
// 否定形（`!== 'visible'`）ではなく列挙で書くのは、将来 `overlay` のような値が増えたときに
// 免除の範囲が黙って広がらないようにするため。
const PANNABLE_OVERFLOW_X: readonly string[] = ['auto', 'scroll'];

/** スクロール領域そのものの幾何（免除する側ではなく、外側の箱として測る対象）。 */
export interface ScrollRegionGeometry {
  /** 識別子。`data-slot` が無ければタグ名。 */
  slot: string;
  /** アクセシブル名（`aria-label`）。どの領域かをメッセージで指すために持つ。 */
  label: string;
  right: number;
  clientWidth: number;
  scrollWidth: number;
}

export interface OverflowMetrics {
  innerWidth: number;
  docScrollWidth: number;
  docClientWidth: number;
  bodyScrollWidth: number;
  maxRight: number;
  widest: string;
  /**
   * 母数から外した要素数。
   *
   * **0 を一律に失敗させてはならない。** 捲れる領域を持たない面（`/s/` の 2 画面）では 0 が正当で、
   * 大域の非空 assert にすると正しい面が赤くなる。「規則が空振りしているか」は
   * 呼び出し側が宣言した `expectedScrollRegions` と `scrollRegions.length` の一致で測る。
   */
  excludedCount: number;
  /** 免除した中の最右端。偽陰性を目視で追えるようにするために残す。 */
  widestExcluded: string;
  /** 免除の根拠になった領域そのもの（入れ子の内側にあるものは含まない）。 */
  scrollRegions: ScrollRegionGeometry[];
}

// 横方向のはみ出しをドキュメント全体と個別要素の両面から実測する。
//
// 捲れる領域の内側で起きている溢れは、面が横に動いていることを意味しない（要件 3.3 が禁じるのは
// **ページ全体の**横スクロールである）。そこで祖先に捲れる領域を持つ要素は `maxRight` の母数から
// 外し、領域そのものは外側の箱として別に測る。
export function readOverflowMetrics(page: Page, rule: ScrollRegionRule): Promise<OverflowMetrics> {
  return page.evaluate(
    ({ rule, pannable }: { rule: ScrollRegionRule; pannable: readonly string[] }) => {
      const doc = document.documentElement;

      // 「この要素はスクロール領域そのものか」。規則ごとに定義が変わるのは対照のためである。
      const isRegion = (element: Element): boolean => {
        if (rule === 'none') return false;
        if (rule === 'data-slot') return element.getAttribute('data-slot') === 'table-container';
        const overflowX = getComputedStyle(element).overflowX;
        if (rule === 'any-non-visible') return overflowX !== 'visible';
        return pannable.includes(overflowX);
      };

      const describe = (element: Element): string =>
        `${element.tagName}[class="${element.getAttribute('class') ?? ''}"]`;

      let maxRight = 0;
      let widest = '(none)';
      let excludedCount = 0;
      let maxExcludedRight = 0;
      let widestExcluded = '(none)';
      const scrollRegions: ScrollRegionGeometry[] = [];

      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue; // 非表示要素は対象外

        // 祖先に捲れる領域があるか。**領域そのものは免除しない**（外側の箱は必ず測る）。
        let inside = false;
        for (let ancestor = el.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
          if (isRegion(ancestor)) {
            inside = true;
            break;
          }
        }

        if (inside) {
          // 入れ子の領域も「内側」として扱う。外側の箱が端末幅に収まっている以上、
          // 内側の領域の右端を端末幅と比べても意味を持たない。
          excludedCount += 1;
          if (rect.right > maxExcludedRight) {
            maxExcludedRight = rect.right;
            widestExcluded = describe(el);
          }
          continue;
        }

        if (isRegion(el)) {
          scrollRegions.push({
            slot: el.getAttribute('data-slot') ?? el.tagName,
            label: el.getAttribute('aria-label') ?? '(名前なし)',
            right: rect.right,
            clientWidth: el.clientWidth,
            scrollWidth: el.scrollWidth,
          });
        }

        if (rect.right > maxRight) {
          maxRight = rect.right;
          widest = describe(el);
        }
      }

      return {
        innerWidth: window.innerWidth,
        docScrollWidth: doc.scrollWidth,
        docClientWidth: doc.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        maxRight,
        widest,
        excludedCount,
        widestExcluded,
        scrollRegions,
      };
    },
    { rule, pannable: PANNABLE_OVERFLOW_X },
  );
}

/**
 * 面が横スクロールしないことを実測する。
 *
 * `expectedScrollRegions` に **既定値を持たせない**のは意図的である。既定値があると呼び出し側は
 * 宣言を省略でき、面へ捲れる領域が増減しても誰も気づかない。面ごとに件数を書かせることで、
 * 領域が `overflow-x-auto` を失った瞬間に `maxRight` と件数の 2 本が同時に赤くなる。
 *
 * 件数の網が本当に効くのは逆向きの事故に対してである。**溢れを「直す」つもりで外側の枠へ
 * `overflow-x-auto` を足すと、その配下は丸ごと免除され `maxRight` は永久に緑になる。**
 * 免除の広さを規則だけで守るのは無理で、件数の宣言がその改変を赤にする唯一の網である。
 */
export async function expectNoHorizontalScroll(
  page: Page,
  where: string,
  expectedScrollRegions: number,
): Promise<void> {
  const deviceWidth = deviceWidthOf(page);
  const m = await readOverflowMetrics(page, 'scroll-container');
  const regions = m.scrollRegions.map((r) => `${r.slot}(${r.label})`).join(', ') || '(なし)';

  // 免除の空振り検出。宣言と実測の食い違いは「領域が捲りを失った」か「面に領域が増えた」の
  // どちらかであり、どちらも黙って通してはならない。
  expect(
    m.scrollRegions.length,
    `${where}: 捲れる領域の実測件数 ${m.scrollRegions.length} が宣言 ${expectedScrollRegions} と` +
      `食い違う（実測: ${regions}）。領域が overflow-x の捲りを失ったか、面へ領域が増えている`,
  ).toBe(expectedScrollRegions);

  // 内側を免除するなら、外側の箱は必ず測る。
  for (const region of m.scrollRegions) {
    expect(
      region.right,
      `${where}: 捲れる領域 ${region.slot}(${region.label}) 自身の右端 ${region.right}px が` +
        `端末幅（${deviceWidth}px）を超えている（内側ではなく領域そのものが面を押し広げている）`,
    ).toBeLessThanOrEqual(deviceWidth + 1);
  }

  // overflow-x: clip の安全網に隠れた実レイアウトのはみ出しを検出する（サブピクセル分は許容）。
  // 下の scrollWidth 2 本は clip により構造的に常に真であり、面の溢れを捕らえる網はここだけである。
  expect(
    m.maxRight,
    `${where}: ${m.widest} が端末幅（${deviceWidth}px）を超えて右端 ${m.maxRight}px まで伸びている` +
      `（捲れる領域の内側として免除したのは ${m.excludedCount} 件・最右端 ${m.widestExcluded}）`,
  ).toBeLessThanOrEqual(deviceWidth + 1);
  expect(
    m.docScrollWidth,
    `${where}: html が横スクロールする（scrollWidth=${m.docScrollWidth} > clientWidth=${m.docClientWidth}）`,
  ).toBeLessThanOrEqual(m.docClientWidth);
  expect(
    m.bodyScrollWidth,
    `${where}: body が横スクロールする（scrollWidth=${m.bodyScrollWidth} > clientWidth=${m.docClientWidth}）`,
  ).toBeLessThanOrEqual(m.docClientWidth);
  // viewport meta 欠落や内容起因の拡大でレイアウト幅が端末幅を超えると横スクロールになる。
  expect(
    m.innerWidth,
    `${where}: レイアウト幅（${m.innerWidth}px）が端末幅（${deviceWidth}px）より広い`,
  ).toBeLessThanOrEqual(deviceWidth + 1);
}
