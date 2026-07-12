// app/api/detail/route.ts（Task 5.2）の DB テスト（実 postgres 必須）。
//
// 検証対象（task 5.2 の観察可能な完了条件）:
//   - 有効トークン + 一意に解決可能な店舗 → 200 と正しい JSON
//   - 無効トークン → 401
//   - 有効トークンだが店舗未特定（confirmed 店舗0件） → 404
//   - 有効トークンだが AMBIGUOUS_STORE（confirmed 店舗が複数） → 404
//   - route モジュールが GET 以外の HTTP メソッドを export しない（4.2 の構造的 no-write 保証）
//
// LINE の /oauth2/v2.1/verify はフェイク HTTP サーバー（node:http）でモックする
// （test/liff-auth.test.ts のフェイクサーバー流儀に準拠）。route.ts はテスト用に
// `LIFF_VERIFY_ENDPOINT` env（任意・本番未設定時は LINE 本番エンドポイントを既定使用）で
// 検証先を差し替えられる（lib/liff-auth.ts の LiffAuthOptions.verifyEndpoint を経由）。
//
// 他テストファイルと DB を共有するため、衝突しない固有 UUID prefix を使う（e8/e9 は
// data.db.test.ts の e5/e6・liff-auth.db.test.ts の d5/d6 と衝突しない未使用 prefix）。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, closePool } from '@fwlm/db';

const OP = 'e8000000-0000-0000-0000-000000000001';
const AG = 'e8000000-0000-0000-0000-000000000002';

const OWNER_VALID = 'e8000000-0000-0000-0000-000000000011'; // confirmed 店舗1件 → 200
const OWNER_UNCONFIRMED = 'e8000000-0000-0000-0000-000000000012'; // confirmed 店舗0件 → 404
const OWNER_MULTI = 'e8000000-0000-0000-0000-000000000013'; // confirmed 店舗2件 → 404 (AMBIGUOUS_STORE)

const SUB_VALID = `U-${OWNER_VALID}`;
const SUB_UNCONFIRMED = `U-${OWNER_UNCONFIRMED}`;
const SUB_MULTI = `U-${OWNER_MULTI}`;

const ST_VALID = 'e9000000-0000-0000-0000-000000000001';
const ST_MULTI_A = 'e9000000-0000-0000-0000-000000000002';
const ST_MULTI_B = 'e9000000-0000-0000-0000-000000000003';

const CLIENT_ID = 'test-liff-channel-id-route';

// id_token の値でフェイクサーバーの応答を分岐する（route.ts → liff-auth.ts が渡す id_token をそのまま反映）。
const TOKEN_VALID = 'token-valid';
const TOKEN_UNCONFIRMED = 'token-unconfirmed';
const TOKEN_MULTI = 'token-multi';
const TOKEN_INVALID = 'token-invalid';

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

// --- フェイク LINE verify サーバー ------------------------------------------------------

interface FakeServer {
  readonly url: string;
  close(): Promise<void>;
}

function startFakeVerifyServer(): Promise<FakeServer> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const params = new URLSearchParams(body);
        const idToken = params.get('id_token');

        const subByToken: Record<string, string> = {
          [TOKEN_VALID]: SUB_VALID,
          [TOKEN_UNCONFIRMED]: SUB_UNCONFIRMED,
          [TOKEN_MULTI]: SUB_MULTI,
        };
        const sub = idToken ? subByToken[idToken] : undefined;

        if (!sub) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_request' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ iss: 'https://access.line.me', sub, aud: CLIENT_ID }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((res2) => server.close(() => res2())),
      });
    });
  });
}

let fakeServer: FakeServer;
let previousEnv: { LIFF_CHANNEL_ID?: string; LIFF_VERIFY_ENDPOINT?: string };

describe.skipIf(!process.env.DATABASE_URL)('GET /api/detail (DB)', () => {
  beforeAll(async () => {
    fakeServer = await startFakeVerifyServer();
    previousEnv = {
      LIFF_CHANNEL_ID: process.env.LIFF_CHANNEL_ID,
      LIFF_VERIFY_ENDPOINT: process.env.LIFF_VERIFY_ENDPOINT,
    };
    process.env.LIFF_CHANNEL_ID = CLIENT_ID;
    process.env.LIFF_VERIFY_ENDPOINT = fakeServer.url;

    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, 'route検証運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, 'route検証代理店']);

    for (const [id, sub] of [
      [OWNER_VALID, SUB_VALID],
      [OWNER_UNCONFIRMED, SUB_UNCONFIRMED],
      [OWNER_MULTI, SUB_MULTI],
    ] as const) {
      await pool.query(
        'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
        [id, AG, sub, 'active'],
      );
    }

    await pool.query(
      'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
      [ST_VALID, OWNER_VALID, 'route検証・確定済み店舗', 'places/route-valid', 'confirmed'],
    );
    // OWNER_UNCONFIRMED は店舗そのものを作らない（confirmed 店舗0件 → STORE_NOT_IDENTIFIED）。
    await pool.query(
      'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
      [ST_MULTI_A, OWNER_MULTI, 'route検証・複数店舗A', 'places/route-multi-a', 'confirmed'],
    );
    await pool.query(
      'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
      [ST_MULTI_B, OWNER_MULTI, 'route検証・複数店舗B', 'places/route-multi-b', 'confirmed'],
    );

    // 200 系検証のため、当日（実時刻）の daily_summaries を ST_VALID に用意する
    // （route.ts は queryStoreDetail を asOf 省略で呼ぶため、実際の「今日」に合わせる必要がある）。
    await pool.query(
      `INSERT INTO daily_summaries
         (store_id, summary_date, status, rank, rank_total, rating, review_count, new_review_count, competitors)
       VALUES ($1, $2, 'ready', 2, 4, '4.6', 120, 1, '[]'::jsonb)`,
      [ST_VALID, todayDateString()],
    );
  });

  afterAll(async () => {
    await closePool();
    await fakeServer.close();
    process.env.LIFF_CHANNEL_ID = previousEnv.LIFF_CHANNEL_ID;
    process.env.LIFF_VERIFY_ENDPOINT = previousEnv.LIFF_VERIFY_ENDPOINT;
  });

  async function callGet(authorization?: string): Promise<Response> {
    const { GET } = await import('../app/api/detail/route.js');
    const headers = new Headers();
    if (authorization !== undefined) {
      headers.set('Authorization', authorization);
    }
    const request = new Request('http://127.0.0.1/api/detail', { method: 'GET', headers });
    return GET(request);
  }

  it('有効トークン + 一意に解決可能な店舗 → 200 と自店データを返す', async () => {
    const res = await callGet(`Bearer ${TOKEN_VALID}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      storeId: string;
      summary: { status: string; rank: number; rankTotal: number } | null;
      competitors: unknown[];
      trend: unknown[];
    };
    expect(body.storeId).toBe(ST_VALID);
    expect(body.summary).toMatchObject({ status: 'ready', rank: 2, rankTotal: 4 });
    expect(Array.isArray(body.competitors)).toBe(true);
    expect(Array.isArray(body.trend)).toBe(true);
  });

  it('無効トークン（LINE が 400 を返す）→ 401', async () => {
    const res = await callGet(`Bearer ${TOKEN_INVALID}`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('Authorization ヘッダが無い → 401（DB・LINE 検証に進まない）', async () => {
    const res = await callGet(undefined);
    expect(res.status).toBe(401);
  });

  it('有効トークンだが店舗未特定（confirmed店舗0件）→ 404', async () => {
    const res = await callGet(`Bearer ${TOKEN_UNCONFIRMED}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('STORE_NOT_FOUND');
  });

  it('有効トークンだが AMBIGUOUS_STORE（confirmed店舗が複数）→ 404（誤った店舗を返さない）', async () => {
    const res = await callGet(`Bearer ${TOKEN_MULTI}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('STORE_NOT_FOUND');

    // 安全性: レスポンス本文に ST_MULTI_A/B のどちらの storeId も一切含まれない
    // （どちらの店舗のデータも漏らさない）。
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(ST_MULTI_A);
    expect(raw).not.toContain(ST_MULTI_B);
  });
});

// --- 構造的検証（DB 不要）: route モジュールが GET 以外の HTTP メソッドを export しない ---
// Next.js App Router は POST/PUT/DELETE/PATCH 等を export すればそのメソッドが有効化される規約のため、
// 「export しない」こと自体が書込 API 不在（design.md 4.2）の構造的な担保になる。DB を必要としないため
// DATABASE_URL の有無に関わらず常時実行する。
describe('route module — 構造的な no-write 保証（4.2）', () => {
  it('GET のみを export し、POST/PUT/DELETE/PATCH/HEAD 等は export しない', async () => {
    const routeModule: Record<string, unknown> = await import('../app/api/detail/route.js');
    const httpMethodNames = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
    const definedHttpMethods = httpMethodNames.filter((name) => typeof routeModule[name] === 'function');

    expect(definedHttpMethods).toEqual(['GET']);
  });
});
