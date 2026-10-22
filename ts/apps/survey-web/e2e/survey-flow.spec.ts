import { test, expect, type Page } from '@playwright/test';

import { openSurveySurface, STORE_ID } from './fixtures/surfaces';

// 面を開く手順（と「本体が描けていること」の前提 assert・storeId の受け取り）は
// fixtures/surfaces.ts が単一の定義を持つ。ここで goto を書き直すと、同じ既定値と同じ前提が
// 2 箇所に生まれ、片方だけが古びる日が来る（Issue #53・PR #191 のレビューで実際に踏んだ形）。

const WRITEREVIEW = /search\.google\.com\/local\/writereview/;

/** token の payload から kind（page / session）を読む。署名の検証はサーバーの仕事なのでここではしない。 */
function tokenKind(token: string): unknown {
  const payload = token.split('.')[0] ?? '';
  return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { kind?: unknown }).kind;
}

/**
 * 投稿導線を押し、自サーバーへの押下の通知（Issue #137・Requirement 5.7 / 5.8）とその応答を捕まえる。
 *
 * リンクは別タブで Google を開く。確かめたいのは自サーバーへの通知であって Google の画面ではないので、
 * 外部へ出ないよう Google への遷移は止め、開いたタブは閉じる。
 */
async function openReviewLinkAndCaptureNotice(page: Page) {
  await page.context().route(/search\.google\.com/, (route) => route.abort());
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/review-link-opened');
  const popup = page.context().waitForEvent('page');
  await page.getByRole('link', { name: /クチコミ欄を開く/ }).click();
  const res = await response;
  await (await popup).close();
  const body = JSON.parse(res.request().postData() ?? '{}') as { storeId?: string; token?: string };
  return { status: res.status(), body };
}

// Issue #3 完了条件の機械化: QR URL → 回答 → 下書き → 編集 → コピー → writereview 遷移リンク。
test('客が回答し下書きをコピーして Google 投稿画面リンクへ到達する', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openSurveySurface(page);
  // LPだけを検索対象にし、店舗ごとの回答画面を重複ページとして登録させない。
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);

  await page.getByRole('button', { name: '星5' }).click();
  await page.getByRole('button', { name: '送信する' }).click();

  const draft = page.getByLabel('口コミ下書き');
  await expect(draft).toBeVisible();

  // 下書きの由来と推敲の促しが**実ブラウザで見えている**こと（Issue #179）。
  //
  // unit は DOM の構造（読み上げ領域の外・aria-describedby）を固定するが、「画面に出ているか」は
  // 別の軸である。実測: 説明へ `display:none` を与えると unit は 29/29 緑のまま、この行だけが赤くなる。
  //
  // **ここが見るのは寸法と可視性であって色ではない。** `toBeVisible` は要素の外接矩形と
  // 可視状態しか見ないため、`--muted-foreground` を面の背景色へ向け直すような改変は通す。
  // 色の劣化を受け持つのは a11y-audit の下書き画面の監査（axe の color-contrast）である。
  // 本 PR より前、その監査は**回答フェーズしか開いていなかった**ため、この面は色を含めて
  // どこからも測られていなかった（PR #218 のレビュー指摘）。
  await expect(page.getByText(/あなたの回答をもとに作成した下書きです。/)).toBeVisible();
  await expect(page.getByText(/ご自身の言葉に直してから投稿してください。/)).toBeVisible();

  await page.getByRole('button', { name: /コピー/ }).click();
  await expect(page.locator('[data-slot="alert"]').getByText(/コピーしました/)).toBeVisible();

  const link = page.getByRole('link', { name: /クチコミ欄を開く/ });
  await expect(link).toHaveAttribute('href', WRITEREVIEW);
});

// 低評価でも同一の投稿導線（レビューゲーティング不在の証明）。
test('低評価（星1）でも同一の投稿導線が表示される', async ({ page }) => {
  await openSurveySurface(page);
  await page.getByRole('button', { name: '星1' }).click();
  await page.getByRole('button', { name: '送信する' }).click();

  await expect(page.getByLabel('口コミ下書き')).toBeVisible();
  await expect(page.getByRole('link', { name: /クチコミ欄を開く/ })).toHaveAttribute('href', WRITEREVIEW);
});

// 素材の集め方を評価で分岐させない（Requirement 2.11・Issue #221）。
// 投稿導線が同一でも、星によって尋ねる内容を変えれば評価で扱いを分ける導線になる。星を選ぶ前・
// 星 1・星 5 のいずれでも、設問の見出しと観点の並びがまったく同じであることを実ブラウザで固定する。
test('設問の見出しと観点の並びは星の値で変わらない', async ({ page }) => {
  await openSurveySurface(page);
  const form = page.locator('form');
  const snapshot = async () => ({
    legends: await form.locator('legend').allTextContents(),
    good: await page.getByRole('group', { name: '良かった点' }).locator('label').allTextContents(),
    concern: await page.getByRole('group', { name: '気になった点' }).locator('label').allTextContents(),
  });

  const before = await snapshot();
  expect(before.legends).toEqual(['満足度（必須）', '良かった点', '気になった点']);
  // 非空アンカー。観点を 1 つも掴めていなければ、以降の相等は空配列同士で成立してしまう。
  expect(before.good.length, '観点を 1 つも掴めていません').toBeGreaterThan(0);
  // 2 つの群は同じ観点を同じ順序で持つ（Requirement 2.4・同じ重みで尋ねる）
  expect(before.concern).toEqual(before.good);

  await page.getByRole('button', { name: '星1' }).click();
  expect(await snapshot()).toEqual(before);
  await page.getByRole('button', { name: '星5' }).click();
  expect(await snapshot()).toEqual(before);
});

// 低評価の客が不満の所在を選んで送信でき、同じ投稿導線へ進める（Issue #221）。
// 送信本文まで見る。wire のフィールド名がずれると、画面は選べるのにサーバーへは届かない
// （silent drop）。画面の見た目だけでは検出できない。
test('星1 で気になった点を選んで送信すると、送信に載って同一の投稿導線が表示される', async ({ page }) => {
  await openSurveySurface(page);
  await page.getByRole('button', { name: '星1' }).click();
  await page.getByRole('group', { name: '気になった点' }).getByRole('checkbox', { name: '接客' }).click();

  const posted = page.waitForRequest(
    (request) => request.url().endsWith('/api/responses') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: '送信する' }).click();
  const body = (await posted).postDataJSON() as { star: number; aspectCodes: string[]; concernCodes: string[] };
  expect(body.star).toBe(1);
  expect(body.aspectCodes).toEqual([]);
  expect(body.concernCodes).toEqual(['service']);

  await expect(page.getByLabel('口コミ下書き')).toBeVisible();
  await expect(page.getByRole('link', { name: /クチコミ欄を開く/ })).toHaveAttribute('href', WRITEREVIEW);
});

// 回答完了後の再訪は回答済み画面＋投稿導線（localStorage・24h）。
test('回答済みで再訪すると回答済み画面と投稿導線が出る', async ({ page }) => {
  await openSurveySurface(page);
  await page.getByRole('button', { name: '星4' }).click();
  await page.getByRole('button', { name: '送信する' }).click();
  await expect(page.getByLabel('口コミ下書き')).toBeVisible();

  await page.reload();
  await expect(page.getByText(/ご回答ありがとうございました/)).toBeVisible();
  await expect(page.getByRole('link', { name: /クチコミ欄を開く/ })).toHaveAttribute('href', WRITEREVIEW);
});

// 投稿導線の押下の観測（Issue #137・Requirement 5.7 / 5.8）。実 token を実サーバーが検証する経路を通す。
// 単体テストはシェルが載せる token と handler の検証を別々に見るので、両者が噛み合って 204 になることは
// ここでしか確かめられない（例: クライアントが送る本文の形とサーバーが読む形のずれ）。
test('下書き画面で投稿導線を押すと、sessionToken つきの押下の通知が受理され、リンクは直リンクのまま', async ({ page }) => {
  await openSurveySurface(page);
  await page.getByRole('button', { name: '星3' }).click();
  await page.getByRole('button', { name: '送信する' }).click();
  await expect(page.getByLabel('口コミ下書き')).toBeVisible();
  // 通知を足しても、投稿導線は Google の投稿画面への直リンクのまま（自サーバーを経由しない）
  await expect(page.getByRole('link', { name: /クチコミ欄を開く/ })).toHaveAttribute('href', WRITEREVIEW);

  const { status, body } = await openReviewLinkAndCaptureNotice(page);

  expect(status).toBe(204);
  expect(body.storeId).toBe(STORE_ID);
  expect(tokenKind(body.token ?? '')).toBe('session');
});

test('回答済み画面で投稿導線を押すと、pageToken つきの押下の通知が受理される', async ({ page }) => {
  await openSurveySurface(page);
  await page.getByRole('button', { name: '星5' }).click();
  await page.getByRole('button', { name: '送信する' }).click();
  await expect(page.getByLabel('口コミ下書き')).toBeVisible();
  await page.reload();
  await expect(page.getByText(/ご回答ありがとうございました/)).toBeVisible();

  const { status, body } = await openReviewLinkAndCaptureNotice(page);

  expect(status).toBe(204);
  expect(body.storeId).toBe(STORE_ID);
  expect(tokenKind(body.token ?? '')).toBe('page');
});

// PR #470: コピー直後の Toast（右下・6 秒）が「Google のクチコミ欄を開く」を覆わないこと。
// 320×568 では着手前、Toast の上端（460）がリンク（512–560）にかぶさり、表示中は押せなかった。
// 見た目ではなく、リンクの中心に何があるか（elementFromPoint）と、その座標を実際に押したときに
// 投稿画面が開いて押下の通知が 1 回だけ飛ぶことまでを、3 つの画面の大きさで確かめる。
// 生成完了の Toast が残っている間にコピーする（Toast が 2 枚積み重なる、厳しい側の状態）。
const TOAST_SIZES = [
  { width: 320, height: 568, ip: '198.51.100.71' },
  { width: 375, height: 667, ip: '198.51.100.72' },
  { width: 390, height: 844, ip: '198.51.100.73' },
] as const;
const COPIED_TOAST = 'コピーしました。「Google のクチコミ欄を開く」から投稿画面を開き、本文欄に貼り付けてください。';

for (const size of TOAST_SIZES) {
  test.describe(`${size.width}×${size.height}`, () => {
    // 流量制限の鍵（X-Forwarded-For の末尾）を大きさごとに分け、ほかのテストと枠を取り合わない。
    test.use({ viewport: { width: size.width, height: size.height }, extraHTTPHeaders: { 'x-forwarded-for': size.ip } });

    test('コピーの Toast の表示中も「Google のクチコミ欄を開く」を押せ、押下の通知は 1 回だけ', async ({ page, context }) => {
      await context.route(/search\.google\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>review</p>' }));
      const notices: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/review-link-opened') notices.push(request.url());
      });

      await openSurveySurface(page);
      await page.getByRole('button', { name: '星5' }).click();
      await page.getByRole('button', { name: '送信する' }).click();
      await expect(page.getByLabel('口コミ下書き')).toBeVisible();
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } });
      });

      await page.getByRole('button', { name: '文章をコピー' }).click();
      const toast = page.locator('[data-sonner-toast]').filter({ hasText: COPIED_TOAST });
      await expect(toast).toBeVisible();

      const link = page.getByRole('link', { name: 'Google のクチコミ欄を開く' });
      // リンクの中心で一番上にある要素が、リンク自身（かその中身）であること。画面送りが落ち着くまで待つ。
      await expect
        .poll(() =>
          link.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const x = box.left + box.width / 2;
            const y = box.top + box.height / 2;
            if (y < 0 || y > window.innerHeight) return 'offscreen';
            const top = document.elementFromPoint(x, y);
            return top !== null && (top === element || element.contains(top)) ? 'link' : (top?.closest('[data-sonner-toast]') ? 'toast' : String(top?.tagName));
          }),
        )
        .toBe('link');
      // 並びの最後の再生成も覆われない（375×667 では着手前、再生成が Toast の下にあった）。
      expect(
        await page.getByRole('button', { name: /別の文章を生成/ }).evaluate((element) => {
          const box = element.getBoundingClientRect();
          const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return top !== null && (top === element || element.contains(top));
        }),
        '再生成が Toast に覆われています',
      ).toBe(true);
      // 確かめている間も Toast は出たままである（Toast が消えたから押せた、ではない）。
      await expect(toast).toBeVisible();

      // その座標を実際に押す（スクロールさせない・force なし）。
      const box = await link.boundingBox();
      expect(box, 'リンクの矩形が取れません').not.toBeNull();
      const firstPopup = context.waitForEvent('page');
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await (await firstPopup).close();
      await expect.poll(() => notices.length).toBe(1);

      // 部品の側の押下（locator.click・force なし）でも開く。通知は最初の押下だけなので増えない。
      const secondPopup = context.waitForEvent('page');
      await link.click();
      await (await secondPopup).close();
      await page.waitForTimeout(300);
      expect(notices).toHaveLength(1);
    });
  });
}

// コピーに失敗したときの主な操作は、選択済みの文章を手動でコピーすること。Toast の上へ操作を
// 送る処理が、選択された入力欄を画面の外へ追い出したり、フォーカスや選択を外したりしないこと。
test.describe('320×568 のコピー失敗', () => {
  test.use({ viewport: { width: 320, height: 568 }, extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.74' } });

  test('入力欄はフォーカスと全文の選択を保ったまま画面に見え、リンクも押せる', async ({ page }) => {
    await openSurveySurface(page);
    await page.getByRole('button', { name: '星5' }).click();
    await page.getByRole('button', { name: '送信する' }).click();
    const draft = page.getByLabel('口コミ下書き');
    await expect(draft).toBeVisible();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
    });

    await page.getByRole('button', { name: '文章をコピー' }).click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: '自動コピーできませんでした' })).toBeVisible();
    // 画面送りが落ち着くまで待つ（リンクが Toast の上に出る）。
    const link = page.getByRole('link', { name: 'Google のクチコミ欄を開く' });
    await expect
      .poll(() =>
        link.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return top !== null && (top === element || element.contains(top));
        }),
      )
      .toBe(true);

    const state = await draft.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      const box = textarea.getBoundingClientRect();
      const style = getComputedStyle(textarea);
      const firstLineY = box.top + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.lineHeight) / 2;
      return {
        focused: document.activeElement === textarea,
        selection: [textarea.selectionStart, textarea.selectionEnd, textarea.value.length],
        top: box.top,
        bottom: box.bottom,
        viewport: window.innerHeight,
        firstLineHit: document.elementFromPoint(box.left + 24, firstLineY) === textarea,
      };
    });
    expect(state.focused, '入力欄からフォーカスが外れています').toBe(true);
    expect(state.selection[0]).toBe(0);
    expect(state.selection[1], '全文の選択が外れています').toBe(state.selection[2]);
    expect(state.top, '入力欄の上端が画面の上へ出ています').toBeGreaterThanOrEqual(0);
    expect(state.bottom, '入力欄の下端が画面の下へ出ています').toBeLessThanOrEqual(state.viewport);
    expect(state.firstLineHit, '文章の 1 行目が見えていません（長押しの起点にできません）').toBe(true);
  });
});
