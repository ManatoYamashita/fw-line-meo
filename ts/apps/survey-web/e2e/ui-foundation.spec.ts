import { test, expect, type Page } from '@playwright/test';

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
