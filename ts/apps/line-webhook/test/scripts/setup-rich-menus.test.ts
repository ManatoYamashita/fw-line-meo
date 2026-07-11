import { describe, it, expect, vi } from 'vitest';
import { setupRichMenus } from '../../scripts/setup-rich-menus.js';
import { decodePostback } from '../../src/onboarding/stages.js';

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

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
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
      uploadCalls.push({ url, contentType: headers['Content-Type'], body: init?.body });
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
    const fetchMock = vi.fn(async (url: string) => {
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
