import { describe, it, expect, vi } from 'vitest';
import {
  setupRichMenus,
  buildCompletedRichMenu,
  buildOnboardingRichMenu,
  relinkExistingUsers,
} from '../../scripts/setup-rich-menus.js';
import { decodePostback } from '../../src/onboarding/stages.js';
// GBP postback の整合検証用（読み取りのみ・task 5.2 の境界順守）。
import { decodeGbpPostback } from '../../src/gbp/postback.js';

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const CREATE_URL = 'https://api.line.me/v2/bot/richmenu';
const DEFAULT_URL_BASE = 'https://api.line.me/v2/bot/user/all/richmenu';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
  } as Response;
}

// Create 呼び出しは2回（オンボーディング用→完了用の順）発生する前提で、
// 呼ばれた順に異なる richMenuId を払い出すフェイク。
function createFetchMock(): {
  fetchMock: ReturnType<typeof vi.fn>;
  createCalls: Array<{ url: string; body: Record<string, unknown> }>;
  uploadCalls: Array<{ url: string; contentType: string; body: unknown }>;
  defaultCalls: string[];
} {
  const createCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const uploadCalls: Array<{ url: string; contentType: string; body: unknown }> = [];
  const defaultCalls: string[] = [];
  let createCount = 0;

  const fetchMock = vi.fn(async (rawUrl: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(rawUrl);
    if (url === TOKEN_URL) {
      return jsonResponse(200, { access_token: 'stateless-token-1', expires_in: 900 });
    }

    if (url === CREATE_URL) {
      createCount += 1;
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      createCalls.push({ url, body });
      const richMenuId = createCount === 1 ? 'richmenu-onboarding-1' : 'richmenu-completed-1';
      return jsonResponse(200, { richMenuId });
    }

    if (url.startsWith('https://api-data.line.me/v2/bot/richmenu/') && url.endsWith('/content')) {
      const headers = init?.headers as Record<string, string>;
      const contentType = headers['Content-Type'];
      if (contentType === undefined) throw new Error('Content-Type ヘッダが送信されていません');
      uploadCalls.push({ url, contentType, body: init?.body });
      return emptyResponse(200);
    }

    if (url.startsWith(DEFAULT_URL_BASE)) {
      defaultCalls.push(url);
      return emptyResponse(200);
    }

    throw new Error(`unexpected fetch call: ${url}`);
  });

  return { fetchMock, createCalls, uploadCalls, defaultCalls };
}

describe('setupRichMenus', () => {
  it('オンボーディング用メニューの areas に resume postback を割り当てる', async () => {
    const { fetchMock, createCalls } = createFetchMock();

    await setupRichMenus({
      channelId: 'test-channel-id',
      channelSecret: 'test-channel-secret',
      fetch: fetchMock,
      onboardingImage: Buffer.from('onboarding-png-bytes'),
      completedImage: Buffer.from('completed-png-bytes'),
    });

    expect(createCalls).toHaveLength(2);
    const onboardingCreateCall = createCalls[0];
    expect(onboardingCreateCall).toBeDefined();
    const areas = onboardingCreateCall!.body.areas as Array<{ action: { type: string; data?: string } }>;
    expect(areas.length).toBeGreaterThan(0);
    const resumeArea = areas.find((area) => area.action.type === 'postback');
    expect(resumeArea).toBeDefined();
    const decoded = decodePostback(resumeArea!.action.data as string);
    expect(decoded).toEqual({ kind: 'resume' });
  });

  it('両メニューの画像アップロードが api-data.line.me の正しい richMenuId へ送信される', async () => {
    const { fetchMock, uploadCalls } = createFetchMock();

    await setupRichMenus({
      channelId: 'id',
      channelSecret: 'secret',
      fetch: fetchMock,
      onboardingImage: Buffer.from('onboarding-bytes'),
      completedImage: Buffer.from('completed-bytes'),
    });

    expect(uploadCalls).toHaveLength(2);
    expect(uploadCalls[0]!.url).toBe(
      'https://api-data.line.me/v2/bot/richmenu/richmenu-onboarding-1/content',
    );
    expect(uploadCalls[0]!.contentType).toBe('image/png');
    expect(uploadCalls[0]!.body).toEqual(Buffer.from('onboarding-bytes'));

    expect(uploadCalls[1]!.url).toBe(
      'https://api-data.line.me/v2/bot/richmenu/richmenu-completed-1/content',
    );
    expect(uploadCalls[1]!.contentType).toBe('image/png');
    expect(uploadCalls[1]!.body).toEqual(Buffer.from('completed-bytes'));
  });

  it('デフォルトリッチメニュー設定はオンボーディング用メニューを対象にする（完了用ではない）', async () => {
    const { fetchMock, defaultCalls } = createFetchMock();

    await setupRichMenus({
      channelId: 'id',
      channelSecret: 'secret',
      fetch: fetchMock,
      onboardingImage: Buffer.from('a'),
      completedImage: Buffer.from('b'),
    });

    expect(defaultCalls).toHaveLength(1);
    expect(defaultCalls[0]).toBe(`${DEFAULT_URL_BASE}/richmenu-onboarding-1`);
  });

  it('両方の richMenuId を返す', async () => {
    const { fetchMock } = createFetchMock();

    const result = await setupRichMenus({
      channelId: 'id',
      channelSecret: 'secret',
      fetch: fetchMock,
      onboardingImage: Buffer.from('a'),
      completedImage: Buffer.from('b'),
    });

    expect(result).toEqual({
      onboardingRichMenuId: 'richmenu-onboarding-1',
      completedRichMenuId: 'richmenu-completed-1',
    });
  });

  it('作成リクエストの size・比率がリッチメニュー画像仕様を満たす（width 800 x height 540, ratio>=1.45）', async () => {
    const { fetchMock, createCalls } = createFetchMock();

    await setupRichMenus({
      channelId: 'id',
      channelSecret: 'secret',
      fetch: fetchMock,
      onboardingImage: Buffer.from('a'),
      completedImage: Buffer.from('b'),
    });

    for (const call of createCalls) {
      const size = call.body.size as { width: number; height: number };
      expect(size.width).toBeGreaterThanOrEqual(800);
      expect(size.width).toBeLessThanOrEqual(2500);
      expect(size.height).toBeGreaterThanOrEqual(250);
      expect(size.width / size.height).toBeGreaterThanOrEqual(1.45);
      expect((call.body.chatBarText as string).length).toBeLessThanOrEqual(14);
    }
  });

  it('トークン発行に失敗した場合は例外を投げる', async () => {
    const fetchMock = vi.fn(async (rawUrl: Parameters<typeof fetch>[0]) => {
    const url = String(rawUrl);
      if (url === TOKEN_URL) {
        return jsonResponse(401, {});
      }
      return emptyResponse(200);
    });

    await expect(
      setupRichMenus({
        channelId: 'id',
        channelSecret: 'secret',
        fetch: fetchMock,
        onboardingImage: Buffer.from('a'),
        completedImage: Buffer.from('b'),
      }),
    ).rejects.toThrow();
  });
});

// task 5.2（gbp-post-review-reply Requirement 5.4）: 完了後メニューの 4 領域化を
// 実 LINE API へ投げずに検証する dry-run（design.md「E2E/UI Tests: リッチメニュー 4 領域の
// 登録スクリプト dry-run（領域座標・postback data 検証）」）。menu 定義を純関数として
// 切り出しているため fetch モックを介さず直接検証できる。
describe('buildCompletedRichMenu (dry-run: 4 領域化)', () => {
  it('ステータス確認 / Google 投稿作成 / クチコミ返信 / Google 連携・設定 の 4 領域を持つ', () => {
    const menu = buildCompletedRichMenu();
    expect(menu.areas).toHaveLength(4);
  });

  // PR #121 レビュー指摘: 完了後メニューに message アクションを残すと、投稿フローの
  // await_input 中にタップされた文字列が **投稿の要点として取り込まれる**（承認ボタン付きの
  // 下書きが提示される）。4 領域すべてを postback にして、テキスト注入経路を消す。
  it('message アクションを 1 つも持たない（テキスト注入経路を作らない）', () => {
    const menu = buildCompletedRichMenu();

    expect(menu.areas.filter((area) => area.action.type === 'message')).toHaveLength(0);
  });

  // 座標・label・data を**束ねて**固定する。別々に検証すると、右上と左下の data を入れ替えても
  // 「4 領域ある」「action の集合が正しい」「label が 20 字以内」がすべて緑のまま通り、
  // 「Google 投稿作成」をタップしたオーナーがクチコミ返信フローに入る無音の事故を検出できない。
  it('各象限の (座標, label, 復号した action) の対応が固定されている', () => {
    const menu = buildCompletedRichMenu();
    const half = { w: menu.size.width / 2, h: menu.size.height / 2 };

    const actual = menu.areas.map((area) => ({
      x: area.bounds.x,
      y: area.bounds.y,
      label: area.action.label,
      // 左上だけは onboarding 名前空間（`a=resume`）。GBP の decode は受理しない。
      decoded:
        decodeGbpPostback(area.action.data as string) ??
        decodePostback(area.action.data as string),
    }));

    expect(actual).toEqual([
      { x: 0, y: 0, label: 'ステータス確認', decoded: { kind: 'resume' } },
      { x: half.w, y: 0, label: 'Google 投稿作成', decoded: { action: 'g_post' } },
      { x: 0, y: half.h, label: 'クチコミ返信', decoded: { action: 'g_reply' } },
      { x: half.w, y: half.h, label: 'Google 連携・設定', decoded: { action: 'g_status' } },
    ]);
  });

  // 4 象限の面積合計が画像全面に一致する（スクリプト内コメントの「重複なく画像全面を被覆」を
  // 機械検証する。重複が無いことは下の非重複テストが別途見ている）。
  it('4 領域の面積合計が画像全面と一致する（タイル被覆）', () => {
    const menu = buildCompletedRichMenu();
    const area = menu.areas.reduce((sum, a) => sum + a.bounds.width * a.bounds.height, 0);

    expect(area).toBe(menu.size.width * menu.size.height);
  });

  it('4 領域は互いに重複せず、リッチメニュー画像サイズ内に収まる', () => {
    const menu = buildCompletedRichMenu();
    const { width, height } = menu.size;

    // 各領域が画像の内側（原点は左上）に収まる。
    for (const { bounds } of menu.areas) {
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.height).toBeGreaterThan(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
    }

    // 全ペアで矩形が重ならないことを検証する（半開区間での交差判定）。
    for (let i = 0; i < menu.areas.length; i += 1) {
      for (let j = i + 1; j < menu.areas.length; j += 1) {
        const a = menu.areas[i]!.bounds;
        const b = menu.areas[j]!.bounds;
        const overlaps =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('全アクションの label が Rich Menu の 20 字上限内である', () => {
    const menu = buildCompletedRichMenu();
    for (const { action } of menu.areas) {
      expect((action.label ?? '').length).toBeLessThanOrEqual(20);
    }
  });
});

describe('buildOnboardingRichMenu (回帰: 不変であること)', () => {
  it('1 領域の resume postback のまま変更されない', () => {
    const menu = buildOnboardingRichMenu();
    expect(menu.areas).toHaveLength(1);
    const decoded = decodePostback(menu.areas[0]!.action.data as string);
    expect(decoded).toEqual({ kind: 'resume' });
  });
});


// PR #121 レビュー指摘の是正。linkRichMenu は confirmStore 完了時の 1 箇所でしか呼ばれないため、
// 完了後メニューを作り直しても既に completed のオーナーは旧メニューに紐づいたままになる。
// bulk/link（500 件上限・userId の一覧が要る）ではなく batch の link 操作を使うのは、
// userId のリストが不要でスクリプトに DB 依存を持ち込まずに済むため。
describe('relinkExistingUsers（既存オーナーの一括再リンク）', () => {
  const BATCH_URL = 'https://api.line.me/v2/bot/richmenu/batch';
  const PROGRESS_URL = 'https://api.line.me/v2/bot/richmenu/progress/batch';

  function createBatchFetchMock(options: { requestId?: string | null; phase?: string } = {}): {
    fetchMock: ReturnType<typeof vi.fn>;
    batchBodies: unknown[];
    progressUrls: string[];
  } {
    const batchBodies: unknown[] = [];
    const progressUrls: string[] = [];

    const fetchMock = vi.fn(async (rawUrl: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(rawUrl);
      if (url === TOKEN_URL) {
        return jsonResponse(200, { access_token: 'stateless-token-1', expires_in: 900 });
      }
      if (url === BATCH_URL) {
        batchBodies.push(JSON.parse(init?.body as string));
        // 進捗照会のキーは応答本文ではなく x-line-request-id ヘッダで返る。
        const requestId = options.requestId === undefined ? 'req-1' : options.requestId;
        return {
          ok: true,
          status: 202,
          headers: { get: (name: string) => (name === 'x-line-request-id' ? requestId : null) },
          json: async () => ({}),
        } as unknown as Response;
      }
      if (url.startsWith(PROGRESS_URL)) {
        progressUrls.push(url);
        return jsonResponse(200, { phase: options.phase ?? 'succeeded' });
      }
      throw new Error(`unexpected fetch call: ${url}`);
    });

    return { fetchMock, batchBodies, progressUrls };
  }

  const deps = (fetchMock: ReturnType<typeof vi.fn>) => ({
    channelId: 'test-channel-id',
    channelSecret: 'test-channel-secret',
    fetch: fetchMock as unknown as typeof fetch,
  });

  it('旧メニュー → 新メニューの link 操作を 1 件だけ送る', async () => {
    const { fetchMock, batchBodies } = createBatchFetchMock();

    const result = await relinkExistingUsers(deps(fetchMock), 'richmenu-old', 'richmenu-new');

    expect(batchBodies).toEqual([
      { operations: [{ type: 'link', from: 'richmenu-old', to: 'richmenu-new' }] },
    ]);
    expect(result).toEqual({ requestId: 'req-1', phase: 'succeeded' });
  });

  it('進捗は x-line-request-id を requestId として照会する（batch は非同期）', async () => {
    const { fetchMock, progressUrls } = createBatchFetchMock({ phase: 'ongoing' });

    const result = await relinkExistingUsers(deps(fetchMock), 'richmenu-old', 'richmenu-new');

    expect(progressUrls).toEqual([`${PROGRESS_URL}?requestId=req-1`]);
    // 受理と反映は別。ongoing をそのまま返し、成功と言い切らない。
    expect(result.phase).toBe('ongoing');
  });

  it('requestId が返らなければ進捗を照会せず unknown を返す（成功と断定しない）', async () => {
    const { fetchMock, progressUrls } = createBatchFetchMock({ requestId: null });

    const result = await relinkExistingUsers(deps(fetchMock), 'richmenu-old', 'richmenu-new');

    expect(progressUrls).toEqual([]);
    expect(result).toEqual({ requestId: null, phase: 'unknown' });
  });

  it('batch が非 2xx なら例外にする（部分適用を黙って成功にしない）', async () => {
    const fetchMock = vi.fn(async (rawUrl: Parameters<typeof fetch>[0]) => {
      const url = String(rawUrl);
      if (url === TOKEN_URL) {
        return jsonResponse(200, { access_token: 'stateless-token-1', expires_in: 900 });
      }
      return emptyResponse(429);
    });

    await expect(
      relinkExistingUsers(deps(fetchMock), 'richmenu-old', 'richmenu-new'),
    ).rejects.toThrow('429');
  });
});
