// app/api/detail/route.ts（Task 5.2）の DB テスト（実 postgres 必須）。
//
// 検証対象（task 5.2 / task 5.4 の観察可能な完了条件）:
//   - 有効トークン + 認可済み集合が1件 → 200 と正しい JSON（storeName / stores[] を含む）
//   - 無効トークン → 401
//   - 有効トークンだが店舗未特定（confirmed 店舗0件） → 404
//   - 有効トークンかつ認可済み集合が複数 → 409 STORE_SELECTION_REQUIRED と候補一覧
//   - ?storeId ヒントが集合内 → その店舗の 200
//   - ?storeId ヒントが集合外・不正 UUID・空文字 → **未指定時と完全に同一の応答**（非オラクル）
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
const OWNER_MULTI = 'e8000000-0000-0000-0000-000000000013'; // confirmed 店舗2件 → 409 (要選択)

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
    // ヒントが「実際に効いている（先頭固定ではない）」ことを storeId だけでなくデータ内容でも
    // 見分けられるよう、複数店舗オーナーの B 側にだけ識別可能なサマリーを入れる。
    await pool.query(
      `INSERT INTO daily_summaries
         (store_id, summary_date, status, rank, rank_total, rating, review_count, new_review_count, competitors)
       VALUES ($1, $2, 'ready', 7, 9, '3.1', 42, 0, '[]'::jsonb)`,
      [ST_MULTI_B, todayDateString()],
    );
  });

  afterAll(async () => {
    await closePool();
    await fakeServer.close();
    process.env.LIFF_CHANNEL_ID = previousEnv.LIFF_CHANNEL_ID;
    process.env.LIFF_VERIFY_ENDPOINT = previousEnv.LIFF_VERIFY_ENDPOINT;
  });

  /**
   * `query` は `?` を含まない生のクエリ文字列（例: `storeId=xxx`）。未指定なら付けない。
   * ヒントの有無で応答が変わらないことを deep-equal で比較するため、同一ヘルパから両方を呼ぶ。
   */
  async function callGet(authorization?: string, query?: string): Promise<Response> {
    const { GET } = await import('../app/api/detail/route.js');
    const headers = new Headers();
    if (authorization !== undefined) {
      headers.set('Authorization', authorization);
    }
    const url = query ? `http://127.0.0.1/api/detail?${query}` : 'http://127.0.0.1/api/detail';
    const request = new Request(url, { method: 'GET', headers });
    return GET(request);
  }

  /** status と本文をまとめて比較可能な形にする（非オラクル性の deep-equal 用）。 */
  async function snapshotOf(res: Response): Promise<{ status: number; body: unknown }> {
    return { status: res.status, body: await res.json() };
  }

  it('有効トークン + 一意に解決可能な店舗 → 200 と自店データを返す', async () => {
    const res = await callGet(`Bearer ${TOKEN_VALID}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      storeId: string;
      storeName: string;
      stores: { storeId: string; name: string }[];
      summary: { status: string; rank: number; rankTotal: number } | null;
      competitors: unknown[];
      trend: unknown[];
    };
    expect(body.storeId).toBe(ST_VALID);
    expect(body.summary).toMatchObject({ status: 'ready', rank: 2, rankTotal: 4 });
    expect(Array.isArray(body.competitors)).toBe(true);
    expect(Array.isArray(body.trend)).toBe(true);

    // 4.7: 表示中の店舗名。多店舗では「今どの店を見ているか」の唯一の手掛かりになる。
    expect(body.storeName).toBe('route検証・確定済み店舗');
    // 認可済み集合は自分の1店舗のみ（切替リンクの要否を画面が判断するために返す）。
    expect(body.stores).toEqual([{ storeId: ST_VALID, name: 'route検証・確定済み店舗' }]);
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

  it('有効トークンかつ confirmed 店舗が複数 → 409 と候補一覧（店舗を推測しない）', async () => {
    const res = await callGet(`Bearer ${TOKEN_MULTI}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string };
      stores: { storeId: string; name: string }[];
      summary?: unknown;
      competitors?: unknown;
      trend?: unknown;
    };
    expect(body.error.code).toBe('STORE_SELECTION_REQUIRED');

    // 候補は自分の店舗のみ・決定的な順序で返る。
    expect(body.stores).toEqual([
      { storeId: ST_MULTI_A, name: 'route検証・複数店舗A' },
      { storeId: ST_MULTI_B, name: 'route検証・複数店舗B' },
    ]);

    // 安全性: 他オーナーの店舗は 1 件も漏れない（旧テストは自店舗の隠蔽のみを見ていたが、
    // 候補一覧を返す設計では「他人の店舗が混ざらないこと」こそが本質的な保証になる）。
    expect(JSON.stringify(body)).not.toContain(ST_VALID);

    // 店舗を選ぶ前に詳細データを返してしまわない（＝どちらかを推測で表示していない）。
    expect(body.summary).toBeUndefined();
    expect(body.competitors).toBeUndefined();
    expect(body.trend).toBeUndefined();
  });

  describe('?storeId ヒント（認可済み集合内でのみ有効）', () => {
    it('集合内のヒント（A）→ 200 でその店舗を返す', async () => {
      const res = await callGet(`Bearer ${TOKEN_MULTI}`, `storeId=${ST_MULTI_A}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        storeId: string;
        storeName: string;
        stores: { storeId: string }[];
        summary: unknown;
      };
      expect(body.storeId).toBe(ST_MULTI_A);
      expect(body.storeName).toBe('route検証・複数店舗A');
      expect(body.stores).toHaveLength(2);
      // A には当日サマリーを入れていないので null（B と取り違えていないことの傍証）。
      expect(body.summary).toBeNull();
    });

    it('集合内のヒント（B）→ 200 で B のデータを返す（先頭固定ではない）', async () => {
      const res = await callGet(`Bearer ${TOKEN_MULTI}`, `storeId=${ST_MULTI_B}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        storeId: string;
        storeName: string;
        summary: { rank: number; rankTotal: number } | null;
      };
      expect(body.storeId).toBe(ST_MULTI_B);
      expect(body.storeName).toBe('route検証・複数店舗B');
      // B 固有のサマリー。ヒントが実際にデータ取得先を決めていることの直接証拠。
      expect(body.summary).toMatchObject({ rank: 7, rankTotal: 9 });
    });

    it('集合外の「実在する」他オーナーの storeId → 未指定時と完全に同一の応答（非オラクル）', async () => {
      // 本テストが本 Issue のセキュリティ中核。ヒントは集合の境界を広げられないだけでなく、
      // 「その storeId が実在するか否か」すらクライアントに観測させない。
      const withHint = await snapshotOf(await callGet(`Bearer ${TOKEN_MULTI}`, `storeId=${ST_VALID}`));
      const withoutHint = await snapshotOf(await callGet(`Bearer ${TOKEN_MULTI}`));

      expect(withHint).toEqual(withoutHint);
      expect(withHint.status).toBe(409);
    });

    it('UUID として不正なヒント → 500 にならず未指定時と同一の応答（SQL へ到達しない）', async () => {
      // ヒントを SQL に渡す実装だと pg の 22P02（invalid_text_representation）で 500 になる。
      // selectAuthorizedStore が純関数であることの外形的な証拠。
      const withoutHint = await snapshotOf(await callGet(`Bearer ${TOKEN_MULTI}`));

      for (const hint of ['not-a-uuid', "'%20OR%201=1%20--", 'x'.repeat(500)]) {
        const res = await callGet(`Bearer ${TOKEN_MULTI}`, `storeId=${hint}`);
        expect(res.status).not.toBe(500);
        expect(await snapshotOf(res)).toEqual(withoutHint);
      }
    });

    it('空文字のヒント（?storeId=）→ 未指定時と同一の応答', async () => {
      const withHint = await snapshotOf(await callGet(`Bearer ${TOKEN_MULTI}`, 'storeId='));
      const withoutHint = await snapshotOf(await callGet(`Bearer ${TOKEN_MULTI}`));

      expect(withHint).toEqual(withoutHint);
    });

    it('ヒントが重複指定された場合も決定的に最初の値を採る', async () => {
      const res = await callGet(`Bearer ${TOKEN_MULTI}`, `storeId=${ST_MULTI_A}&storeId=${ST_MULTI_B}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { storeId: string };
      expect(body.storeId).toBe(ST_MULTI_A);
    });

    it('認可済み集合が空なら、ヒントがあっても 404（ヒントは集合を作れない）', async () => {
      const res = await callGet(`Bearer ${TOKEN_UNCONFIRMED}`, `storeId=${ST_MULTI_A}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('STORE_NOT_FOUND');
      expect(JSON.stringify(body)).not.toContain(ST_MULTI_A);
    });

    it('単店舗オーナーが自分の storeId をヒントに渡した場合も 200', async () => {
      const res = await callGet(`Bearer ${TOKEN_VALID}`, `storeId=${ST_VALID}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { storeId: string };
      expect(body.storeId).toBe(ST_VALID);
    });
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
