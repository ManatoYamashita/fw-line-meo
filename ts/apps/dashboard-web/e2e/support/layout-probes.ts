// 携帯端末の幅で「読めるか・届くか・捲れると分かるか」を実描画から測る道具（Issue #283）。
//
// 既存の網がここを見ていない理由:
//   - `expectNoHorizontalScroll`（@fwlm/e2e-support/viewport）は**捲り容器の内側を免除する**。
//     容器の中で列が 1 文字ずつ縦に並んでも、行末の操作が見える範囲の外にあっても赤にならない。
//   - axe は捲り容器の外へ出た要素を黙って対象から外す（dashboard-user-edit tasks 3.5 で実測）。
//   - `toBeVisible()` は overflow による切り取りを見ない。
//
// そこで、スクロールポートの矩形との**幾何比較**（R1・R2・R3 の前半）と、**実描画の画素**
// （R3 の後半）で測る。計算済みスタイルの照合は採らない。それは実装を確かめるだけで、
// 「利用者に見えているか」を確かめないためである（背景の層の順序や、上に載る不透明な面で
// 効果が消えても緑になる）。
import { expect, type Page } from '@playwright/test';
import { PANNABLE_OVERFLOW_X } from '@fwlm/e2e-support/viewport';

/** 縦に並んでいると見なす内容幅の上限（文字数）。Issue #283 の実測の定義に合わせる。 */
export const VERTICAL_WIDTH_EM = 1.6;

/**
 * 模擬した幅が実際に効いていることの裏取り。
 *
 * Playwright の未知の test option は黙って無視される（survey-web の reducedMotion で実際に踏んだ）。
 * `test.use({ viewport })` が効かないまま走ると、幅 320 の検証が幅 393 を測って緑を返す。
 * Playwright 側（viewportSize）とページ側（clientWidth）の両方で確かめる。
 */
export async function expectLayoutWidth(page: Page, width: number): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport?.width, `viewport が ${width}px で設定されていません`).toBe(width);
  const layoutWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(layoutWidth, `レイアウト幅が ${width}px になっていません（模擬が効いていません）`).toBe(
    width,
  );
  // 字形が確定する前に測ると、行数も内容幅も後から変わる。
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

// --- R1: セルが縦に並んでいないか -------------------------------------------------------

export interface CellWrapMeasurement {
  /** `th` か `td`。 */
  readonly tag: string;
  /** セルの文言（失敗の文言用に先頭だけ）。 */
  readonly text: string;
  /** 描かれた行数。 */
  readonly lines: number;
  /** 描かれた文字列の幅（CSS px）。 */
  readonly width: number;
  /** 文字列の親の計算済み font-size（CSS px）。 */
  readonly fontSize: number;
  /** セルの計算済み white-space（失敗の原因を読むために持つ）。 */
  readonly whiteSpace: string;
}

export interface CellWrapReport {
  readonly tables: number;
  readonly measured: readonly CellWrapMeasurement[];
  /** 文字列を持たないセル（判定の対象外・空振りの検出用に数える）。 */
  readonly emptyCells: number;
  /** 行の直下のパネルのセル（全列にまたがるので R4 が受け持つ）。 */
  readonly panelCells: number;
}

/**
 * 表のセルごとに、描かれた文字列の行数と幅を読む。
 *
 * 行数は Range の矩形から数える。`clientHeight / lineHeight` では、セルの中に押しボタンや
 * 入力が混ざったときに行数が実態とずれる。
 */
export function readCellWrapping(page: Page): Promise<CellWrapReport> {
  return page.evaluate(() => {
    const measured: CellWrapMeasurement[] = [];
    let tables = 0;
    let emptyCells = 0;
    let panelCells = 0;

    for (const table of Array.from(document.querySelectorAll('table'))) {
      tables += 1;
      const columns = table.querySelector('thead tr')?.children.length ?? 0;
      for (const cell of Array.from(table.querySelectorAll('th, td'))) {
        const tableCell = cell as HTMLTableCellElement;
        // 行の直下のパネル（全列にまたがるセル）は、折り返しの規則ではなく配置の問題であり、
        // R4（パネルが見えている矩形に収まるか）が受け持つ。外した件数は呼び出し側が宣言と
        // 照合する（外しすぎを検出するため）。
        if (columns > 1 && tableCell.colSpan >= columns) {
          panelCells += 1;
          continue;
        }

        const rects: DOMRect[] = [];
        let fontSize = 0;
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if ((node.textContent ?? '').trim() === '') continue;
          const parent = node.parentElement;
          if (parent === null) continue;
          // 読み上げ専用の文字（幅 0）は描かれていないので数えない。
          if (parent.getBoundingClientRect().width <= 1) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of Array.from(range.getClientRects())) {
            if (rect.width > 0 && rect.height > 0) rects.push(rect);
          }
          fontSize = Math.max(fontSize, parseFloat(getComputedStyle(parent).fontSize));
        }
        if (rects.length === 0) {
          emptyCells += 1;
          continue;
        }

        // 同じ行に属する矩形をまとめる（上端が半行以上離れたら次の行とみなす）。
        rects.sort((a, b) => a.top - b.top);
        let lines = 0;
        let lineTop = -Infinity;
        for (const rect of rects) {
          if (rect.top > lineTop + rect.height / 2) {
            lines += 1;
            lineTop = rect.top;
          }
        }
        const left = Math.min(...rects.map((rect) => rect.left));
        const right = Math.max(...rects.map((rect) => rect.right));

        measured.push({
          tag: cell.tagName.toLowerCase(),
          text: (cell.textContent ?? '').trim().slice(0, 24),
          lines,
          width: right - left,
          fontSize,
          whiteSpace: getComputedStyle(cell).whiteSpace,
        });
      }
    }

    return { tables, measured, emptyCells, panelCells };
  });
}

/** 内容幅が 1.6 文字未満で、かつ `minLines` 行以上に折り返されたセル。 */
export function verticalCells(
  report: CellWrapReport,
  minLines: number,
): readonly CellWrapMeasurement[] {
  return report.measured.filter(
    (cell) => cell.lines >= minLines && cell.width < cell.fontSize * VERTICAL_WIDTH_EM,
  );
}

/** 失敗の文言用（原因を読めるように white-space まで出す）。 */
export function describeCell(cell: CellWrapMeasurement): string {
  return `${cell.tag}「${cell.text}」${cell.lines}行・幅${round(cell.width)}px・字${round(
    cell.fontSize,
  )}px・${cell.whiteSpace}`;
}

// --- R2: 帯の操作要素すべてに捲らずに届くか ---------------------------------------------

export interface NavControlReach {
  /** 読み上げ名（リンクと押しボタンの文言）。 */
  readonly name: string;
  readonly left: number;
  readonly right: number;
  /** 見えている矩形（端末の幅と、切り取る祖先すべての交差）の内側にあるか。 */
  readonly inside: boolean;
  /** 帯そのものの箱の内側にあるか（縦も見る）。 */
  readonly insideNav: boolean;
  /** 見える部分の中心を指したとき、その要素が当たるか。 */
  readonly hit: boolean;
  /** 切り取っている祖先（失敗の文言用）。 */
  readonly clippedBy: string | null;
}

export interface NavReachReport {
  readonly navs: number;
  readonly controls: readonly NavControlReach[];
  /** 操作要素ではない文字（ワードマーク・ロール）。1 段目の収まりを見る。 */
  readonly texts: readonly { readonly text: string; readonly inside: boolean }[];
}

/**
 * 帯の中のリンクと押しボタンが、捲らずに届く位置にあるかを読む。
 *
 * 「見えている矩形」は、端末の幅から始めて、overflow が visible でない祖先のパディング箱を
 * 順に交差させて求める。`toBeVisible()` では測れない（overflow による切り取りを見ない）。
 * 当たり判定は `elementFromPoint` で裏を取る。幾何だけだと、上に載った透明な覆いを見逃す。
 */
export function readNavReach(page: Page, deviceWidth: number): Promise<NavReachReport> {
  return page.evaluate((width: number) => {
    // 帯は文書の先頭にあるので、ページを縦へ送った後では画面の外にある（行の直下のパネルを
    // 開くと、ブラウザがパネルを見える位置まで送る）。**縦の送りは利用者が普通に戻せる**ので、
    // ここで測るのは横方向の到達性だけである。当たり判定を取る前に縦の位置を戻す。
    window.scrollTo(0, 0);
    const navs = Array.from(document.querySelectorAll('nav[aria-label="メインナビゲーション"]'));
    const controls: NavControlReach[] = [];
    const texts: { text: string; inside: boolean }[] = [];

    /** 端末の幅と、切り取る祖先すべての交差。 */
    const visibleRange = (element: Element): { left: number; right: number; by: string | null } => {
      let left = 0;
      let right = width;
      let by: string | null = null;
      for (let a = element.parentElement; a !== null; a = a.parentElement) {
        const style = getComputedStyle(a);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        if (a.getClientRects().length === 0) continue;
        const box = a.getBoundingClientRect();
        const l = box.left + a.clientLeft;
        const r = l + a.clientWidth;
        if (l > left) {
          left = l;
          by = `${a.tagName} overflow-x:${style.overflowX}`;
        }
        if (r < right) {
          right = r;
          by = `${a.tagName} overflow-x:${style.overflowX}`;
        }
      }
      return { left, right, by };
    };

    for (const nav of navs) {
      const navBox = nav.getBoundingClientRect();
      for (const element of Array.from(nav.querySelectorAll('a[href], button'))) {
        const rect = element.getBoundingClientRect();
        const range = visibleRange(element);
        const inside = rect.left >= range.left - 0.5 && rect.right <= range.right + 0.5;
        const insideNav =
          rect.left >= navBox.left - 0.5 &&
          rect.right <= navBox.right + 0.5 &&
          rect.top >= navBox.top - 0.5 &&
          rect.bottom <= navBox.bottom + 0.5;
        // 見えている部分の中心（画面の外に出ていても、残った部分で当たり判定を試す）。
        const cx = (Math.max(rect.left, range.left) + Math.min(rect.right, range.right)) / 2;
        const cy = (rect.top + rect.bottom) / 2;
        const hitElement =
          cx >= 0 && cx <= width && cy >= 0 && cy <= window.innerHeight
            ? document.elementFromPoint(cx, cy)
            : null;
        controls.push({
          name: (element.textContent ?? '').trim(),
          left: rect.left,
          right: rect.right,
          inside,
          insideNav,
          hit: hitElement !== null && (element === hitElement || element.contains(hitElement)),
          clippedBy: inside ? null : range.by,
        });
      }

      // 操作要素ではない文字（ワードマーク・ロール）。狭い幅で 1 段目が溢れていないかを見る。
      const walker = document.createTreeWalker(nav, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = (node.textContent ?? '').trim();
        if (text === '') continue;
        const parent = node.parentElement;
        if (parent === null || parent.closest('a[href], button') !== null) continue;
        const nodeRange = document.createRange();
        nodeRange.selectNodeContents(node);
        const rect = nodeRange.getBoundingClientRect();
        const range = visibleRange(parent);
        texts.push({
          text,
          inside: rect.left >= range.left - 0.5 && rect.right <= range.right + 0.5,
        });
      }
    }

    return { navs: navs.length, controls, texts };
  }, deviceWidth);
}

// --- R3: 溢れた捲り容器に、まだ捲れる側の手がかりがあるか -------------------------------

/** 測る対象に付ける一時の印。**製品コードは知らない**（E2E の中だけで付けて使う）。 */
const CUE_ATTRIBUTE = 'data-e2e-cue';

export interface PannableContainer {
  readonly probeId: string;
  /** `aria-label`（無ければタグ名）。宣言と照合するのはこの名前である。 */
  readonly label: string;
  readonly clientWidth: number;
  readonly scrollWidth: number;
  /** 実際に溢れているか。溢れていない容器には**手がかりが出ていないこと**を要求する。 */
  readonly overflowing: boolean;
  /** 手がかりを要求できるだけ溢れているか（覆いの幅より大きく捲れるか）。 */
  readonly cueExpected: boolean;
  /** 捲り位置 0 で、見えている矩形の外にある操作要素の名前。 */
  readonly hiddenControls: readonly string[];
}

/**
 * 捲れる容器へ印を付け、捲り位置を 0 に戻し、隠れている操作要素を数える。
 *
 * 「捲れる」の定義は `expectNoHorizontalScroll` と同じ（計算済み overflow-x が捲れる値）。
 * 定義の写しを作らないよう `PANNABLE_OVERFLOW_X` を共有する。
 *
 * **溢れていない容器も返す。** 手がかりは「まだ捲れる側にだけ出る」ものであり、
 * 捲れない容器に出ていないことまで測って初めて、出し分けを確かめたことになる。
 */
export function markPannableContainers(page: Page): Promise<readonly PannableContainer[]> {
  return page.evaluate(({ pannable, minOverflow }: { pannable: readonly string[]; minOverflow: number }) => {
    const found: PannableContainer[] = [];
    let index = 0;
    for (const element of Array.from(document.body.querySelectorAll('*'))) {
      const style = getComputedStyle(element);
      if (!pannable.includes(style.overflowX)) continue;

      const probeId = String(index);
      index += 1;
      element.setAttribute('data-e2e-cue', probeId);
      element.scrollTo({ left: 0, behavior: 'instant' });

      const box = element.getBoundingClientRect();
      const left = box.left + element.clientLeft;
      const right = left + element.clientWidth;
      const hiddenControls: string[] = [];
      for (const control of Array.from(
        element.querySelectorAll('a[href], button, input, select, textarea'),
      )) {
        const rect = control.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.left < left - 0.5 || rect.right > right + 0.5) {
          hiddenControls.push((control.textContent ?? '').trim() || control.tagName.toLowerCase());
        }
      }

      found.push({
        probeId,
        label: element.getAttribute('aria-label') ?? element.tagName,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowing: element.scrollWidth > element.clientWidth,
        cueExpected: element.scrollWidth - element.clientWidth >= minOverflow,
        hiddenControls,
      });
    }
    return found;
  }, { pannable: PANNABLE_OVERFLOW_X, minOverflow: CUE_MIN_OVERFLOW_PX });
}

/** 捲り位置。`start` は左端（＝右にまだ中身がある）、`end` は右端。 */
export type CuePosition = 'start' | 'end';

export interface BandStat {
  /** 閾値以上に異なる画素の数。 */
  readonly changed: number;
  /** 画素の差の最大値（0〜255）。 */
  readonly maxDelta: number;
  /** 比べた画素の総数（`changed` の母数。0 件だと「差が無い」と読めてしまうので必ず見る）。 */
  readonly total: number;
  /** 帯の横幅（装置の画素の列数）。「何列ぶんの差か」を言えるようにするために持つ。 */
  readonly columns: number;
}

export interface CueBands {
  readonly left: BandStat;
  readonly right: BandStat;
  readonly center: BandStat;
  /** 同じ状態で 2 回撮った画像の最大の差。0 でなければ描画が安定していない。 */
  readonly maxSelfDelta: number;
  /** 装置の画素 ÷ CSS px。 */
  readonly scale: number;
  readonly clip: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** 端の帯として見る幅（CSS px）。濃淡の幅（1rem）より少し狭く取り、角の丸みを避ける。 */
const BAND_WIDTH_CSS = 12;

/**
 * 文字を消すスタイル。**2 枚とも同じように当てる。**
 *
 * 背景を外すと、その上に載る文字の縁取りの描き方（副画素の割り当て）まで変わる環境がある。
 * Linux の CI では、これだけで中央の帯に 1 万画素を超える差が出た（macOS では 0 だった）。
 * 差の出所を容器の背景だけに限るため、両方の撮影で文字を透明にする。色は配置を変えないので、
 * 測る対象の幾何は動かない。
 */
const HIDE_TEXT_STYLE = '*{color:transparent !important;text-shadow:none !important}';

/**
 * 手がかりを要求する下限の溢れ量（CSS px）。
 *
 * 覆いは中身と一緒に動き、幅は 2rem である。溢れがそれより小さいと、捲り位置 0 でも
 * 反対側の覆いが端の帯へ掛かり、濃淡が構造的に薄くなる。**そこまで測ろうとすると、
 * ほとんど捲れない容器で偽の赤が出る**（CI の Linux の字幅では代理店一覧が 9px だけ溢れ、
 * これに当たった）。捲る余地がその程度しか無い容器は、手がかりの有無を問わない。
 */
const CUE_MIN_OVERFLOW_PX = 32;
/** 中央として見る範囲の、左右から除く幅（CSS px）。 */
const CENTER_INSET_CSS = 48;
/** 画素が「異なる」と見なす差（0〜255）。影の最も濃い点は白との差が約 18 になる。 */
export const CUE_DELTA_THRESHOLD = 8;

/**
 * 捲り容器の端に手がかりが**描かれているか**を、実描画の差分で測る。
 *
 * 同じ切り取りで「手がかりあり」と「容器の背景画像を外したもの」を撮り、端の帯と中央で画素を比べる。
 * 中身（文字・罫線・押しボタン）は両方に等しく写るので、差は容器の背景の層からしか生じない。
 *
 * 計算済みスタイルを読むだけの判定を採らない理由: それは実装の宣言を確かめるだけで、
 * 上に載る不透明な面に隠れていても、層の順序を誤っていても緑になる。逆に、同じ効果を別の実装
 * （擬似要素・mask・scroll 駆動のアニメーション）で出したときに偽りの赤になる。
 */
export async function measureCueBands(
  page: Page,
  probeId: string,
  position: CuePosition,
): Promise<CueBands> {
  const selector = `[${CUE_ATTRIBUTE}="${probeId}"]`;

  const clip = await page.evaluate(
    ({ sel, pos }: { sel: string; pos: CuePosition }) => {
      const element = document.querySelector(sel);
      if (element === null) throw new Error(`印 ${sel} の容器が見つかりません`);
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      // 捲り切りは **大きな値を渡してブラウザに丸めさせる**。`scrollWidth - clientWidth` は
      // どちらも整数へ丸められた値なので、端まで 1px 弱届かないことがある。その隙間のぶん、
      // 中身と一緒に動く覆いが画面の外へずれ、端の 1 画素に濃淡が残って「捲り切っても手がかりが
      // 消えない」と読める（実測: 装置画素で 1 列だけ・差 12/255）。
      element.scrollTo({ left: pos === 'start' ? 0 : element.scrollWidth * 2, behavior: 'instant' });
      return new Promise<{ x: number; y: number; width: number; height: number; scrollLeft: number }>(
        (resolve) => {
          // 捲りと縦送りの反映を 2 フレーム待ってから測る。
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const box = element.getBoundingClientRect();
              const left = box.left + element.clientLeft;
              const top = box.top + element.clientTop;
              // 角の丸みと縦の捲り棒を避けて上下を内側にする。低い容器では内側へ寄せる量を
              // 減らす（帯のリストのように高さ 40px 程度の容器でも測れるようにする）。
              const inset = Math.min(16, Math.max(2, Math.floor(element.clientHeight / 5)));
              const visibleTop = Math.max(top, 0) + inset;
              const visibleBottom = Math.min(top + element.clientHeight, window.innerHeight) - inset;
              resolve({
                x: Math.ceil(left),
                y: Math.ceil(visibleTop),
                width: Math.floor(element.clientWidth),
                height: Math.floor(visibleBottom - visibleTop),
                scrollLeft: element.scrollLeft,
              });
            });
          });
        },
      );
    },
    { sel: selector, pos: position },
  );
  // 見える幅が端の帯 2 本ぶんに満たない容器は、手がかりを描く余地そのものが無い。これは
  // 測定の都合ではなく面の欠陥である（帯の案内リストは幅 393 で 29px・320 で 0px しか無かった）。
  expect(
    clip.width,
    `捲れる容器の見える幅が ${clip.width}px しか無く、端に手がかりを描く余地がありません` +
      '（容器そのものが潰れています）',
  ).toBeGreaterThan(BAND_WIDTH_CSS * 2);
  expect(
    clip.height,
    `捲れる容器の見えている高さが ${clip.height}px しかなく、帯を撮れません（画面の外にあります）`,
  ).toBeGreaterThan(8);

  const shot = {
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
    animations: 'disabled',
    caret: 'hide',
  } as const;
  const hidden = `${HIDE_TEXT_STYLE} [${CUE_ATTRIBUTE}="${probeId}"]{background-image:none!important}`;
  const withCue = await page.screenshot({ ...shot, style: HIDE_TEXT_STYLE });
  const withoutCue = await page.screenshot({ ...shot, style: hidden });
  const withCueAgain = await page.screenshot({ ...shot, style: HIDE_TEXT_STYLE });

  return page.evaluate(
    async ({
      a,
      b,
      c,
      cssWidth,
      bandCss,
      centerCss,
      threshold,
      rect,
    }: {
      a: string;
      b: string;
      c: string;
      cssWidth: number;
      bandCss: number;
      centerCss: number;
      threshold: number;
      rect: { x: number; y: number; width: number; height: number };
    }) => {
      const decode = async (base64: string): Promise<ImageData> => {
        const response = await fetch(`data:image/png;base64,${base64}`);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob, {
          premultiplyAlpha: 'none',
          colorSpaceConversion: 'none',
        });
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (context === null) throw new Error('2d コンテキストを取得できません');
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
      };

      const [first, without, second] = await Promise.all([decode(a), decode(b), decode(c)]);
      const scale = first.width / cssWidth;
      const band = Math.max(1, Math.round(bandCss * scale));
      const center = Math.max(1, Math.round(centerCss * scale));

      const compare = (x0: number, x1: number, p: ImageData, q: ImageData): BandStat => {
        let changed = 0;
        let maxDelta = 0;
        let total = 0;
        const width = Math.min(p.width, q.width);
        const height = Math.min(p.height, q.height);
        for (let y = 0; y < height; y += 1) {
          for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) {
            total += 1;
            const i = (y * p.width + x) * 4;
            const j = (y * q.width + x) * 4;
            const delta = Math.max(
              Math.abs(p.data[i]! - q.data[j]!),
              Math.abs(p.data[i + 1]! - q.data[j + 1]!),
              Math.abs(p.data[i + 2]! - q.data[j + 2]!),
            );
            if (delta > maxDelta) maxDelta = delta;
            if (delta >= threshold) changed += 1;
          }
        }
        return { changed, maxDelta, total, columns: Math.max(0, Math.min(width, x1) - Math.max(0, x0)) };
      };

      return {
        left: compare(0, band, first, without),
        right: compare(first.width - band, first.width, first, without),
        center: compare(center, first.width - center, first, without),
        maxSelfDelta: compare(0, first.width, first, second).maxDelta,
        scale,
        clip: rect,
      };
    },
    {
      a: withCue.toString('base64'),
      b: withoutCue.toString('base64'),
      c: withCueAgain.toString('base64'),
      cssWidth: clip.width,
      bandCss: BAND_WIDTH_CSS,
      centerCss: CENTER_INSET_CSS,
      threshold: CUE_DELTA_THRESHOLD,
      rect: { x: clip.x, y: clip.y, width: clip.width, height: clip.height },
    },
  );
}

/** 数値を小数第 2 位で丸めた表記（失敗の文言用。比較は丸める前の値で行う）。 */
export function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}
