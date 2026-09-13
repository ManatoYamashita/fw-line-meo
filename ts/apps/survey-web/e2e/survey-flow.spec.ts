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
  await page.getByRole('link', { name: /クチコミを書く/ }).click();
  const res = await response;
  await (await popup).close();
  const body = JSON.parse(res.request().postData() ?? '{}') as { storeId?: string; token?: string };
  return { status: res.status(), body };
}

// Issue #3 完了条件の機械化: QR URL → 回答 → 下書き → 編集 → コピー → writereview 遷移リンク。
test('客が回答し下書きをコピーして Google 投稿画面リンクへ到達する', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openSurveySurface(page);

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
  await expect(page.getByText(/コピーしました/)).toBeVisible();

  const link = page.getByRole('link', { name: /クチコミを書く/ });
  await expect(link).toHaveAttribute('href', WRITEREVIEW);
});

// 低評価でも同一の投稿導線（レビューゲーティング不在の証明）。
test('低評価（星1）でも同一の投稿導線が表示される', async ({ page }) => {
  await openSurveySurface(page);
  await page.getByRole('button', { name: '星1' }).click();
  await page.getByRole('button', { name: '送信する' }).click();

  await expect(page.getByLabel('口コミ下書き')).toBeVisible();
  await expect(page.getByRole('link', { name: /クチコミを書く/ })).toHaveAttribute('href', WRITEREVIEW);
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
  await expect(page.getByRole('link', { name: /クチコミを書く/ })).toHaveAttribute('href', WRITEREVIEW);
});

// 回答完了後の再訪は回答済み画面＋投稿導線（localStorage・24h）。
test('回答済みで再訪すると回答済み画面と投稿導線が出る', async ({ page }) => {
  await openSurveySurface(page);
  await page.getByRole('button', { name: '星4' }).click();
  await page.getByRole('button', { name: '送信する' }).click();
  await expect(page.getByLabel('口コミ下書き')).toBeVisible();

  await page.reload();
  await expect(page.getByText(/ご回答ありがとうございました/)).toBeVisible();
  await expect(page.getByRole('link', { name: /クチコミを書く/ })).toHaveAttribute('href', WRITEREVIEW);
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
  await expect(page.getByRole('link', { name: /クチコミを書く/ })).toHaveAttribute('href', WRITEREVIEW);

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
