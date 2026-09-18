import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupCompletedRichMenuOnly, setupRichMenus } from '../../scripts/setup-rich-menus.js';
import { decodePostback } from '../../src/onboarding/stages.js';

/** 完了後メニューの「詳細を見る」の遷移先（env LIFF_STORE_DETAIL_URL 相当）。 */
const LIFF_STORE_DETAIL_URL = 'https://liff.line.me/2000000000-c9detail';

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const CREATE_URL = 'https://api.line.me/v2/bot/richmenu';
const DEFAULT_URL_BASE = 'https://api.line.me/v2/bot/user/all/richmenu';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** リッチメニュー画像の上限（rich-menu.md「Image Specifications」の Max file size 1 MB）。 */
const RICH_MENU_IMAGE_MAX_BYTES = 1024 * 1024;
/** PNG のカラータイプのうちアルファチャネルを持つもの（4=グレースケール+A, 6=truecolor+A）。 */
const PNG_COLOR_TYPES_WITH_ALPHA = [4, 6];

// メニューごとの寸法の正典（design.md「RichMenuDefinitions と RichMenuScripts」の区画表）。
// 作成リクエストの発生順（1 回目=オンボーディング用、2 回目=完了後）に並べる。
// 実装の定数をそのまま読まずに値を書き写しているのは、宣言と実 PNG が同じ向きへ一緒にずれた状態
// （両方を 2500x843 のまま据え置く等）を試験が受理しないためである。
const EXPECTED_MENU_SIZES: ReadonlyArray<{ menu: string; width: number; height: number }> = [
  // オンボーディング用は Half (HD)。再開の 1 タップだけの面なので占有高さを増やさない。
  { menu: 'onboarding', width: 2500, height: 843 },
  // 完了後は Full (HD)。上段 3 区画（レポート）＋下段 2 区画（詳細・ステータス）の 2 段を持つ。
  { menu: 'completed', width: 2500, height: 1686 },
];

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

// Create 呼び出しの順に richMenuId を払い出すフェイク。既定は 2 回（オンボーディング用→完了用）の
// 前提だが、`--completed-only`（完了後メニューだけを作る動作）では 1 回しか呼ばれないため、
// 払い出す ID の並びを呼出側から渡せるようにしてある。
function createFetchMock(
  richMenuIds: readonly string[] = ['richmenu-onboarding-1', 'richmenu-completed-1'],
): {
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
      const richMenuId = richMenuIds[createCount - 1];
      if (richMenuId === undefined) throw new Error(`払い出す richMenuId が足りない（${createCount} 回目）`);
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
      liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
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
      liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
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
      liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
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
      liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
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
      liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
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
  // 変えた状態が素通りする。区画の bounds は宣言した寸法の中に置かれるので、寸法の食い違いは
  // そのまま「押せる範囲と絵の食い違い」になる。
  // Issue #256: メニューごとに寸法が異なる（オンボーディング用は Half・完了後は Full）ため、
  // 照合は 2 つのメニューそれぞれの宣言と、そのメニューの PNG の間で行う。
  it('宣言した size がメニューごとの正典および assets の実 PNG の寸法と一致し、画像が LINE の仕様を満たす', async () => {
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
      liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
      onboardingImage,
      completedImage,
    });

    expect(createCalls).toHaveLength(2);
    expect(uploadCalls).toHaveLength(2);

    // createFetchMock は 1 回目に richmenu-onboarding-1、2 回目に richmenu-completed-1 を払い出す。
    const richMenuIds = ['richmenu-onboarding-1', 'richmenu-completed-1'];

    for (const [index, createCall] of createCalls.entries()) {
      const richMenuId = richMenuIds[index];
      const expected = EXPECTED_MENU_SIZES[index];
      expect(expected, `${index} 番目のメニューの寸法の正典が無い`).toBeDefined();
      const upload = uploadCalls.find((call) => call.url.includes(richMenuId!));
      expect(upload, `${richMenuId!} の画像アップロードが見つからない`).toBeDefined();
      expect(upload!.contentType).toBe('image/png');

      const image = upload!.body as Buffer;
      const header = readPngHeader(image);
      const declared = createCall.body.size as { width: number; height: number };

      // 本検査の主眼: 宣言と実物の一致。あわせて、両者が同じ向きへ一緒にずれていないことを
      // メニューごとの正典に対して固定する。
      expect(declared.width).toBe(header.width);
      expect(declared.height).toBe(header.height);
      expect({ menu: expected!.menu, width: declared.width, height: declared.height }).toEqual(
        expected,
      );

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
        liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
        onboardingImage: Buffer.from('a'),
        completedImage: Buffer.from('b'),
      }),
    ).rejects.toThrow();
  });
});

// メニューの差し替え（design.md「Migration Strategy」の Step C）が使う動作。
describe('setupCompletedRichMenuOnly', () => {
  it('完了後メニューだけを作り、既定メニューには触れない', async () => {
    const { fetchMock, createCalls, uploadCalls, defaultCalls } = createFetchMock([
      'richmenu-completed-2',
    ]);

    const result = await setupCompletedRichMenuOnly({
      channelId: 'id',
      channelSecret: 'secret',
      fetch: fetchMock,
      liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
      completedImage: Buffer.from('completed-bytes'),
    });

    // 作るのは 1 面だけで、それは完了後メニュー（Full・5 区画）である。
    expect(createCalls).toHaveLength(1);
    const body = createCalls[0]!.body;
    expect(body.size).toEqual({ width: 2500, height: 1686 });
    expect((body.areas as unknown[]).length).toBe(5);

    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]!.url).toBe(
      'https://api-data.line.me/v2/bot/richmenu/richmenu-completed-2/content',
    );
    expect(uploadCalls[0]!.body).toEqual(Buffer.from('completed-bytes'));

    // Requirement 2.6: 既定メニューはオンボーディング用のままでなければならない。
    // 既定の設定を 1 回でも呼ぶと、店舗特定前のオーナーの面が完了後メニューに置き換わる。
    expect(defaultCalls).toEqual([]);
    const requestedUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(requestedUrls.filter((url) => url.startsWith(DEFAULT_URL_BASE))).toEqual([]);

    // 運用者が LINE_RICHMENU_COMPLETED_ID と張り替えへ渡す値。
    expect(result).toEqual({ completedRichMenuId: 'richmenu-completed-2' });
  });

  it('作成に失敗した場合は例外を投げる（画像を登録しないメニューを残さない）', async () => {
    const fetchMock = vi.fn(async (rawUrl: Parameters<typeof fetch>[0]) => {
      const url = String(rawUrl);
      if (url === TOKEN_URL) {
        return jsonResponse(200, { access_token: 'stateless-token-1', expires_in: 900 });
      }
      if (url === CREATE_URL) {
        return jsonResponse(500, {});
      }
      return emptyResponse(200);
    });

    await expect(
      setupCompletedRichMenuOnly({
        channelId: 'id',
        channelSecret: 'secret',
        fetch: fetchMock,
        liffStoreDetailUrl: LIFF_STORE_DETAIL_URL,
        completedImage: Buffer.from('b'),
      }),
    ).rejects.toThrow();
  });
});
