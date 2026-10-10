import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@fwlm/db';

// アンケート設定 API の route.ts の配線（Issue #437）。中核の振る舞いは survey-settings-api.db.test.ts が
// 確かめるので、ここでは実際の route.ts が env（LIFF_CHANNEL_ID・LIFF_VERIFY_ENDPOINT）・DB・LINE の検証
// エンドポイントを本番と同じ経路で繋ぐことと、各ルートが公開する HTTP メソッドを固定する。
// LINE の検証エンドポイントは route.db.test.ts と同じく、ローカルの偽サーバーへ差し替える。

const OP = 'a4370003-0000-4000-8000-000000000001';
const AG = 'a4370003-0000-4000-8000-000000000002';
const OWNER = 'a4370003-0000-4000-8000-000000000003';
const STORE = 'a4370003-0000-4000-8000-000000000004';
const SUB = 'U-survey-settings-route';
const TOKEN = 'token-survey-settings-route';
const CLIENT_ID = 'test-liff-channel-id-survey-settings';

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
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        if (params.get('id_token') !== TOKEN || params.get('client_id') !== CLIENT_ID) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_request' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ iss: 'https://access.line.me', sub: SUB, aud: CLIENT_ID }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function req(method: string, path: string, body?: unknown, token = TOKEN): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = <T,>(value: T) => ({ params: Promise.resolve(value) });

let fakeServer: FakeServer;
let previousEnv: { LIFF_CHANNEL_ID?: string; LIFF_VERIFY_ENDPOINT?: string };

describe.skipIf(!process.env.DATABASE_URL)('/api/survey-settings の route.ts（DB）', () => {
  beforeAll(async () => {
    fakeServer = await startFakeVerifyServer();
    previousEnv = { LIFF_CHANNEL_ID: process.env.LIFF_CHANNEL_ID, LIFF_VERIFY_ENDPOINT: process.env.LIFF_VERIFY_ENDPOINT };
    process.env.LIFF_CHANNEL_ID = CLIENT_ID;
    process.env.LIFF_VERIFY_ENDPOINT = fakeServer.url;
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '設定ルート運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, '設定ルート代理店']);
    await pool.query('INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)', [
      OWNER,
      AG,
      SUB,
      'active',
    ]);
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, '設定ルート店', 'ChIJ_route437', 'confirmed')`,
      [STORE, OWNER],
    );
  });

  afterAll(async () => {
    await closePool();
    await fakeServer.close();
    process.env.LIFF_CHANNEL_ID = previousEnv.LIFF_CHANNEL_ID;
    process.env.LIFF_VERIFY_ENDPOINT = previousEnv.LIFF_VERIFY_ENDPOINT;
  });

  it('6 つのルートを通して、追加・名前の変更・並び替え・非表示・カテゴリの切り替え・読み取りができる', async () => {
    const root = await import('../app/api/survey-settings/route.js');
    const targets = await import('../app/api/survey-settings/targets/route.js');
    const target = await import('../app/api/survey-settings/targets/[targetId]/route.js');
    const disable = await import('../app/api/survey-settings/targets/[targetId]/disable/route.js');
    const order = await import('../app/api/survey-settings/targets/order/route.js');
    const category = await import('../app/api/survey-settings/categories/[categoryCode]/route.js');

    const added = await targets.POST(req('POST', '/api/survey-settings/targets', { categoryCode: 'food', label: '刺身' }));
    expect(added.status).toBe(200);
    const second = await targets.POST(req('POST', '/api/survey-settings/targets', { categoryCode: 'food', label: '焼き鳥' }));
    const ids = ((await second.json()) as { targets: { id: string; label: string }[] }).targets.map((t) => t.id);
    expect(ids).toHaveLength(2);

    const renamed = await target.PATCH(
      req('PATCH', `/api/survey-settings/targets/${ids[0]}`, { label: 'お刺身' }),
      params({ targetId: ids[0]! }),
    );
    expect(renamed.status).toBe(200);
    const reordered = await order.PUT(
      req('PUT', '/api/survey-settings/targets/order', { categoryCode: 'food', targetIds: [ids[1], ids[0]] }),
    );
    expect(reordered.status).toBe(200);
    const disabled = await disable.POST(
      req('POST', `/api/survey-settings/targets/${ids[1]}/disable`),
      params({ targetId: ids[1]! }),
    );
    expect(disabled.status).toBe(200);
    const toggled = await category.PATCH(
      req('PATCH', '/api/survey-settings/categories/reservation_visit', { enabled: false }),
      params({ categoryCode: 'reservation_visit' }),
    );
    expect(toggled.status).toBe(200);

    const read = await root.GET(req('GET', '/api/survey-settings'));
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      storeId: string;
      revision: number;
      targets: { id: string; label: string; active: boolean }[];
      categories: { code: string; enabled: boolean }[];
    };
    expect(body.storeId).toBe(STORE);
    expect(body.revision).toBe(6);
    expect(body.targets.map((t) => [t.label, t.active])).toEqual([
      ['お刺身', true],
      ['焼き鳥', false],
    ]);
    expect(body.categories.find((c) => c.code === 'reservation_visit')?.enabled).toBe(false);
  });

  it('LINE が拒否したトークンは 401', async () => {
    const { GET } = await import('../app/api/survey-settings/route.js');
    expect((await GET(req('GET', '/api/survey-settings', undefined, 'forged'))).status).toBe(401);
  });

  it('LIFF_CHANNEL_ID が無ければ 500（設定不備を認証失敗に見せない）', async () => {
    const { GET } = await import('../app/api/survey-settings/route.js');
    const saved = process.env.LIFF_CHANNEL_ID;
    delete process.env.LIFF_CHANNEL_ID;
    try {
      expect((await GET(req('GET', '/api/survey-settings'))).status).toBe(500);
    } finally {
      process.env.LIFF_CHANNEL_ID = saved;
    }
  });
});

// App Router は export したメソッドを有効にする。各ルートが契約どおりのメソッドだけを持つことを固定する
// （詳細 API が GET だけを持つことは route.db.test.ts が固定している）。
describe('/api/survey-settings の各ルートが公開するメソッド', () => {
  const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
  const cases: [string, () => Promise<Record<string, unknown>>, string[]][] = [
    ['/api/survey-settings', () => import('../app/api/survey-settings/route.js'), ['GET']],
    ['/api/survey-settings/targets', () => import('../app/api/survey-settings/targets/route.js'), ['POST']],
    ['/api/survey-settings/targets/:targetId', () => import('../app/api/survey-settings/targets/[targetId]/route.js'), ['PATCH']],
    [
      '/api/survey-settings/targets/:targetId/disable',
      () => import('../app/api/survey-settings/targets/[targetId]/disable/route.js'),
      ['POST'],
    ],
    ['/api/survey-settings/targets/order', () => import('../app/api/survey-settings/targets/order/route.js'), ['PUT']],
    [
      '/api/survey-settings/categories/:categoryCode',
      () => import('../app/api/survey-settings/categories/[categoryCode]/route.js'),
      ['PATCH'],
    ],
  ];
  for (const [path, load, expected] of cases) {
    it(`${path} は ${expected.join(', ')} だけを export する（DELETE は無い）`, async () => {
      const mod = await load();
      expect(METHODS.filter((m) => typeof mod[m] === 'function')).toEqual(expected);
    });
  }
});
