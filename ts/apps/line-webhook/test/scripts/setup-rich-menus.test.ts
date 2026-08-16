import { describe, it, expect, vi } from 'vitest';
import {
  setupRichMenus,
  buildCompletedRichMenu,
  buildOnboardingRichMenu,
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

  it('各 postback 領域の data が encodeGbpPostback 出力（g_post / g_reply / g_status）と整合する', () => {
    const menu = buildCompletedRichMenu();

    // message 領域はステータス確認（既存挙動の踏襲）。
    const messageActions = menu.areas
      .map((area) => area.action)
      .filter((action) => action.type === 'message');
    expect(messageActions).toHaveLength(1);
    expect(messageActions[0]!.text).toBe('ステータス確認');

    // postback 領域は 3 つ。data を decodeGbpPostback で復号し、g_post / g_reply / g_status に
    // 一致することを機械検証する（リテラル a=g_post 等が encodeGbpPostback と整合する証明）。
    const decoded = menu.areas
      .map((area) => area.action)
      .filter((action) => action.type === 'postback')
      .map((action) => decodeGbpPostback(action.data as string));
    expect(decoded).toHaveLength(3);
    expect(decoded).toContainEqual({ action: 'g_post' });
    expect(decoded).toContainEqual({ action: 'g_reply' });
    expect(decoded).toContainEqual({ action: 'g_status' });
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
