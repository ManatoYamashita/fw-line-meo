// LIFF 認可ライブラリ（liff-auth.ts, Task 5.1）のトークン検証テスト。
//
// フェイク HTTP サーバー（node:http、依存追加なし）を LINE の /oauth2/v2.1/verify モックとして使い、
// 有効トークン→sub 解決、無効トークン→検証エラーの分岐を検証する（task 4.2 line.test.ts のフェイク
// サーバー流儀に準拠）。DB を必要としないため describe.skipIf は不要（liff-auth.db.test.ts が
// owner/store 解決側の DB 依存テストを担う）。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { Queryable } from '@fwlm/db';
import {
  authorizeStoreDetailRequest,
  resolveOwnerStore,
  verifyLiffIdToken,
} from '../lib/liff-auth.js';

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

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const servers: FakeServer[] = [];
async function useServer(handler: FakeHandler): Promise<FakeServer> {
  const server = await startFakeServer(handler);
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const CLIENT_ID = 'test-liff-channel-id';
const ID_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.fake-id-token-payload.fake-signature';

describe('verifyLiffIdToken', () => {
  it('有効トークン: LINE の /oauth2/v2.1/verify へ id_token・client_id を渡し、sub を返す', async () => {
    const server = await useServer((record, res) => {
      expect(record.method).toBe('POST');
      expect(record.headers['content-type']).toBe('application/x-www-form-urlencoded');
      const params = new URLSearchParams(record.body);
      expect(params.get('id_token')).toBe(ID_TOKEN);
      expect(params.get('client_id')).toBe(CLIENT_ID);
      respondJson(res, 200, {
        iss: 'https://access.line.me',
        sub: 'U1234567890abcdef1234567890abcde',
        aud: CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      });
    });

    const result = await verifyLiffIdToken(ID_TOKEN, CLIENT_ID, { verifyEndpoint: server.url });

    expect(result).toEqual({ ok: true, value: 'U1234567890abcdef1234567890abcde' });
    expect(server.requests).toHaveLength(1);
  });

  it('無効トークン（LINE が 400 を返す）: INVALID_TOKEN を返す', async () => {
    const server = await useServer((_record, res) => {
      respondJson(res, 400, { error: 'invalid_request', error_description: 'invalid id_token' });
    });

    const result = await verifyLiffIdToken('bogus-token', CLIENT_ID, { verifyEndpoint: server.url });

    expect(result).toEqual({ ok: false, error: 'INVALID_TOKEN' });
  });

  it('検証レスポンスに sub が無い場合も INVALID_TOKEN として扱う（想定外の成功形は信頼しない）', async () => {
    const server = await useServer((_record, res) => {
      respondJson(res, 200, { iss: 'https://access.line.me' });
    });

    const result = await verifyLiffIdToken(ID_TOKEN, CLIENT_ID, { verifyEndpoint: server.url });

    expect(result).toEqual({ ok: false, error: 'INVALID_TOKEN' });
  });

  it('LINE 側の障害（5xx）: VERIFY_REQUEST_FAILED を返し、INVALID_TOKEN と区別する', async () => {
    const server = await useServer((_record, res) => {
      respondJson(res, 503, { error: 'service_unavailable' });
    });

    const result = await verifyLiffIdToken(ID_TOKEN, CLIENT_ID, { verifyEndpoint: server.url });

    expect(result).toEqual({ ok: false, error: 'VERIFY_REQUEST_FAILED' });
  });

  it('ネットワークエラー: VERIFY_REQUEST_FAILED を返す', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('network error');
    };

    const result = await verifyLiffIdToken(ID_TOKEN, CLIENT_ID, {
      verifyEndpoint: 'http://127.0.0.1:1/unreachable',
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, error: 'VERIFY_REQUEST_FAILED' });
  });

  it('不正な JSON レスポンス: VERIFY_REQUEST_FAILED を返す', async () => {
    const server = await useServer((_record, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not json');
    });

    const result = await verifyLiffIdToken(ID_TOKEN, CLIENT_ID, { verifyEndpoint: server.url });

    expect(result).toEqual({ ok: false, error: 'VERIFY_REQUEST_FAILED' });
  });

  it('ID トークン・クライアントシークレット相当の値をエラーに含めない', async () => {
    const server = await useServer((_record, res) => {
      respondJson(res, 400, { error: 'invalid_request' });
    });

    const result = await verifyLiffIdToken(ID_TOKEN, CLIENT_ID, { verifyEndpoint: server.url });

    expect(result.ok).toBe(false);
    // ok: false の分岐でも JSON.stringify した結果に生トークンが含まれないことを確認する。
    expect(JSON.stringify(result)).not.toContain(ID_TOKEN);
  });
});

// --- 型レベルの制約検証（Security-critical） ------------------------------------------
//
// design.md「storeId を URL・リクエストボディから受けない」制約を型システムで構造的に強制する。
// resolveOwnerStore / authorizeStoreDetailRequest のシグネチャに storeId・ownerId 等の
// クライアント制御可能な識別子が引数として追加されると、以下の型代入がコンパイルエラーになり
// `tsc`（typecheck/build）が失敗する。ランタイムの arity チェックも defense-in-depth として併用する。

type ExpectedResolveOwnerStoreParams = [pool: Queryable, sub: string];
type ActualResolveOwnerStoreParams = Parameters<typeof resolveOwnerStore>;
// 双方向の代入可能性を確認することで、パラメータのタプル形状が完全一致することを強制する。
const _resolveOwnerStoreShapeForward: ExpectedResolveOwnerStoreParams =
  null as unknown as ActualResolveOwnerStoreParams;
const _resolveOwnerStoreShapeBackward: ActualResolveOwnerStoreParams =
  null as unknown as ExpectedResolveOwnerStoreParams;
void _resolveOwnerStoreShapeForward;
void _resolveOwnerStoreShapeBackward;

type ExpectedAuthorizeParams = [
  idToken: string,
  clientId: string,
  pool: Queryable,
  options?: Parameters<typeof authorizeStoreDetailRequest>[3],
];
type ActualAuthorizeParams = Parameters<typeof authorizeStoreDetailRequest>;
const _authorizeShapeForward: ExpectedAuthorizeParams = null as unknown as ActualAuthorizeParams;
const _authorizeShapeBackward: ActualAuthorizeParams = null as unknown as ExpectedAuthorizeParams;
void _authorizeShapeForward;
void _authorizeShapeBackward;

describe('resolveOwnerStore / authorizeStoreDetailRequest — 引数形状（Security-critical）', () => {
  it('resolveOwnerStore は (pool, sub) の 2 引数のみを受け付ける（storeId/ownerId パラメータが存在しない）', () => {
    // 関数の宣言済み仮引数の個数（デフォルト値付き引数は含まない）。呼出元が storeId 等の
    // 追加引数を渡しても TypeScript の型チェックで弾かれるが、ランタイムの arity でも二重に確認する。
    expect(resolveOwnerStore.length).toBe(2);
  });

  it('authorizeStoreDetailRequest はクライアント入力として idToken のみを受け取り、storeId は受け取らない', () => {
    // options はテスト用の verifyEndpoint/fetchImpl 差替えのみを目的とし、クライアント制御可能な
    // 識別子を含まない（デフォルト値付きのため .length には数えられない）。
    expect(authorizeStoreDetailRequest.length).toBe(3);
  });
});
