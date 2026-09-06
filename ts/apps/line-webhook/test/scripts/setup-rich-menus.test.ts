import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupRichMenus } from '../../scripts/setup-rich-menus.js';
import { decodePostback } from '../../src/onboarding/stages.js';

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const CREATE_URL = 'https://api.line.me/v2/bot/richmenu';
const DEFAULT_URL_BASE = 'https://api.line.me/v2/bot/user/all/richmenu';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** リッチメニュー画像の上限（rich-menu.md「Image Specifications」の Max file size 1 MB）。 */
const RICH_MENU_IMAGE_MAX_BYTES = 1024 * 1024;
/** PNG のカラータイプのうちアルファチャネルを持つもの（4=グレースケール+A, 6=truecolor+A）。 */
const PNG_COLOR_TYPES_WITH_ALPHA = [4, 6];

// PNG の IHDR は署名 8 バイト + 長さ 4 + 型 4 の直後に固定位置で並ぶ（幅 4 / 高さ 4 /
// ビット深度 1 / カラータイプ 1）。ここを読むだけなら外部依存もデコードも要らない。
function readPngHeader(image: Buffer): { width: number; height: number; colorType: number } {
  if (!image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('PNG 署名が一致しない（assets に PNG 以外が置かれている）');
  }
  return {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
    colorType: image.readUInt8(25),
  };
}

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

  it('作成リクエストの size・比率がリッチメニュー画像仕様の範囲に収まる（幅 800-2500 / 高さ 250 以上 / 比 1.45 以上）', async () => {
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

  // Issue #195: 「宣言した size」と「実際にアップロードする PNG の寸法」が一致していることを、
  // assets/ の実ファイルに対して確かめる。上の範囲判定だけでは、画像と定数のどちらか一方だけを
  // 変えた状態が素通りする。areas は全面 1 タップ（bounds が RICH_MENU_WIDTH/HEIGHT そのもの）
  // なので、寸法の食い違いはそのまま「押せる範囲と絵の食い違い」になる。
  it('宣言した size が assets の実 PNG の寸法と一致し、画像が LINE の仕様を満たす', async () => {
    const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets');
    const [onboardingImage, completedImage] = await Promise.all([
      readFile(path.join(assetsDir, 'richmenu-onboarding.png')),
      readFile(path.join(assetsDir, 'richmenu-completed.png')),
    ]);

    const { fetchMock, createCalls, uploadCalls } = createFetchMock();

    await setupRichMenus({
      channelId: 'id',
      channelSecret: 'secret',
      fetch: fetchMock,
      onboardingImage,
      completedImage,
    });

    expect(createCalls).toHaveLength(2);
    expect(uploadCalls).toHaveLength(2);

    // createFetchMock は 1 回目に richmenu-onboarding-1、2 回目に richmenu-completed-1 を払い出す。
    const richMenuIds = ['richmenu-onboarding-1', 'richmenu-completed-1'];

    for (const [index, createCall] of createCalls.entries()) {
      const richMenuId = richMenuIds[index];
      const upload = uploadCalls.find((call) => call.url.includes(richMenuId!));
      expect(upload, `${richMenuId!} の画像アップロードが見つからない`).toBeDefined();
      expect(upload!.contentType).toBe('image/png');

      const image = upload!.body as Buffer;
      const header = readPngHeader(image);
      const declared = createCall.body.size as { width: number; height: number };

      // 本検査の主眼: 宣言と実物の一致。
      expect(declared.width).toBe(header.width);
      expect(declared.height).toBe(header.height);

      // rich-menu.md「Image Specifications」。透過は下地が白でない面で合成が崩れる。
      expect(image.byteLength).toBeGreaterThan(0);
      expect(image.byteLength).toBeLessThanOrEqual(RICH_MENU_IMAGE_MAX_BYTES);
      expect(PNG_COLOR_TYPES_WITH_ALPHA).not.toContain(header.colorType);
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
