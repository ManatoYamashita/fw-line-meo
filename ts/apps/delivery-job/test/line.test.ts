// LINE Push クライアント（line.ts, Task 4.2）のテスト。
//
// フェイク HTTP サーバー（node:http、依存追加なし）を使い、LINE モックとして
// トークン発行・Push の各ステータス分岐（200/409/400/429×2種/500）と再送回数・
// Retry-Key/リクエストボディの不変性を検証する。タイムアウトのみ fetchImpl 差し替えで
// 疑似発生させる（実ネットワーク切断を待たずに決定的にテストするため）。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { LineClient, LineTokenIssuanceError } from '../src/line.js';

// --- フェイク HTTP サーバー ----------------------------------------------------------

interface RecordedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface FakeServer {
  readonly url: string;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

type FakeHandler = (record: RecordedRequest, res: ServerResponse) => void;

function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const record: RecordedRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        requests.push(record);
        handler(record, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise<void>((res2) => server.close(() => res2())),
      });
    });
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** 呼出回数に応じて分岐するハンドラを作るヘルパー（500 リトライ系テスト用）。 */
function sequencedHandler(responders: readonly FakeHandler[]): FakeHandler {
  let call = 0;
  return (record, res) => {
    const responder = responders[Math.min(call, responders.length - 1)];
    call++;
    responder!(record, res);
  };
}

const CREDENTIALS = { channelId: 'test-channel-id', channelSecret: 'test-channel-secret-must-not-leak' };
const RETRY_KEY = '123e4567-e89b-12d3-a456-426614174000';
const MESSAGES = [{ type: 'flex', altText: 'test', contents: { type: 'bubble' } }];

const servers: FakeServer[] = [];
async function useServer(handler: FakeHandler): Promise<FakeServer> {
  const server = await startFakeServer(handler);
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** テストを高速化するための sleep スタブ（実待機せず、呼出引数のみ記録する）。 */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    calls.push(ms);
  };
  return { sleep, calls };
}

// --- トークン発行 --------------------------------------------------------------------

describe('LineClient.issueAccessToken', () => {
  it('成功時にアクセストークンと有効期限を返す', async () => {
    const server = await useServer((record, res) => {
      expect(record.method).toBe('POST');
      expect(record.headers['content-type']).toBe('application/x-www-form-urlencoded');
      const params = new URLSearchParams(record.body);
      expect(params.get('grant_type')).toBe('client_credentials');
      expect(params.get('client_id')).toBe(CREDENTIALS.channelId);
      expect(params.get('client_secret')).toBe(CREDENTIALS.channelSecret);
      respondJson(res, 200, { token_type: 'Bearer', access_token: 'stateless-access-token', expires_in: 900 });
    });

    const client = new LineClient(CREDENTIALS, { tokenEndpoint: `${server.url}/oauth2/v3/token` });
    const token = await client.issueAccessToken();

    expect(token).toEqual({ accessToken: 'stateless-access-token', expiresInSeconds: 900 });
  });

  it('失敗時に LineTokenIssuanceError を送出し、channelSecret を含めない', async () => {
    const server = await useServer((_record, res) => {
      respondJson(res, 400, { message: 'invalid_client' });
    });

    const client = new LineClient(CREDENTIALS, { tokenEndpoint: `${server.url}/oauth2/v3/token` });

    await expect(client.issueAccessToken()).rejects.toThrow(LineTokenIssuanceError);
    try {
      await client.issueAccessToken();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LineTokenIssuanceError);
      const tokenErr = err as LineTokenIssuanceError;
      expect(tokenErr.httpStatus).toBe(400);
      expect(tokenErr.message).toContain('invalid_client');
      expect(tokenErr.message).not.toContain(CREDENTIALS.channelSecret);
    }
  });
});

// --- Push: 各ステータス分岐 ------------------------------------------------------------

describe('LineClient.pushMessage — ステータス分岐', () => {
  it('200: 成功として扱い、X-Line-Request-Id を結果に含める', async () => {
    const server = await useServer((record, res) => {
      expect(record.headers['x-line-retry-key']).toBe(RETRY_KEY);
      expect(record.headers['authorization']).toBe('Bearer test-access-token');
      expect(JSON.parse(record.body)).toEqual({ to: 'Uabc123', messages: MESSAGES });
      respondJson(res, 200, { sentMessages: [{ id: '1' }] }, { 'X-Line-Request-Id': 'req-200' });
    });

    const client = new LineClient(CREDENTIALS, { pushEndpoint: `${server.url}/v2/bot/message/push` });
    const result = await client.pushMessage('test-access-token', 'Uabc123', MESSAGES, RETRY_KEY);

    expect(result).toEqual({ status: 'success', duplicate: false, requestId: 'req-200' });
    expect(server.requests).toHaveLength(1);
  });

  it('409: Retry-Key 重複検知を成功扱いとし、再送しない', async () => {
    const server = await useServer((_record, res) => {
      respondJson(
        res,
        409,
        { message: 'The retry key is already accepted', sentMessages: [{ id: '1' }] },
        { 'X-Line-Request-Id': 'req-409' },
      );
    });

    const client = new LineClient(CREDENTIALS, { pushEndpoint: `${server.url}/v2/bot/message/push` });
    const result = await client.pushMessage('test-access-token', 'Uabc123', MESSAGES, RETRY_KEY);

    expect(result).toEqual({ status: 'success', duplicate: true, requestId: 'req-409' });
    expect(server.requests).toHaveLength(1);
  });

  it('400: failed として記録し、再送しない', async () => {
    const server = await useServer((_record, res) => {
      respondJson(res, 400, { message: 'Not found' }, { 'X-Line-Request-Id': 'req-400' });
    });

    const client = new LineClient(CREDENTIALS, { pushEndpoint: `${server.url}/v2/bot/message/push` });
    const result = await client.pushMessage('test-access-token', 'Uinvalid', MESSAGES, RETRY_KEY);

    expect(result).toEqual({ status: 'failed', requestId: 'req-400', httpStatus: 400, message: 'Not found' });
    expect(server.requests).toHaveLength(1);
  });

  it('429（月次クォータ超過）: quota_exceeded とし、再送しない（即時終了シグナル）', async () => {
    const server = await useServer((_record, res) => {
      respondJson(res, 429, { message: 'You have reached your monthly limit.' }, { 'X-Line-Request-Id': 'req-429-quota' });
    });

    const client = new LineClient(CREDENTIALS, { pushEndpoint: `${server.url}/v2/bot/message/push` });
    const result = await client.pushMessage('test-access-token', 'Uabc123', MESSAGES, RETRY_KEY);

    expect(result).toEqual({
      status: 'quota_exceeded',
      requestId: 'req-429-quota',
      message: 'You have reached your monthly limit.',
    });
    expect(server.requests).toHaveLength(1);
  });

  it('429（レート制限）: quota とは区別し failed とし、再送しない', async () => {
    const server = await useServer((_record, res) => {
      respondJson(
        res,
        429,
        { message: 'The API rate limit has been exceeded.' },
        { 'X-Line-Request-Id': 'req-429-rate' },
      );
    });

    const client = new LineClient(CREDENTIALS, { pushEndpoint: `${server.url}/v2/bot/message/push` });
    const result = await client.pushMessage('test-access-token', 'Uabc123', MESSAGES, RETRY_KEY);

    expect(result.status).toBe('failed');
    expect(result).toEqual({
      status: 'failed',
      requestId: 'req-429-rate',
      httpStatus: 429,
      message: 'The API rate limit has been exceeded.',
    });
    expect(server.requests).toHaveLength(1);
  });
});

// --- Push: 500 / タイムアウトの再送 ------------------------------------------------------

describe('LineClient.pushMessage — 500/タイムアウトの再送', () => {
  it('500 が 2 回続いた後 200 で成功: 同一 Retry-Key・同一ボディで再送し、指数バックオフで待機する', async () => {
    const server = await useServer(
      sequencedHandler([
        (_r, res) => respondJson(res, 500, { message: 'Internal Server Error' }),
        (_r, res) => respondJson(res, 500, { message: 'Internal Server Error' }),
        (_r, res) => respondJson(res, 200, { sentMessages: [] }, { 'X-Line-Request-Id': 'req-after-retry' }),
      ]),
    );

    const { sleep, calls } = recordingSleep();
    const client = new LineClient(CREDENTIALS, {
      pushEndpoint: `${server.url}/v2/bot/message/push`,
      sleep,
      backoffBaseMs: 10,
      backoffMaxMs: 1000,
      maxRetries: 5,
    });

    const result = await client.pushMessage('test-access-token', 'Uabc123', MESSAGES, RETRY_KEY);

    expect(result).toEqual({ status: 'success', duplicate: false, requestId: 'req-after-retry' });
    expect(server.requests).toHaveLength(3);

    // Retry-Key は全リクエストで同一値を維持する（LINE 側の重複排除の前提）。
    for (const req of server.requests) {
      expect(req.headers['x-line-retry-key']).toBe(RETRY_KEY);
    }
    // リクエストボディは完全一致（再送は内容変更禁止）。
    expect(server.requests[0]!.body).toBe(server.requests[1]!.body);
    expect(server.requests[1]!.body).toBe(server.requests[2]!.body);

    // 指数バックオフ: base=10ms → 10, 20（2 回の待機のみ、3 回目で成功するため）。
    expect(calls).toEqual([10, 20]);
  });

  it('500 が上限まで続く場合: 再送回数の上限で failed を返す', async () => {
    const server = await useServer((_r, res) => respondJson(res, 500, { message: 'boom' }));

    const { sleep, calls } = recordingSleep();
    const client = new LineClient(CREDENTIALS, {
      pushEndpoint: `${server.url}/v2/bot/message/push`,
      sleep,
      backoffBaseMs: 5,
      maxRetries: 2,
    });

    const result = await client.pushMessage('test-access-token', 'Uabc123', MESSAGES, RETRY_KEY);

    expect(result.status).toBe('failed');
    expect(result.message).toContain('exceeded max retries');
    // 初回 + maxRetries(2) = 3 リクエスト。
    expect(server.requests).toHaveLength(3);
    expect(calls).toHaveLength(2);
    for (const req of server.requests) {
      expect(req.headers['x-line-retry-key']).toBe(RETRY_KEY);
    }
  });

  it('タイムアウト（fetch 例外）は 500 と同じ再送対象になり、同一 Retry-Key で再送して成功する', async () => {
    const server = await useServer((_r, res) =>
      respondJson(res, 200, { sentMessages: [] }, { 'X-Line-Request-Id': 'req-timeout-recovered' }),
    );

    let callCount = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      callCount++;
      if (callCount === 1) {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }
      return fetch(input, init);
    };

    const { sleep, calls } = recordingSleep();
    const client = new LineClient(CREDENTIALS, {
      pushEndpoint: `${server.url}/v2/bot/message/push`,
      fetchImpl,
      sleep,
      backoffBaseMs: 15,
    });

    const result = await client.pushMessage('test-access-token', 'Uabc123', MESSAGES, RETRY_KEY);

    expect(result).toEqual({ status: 'success', duplicate: false, requestId: 'req-timeout-recovered' });
    expect(callCount).toBe(2);
    expect(calls).toEqual([15]);
    // タイムアウト後の再送でも Retry-Key・ボディは同一のまま LINE 側へ届く。
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.headers['x-line-retry-key']).toBe(RETRY_KEY);
  });

  it('Retry-Key は初回リクエストから常に付与される（再送発生前でも付く）', async () => {
    const server = await useServer((_r, res) => respondJson(res, 200, { sentMessages: [] }));
    const client = new LineClient(CREDENTIALS, { pushEndpoint: `${server.url}/v2/bot/message/push` });

    await client.pushMessage('test-access-token', 'Uabc123', MESSAGES, RETRY_KEY);

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.headers['x-line-retry-key']).toBe(RETRY_KEY);
  });
});
