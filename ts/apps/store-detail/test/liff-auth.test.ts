// LIFF 認可ライブラリ（liff-auth.ts, Task 5.1）のトークン検証テスト。
//
// フェイク HTTP サーバー（node:http、依存追加なし）を LINE の /oauth2/v2.1/verify モックとして使い、
// 有効トークン→sub 解決、無効トークン→検証エラーの分岐を検証する（task 4.2 line.test.ts のフェイク
// サーバー流儀に準拠）。DB を必要としないため describe.skipIf は不要（liff-auth.db.test.ts が
// owner/store 解決側の DB 依存テストを担う）。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { Queryable, StoreRow } from '@fwlm/db';
import {
  authorizeStoreDetailRequest,
  listOwnerConfirmedStores,
  selectAuthorizedStore,
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
// design.md「クライアント入力の不変条件」を型で表明する:
//   認可主体（誰か）は検証済み sub のみが決める。クライアント由来の識別子は sub から導いた
//   認可済み集合の内部での絞り込みにしか使えず、集合の境界を広げる入力としては使えない。
//
// ⚠️ 重要な限界（実測に基づく・虚偽の安心を残さないための記述）:
//   `ts/apps/store-detail/tsconfig.json` の `exclude` に `"test"` が含まれるため、
//   **以下の型代入は `tsc -p tsconfig.json --noEmit`（typecheck）でも `next build` でも
//   検査されない**。lint も typescript-eslint の非型認識 recommended のみで型は見ない。
//   したがってこのブロックは「意図の宣言」であり、破っても赤くならない。
//   実効的に効いているガードは (a) 下の arity チェック、(b) `selectAuthorizedStore` の
//   振る舞いテスト（戻り値が必ず入力配列の要素であること）、(c) route.db.test.ts の
//   非オラクル deep-equal の 3 点である。tsconfig 側の是正は別 Issue で扱う。

type ExpectedListOwnerConfirmedStoresParams = [pool: Queryable, sub: string];
type ActualListOwnerConfirmedStoresParams = Parameters<typeof listOwnerConfirmedStores>;
// 双方向の代入可能性を確認することで、パラメータのタプル形状が完全一致することを強制する。
const _listStoresShapeForward: ExpectedListOwnerConfirmedStoresParams =
  null as unknown as ActualListOwnerConfirmedStoresParams;
const _listStoresShapeBackward: ActualListOwnerConfirmedStoresParams =
  null as unknown as ExpectedListOwnerConfirmedStoresParams;
void _listStoresShapeForward;
void _listStoresShapeBackward;

// 集合内の選択は DB に触れない純関数である（第1引数に Queryable を取らない＝クライアント由来の
// ヒントを検索キーとして DB へ渡す実装が書けない）ことの型表明。
type ExpectedSelectAuthorizedStoreParams = [
  stores: readonly StoreRow[],
  requestedStoreId: string | null,
];
type ActualSelectAuthorizedStoreParams = Parameters<typeof selectAuthorizedStore>;
const _selectShapeForward: ExpectedSelectAuthorizedStoreParams =
  null as unknown as ActualSelectAuthorizedStoreParams;
const _selectShapeBackward: ActualSelectAuthorizedStoreParams =
  null as unknown as ExpectedSelectAuthorizedStoreParams;
void _selectShapeForward;
void _selectShapeBackward;

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

describe('listOwnerConfirmedStores / selectAuthorizedStore / authorizeStoreDetailRequest — 引数形状（Security-critical）', () => {
  it('listOwnerConfirmedStores は (pool, sub) の 2 引数のみを受け付ける（storeId/ownerId パラメータが存在しない）', () => {
    // 認可済み集合の生成はクライアント入力を一切受け取らない。ヒントによる絞り込みは
    // selectAuthorizedStore（DB に触れない純関数）の責務に完全に分離されている。
    expect(listOwnerConfirmedStores.length).toBe(2);
  });

  it('selectAuthorizedStore は (stores, requestedStoreId) の 2 引数のみを受け付ける（pool を受け取らない）', () => {
    expect(selectAuthorizedStore.length).toBe(2);
  });

  it('authorizeStoreDetailRequest はクライアント入力として idToken のみを受け取り、storeId は受け取らない', () => {
    // options はテスト用の verifyEndpoint/fetchImpl 差替えのみを目的とし、クライアント制御可能な
    // 識別子を含まない（デフォルト値付きのため .length には数えられない）。
    //
    // ⚠️ この arity チェックは options への密輸（例: `options.requestedStoreId`）を検出できない
    //    — デフォルト値付き引数は .length に数えられないためである。arity ガードを満たしたまま
    //    不変条件を破れる唯一の抜け道なので、LiffAuthOptions にクライアント制御可能な識別子を
    //    足すことは明示的に禁止する（レビュー時の必須確認項目）。
    expect(authorizeStoreDetailRequest.length).toBe(3);
  });
});

// --- selectAuthorizedStore の振る舞い（DB 不要・非オラクル性の中核証拠） -----------------
//
// design.md「クライアント入力の不変条件」の実効ガード。集合外の値が集合を広げないこと、
// および戻り値が必ず入力配列の要素であること（＝ IDOR が構造的に成立しないこと）を固定する。

function fakeStore(id: string, name: string): StoreRow {
  return {
    id,
    owner_id: 'owner-fake',
    category_code: 'cafe',
    name,
    latitude: null,
    longitude: null,
    place_id: `place-${id}`,
    place_status: 'confirmed',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('selectAuthorizedStore — 認可済み集合内でのみ有効なヒント', () => {
  const stores: readonly StoreRow[] = [
    fakeStore('11111111-1111-4111-8111-111111111111', '1号店'),
    fakeStore('22222222-2222-4222-8222-222222222222', '2号店'),
  ];

  it('ヒントが null なら null を返す（単店舗のフォールバックは呼出元の責務）', () => {
    expect(selectAuthorizedStore(stores, null)).toBeNull();
  });

  it('ヒントが空文字なら null を返す（?storeId= を未指定と同一に扱う）', () => {
    expect(selectAuthorizedStore(stores, '')).toBeNull();
  });

  it('ヒントが集合内なら該当要素そのもの（参照同一）を返す', () => {
    expect(selectAuthorizedStore(stores, stores[1]!.id)).toBe(stores[1]);
  });

  it('ヒントが集合外の実在しうる UUID なら null を返す（他オーナーの storeId を渡しても選ばれない）', () => {
    expect(selectAuthorizedStore(stores, '99999999-9999-4999-8999-999999999999')).toBeNull();
  });

  it('ヒントが UUID でなくても例外を投げず null を返す（SQL へ到達しないため 500 にならない）', () => {
    for (const hint of ['x', "' OR 1=1 --", '../../etc/passwd', 'x'.repeat(1000)]) {
      expect(selectAuthorizedStore(stores, hint)).toBeNull();
    }
  });

  it('戻り値は必ず入力配列の要素である（集合外を返すことが構造的に不可能）', () => {
    for (const hint of [null, '', stores[0]!.id, stores[1]!.id, 'not-in-set']) {
      const result = selectAuthorizedStore(stores, hint);
      if (result !== null) {
        expect(stores).toContain(result);
      }
    }
  });

  it('空集合ならどんなヒントでも null を返す', () => {
    expect(selectAuthorizedStore([], '11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(selectAuthorizedStore([], null)).toBeNull();
  });
});
