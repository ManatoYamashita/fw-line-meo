import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect, type Locator, type Page } from '@playwright/test';
import { contrastRatio } from '@fwlm/design-tokens';

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

interface RenderedColors {
  /** 実際に描画される文字色（6桁 hex）。 */
  color: string | null;
  /** 実際に描画される背景色（6桁 hex）。透明なら null。 */
  backgroundColor: string | null;
}

// 要素に実際に描画される色を読む。
//
// getComputedStyle は color-mix() を `oklch(…)` や `color(srgb …)` の書式のまま返しうるため、
// 文字列の突き合わせでは書式に依存してしまう。canvas の fillStyle にその値をそのまま流して
// 1px 描き、描かれたピクセルの sRGB を読むことで書式非依存の実測値にする。
// 透明（alpha < 255）は「その要素では色が決まらない」ことを意味するので null を返し、
// 呼び出し側に下地の要素を測らせる（無音で 0 と比較して緑になるのを防ぐ）。
function readRenderedColors(locator: Locator): Promise<RenderedColors> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const context = document.createElement('canvas').getContext('2d');
    if (context === null) throw new Error('canvas の 2d コンテキストを取得できません');

    const toHex = (value: string): string | null => {
      context.clearRect(0, 0, 1, 1);
      // 解釈できない書式が来た場合に前の値が残らないよう、毎回 sentinel を置いてから代入する。
      context.fillStyle = '#000000';
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      if (alpha !== 255) return null;
      return `#${[red, green, blue]
        .map((channel) => (channel ?? 0).toString(16).padStart(2, '0'))
        .join('')}`.toUpperCase();
    };

    return { color: toHex(style.color), backgroundColor: toHex(style.backgroundColor) };
  });
}

// --- 実描画の計測基盤（ui-a11y-gaps・要件 5.1 / 5.3） ----------------------------------
//
// タッチ操作領域も動きの抑制も、クラス名の有無では判定できない。前者は疑似要素の幾何と
// レイアウトの相互作用で決まり、後者はカスケードレイヤの優先順位で決まるため、いずれも
// 「そう書いてあるのに効いていない」が起こりうる。ここでは実描画から直接測る。

interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface TouchGeometry {
  /** 利用者に見えている矩形（border box）。 */
  visual: Box;
  /** 見えている矩形と拡張面の和 ＝ 実際に指で押せる領域。 */
  effective: Box;
  /** 拡張面によって領域が実際に広がっているか。 */
  hasExpansion: boolean;
}

/**
 * 要素の実効的な操作領域を実描画から求める。
 *
 * `::after` による拡張はレイアウトフローから外れるので `getBoundingClientRect` には現れない。
 * 疑似要素の矩形は API から直接取れないため、計算済みスタイルの inset から幾何的に求める。
 * `::after` の含有ブロックは本体の **padding box** なので、border 幅の分だけ内側から測る。
 *
 * 拡張量を数値として主張できない場合（`auto` 等）は本体の矩形へ倒す。不明を「広い」と
 * 読み替えると、拡張が消えた実装をそのまま緑で通してしまうため。
 */
function readTouchGeometry(locator: Locator): Promise<TouchGeometry> {
  return locator.evaluate((element) => {
    const toBox = (top: number, right: number, bottom: number, left: number): Box => ({
      top,
      right,
      bottom,
      left,
      width: right - left,
      height: bottom - top,
    });
    const rect = element.getBoundingClientRect();
    const visual = toBox(rect.top, rect.right, rect.bottom, rect.left);
    const withoutExpansion = { visual, effective: visual, hasExpansion: false };

    const after = getComputedStyle(element, '::after');
    // 疑似要素が生成されない／レイアウトに参加しない／当たり判定を持たない場合は拡張なし。
    if (
      after.content === 'none' ||
      after.position !== 'absolute' ||
      after.pointerEvents === 'none'
    ) {
      return withoutExpansion;
    }

    const px = (value: string): number => Number.parseFloat(value);
    const own = getComputedStyle(element);
    const padTop = rect.top + px(own.borderTopWidth);
    const padLeft = rect.left + px(own.borderLeftWidth);
    const padRight = rect.right - px(own.borderRightWidth);
    const padBottom = rect.bottom - px(own.borderBottomWidth);

    const insets = [after.top, after.right, after.bottom, after.left].map(px);
    if (insets.some((value) => !Number.isFinite(value))) return withoutExpansion;
    const [insetTop, insetRight, insetBottom, insetLeft] = insets as [
      number,
      number,
      number,
      number,
    ];

    // inset は含有ブロックの各辺からの距離。負の値が外側へのはみ出しになる。
    const overlay = toBox(
      padTop + insetTop,
      padRight - insetRight,
      padBottom - insetBottom,
      padLeft + insetLeft,
    );
    // 実際に押せるのは本体と拡張面の和。拡張面が本体より内側でも領域は縮まない。
    const effective = toBox(
      Math.min(visual.top, overlay.top),
      Math.max(visual.right, overlay.right),
      Math.max(visual.bottom, overlay.bottom),
      Math.min(visual.left, overlay.left),
    );
    return {
      visual,
      effective,
      hasExpansion: effective.width > visual.width || effective.height > visual.height,
    };
  });
}

interface HitTarget {
  slot: string | null;
  name: string;
}

/**
 * 指定した座標で実際に反応する部品を返す。
 *
 * 幾何の計算だけでは「その矩形が本当に当たり判定を持つか」を主張できない。座標を撃って
 * 返ってきた要素を見ることで、幾何と実際の反応先を結びつける（この紐が無いと、
 * `pointer-events` の欠落や他要素による被覆を素通ししてしまう）。
 */
function readHitTarget(page: Page, x: number, y: number): Promise<HitTarget | null> {
  return page.evaluate(
    ([pointX, pointY]) => {
      const element = document.elementFromPoint(pointX as number, pointY as number);
      if (element === null) return null;
      const owner = element.closest('[data-slot]');
      const named = owner ?? element;
      return {
        slot: owner === null ? null : owner.getAttribute('data-slot'),
        name:
          named.getAttribute('aria-label') ?? (named.textContent ?? '').trim().slice(0, 24),
      };
    },
    [x, y],
  );
}

interface MotionValues {
  animationName: string;
  animationDurationSeconds: number;
  animationIterationCount: string;
  transitionDurationSeconds: number;
}

/**
 * 動きの実効値を計算済みスタイルから読む。
 *
 * カンマ区切りで複数指定されうるため代表値には最大を採る。1 つでも知覚できる長さが
 * 残っていれば抑制は成立していないので、平均や先頭では甘くなる。
 */
function readMotion(locator: Locator): Promise<MotionValues> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const maxSeconds = (value: string): number =>
      value.split(',').reduce((longest, part) => {
        const text = part.trim();
        const amount = Number.parseFloat(text);
        if (!Number.isFinite(amount)) return longest;
        return Math.max(longest, text.endsWith('ms') ? amount / 1000 : amount);
      }, 0);
    return {
      animationName: style.animationName,
      animationDurationSeconds: maxSeconds(style.animationDuration),
      animationIterationCount: style.animationIterationCount,
      transitionDurationSeconds: maxSeconds(style.transitionDuration),
    };
  });
}

/**
 * 検証面のレイアウトが degenerate になっていないことを、寸法の検証より **先に** 確かめる。
 *
 * これが無いと、検証面が潰れたときに寸法の検証は失敗側へ倒れるものの、原因が部品ではなく
 * 検証面にあることに気づけない（design「失敗モードと観測性」）。
 */
async function expectVerificationSurfaceSane(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) {
    throw new Error('Playwright の viewport が未設定（モバイル幅の project で実行すること）');
  }
  const width = await page
    .locator('main')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(
    width,
    `検証面の main の実幅が ${width}px しかない（端末幅 ${viewport.width}px）。` +
      'これは部品の欠陥ではなく検証面のレイアウトが壊れている状態で、この幅で測った' +
      'タッチ操作領域は実態を表さない。コンテナ幅に名前付きスケール（max-w-md 等）を' +
      '使うと --spacing-* のトークン上書きに巻き込まれて実幅 32px へ潰れる（Issue #54）',
  ).toBeGreaterThanOrEqual(viewport.width * 0.8);
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

// ui-a11y-gaps 要件 5.3: 実測の前提そのものを検証する。
//
// 以降のタッチ操作領域・動きの検証は、いずれもこの計測基盤の上に立つ。基盤が壊れたまま
// 「部品が要求を満たしていない」と報告すると原因の切り分けを誤らせるため、基盤の健全性を
// 独立したテストとして固定する。
test('実描画の計測基盤と検証面が実測の前提を満たしている', async ({ page }) => {
  await page.goto('/ui-check');
  await expect(page.getByRole('button', { name: '既定のボタン' })).toBeVisible();

  // 前提 1: 検証面が端末幅どおりに描かれている。
  await expectVerificationSurfaceSane(page);

  // 前提 2: 拡張面を持つ部品で、見えている矩形と実効領域を区別して読める。
  // Checkbox は `::after` で操作領域だけを広げている唯一の既存例（要件 4.8 により現状維持）。
  const checkbox = page.locator('[data-slot="checkbox"]').first();
  const geometry = await readTouchGeometry(checkbox);
  expect(
    geometry.hasExpansion,
    `Checkbox の拡張面を読み取れていない: ${JSON.stringify(geometry)}`,
  ).toBe(true);
  expect(
    geometry.effective.height,
    `実効領域(${geometry.effective.height}px)が視覚領域(${geometry.visual.height}px)を超えていない`,
  ).toBeGreaterThan(geometry.visual.height);

  // 前提 3: 求めた幾何が実際に当たり判定を持つ（pointer-events の欠落・被覆を落とす）。
  // 拡張領域の左上の内側 1px を撃つ。本体の外側なので、拡張が効いていなければ別要素が返る。
  const corner = await readHitTarget(
    page,
    geometry.effective.left + 1,
    geometry.effective.top + 1,
  );
  expect(
    corner?.slot,
    `拡張領域の隅(${geometry.effective.left + 1}, ${geometry.effective.top + 1})で ` +
      `${JSON.stringify(corner)} が反応した。幾何は広いが当たり判定が無い`,
  ).toBe('checkbox');

  // 前提 4: 動きの実効値が読める。かつ「無いものを有ると言わない」。
  const button = page.getByRole('button', { name: '既定のボタン' });
  const motion = await readMotion(button);
  expect(
    motion.transitionDurationSeconds,
    `既定のボタンの遷移時間を読み取れていない: ${JSON.stringify(motion)}`,
  ).toBeGreaterThan(0);
  expect(
    motion.animationDurationSeconds,
    `アニメーションを持たない部品に時間が現れている: ${JSON.stringify(motion)}`,
  ).toBe(0);
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
