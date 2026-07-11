import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLineMessenger } from '../../src/line/client.js';

const TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const REPLY_URL = 'https://api.line.me/v2/bot/message/reply';

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

// トークン発行要求に対しては常に固定トークンを返し、それ以外の URL は個別ハンドラに委譲する
// ルーティング型 fetch モック。テストごとに「非トークン系エンドポイントへの呼び出し」だけを
// 素朴に検証できるようにするための小道具。
function routingFetchMock(
  handleOther: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === TOKEN_URL) {
      return jsonResponse(200, { token_type: 'Bearer', access_token: 'stateless-token-1', expires_in: 900 });
    }
    return handleOther(url, init);
  });
}

function fakeLogger(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

describe('createLineMessenger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('トークン発行・キャッシュ', () => {
    it('reply 呼び出し時にトークンを発行し、正しいエンドポイント・form-encoded body で送信する', async () => {
      const fetchMock = routingFetchMock(() => emptyResponse(200));
      const messenger = createLineMessenger({
        channelId: 'test-channel-id',
        channelSecret: 'test-channel-secret',
        fetch: fetchMock,
        logger: fakeLogger(),
      });

      await messenger.reply('reply-token-1', [{ type: 'text', text: 'hello' }]);

      const tokenCall = fetchMock.mock.calls.find(([url]) => url === TOKEN_URL);
      expect(tokenCall).toBeDefined();
      const [, init] = tokenCall as [string, RequestInit];
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      const params = new URLSearchParams(init.body as string);
      expect(params.get('grant_type')).toBe('client_credentials');
      expect(params.get('client_id')).toBe('test-channel-id');
      expect(params.get('client_secret')).toBe('test-channel-secret');
    });

    it('複数メソッドを連続で呼んでもトークン発行は1回だけ（有効期限内はメモリキャッシュを再利用する）', async () => {
      const fetchMock = routingFetchMock((url) => {
        if (url.startsWith('https://api.line.me/v2/bot/profile/')) {
          return jsonResponse(200, { displayName: 'テスト太郎' });
        }
        return emptyResponse(200);
      });
      const messenger = createLineMessenger({
        channelId: 'id',
        channelSecret: 'secret',
        fetch: fetchMock,
        logger: fakeLogger(),
      });

      await messenger.reply('reply-token-1', [{ type: 'text', text: 'hi' }]);
      await messenger.getProfile('Uabc123');

      const tokenCalls = fetchMock.mock.calls.filter(([url]) => url === TOKEN_URL);
      expect(tokenCalls).toHaveLength(1);
    });

    // client.ts の TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000（ソース定数の実値）。
    // expires_in=900秒に対し、マージン差引後のキャッシュ失効点は 900_000 - 60_000 = 840_000ms。
    // 「マージンぴったりで境界判定している」ことを証明するため、
    //   1) マージン失効点の手前（830_000ms）ではまだ再利用される
    //   2) マージン失効点は過ぎたが raw expires_in（900_000ms）にはまだ達していない時点（845_000ms）
    //      では、すでに再発行済みである
    // の2段階に分けて検証する。両方を一度に900_001msまで進めてしまうと、
    // 「マージンが正しく機能している」ことと「マージンが無い/誤っていても raw expiry で
    // いずれ再発行される」ことを区別できないため。
    const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;
    const EXPIRES_IN_MS = 900_000;
    const MARGIN_ADJUSTED_EXPIRY_MS = EXPIRES_IN_MS - TOKEN_EXPIRY_SAFETY_MARGIN_MS;

    it('マージン失効点の手前ではキャッシュされたトークンを再利用する', async () => {
      let issuedCount = 0;
      const fetchMock = vi.fn(async (url: string) => {
        if (url === TOKEN_URL) {
          issuedCount += 1;
          return jsonResponse(200, {
            token_type: 'Bearer',
            access_token: `token-${issuedCount}`,
            expires_in: 900,
          });
        }
        return emptyResponse(200);
      });
      const messenger = createLineMessenger({
        channelId: 'id',
        channelSecret: 'secret',
        fetch: fetchMock,
        logger: fakeLogger(),
      });

      await messenger.reply('reply-token-1', [{ type: 'text', text: 'hi' }]);
      expect(issuedCount).toBe(1);

      // マージン失効点（840_000ms）の10秒手前まで進める。まだ再発行されないはず。
      await vi.advanceTimersByTimeAsync(MARGIN_ADJUSTED_EXPIRY_MS - 10_000);
      await messenger.reply('reply-token-2', [{ type: 'text', text: 'hi again' }]);

      expect(issuedCount).toBe(1);
    });

    it('マージン失効点を過ぎたら raw expires_in 到達前でも再発行する', async () => {
      let issuedCount = 0;
      const fetchMock = vi.fn(async (url: string) => {
        if (url === TOKEN_URL) {
          issuedCount += 1;
          return jsonResponse(200, {
            token_type: 'Bearer',
            access_token: `token-${issuedCount}`,
            expires_in: 900,
          });
        }
        return emptyResponse(200);
      });
      const messenger = createLineMessenger({
        channelId: 'id',
        channelSecret: 'secret',
        fetch: fetchMock,
        logger: fakeLogger(),
      });

      await messenger.reply('reply-token-1', [{ type: 'text', text: 'hi' }]);
      expect(issuedCount).toBe(1);

      // マージン失効点（840_000ms）は過ぎたが、raw expires_in（900_000ms）にはまだ達していない
      // 845_000ms まで進める。ここで既に再発行されているはず。
      await vi.advanceTimersByTimeAsync(MARGIN_ADJUSTED_EXPIRY_MS + 5_000);
      await messenger.reply('reply-token-2', [{ type: 'text', text: 'hi again' }]);

      expect(issuedCount).toBe(2);
    });
  });

  describe('reply', () => {
    it('replyToken と messages を正しい URL・ヘッダ・body で送信する', async () => {
      const fetchMock = routingFetchMock(() => emptyResponse(200));
      const messenger = createLineMessenger({
        channelId: 'id',
        channelSecret: 'secret',
        fetch: fetchMock,
        logger: fakeLogger(),
      });

      await messenger.reply('reply-token-xyz', [
        { type: 'text', text: 'こんにちは' },
        { type: 'flex', altText: '候補一覧', contents: { type: 'bubble' } },
      ]);

      const replyCall = fetchMock.mock.calls.find(([url]) => url === REPLY_URL);
      expect(replyCall).toBeDefined();
      const [, init] = replyCall as [string, RequestInit];
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer stateless-token-1');
      expect(headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).toEqual({
        replyToken: 'reply-token-xyz',
        messages: [
          { type: 'text', text: 'こんにちは' },
          { type: 'flex', altText: '候補一覧', contents: { type: 'bubble' } },
        ],
      });
    });

    it('非2xxレスポンスでも例外を投げず、logger.warn を呼ぶ（再配信側で救済されるため）', async () => {
      const fetchMock = routingFetchMock(() => jsonResponse(400, { message: 'Invalid reply token' }));
      const logger = fakeLogger();
      const messenger = createLineMessenger({
        channelId: 'id',
        channelSecret: 'secret',
        fetch: fetchMock,
        logger,
      });

      await expect(
        messenger.reply('expired-reply-token', [{ type: 'text', text: 'hi' }]),
      ).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [message, meta] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
      expect(typeof message).toBe('string');
      expect(meta).toMatchObject({ status: 400 });
    });
  });

  describe('getProfile', () => {
    it('displayName のみを返し、他フィールド（pictureUrl等）は構造的に落とす', async () => {
      const fetchMock = routingFetchMock(() =>
        jsonResponse(200, {
          displayName: 'テスト太郎',
          userId: 'Uabc123',
          pictureUrl: 'https://example.com/pic.png',
          statusMessage: '元気です',
          language: 'ja',
        }),
      );
      const messenger = createLineMessenger({
        channelId: 'id',
        channelSecret: 'secret',
        fetch: fetchMock,
        logger: fakeLogger(),
      });

      const profile = await messenger.getProfile('Uabc123');

      expect(profile).toEqual({ displayName: 'テスト太郎' });
      expect(profile).not.toHaveProperty('pictureUrl');
      expect(profile).not.toHaveProperty('statusMessage');
      expect(profile).not.toHaveProperty('language');
      expect(profile).not.toHaveProperty('userId');
      expect(Object.keys(profile as object)).toEqual(['displayName']);
    });

    it('正しい URL・Authorization ヘッダで GET する', async () => {
      const fetchMock = routingFetchMock(() => jsonResponse(200, { displayName: 'X' }));
      const messenger = createLineMessenger({
        channelId: 'id',
        channelSecret: 'secret',
        fetch: fetchMock,
        logger: fakeLogger(),
      });

      await messenger.getProfile('Uabc123');

      const profileCall = fetchMock.mock.calls.find(([url]) =>
        (url as string).startsWith('https://api.line.me/v2/bot/profile/'),
      );
      expect(profileCall).toBeDefined();
      const [url, init] = profileCall as [string, RequestInit];
      expect(url).toBe('https://api.line.me/v2/bot/profile/Uabc123');
      expect(init.method).toBe('GET');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer stateless-token-1');
    });

    it('404 のとき例外を投げず null を返す（ブロック等）', async () => {
      const fetchMock = routingFetchMock(() => jsonResponse(404, {}));
      const messenger = createLineMessenger({
        channelId: 'id',
        channelSecret: 'secret',
        fetch: fetchMock,
        logger: fakeLogger(),
      });

      await expect(messenger.getProfile('Ublocked')).resolves.toBeNull();
    });
  });

  describe('linkRichMenu', () => {
    it('userId・richMenuId を両方埋め込んだ正しい URL に POST する', async () => {
      const fetchMock = routingFetchMock(() => emptyResponse(200));
      const messenger = createLineMessenger({
        channelId: 'id',
        channelSecret: 'secret',
        fetch: fetchMock,
        logger: fakeLogger(),
      });

      await messenger.linkRichMenu('Uabc123', 'richmenu-completed-1');

      const linkCall = fetchMock.mock.calls.find(([url]) =>
        (url as string).includes('/richmenu/'),
      );
      expect(linkCall).toBeDefined();
      const [url, init] = linkCall as [string, RequestInit];
      expect(url).toBe('https://api.line.me/v2/bot/user/Uabc123/richmenu/richmenu-completed-1');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer stateless-token-1');
    });

    it('非2xxレスポンスのとき例外を投げる', async () => {
      const fetchMock = routingFetchMock(() => jsonResponse(500, {}));
      const messenger = createLineMessenger({
        channelId: 'id',
        channelSecret: 'secret',
        fetch: fetchMock,
        logger: fakeLogger(),
      });

      await expect(messenger.linkRichMenu('Uabc123', 'richmenu-1')).rejects.toThrow();
    });
  });
});
