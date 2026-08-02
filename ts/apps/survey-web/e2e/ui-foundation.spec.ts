import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect, type Locator, type Page } from '@playwright/test';
import { colors, compositeOver, contrastRatio } from '@fwlm/design-tokens';

// UI デザイン基盤（ui-design-foundation）の非後退 E2E。
// requirements 5.3（キーボードフォーカス時に視認可能なフォーカス表示）と
// requirements 3.3（モバイル端末で横スクロールを発生させない）を検証する。
// クラス名の有無ではなく getComputedStyle とレイアウト実測（実描画）で判定する。

const STORE_ID = process.env.E2E_STORE_ID ?? '44444444-4444-4444-4444-444444444444';

// alpha = 0 のアウトラインは描画されないため「見えている」とは扱わない。
const TRANSPARENT = /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/;

// Tab でたどる上限回数（フォーム全体＝星5＋良かった点＋一言＋送信を余裕をもって通過できる数）。
// フォーカスが body へ抜けた時点でループは自然に終了するため、余裕を持たせても実行時間は増えない。
const MAX_TAB_STEPS = 24;

/** 通常文字の WCAG 2.1 AA 基準（Requirements 5.2）。 */
const AA_NORMAL_TEXT_RATIO = 4.5;

// 非テキスト（部品の輪郭・状態表示）の WCAG 2.1 SC 1.4.11 基準。
// spec form-non-text-contrast の Requirements 1.1 / 2.1 / 3.4 が課すしきい値。
const NON_TEXT_RATIO = 3;

// color-mix() の合成後の実効色は @fwlm/ui の許可リストを正典にする（PR #56 レビュー指摘2）。
// 同じファイルを ui の contrast-usage.test.ts が静的な数値検証に使う。実測値を両側へ手書きすると、
// それ自体が drift の発生源になるため、値は 1 箇所にしか置かない。
interface ColorMixEntry {
  readonly file: string;
  readonly expression: string;
  readonly measuredHex: string;
  readonly foreground: string;
  readonly kind: string;
  readonly reason: string;
}

const colorMixAllowlist = (
  JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'packages',
        'ui',
        'test',
        'color-mix-allowlist.json',
      ),
      'utf8',
    ),
  ) as { readonly entries: readonly ColorMixEntry[] }
).entries;

/** 実測した 1 レイヤ分の色。`alpha` は 0..1（1 が不透明）。 */
interface MeasuredColor {
  /** 不透明度を戻した色（6桁大文字 hex・`compositeOver` にそのまま渡せる形式）。 */
  readonly hex: string;
  /** そのレイヤ自身の不透明度（0..1）。 */
  readonly alpha: number;
}

interface RenderedLayers {
  color: MeasuredColor;
  backgroundColor: MeasuredColor;
  /** 上・右・下・左の順。 */
  borderColors: readonly MeasuredColor[];
  /** 枠の描画幅（px・上辺）。0 は「枠が描かれていない」ことを意味する。 */
  borderWidth: number;
  /** 要素全体（枠も面も子孫も）に掛かる不透明度（0..1）。計算値の色には合成されていない。 */
  opacity: number;
  /** 測定時点でこの要素がフォーカスされていたか（Requirements 1.2 の前提確認用）。 */
  focused: boolean;
}

// 要素に実際に描画される色を、合成前のレイヤ単位で読む。
//
// getComputedStyle は color-mix() を `oklch(…)` や `oklab(…)` の書式のまま返しうるため、
// 文字列の突き合わせでは書式に依存してしまう。canvas の fillStyle にその値をそのまま流して
// 1px 描き、描かれたピクセルの sRGB を読むことで書式非依存の実測値にする。
// alpha も同時に返すのは、半透明の指定（`bg-input/50` など）を上位で下地へ合成できるように
// するため（タスク 4.3）。**ここでは合成しない**。合成は下地が何かを知る呼び出し側の責務であり、
// 演算そのものは design-tokens の `compositeOver` に委ねる。
//
// 要素の `opacity` を併せて返す理由: `opacity` は要素の描画結果全体に掛かるが、計算値の色には
// 一切反映されない。無効化状態のように `opacity` が 1 未満の要素では、利用者が見る色は
// 計算値そのものではない（design.md D8 / Open Questions #4）。
function readRenderedLayers(locator: Locator): Promise<RenderedLayers> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const context = document.createElement('canvas').getContext('2d');
    if (context === null) throw new Error('canvas の 2d コンテキストを取得できません');

    const measure = (value: string): MeasuredColor => {
      context.clearRect(0, 0, 1, 1);
      // 解釈できない書式が来た場合に前の値が残らないよう、毎回 sentinel を置いてから代入する。
      context.fillStyle = '#000000';
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return {
        hex: `#${[red, green, blue]
          .map((channel) => (channel ?? 0).toString(16).padStart(2, '0'))
          .join('')}`.toUpperCase(),
        alpha: (alpha ?? 0) / 255,
      };
    };

    return {
      color: measure(style.color),
      backgroundColor: measure(style.backgroundColor),
      borderColors: [
        style.borderTopColor,
        style.borderRightColor,
        style.borderBottomColor,
        style.borderLeftColor,
      ].map(measure),
      borderWidth: Number.parseFloat(style.borderTopWidth),
      opacity: Number.parseFloat(style.opacity),
      focused: element.matches(':focus'),
    };
  });
}

interface RenderedColors {
  /** 実際に描画される文字色（6桁 hex）。 */
  color: string | null;
  /** 実際に描画される背景色（6桁 hex）。透明なら null。 */
  backgroundColor: string | null;
  /** 実際に描画される枠色（6桁 hex）。四辺で色が食い違う場合と半透明なら null。 */
  borderColor: string | null;
  /** 枠の描画幅（px・上辺）。0 は「枠が描かれていない」ことを意味する。 */
  borderWidth: number;
  /** 測定時点でこの要素がフォーカスされていたか（Requirements 1.2 の前提確認用）。 */
  focused: boolean;
}

// 「その要素だけを見て色が決まる」場合の実描画色。
// 半透明（alpha < 1）は「その要素では色が決まらない」ことを意味するので null を返し、
// 呼び出し側に下地の要素を測らせる（無音で 0 と比較して緑になるのを防ぐ）。
// この思想は維持する。半透明を織り込んだ実効色が要る場合は effectiveColorOver を使うこと。
//
// 枠色（Issue #57 / spec form-non-text-contrast タスク 4.2）:
// 枠は意味論変数（--input など）を経由してトークンへ解決されるため、クラス集合（border-input）
// を読んでも実際に描かれる色は分からない。変数の付け替えを誤れば、クラス名は無傷のまま色だけが
// 薄い装飾用へ戻る。枠色まで実測することでその経路を塞ぐ。上辺だけを代表値にすると四辺で色が
// 食い違う要素の他の辺を見逃すため、四辺が一致したときのみ値を返す（半透明の扱いと同じ思想で、
// 「決められないときは null を返して呼び出し側に落とさせる」）。
async function readRenderedColors(locator: Locator): Promise<RenderedColors> {
  const layers = await readRenderedLayers(locator);
  const opaqueHex = (measured: MeasuredColor): string | null =>
    measured.alpha === 1 ? measured.hex : null;

  const sides = layers.borderColors.map(opaqueHex);
  const [top] = sides;

  return {
    color: opaqueHex(layers.color),
    backgroundColor: opaqueHex(layers.backgroundColor),
    borderColor: top != null && sides.every((side) => side === top) ? top : null,
    borderWidth: layers.borderWidth,
    focused: layers.focused,
  };
}

// 利用者が実際に見る色（実効色）を導く。
//
// 2 段の合成が要る。(1) レイヤ自身の半透明（`bg-input/50`）を下地へ合成し、
// (2) 要素全体に掛かる不透明度（`opacity-50`）でさらに下地へ合成する。
// どちらか一方でも欠けると、計算値と実際の見た目が食い違ったまま検証が緑になる。
//
// 合成の演算は design-tokens の compositeOver（正典の実装）にのみ委ねる。ここで自前の
// アルファブレンドを書くと、検証側だけが持つ第 2 の実装になり、まさに本プロジェクトのガードが
// 防ごうとしている実装ドリフトを自分で作ることになる（contrast.ts の冒頭コメント）。
function effectiveColorOver(
  layer: MeasuredColor,
  backdrop: string,
  elementOpacity: number,
): string {
  return compositeOver(
    compositeOver(layer.hex, backdrop, layer.alpha),
    backdrop,
    elementOpacity,
  );
}

// 枠色を「空振りしていないこと」を確かめたうえで返す。
//
// 枠の指定が発火していない要素でも計算値としての枠色は返る（Tailwind の preflight が
// `border: 0 solid` を敷き、theme.css の base レイヤが色だけを与えているため）。色だけを見ると
// 枠が一切描かれていなくても assert が通ってしまうので、幅が 0 でないことを先に要求する
// （tasks.md Implementation Notes「空振りしているかどうかは色ではなく枠幅を見ると一発で分かる」）。
async function readRenderedBorder(locator: Locator, where: string): Promise<RenderedColors> {
  const rendered = await readRenderedColors(locator);
  expect(
    rendered.borderWidth,
    `${where}: 枠が描画されていない（幅 0）。枠の指定が発火していない可能性がある`,
  ).toBeGreaterThan(0);
  expect(
    rendered.borderColor,
    `${where}: 枠色を実測できない（四辺の色が食い違うか半透明）`,
  ).not.toBeNull();
  return rendered;
}

// 頁の下地の色を実測する。
// フォーム部品は bg-transparent で描かれるため、枠が識別すべき相手は自分の背景ではなく
// 隣接する頁背景になる（design.md「エラー状態と選択状態の優先順位」の決定事項）。
async function readPageBackground(page: Page): Promise<string> {
  const { backgroundColor } = await readRenderedColors(page.locator('body'));
  expect(backgroundColor, '頁の下地の色を実測できない').not.toBeNull();
  return backgroundColor as string;
}

/** 実測した枠色と頁背景の比が非テキスト基準（3:1）を満たすことを要求する。 */
function expectNonTextContrast(border: string, background: string, where: string): void {
  const ratio = contrastRatio(border, background);
  expect(
    ratio,
    `${where}: 枠 ${border} on 背景 ${background} → ${ratio.toFixed(3)}:1（要求 ${NON_TEXT_RATIO}:1）`,
  ).toBeGreaterThanOrEqual(NON_TEXT_RATIO);
}

interface FocusIndicator {
  tag: string;
  name: string;
  focusVisible: boolean;
  outlineStyle: string;
  outlineWidth: number;
  outlineColor: string;
  boxShadow: string;
}

// 現在フォーカスされている要素の可視表示を計算済みスタイルから読み取る。
// フォーカスが body / html へ抜けた（＝たどれる要素が尽きた）場合は null を返す。
function readFocusIndicator(page: Page): Promise<FocusIndicator | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body || el === document.documentElement) return null;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName,
      name: el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 24),
      focusVisible: el.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
    };
  });
}

interface OverflowMetrics {
  innerWidth: number;
  docScrollWidth: number;
  docClientWidth: number;
  bodyScrollWidth: number;
  maxRight: number;
  widest: string;
}

// 横方向のはみ出しをドキュメント全体と個別要素の両面から実測する。
function readOverflowMetrics(page: Page): Promise<OverflowMetrics> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    let maxRight = 0;
    let widest = '(none)';
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue; // 非表示要素は対象外
      if (rect.right > maxRight) {
        maxRight = rect.right;
        widest = `${el.tagName}[class="${el.getAttribute('class') ?? ''}"]`;
      }
    }
    return {
      innerWidth: window.innerWidth,
      docScrollWidth: doc.scrollWidth,
      docClientWidth: doc.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      maxRight,
      widest,
    };
  });
}

async function expectNoHorizontalScroll(page: Page, where: string): Promise<void> {
  // 端末幅は Playwright の project 設定（devices['Pixel 5']）を正とする。
  // ページ側の window.innerWidth ははみ出し時に自動で広がるため基準に使わない。
  const viewport = page.viewportSize();
  if (viewport === null) {
    throw new Error('Playwright の viewport が未設定（モバイル幅の project で実行すること）');
  }
  const deviceWidth = viewport.width;
  expect(deviceWidth, 'モバイル幅の project で実行されていない').toBeLessThanOrEqual(480);

  const m = await readOverflowMetrics(page);
  // overflow-x: clip の安全網に隠れた実レイアウトのはみ出しを検出する（サブピクセル分は許容）。
  expect(
    m.maxRight,
    `${where}: ${m.widest} が端末幅（${deviceWidth}px）を超えて右端 ${m.maxRight}px まで伸びている`,
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

// requirements 5.3: キーボードフォーカス時に視認可能なフォーカス表示を提示する。
test('キーボードでたどった操作可能要素すべてに可視フォーカス表示が出る', async ({ page }) => {
  await page.goto(`/s/${STORE_ID}`);
  const firstStar = page.getByRole('button', { name: '星1' });
  await expect(firstStar).toBeVisible();

  // 先頭の操作可能要素へキーボードで入る（プログラム的 focus では :focus-visible が付かない）。
  await page.keyboard.press('Tab');
  await expect(firstStar).toBeFocused();

  const checked: string[] = [];
  for (let i = 0; i < MAX_TAB_STEPS; i += 1) {
    const indicator = await readFocusIndicator(page);
    if (indicator === null) break; // たどれる要素が尽きた
    const where = `${indicator.tag}(${indicator.name})`;

    expect(indicator.focusVisible, `${where} が :focus-visible に一致しない`).toBe(true);
    const outlineVisible =
      indicator.outlineStyle !== 'none' &&
      indicator.outlineWidth > 0 &&
      !TRANSPARENT.test(indicator.outlineColor);
    expect(
      outlineVisible || indicator.boxShadow !== 'none',
      `${where} に可視フォーカス表示が無い: ${JSON.stringify(indicator)}`,
    ).toBe(true);

    checked.push(where);
    await page.keyboard.press('Tab');
  }

  // 空振り緑の防止: 星5個＋一言 textarea＋送信ボタンまで実際にたどれていること。
  const trail = `たどれた操作可能要素: ${checked.join(', ')}`;
  expect(checked.length, trail).toBeGreaterThanOrEqual(7);
  expect(
    checked.some((w) => w.includes('送信する')),
    trail,
  ).toBe(true);
});

// requirements 5.3 / Issue #49: @fwlm/ui の部品そのものに可視フォーカス表示が出る。
//
// 上のテストが走査する回答画面は素の <button> / <textarea> / <input> で構成されており、
// @fwlm/ui の部品を一度も通っていない。そのため「部品が base レイヤのフォーカス既定を
// outline を打ち消すユーティリティで無効化していた」欠陥（Issue #49）を検出できなかった。
// ここでは部品を実描画する検証面（/ui-check）を的にして、同じ実測ロジックを部品経路へ通す。
test('@fwlm/ui の対話的部品すべてに可視フォーカス表示が出る', async ({ page }) => {
  await page.goto('/ui-check');
  const firstButton = page.getByRole('button', { name: '既定のボタン' });
  await expect(firstButton).toBeVisible();

  await page.keyboard.press('Tab');
  await expect(firstButton).toBeFocused();

  const checked: string[] = [];
  for (let i = 0; i < MAX_TAB_STEPS; i += 1) {
    const indicator = await readFocusIndicator(page);
    if (indicator === null) break;
    const where = `${indicator.tag}(${indicator.name})`;

    expect(indicator.focusVisible, `${where} が :focus-visible に一致しない`).toBe(true);
    // フォーカス表示は theme.css の base レイヤの outline に一本化されているため、
    // box-shadow による代替は認めず outline が実際に描画されていることを要求する
    // （リングでの代替を許すと、2.08:1 の薄いリングでも緑になってしまう）。
    expect(
      indicator.outlineStyle !== 'none',
      `${where} の outline が無効化されている: ${JSON.stringify(indicator)}`,
    ).toBe(true);
    expect(
      indicator.outlineWidth,
      `${where} の outline 幅が 0: ${JSON.stringify(indicator)}`,
    ).toBeGreaterThan(0);
    expect(
      TRANSPARENT.test(indicator.outlineColor),
      `${where} の outline が透明: ${JSON.stringify(indicator)}`,
    ).toBe(false);

    checked.push(where);
    await page.keyboard.press('Tab');
  }

  // 空振り緑の防止: ボタン 6 種＋入力 2 種＋チェックボックス＋ラジオまでたどれていること。
  const trail = `たどれた操作可能要素: ${checked.join(', ')}`;
  expect(checked.length, trail).toBeGreaterThanOrEqual(10);
  expect(
    checked.some((w) => w.includes('破壊的なボタン')),
    `destructive variant に到達していない。${trail}`,
  ).toBe(true);
  expect(
    checked.some((w) => w.includes('複数行入力')),
    `Textarea に到達していない。${trail}`,
  ).toBe(true);
});

// Requirements 5.2 / PR #56 レビュー指摘1: 変種の状態色が説明文まで実描画で届く。
//
// なぜクラス名の検証では足りないか:
// AlertDescription は自身に text-muted-foreground を持つため、親 variant が子孫指定で色を
// 渡さない限り説明文は灰色で描画される。それでも親のクラス集合は壊れないので、jsdom での
// クラス assert も含めた既存の静的検証は全て緑のまま通る。ここでは実際に描かれた色を測る。
test('Alert の説明文に変種の状態色が実描画で届いている', async ({ page }) => {
  await page.goto('/ui-check');
  const alerts = page.getByRole('alert');
  await expect(alerts.filter({ hasText: '成功の通知' })).toBeVisible();

  const partOf = (heading: string, slot: string): Locator =>
    alerts.filter({ hasText: heading }).locator(`[data-slot="alert-${slot}"]`);

  // 既定の変種の説明文＝状態色が届いていないときに出るはずの色。基準として先に測る。
  const baseline = await readRenderedColors(partOf('お知らせ', 'description'));
  expect(baseline.color, '既定の説明文の色を実測できない').not.toBeNull();

  for (const heading of ['成功の通知', 'エラーの通知']) {
    const container = await readRenderedColors(alerts.filter({ hasText: heading }));
    const title = await readRenderedColors(partOf(heading, 'title'));
    const description = await readRenderedColors(partOf(heading, 'description'));

    expect(description.color, `${heading}: 説明文の色を実測できない`).not.toBeNull();
    expect(container.backgroundColor, `${heading}: 下地の色を実測できない`).not.toBeNull();

    expect(
      description.color,
      `${heading}: 説明文が既定の色（${baseline.color ?? '不明'}）のまま描画されている。` +
        '変種の状態色が説明文へ届いていない',
    ).not.toBe(baseline.color);
    expect(
      description.color,
      `${heading}: 説明文（${description.color ?? '不明'}）が見出し（${title.color ?? '不明'}）と別色で描画されている`,
    ).toBe(title.color);

    const ratio = contrastRatio(description.color ?? '#000000', container.backgroundColor ?? '#000000');
    expect(
      ratio,
      `${heading}: 説明文 ${description.color ?? '不明'} on ${container.backgroundColor ?? '不明'} → ` +
        `${ratio.toFixed(3)}:1（要求 ${AA_NORMAL_TEXT_RATIO}:1）`,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_RATIO);
  }
});

// Requirements 5.2 / PR #56 レビュー指摘2: color-mix() の合成後の実効色を実ブラウザで測る。
//
// color-mix は oklab / oklch 等の色空間で合成されるため hex ベースの静的計算ができない。
// ui 側の許可リストは「実測した実効色」を持ち、その値でコントラストを数値検証している。
// ここでその実測値が今も実描画と一致することを確かめ、トークンや式の変更で許可リストの値が
// 古くなった場合に必ず赤化させる（誰も検証していない自由記述に戻さない）。
test.describe('color-mix の実効色（ポインタのある環境）', () => {
  // Tailwind の hover: は `@media (hover: hover)` に展開されるため、タッチ端末を模した
  // 既定の project（Pixel 5）では hover のスタイルが一切適用されない（実測で確認済み）。
  // hover の色を測るにはポインタのある文脈が要るので、このテストだけ touch 模擬を外す。
  // 裏を返せば、この hover 色は実機のスマートフォンでは描画されない。
  test.use({ isMobile: false, hasTouch: false });

  test('secondary ボタン hover の色が許可リストの実測値と一致する', async ({ page }) => {
    const entry = colorMixAllowlist.find((candidate) => candidate.file === 'button.tsx');
    expect(entry, 'button.tsx の color-mix が許可リストにない').toBeDefined();

    await page.goto('/ui-check');
    const secondary = page.getByRole('button', { name: '副次のボタン' });
    await expect(secondary).toBeVisible();
    expect(
      await page.evaluate(() => matchMedia('(hover: hover)').matches),
      'ポインタのない文脈で実行されている（hover のスタイルが適用されず空振りする）',
    ).toBe(true);

    await secondary.hover();

    // 部品は transition-all を持つため hover 直後は遷移の途中の色が読める。
    // 遷移が終わって色が落ち着くまで待つ（失敗時は最後に読めた実測値がメッセージに出る）。
    await expect
      .poll(async () => (await readRenderedColors(secondary)).backgroundColor, {
        message:
          'hover 後の背景（color-mix の合成後）が許可リストの measuredHex と一致しない。' +
          'トークンか式を変えたなら、実測した値を color-mix-allowlist.json へ反映すること',
        timeout: 5_000,
      })
      .toBe(entry!.measuredHex);

    const rendered = await readRenderedColors(secondary);
    const ratio = contrastRatio(rendered.color ?? '#000000', rendered.backgroundColor ?? '#000000');
    expect(
      ratio,
      `hover 中の secondary ボタン: 文字 ${rendered.color ?? '不明'} on ${rendered.backgroundColor ?? '不明'} → ` +
        `${ratio.toFixed(3)}:1（要求 ${AA_NORMAL_TEXT_RATIO}:1）`,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_RATIO);
  });
});

// ---------------------------------------------------------------------------
// 非テキストコントラスト（WCAG 2.1 SC 1.4.11）の実描画検証。
// spec form-non-text-contrast タスク 4.2 / design.md「Testing Strategy — E2E Tests」1〜4。
//
// なぜ実描画でなければならないか:
// 枠色は「クラス名 → 意味論変数 → 役割トークン」の 3 段を経て決まり、状態依存の指定
// （aria-invalid / data-checked / has-data-checked）は**詳細度の勝敗で最終的な色が決まる**。
// クラス集合の検証はどのクラスが付いているかしか見ないため、どれが実際に勝ったかを証明できない。
// ここでの実測がその唯一の実証手段である。
// ---------------------------------------------------------------------------

// Requirements 1.1 / 1.2: 既定状態のフォーム部品の枠が、フォーカスを当てずに 3:1 以上で識別できる。
test('既定状態のフォーム部品の枠がフォーカスなしで 3:1 以上で描画される', async ({ page }) => {
  await page.goto('/ui-check');
  await expect(page.getByRole('textbox', { name: '一行入力' })).toBeVisible();

  const pageBackground = await readPageBackground(page);

  // 要件 1.2 は「フォーカス指標に依存せずに識別可能」を課す。この test は測定対象を一度も
  // クリック・フォーカスしない。前提が崩れていないことを頁全体でも確認する
  // （何かがフォーカスされていれば、測っているのはフォーカス時の色かもしれない）。
  expect(
    await page.evaluate(() => document.activeElement === document.body),
    '測定前に何かがフォーカスされている。要件 1.2 の「フォーカスを当てずに」が成立していない',
  ).toBe(true);

  const targets: ReadonlyArray<readonly [string, Locator]> = [
    ['一行入力（Input）', page.getByRole('textbox', { name: '一行入力' })],
    ['複数行入力（Textarea）', page.getByRole('textbox', { name: '複数行入力' })],
    ['チェックボックス（Checkbox）', page.getByRole('checkbox', { name: 'チェックボックス' })],
    // ラジオ1 は defaultValue で選択済みのため、既定状態の枠を測る的にはならない。
    ['ラジオ2（RadioGroupItem・未選択）', page.getByRole('radio', { name: 'ラジオ2' })],
  ];

  for (const [where, locator] of targets) {
    const rendered = await readRenderedBorder(locator, where);
    expect(rendered.focused, `${where}: 測定対象がフォーカスされている`).toBe(false);
    expectNonTextContrast(rendered.borderColor as string, pageBackground, where);
  }
});

// Requirements 2.1 / 2.3: 選択状態の表示が 3:1 以上で、かつ未選択とは別色で描画される。
test('選択状態の枠が 3:1 以上かつ未選択と別色で描画される', async ({ page }) => {
  await page.goto('/ui-check');
  const selected = page.getByTestId('wrapped-choice-checked');
  const unselected = page.getByTestId('wrapped-choice-unchecked');
  await expect(selected).toBeAttached();
  await expect(unselected).toBeAttached();

  const pageBackground = await readPageBackground(page);

  // 選択枠の指定（has-data-checked:）は「ラベル領域が選択肢を直下に内包する」構造でしか
  // 発火しない。平坦化すると色が変わるのではなく枠幅が 0 になって消えるため、
  // readRenderedBorder の幅の assert が空振りを捕まえる。
  const selectedBorder = await readRenderedBorder(selected, '囲み枠の選択済み');
  expectNonTextContrast(selectedBorder.borderColor as string, pageBackground, '囲み枠の選択済み');

  // 未選択側は装飾用の枠のままであり、要件が 3:1 を課すのは選択状態のみ（Requirements 2.1）。
  // ここでは「選択状態を示す視覚情報が未選択では出ていない」ことの相手として使う（要件 2.3）。
  const unselectedBorder = await readRenderedBorder(unselected, '囲み枠の未選択');
  expect(
    selectedBorder.borderColor,
    `選択済み（${selectedBorder.borderColor ?? '不明'}）と未選択（${unselectedBorder.borderColor ?? '不明'}）が` +
      '同色で描画されている。選択状態が枠で識別できない',
  ).not.toBe(unselectedBorder.borderColor);
});

// Requirements 3.4: エラー状態の枠が隣接背景に対し 3:1 以上で描画される。
test('エラー状態の枠が 3:1 以上で描画される', async ({ page }) => {
  await page.goto('/ui-check');
  await expect(page.getByRole('textbox', { name: 'エラーの記入欄' })).toBeVisible();

  const pageBackground = await readPageBackground(page);

  const targets: ReadonlyArray<readonly [string, Locator]> = [
    ['エラーの記入欄（Input）', page.getByRole('textbox', { name: 'エラーの記入欄' })],
    ['エラーの確認欄（Checkbox）', page.getByRole('checkbox', { name: 'エラーの確認欄' })],
  ];

  for (const [where, locator] of targets) {
    const rendered = await readRenderedBorder(locator, where);
    // 3:1 だけを見ると、エラー枠が識別用の枠色（4.542:1）へ黙って戻っても緑になる。
    // 測っている枠が確かにエラーの視覚情報であることをトークンの値で固定する。
    expect(
      rendered.borderColor,
      `${where}: 枠がエラー色で描画されていない（実測 ${rendered.borderColor ?? '不明'}）`,
    ).toBe(colors.destructive);
    expectNonTextContrast(rendered.borderColor as string, pageBackground, where);
  }
});

// Requirements 3.4（および 3.1〜3.3）: エラーかつチェック済みの枠がエラー色を保つ。
//
// 本仕様の是正の核心。複合指定（属性セレクタ 2 個分の詳細度）が、選択状態を条件にする単一指定に
// 実描画で実際に勝つことを示す。クラス集合の検証では「どちらのクラスも付いている」ことまでしか
// 分からず、詳細度の破綻はここでしか捕捉できない（tasks.md「3.3 → 4.2 への申し送り」）。
test('エラーかつチェック済みの枠がエラー色で描画され選択色でない', async ({ page }) => {
  await page.goto('/ui-check');

  // 対照: エラーでないチェック済みの枠は選択色である。これが選択色でなければ、
  // 下の「エラー色である」は詳細度の勝敗と無関係に成立してしまい実証にならない。
  const checkedOnly = await readRenderedBorder(
    page.getByRole('checkbox', { name: 'チェック済みの確認欄' }),
    'チェック済みの確認欄',
  );
  expect(
    checkedOnly.borderColor,
    `対照が成立していない: エラーでないチェック済みの枠が選択色で描画されていない（実測 ${checkedOnly.borderColor ?? '不明'}）`,
  ).toBe(colors.primary);

  const composite = await readRenderedBorder(
    page.getByRole('checkbox', { name: 'エラー重畳の確認欄' }),
    'エラー重畳の確認欄',
  );
  expect(
    composite.borderColor,
    `エラーかつチェック済みの枠がエラー色で描画されていない（実測 ${composite.borderColor ?? '不明'}）。` +
      '選択状態の指定が詳細度で勝っており、目で見ている利用者にだけエラーが伝わらない',
  ).toBe(colors.destructive);
  expect(
    composite.borderColor,
    'エラーかつチェック済みの枠が選択色で描画されている（是正前の症状）',
  ).not.toBe(colors.primary);

  // 空振り防止: 対象が実際にチェック済みでなければ、上の assert は aria-invalid 単独の指定でも
  // 通ってしまい「複合指定が勝った」ことの証明にならない。選択済みであることを担う面塗り
  // （要件 3.3: 選択済みは面塗りと印、エラーは枠が担う）を同時に実測する。
  expect(
    composite.backgroundColor,
    `エラー重畳の確認欄が選択色で塗られていない（実測 ${composite.backgroundColor ?? '不明'}）。` +
      'チェック済みになっておらず、枠色の測定が複合指定を通っていない',
  ).toBe(colors.primary);
});

// Requirements 4.2: 装飾用の罫線が識別用へ巻き込まれず現在の値のまま描画される。
test('区切り線が装飾用の値のまま描画される', async ({ page }) => {
  await page.goto('/ui-check');
  const separator = page.locator('[data-slot="separator"]');
  await expect(separator).toHaveCount(1);

  // 可視性でゲートしないこと: 検証面のコンテナ幅が既存の欠陥で極端に狭く解決されるため、
  // 区切り線の矩形は 0×0 になり toBeVisible() は false を返す。枠色・面色の計算値を読む経路は
  // 成立するのでそちらを使う（tasks.md「4.1 → 4.2 への申し送り」）。
  const rendered = await readRenderedColors(separator);
  expect(
    rendered.backgroundColor,
    `区切り線が装飾用の値で描画されていない（実測 ${rendered.backgroundColor ?? '不明'}）`,
  ).toBe(colors.border);
  expect(
    rendered.backgroundColor,
    '区切り線が識別用の枠色へ巻き込まれている。装飾用の意匠を維持する要件 4.2 に反する',
  ).not.toBe(colors.borderInteractive);
});

// Requirements 6.3 / 6.4: 枠色の変更が無効化状態の見た目を巻き添えにした結果を、
// design.md D8 が記録した値として固定する。
//
// D8 が記録する実効色（利用者が実際に見る、合成後の色）。是正前は枠 #EEEEEE / 面 #F7F7F7 で、
// `--input` を識別用役割へ向け直したことで下の値へ変化した。要件 6.4 は「変化するなら意図として
// 記録する」ことを条件に許容しており、D8 がその記録である。ここはその記録の**写し**であり、
// 実描画がこの値から動いたら、意匠判断をやり直して D8 を更新するまで緑にしてはならない。
//
// なぜトークンから再計算しないか: トークンや不透明度から導出した値と突き合わせると、
// 値が変わったときに期待値も一緒に動いてしまい「意図せぬ変化」を検出できない。
// 記録値は固定の literal でなければ番人にならない。
const DISABLED_EFFECTIVE_BORDER = '#BBBBBB';
const DISABLED_EFFECTIVE_SURFACE = '#DDDDDD';

test('無効化された記入欄の枠と面が D8 の記録値どおりの実効色で描画される', async ({ page }) => {
  await page.goto('/ui-check');
  const disabled = page.getByRole('textbox', { name: '無効化の記入欄' });
  await expect(disabled).toBeVisible();
  await expect(disabled).toBeDisabled();

  const pageBackground = await readPageBackground(page);
  const layers = await readRenderedLayers(disabled);

  // 枠の計算値は不透明で四辺一致（readRenderedBorder が幅 0 と食い違いを弾く）。
  // ただしこの値は**利用者が見る色ではない**。要素の不透明度がまだ掛かっていない。
  const rendered = await readRenderedBorder(disabled, '無効化の記入欄');
  expect(
    rendered.borderColor,
    `無効化の記入欄: 枠が識別用の枠色で描画されていない（実測 ${rendered.borderColor ?? '不明'}）`,
  ).toBe(colors.borderInteractive);

  // 空振り防止 1: 面が半透明であること。不透明なら既存の測定手段だけで足り、
  // 本 test が確立した「半透明を織り込む」経路を一度も通らないまま緑になる。
  expect(
    layers.backgroundColor.alpha,
    `無効化の記入欄: 面が半透明で描画されていない（alpha=${layers.backgroundColor.alpha}）`,
  ).toBeLessThan(1);
  expect(layers.backgroundColor.alpha, '無効化の記入欄: 面が完全に透明').toBeGreaterThan(0);

  // 空振り防止 2: 要素全体の不透明度が 1 未満であること。1 なら 2 段目の合成が恒等写像になり、
  // 「要素の不透明度を織り込む」という本 test の主張が検証されないまま緑になる。
  expect(
    layers.opacity,
    `無効化の記入欄に要素の不透明度が掛かっていない（opacity=${layers.opacity}）`,
  ).toBeLessThan(1);
  expect(layers.opacity, '無効化の記入欄の要素の不透明度が 0（描画されていない）').toBeGreaterThan(0);

  // 既存の測定手段は半透明に対して値を返さない。その設計思想（無音で 0 と比較して緑にしない）を
  // 保ったまま実効色を導けることが本 test の主張であり、前提としてここで固定する。
  expect(
    rendered.backgroundColor,
    '半透明の面に対して既存の測定手段が値を返している。' +
      '「決められないときは null」の規律が崩れると、下地を無視した色で無音の緑が出る',
  ).toBeNull();

  // 面の生値も枠と同じ識別用の枠色である（`--input` が枠色と面塗りの双方に使われている
  // 既知の構造。design.md「ui / theme.css 層」で明示的に引き受けている）。
  expect(
    layers.backgroundColor.hex,
    `無効化の記入欄: 面が識別用の枠色で塗られていない（実測 ${layers.backgroundColor.hex}）`,
  ).toBe(colors.borderInteractive);

  const [borderLayer] = layers.borderColors; // 四辺一致は readRenderedBorder が保証済み
  const effectiveBorder = effectiveColorOver(borderLayer!, pageBackground, layers.opacity);
  const effectiveSurface = effectiveColorOver(
    layers.backgroundColor,
    pageBackground,
    layers.opacity,
  );
  const measured =
    `枠 生値 ${borderLayer!.hex}(alpha=${borderLayer!.alpha}) → ${effectiveBorder} / ` +
    `面 生値 ${layers.backgroundColor.hex}(alpha=${layers.backgroundColor.alpha}) → ${effectiveSurface} / ` +
    `要素の不透明度 ${layers.opacity} / 下地 ${pageBackground}`;

  expect(
    effectiveBorder,
    `無効化の記入欄の枠の実効色が design.md D8 の記録値と一致しない。${measured}。` +
      '意図した意匠変更なら D8 を更新すること',
  ).toBe(DISABLED_EFFECTIVE_BORDER);
  expect(
    effectiveSurface,
    `無効化の記入欄の面の実効色が design.md D8 の記録値と一致しない。${measured}。` +
      '意図した意匠変更なら D8 を更新すること',
  ).toBe(DISABLED_EFFECTIVE_SURFACE);

  // 要素の不透明度を織り込まなければ実効色は計算値そのものになる。両者が異なることを固定して、
  // 「不透明度を無視した実装でも通る」検証へ退化しないようにする。
  expect(
    effectiveBorder,
    `枠の実効色が計算値（${rendered.borderColor ?? '不明'}）と同じ。` +
      '要素の不透明度が実効色に効いておらず、利用者が見る色を測れていない',
  ).not.toBe(rendered.borderColor);
});

// requirements 3.3: モバイル端末で横スクロールを発生させずに閲覧・操作できる（回答画面）。
test('モバイルビューポートの回答画面で横スクロールが発生しない', async ({ page }) => {
  await page.goto(`/s/${STORE_ID}`);
  await expect(page.getByRole('button', { name: '星5' })).toBeVisible();
  await expectNoHorizontalScroll(page, '回答画面');
});

// requirements 3.3: 下書き画面（生成テキスト・投稿導線を含む主要画面）でも同様。
test('モバイルビューポートの下書き画面で横スクロールが発生しない', async ({ page }) => {
  await page.goto(`/s/${STORE_ID}`);
  await page.getByRole('button', { name: '星5' }).click();
  await page.getByRole('button', { name: '送信する' }).click();
  await expect(page.getByLabel('口コミ下書き')).toBeVisible();
  await expectNoHorizontalScroll(page, '下書き画面');
});
