import { expect, test, type Page, type Route } from '@playwright/test';

import { openStructuredSurvey } from './fixtures/structured';
import { openSurveySurface } from './fixtures/surfaces';

// structured survey の回答の段階と下書きの段階の振る舞い（材料の数え方・極性の表示と折り畳み・送信中・再生成・生成失敗）と、
// legacy の再生成。structured-survey.spec.ts は 1 本の通しの流れを持ち、ここはその途中の分岐を 1 つずつ固定する。
//
// 送信と再生成は実際の /api/responses・/api/drafts（実 DB・Gemini は mock-gemini.mjs）へ届く。処理中の表示を観測する
// ためにブラウザ側で応答を遅らせることと、生成失敗の応答を返すことだけを page.route で行う（サーバーの生成器には触れない）。

// 回答と再生成の API は送信元ごとに 1 分 20 件の流量制限を持つ（鍵は X-Forwarded-For の末尾・lib/client-key.ts）。
// このファイルは送信が多く、ほかの spec と同じ鍵（ヘッダー無し）を使うと、スイート全体で上限を超えて 429 になる。
// テストごとに別の送信元として送る（サーバーの制限そのものは変えない）。
test.beforeEach(async ({ page }, testInfo) => {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': `e2e-structured-behavior-${testInfo.testId}` });
});

const positive = (page: Page) => page.getByRole('region', { name: '良かったところ（任意）' });
const concern = (page: Page) => page.getByRole('region', { name: '気になったところ（任意）' });
const commentToggle = (page: Page) => page.getByRole('button', { name: /^その他の感想（任意）/ });
const commentBox = (page: Page) => page.getByRole('textbox', { name: 'その他に伝えたいことがあれば入力してください' });
const submitButton = (page: Page) => page.getByRole('button', { name: /^口コミ文を(作る|作成しています…)$/ });
const regenerateButton = (page: Page) => page.getByRole('button', { name: /^別の文章を(生成（残り\d+回）|作成しています…)$/ });

/** 応答を止めておき、release() で通す（処理中の表示を観測するため）。止めている間の要求の件数も数える。 */
async function holdRequests(page: Page, path: string) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let count = 0;
  await page.route(`**${path}`, async (route: Route) => {
    count += 1;
    await released;
    await route.continue();
  });
  return { release, count: () => count };
}

/** 料理を開いて「量」（料理全体）と「刺身盛り合わせ」の「味」を選ぶ（良かったところ 2 件）。 */
async function pickTwoPositives(page: Page) {
  await positive(page).getByRole('button', { name: '料理' }).click();
  const food = positive(page).getByRole('group', { name: '料理' });
  await food.getByRole('checkbox', { name: '量' }).click();
  await food.getByRole('checkbox', { name: '刺身盛り合わせ' }).click();
  await food.getByText('刺身盛り合わせについて').locator('..').getByRole('checkbox', { name: '味' }).click();
}

async function submitAndWaitForDraft(page: Page) {
  const response = page.waitForResponse((r) => r.url().endsWith('/api/responses'));
  await submitButton(page).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByLabel('口コミ下書き')).toBeVisible();
}

test.describe('structured の材料の数え方（2 件以上で口コミ文を作れる）', () => {
  test('0 件・一言だけ・カテゴリを開いただけは押せず、Target と facet は二重に数えない。2 件で押せる', async ({ page }) => {
    await openStructuredSurvey(page);
    await page.getByRole('button', { name: '星4' }).click();
    await expect(submitButton(page)).toBeDisabled();
    await expect(page.getByText('感想を2つ以上選ぶと口コミ文を作れます')).toBeVisible();

    // 一言だけでは材料に数えない。
    await commentToggle(page).click();
    await commentBox(page).fill('量が多くてお得でした');
    await expect(submitButton(page)).toBeDisabled();
    await expect(page.getByText('感想を2つ以上選ぶと口コミ文を作れます')).toBeVisible();

    // カテゴリを開いただけでは数えない。
    await positive(page).getByRole('button', { name: '料理' }).click();
    await expect(submitButton(page)).toBeDisabled();
    await expect(page.getByText('感想を2つ以上選ぶと口コミ文を作れます')).toBeVisible();

    // Target だけで 1 件。その Target の facet を足しても 1 件のまま（Target と facet を二重に数えない）。
    const food = positive(page).getByRole('group', { name: '料理' });
    await food.getByRole('checkbox', { name: '刺身盛り合わせ' }).click();
    await expect(page.getByText('あと1つ選ぶと口コミ文を作れます')).toBeVisible();
    await food.getByText('刺身盛り合わせについて').locator('..').getByRole('checkbox', { name: '味' }).click();
    await expect(page.getByText('あと1つ選ぶと口コミ文を作れます')).toBeVisible();
    await expect(submitButton(page)).toBeDisabled();

    // 料理全体の「量」で 2 件（良かったところ 2 件だけでよい）。Target の facet にも「量」があるので、先頭（料理全体）を押す。
    await food.getByRole('checkbox', { name: '量' }).first().click();
    await expect(submitButton(page)).toBeEnabled();
    await expect(page.getByText('回答内容をもとに文章を作成します')).toBeVisible();
    await submitAndWaitForDraft(page);
  });

  test('良かったところ 1 件と気になったところ 1 件で作れる（320px 幅でも操作できる）', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await openStructuredSurvey(page);
    await page.getByRole('button', { name: '星3' }).click();
    await positive(page).getByRole('button', { name: '料理' }).click();
    await positive(page).getByRole('group', { name: '料理' }).getByRole('checkbox', { name: '量' }).click();
    await expect(submitButton(page)).toBeDisabled();

    await concern(page).getByRole('button', { name: 'ドリンク' }).click();
    await concern(page).getByRole('group', { name: 'ドリンク' }).getByRole('checkbox', { name: '種類' }).click();
    await expect(submitButton(page)).toBeEnabled();

    const request = page.waitForRequest((r) => r.url().endsWith('/api/responses') && r.method() === 'POST');
    await submitAndWaitForDraft(page);
    const body = (await request).postDataJSON() as { positiveSelections: unknown[]; concernSelections: unknown[] };
    expect(body.positiveSelections).toEqual([{ categoryCode: 'food', facetCodes: ['volume'] }]);
    expect(body.concernSelections).toEqual([{ categoryCode: 'drink', facetCodes: ['variety'] }]);
    await expect(regenerateButton(page)).toBeVisible();
  });
});

test.describe('structured の極性の表示と、その他の感想の折り畳み（Issue #460）', () => {
  test('良かったところと気になったところは同じ形で最初から札を出し、どちらも畳めない', async ({ page }) => {
    await openStructuredSurvey(page);
    const positiveHeading = positive(page).getByRole('heading', { level: 2 });
    const concernHeading = concern(page).getByRole('heading', { level: 2 });
    await expect(positiveHeading).toHaveText('良かったところ（任意）');
    await expect(concernHeading).toHaveText('気になったところ（任意）');
    expect(await concernHeading.getAttribute('class')).toBe(await positiveHeading.getAttribute('class'));
    // 見た目の大きさも同じ（class だけでなく計算後の文字サイズ・太さ・色で確かめる）。
    const style = (h: typeof positiveHeading) =>
      h.evaluate((e) => {
        const c = getComputedStyle(e);
        return [c.fontSize, c.fontWeight, c.color].join('|');
      });
    expect(await style(concernHeading)).toBe(await style(positiveHeading));
    // 両側とも、最初からカテゴリの札が見える（開閉の押しボタンを押さずに選べる）。
    await expect(positive(page).getByRole('button', { name: '料理' })).toBeVisible();
    await expect(concern(page).getByRole('button', { name: '料理' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(良かった|気になった)ところ/ })).toHaveCount(0);
    // 共通の案内は 1 つで、両方の領域が説明として指す。
    const note = page.getByText('良かったところ・気になったところの、どちらからでも選べます。両方を埋める必要はありません。');
    await expect(note).toHaveCount(1);
    const noteId = await note.getAttribute('id');
    expect(noteId).toBeTruthy();
    for (const region of [positive(page), concern(page)]) {
      expect((await region.getAttribute('aria-describedby'))?.split(' ')).toContain(noteId);
    }
  });

  test('気になったところで選び、その他の感想を畳んでも、選択・入力は保持され、送信にも載る', async ({ page }) => {
    await openStructuredSurvey(page);
    await page.getByRole('button', { name: '星2' }).click();

    await concern(page).getByRole('button', { name: '接客・提供' }).click();
    const service = concern(page).getByRole('group', { name: '接客・提供' });
    await service.getByRole('checkbox').nth(0).click();
    await service.getByRole('checkbox').nth(1).click();
    await expect(submitButton(page)).toBeEnabled();

    // その他の感想は、畳んで開き直しても入力が残る。
    await expect(commentBox(page)).toHaveCount(0);
    await commentToggle(page).click();
    await commentBox(page).fill('少し待ちました');
    await commentToggle(page).click();
    await expect(commentBox(page)).toHaveCount(0);
    await expect(commentToggle(page)).toContainText('入力済み');
    await commentToggle(page).click();
    await expect(commentBox(page)).toHaveValue('少し待ちました');
    await commentToggle(page).click();

    // その他の感想を畳んだまま送信しても、選択と一言が載る。
    const request = page.waitForRequest((r) => r.url().endsWith('/api/responses') && r.method() === 'POST');
    await submitAndWaitForDraft(page);
    const body = (await request).postDataJSON() as { concernSelections: { facetCodes: string[] }[]; comment?: string };
    expect(body.concernSelections).toHaveLength(1);
    expect(body.concernSelections[0]!.facetCodes).toHaveLength(2);
    expect(body.comment).toBe('少し待ちました');
  });
});

test.describe('structured の送信中・下書き・再生成', () => {
  test('送信中は押しボタンが処理中になり、二重に送らない', async ({ page }) => {
    await openStructuredSurvey(page);
    await page.getByRole('button', { name: '星5' }).click();
    await pickTwoPositives(page);

    const held = await holdRequests(page, '/api/responses');
    await submitButton(page).click();
    await expect(submitButton(page)).toHaveText(/口コミ文を作成しています…/);
    await expect(submitButton(page)).toBeDisabled();
    await expect(submitButton(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByText('回答内容をもとに文章を作成しています')).toBeVisible();
    // もう一度押しても（押せない押しボタンを強制で押す・Enter で送る）、要求は 1 件のまま。
    await submitButton(page).click({ force: true });
    await page.keyboard.press('Enter');
    expect(held.count()).toBe(1);

    held.release();
    await expect(page.getByLabel('口コミ下書き')).toBeVisible();
    expect(held.count()).toBe(1);
  });

  test('「別の文章を生成」は処理中を示し、成功すると残り回数が減る', async ({ page }) => {
    await openStructuredSurvey(page);
    await page.getByRole('button', { name: '星4' }).click();
    await pickTwoPositives(page);
    await submitAndWaitForDraft(page);
    await expect(page.getByLabel('口コミ下書き')).toHaveValue(/刺身盛り合わせの味が良かったです。/);
    await expect(regenerateButton(page)).toHaveText('別の文章を生成（残り3回）');

    const held = await holdRequests(page, '/api/drafts');
    await regenerateButton(page).click();
    await expect(regenerateButton(page)).toHaveText(/別の文章を作成しています…/);
    await expect(regenerateButton(page)).toBeDisabled();
    await expect(page.getByText('回答内容をもとに文章を作成しています')).toBeVisible();
    await regenerateButton(page).click({ force: true });
    expect(held.count()).toBe(1);
    held.release();

    await expect(regenerateButton(page)).toHaveText('別の文章を生成（残り2回）');
    await expect(page.getByLabel('口コミ下書き')).toHaveValue(/刺身盛り合わせの味が良かったです。/);
  });

  test('初回の生成に失敗したら、失敗の案内・もう一度生成する・投稿導線を出す', async ({ page }) => {
    await openStructuredSurvey(page);
    await page.getByRole('button', { name: '星4' }).click();
    await pickTwoPositives(page);
    await page.route('**/api/responses', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ mode: 'structured', generation: 'failed', draft: null, sessionToken: 'e2e-failed', regenerationsLeft: 3 }),
      }),
    );
    await submitButton(page).click();
    await expect(page.getByText('下書きの生成に失敗しました。再試行するか、そのまま投稿画面へお進みください。')).toBeVisible();
    await expect(page.getByRole('button', { name: 'もう一度生成する' })).toBeEnabled();
    await expect(page.getByRole('link', { name: 'Google のクチコミ欄を開く' })).toBeVisible();
    await expect(page.getByLabel('口コミ下書き')).toHaveCount(0);
  });

  test('表示中の下書きがある再生成の失敗は、編集済みの文章と操作を残し、回数も減らさない。もう一度押すと成功する', async ({ page }) => {
    await openStructuredSurvey(page);
    await page.getByRole('button', { name: '星4' }).click();
    await pickTwoPositives(page);
    await submitAndWaitForDraft(page);
    const draft = page.getByLabel('口コミ下書き');
    await draft.fill('自分の言葉に直した文章です。');

    // サーバーが生成失敗を返したときの応答（同じ sessionToken・残り回数は据え置き）をブラウザ側で返す。
    await page.route('**/api/drafts', async (route) => {
      const { sessionToken } = route.request().postDataJSON() as { sessionToken: string };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ generation: 'failed', draft: null, sessionToken, regenerationsLeft: 3 }),
      });
    });
    await regenerateButton(page).click();
    // 失敗は Toast で伝え、失敗専用の画面（初回の生成の失敗だけに使う）へは切り替えない。
    const failedToast = page.locator('[data-sonner-toast]').filter({ hasText: '別の文章を作成できませんでした' });
    await expect(failedToast).toBeVisible();
    await expect(failedToast).toHaveAttribute('data-type', 'error');
    await expect(draft).toBeVisible();
    await expect(draft).toHaveValue('自分の言葉に直した文章です。');
    await expect(page.getByRole('button', { name: '文章をコピー' })).toBeEnabled();
    await expect(regenerateButton(page)).toHaveText('別の文章を生成（残り3回）');
    await expect(regenerateButton(page)).toBeEnabled();
    await expect(page.getByRole('link', { name: 'Google のクチコミ欄を開く' })).toBeVisible();
    await expect(page.getByText('下書きの生成に失敗しました。再試行するか、そのまま投稿画面へお進みください。')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'もう一度生成する' })).toHaveCount(0);
    await page.unroute('**/api/drafts');

    // 実サーバーへ。失敗では試行を消費していないので、成功して残り 2 回になり、新しい下書きへ置き換わる。
    await regenerateButton(page).click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: '別の口コミ文を作成しました。' })).toHaveAttribute('data-type', 'success');
    await expect(draft).toHaveValue(/刺身盛り合わせの味が良かったです。/);
    await expect(regenerateButton(page)).toHaveText('別の文章を生成（残り2回）');
  });

  test('客の画面に「AI」の語が出ない（回答・送信中・下書き）', async ({ page }) => {
    const noAi = async (where: string) => {
      const text = await page.locator('body').innerText();
      expect(text, where).not.toMatch(/AI|ＡＩ/);
    };
    await openStructuredSurvey(page);
    await noAi('回答の画面');
    await page.getByRole('button', { name: '星4' }).click();
    await pickTwoPositives(page);
    await commentToggle(page).click();
    await noAi('回答の画面（すべて開いた）');
    const held = await holdRequests(page, '/api/responses');
    await submitButton(page).click();
    await expect(submitButton(page)).toBeDisabled();
    await noAi('送信中');
    held.release();
    await expect(page.getByLabel('口コミ下書き')).toBeVisible();
    await noAi('下書きの画面');
  });
});

test.describe('legacy の下書きと再生成', () => {
  test('legacy の回答から下書きを作り、「別の文章を生成」で残り回数が減る', async ({ page }) => {
    await openSurveySurface(page);
    await page.getByRole('button', { name: '星4' }).click();
    await page.getByRole('button', { name: '送信する' }).click();
    const draft = page.getByLabel('口コミ下書き');
    await expect(draft).toHaveValue('E2E モックの口コミ下書きです。');
    await expect(regenerateButton(page)).toHaveText('別の文章を生成（残り3回）');

    const held = await holdRequests(page, '/api/drafts');
    await regenerateButton(page).click();
    await expect(regenerateButton(page)).toBeDisabled();
    await expect(regenerateButton(page)).toHaveText(/別の文章を作成しています…/);
    held.release();
    await expect(regenerateButton(page)).toHaveText('別の文章を生成（残り2回）');
    await expect(draft).toHaveValue('E2E モックの口コミ下書きです。');
  });
});
