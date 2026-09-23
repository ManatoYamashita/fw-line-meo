import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getPool,
  closePool,
  findByAuthSubject,
  linkAuthSubjectByEmail,
  setStoreSuspension,
  createAuditLog,
} from '@fwlm/db';
import { createApp, type AppDeps } from '../src/app.js';

// 実 postgres（ts-test-db）＋実 @fwlm/db で停止・再開のルートを app.request 経由で検証する
// （store-suspension Req 1.1–1.5, 7.1–7.3）。firebase-admin のみモック（Bearer 文字列＝uid とみなす）。
// 監査は実物の createAuditLog を配線し、migration 0012 の CHECK が新しい action を受け付けることも観測する。
// DATABASE_URL 無しは skip。共有 DB のため UUID prefix は d7（他のファイルと非交差）。

const OP1 = 'd7000000-0000-0000-0000-000000000001';
const AG1 = 'd7000000-0000-0000-0000-000000000002';
const AG2 = 'd7000000-0000-0000-0000-000000000003';
const OW1 = 'd7000000-0000-0000-0000-000000000004';
const OW2 = 'd7000000-0000-0000-0000-000000000005';
const S1 = 'd7000000-0000-0000-0000-000000000006'; // AG1・confirmed
const S2 = 'd7000000-0000-0000-0000-000000000007'; // AG2・confirmed（AG1 の代理店からは範囲外）
const S3 = 'd7000000-0000-0000-0000-000000000008'; // AG2・confirmed（運営の停止・再開の対象）
const DU_OP = 'd7000000-0000-0000-0000-000000000010';
const DU_AG1 = 'd7000000-0000-0000-0000-000000000011';
const MISSING = 'd7000000-0000-0000-0000-0000000000ff';

const OP_TOKEN = 'd7-op-uid';
const AG1_TOKEN = 'd7-ag1-uid';

// 停止・再開の経路だけを検証する最小 deps（他の業務 deps はこのテストで一度も呼ばれない）。
type SuspensionOnlyDeps = Pick<AppDeps, 'corsOrigin' | 'storeSuspension'>;

function buildApp(): ReturnType<typeof createApp> {
  const deps: SuspensionOnlyDeps = {
    corsOrigin: 'https://dash.example',
    storeSuspension: {
      auth: {
        verifier: {
          verifyIdToken: (t) =>
            Promise.resolve({ uid: t, email: null, emailVerified: false, signInProvider: null }),
        },
        findUser: async (uid) => findByAuthSubject(await getPool(), uid),
        linkByEmail: async (email, uid) => linkAuthSubjectByEmail(await getPool(), email, uid),
      },
      setSuspension: async (input) => setStoreSuspension(await getPool(), input),
      auditLog: async (input) => createAuditLog(await getPool(), input),
    },
  };
  return createApp(deps as AppDeps);
}

async function post(path: string, bearer: string): Promise<Response> {
  return await buildApp().request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

async function storeRow(id: string): Promise<Record<string, unknown>> {
  const pool = await getPool();
  const res = await pool.query<Record<string, unknown>>('SELECT * FROM stores WHERE id = $1', [id]);
  const row = res.rows[0];
  if (row === undefined) throw new Error(`store ${id} が見つかりません`);
  return row;
}

async function auditRows(storeId: string): Promise<{ action: string; actor_type: string; actor_id: string }[]> {
  const pool = await getPool();
  const res = await pool.query<{ action: string; actor_type: string; actor_id: string }>(
    `SELECT action, actor_type::text AS actor_type, actor_id::text AS actor_id
       FROM audit_logs
      WHERE target_type = 'store' AND target_id = $1
      ORDER BY occurred_at, id`,
    [storeId],
  );
  return res.rows;
}

describe.skipIf(!process.env.DATABASE_URL)('store suspension routes (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP1, '停止運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3), ($4, $2, $5)', [
      AG1, OP1, '停止代理店1', AG2, '停止代理店2',
    ]);
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
       VALUES ($1, $2, $3, 'active'), ($4, $5, $6, 'active')`,
      [OW1, AG1, 'U-d7-susp-1', OW2, AG2, 'U-d7-susp-2'],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES
        ($1, $2, '停止店1', 'ChIJ-d7-1', 'confirmed'),
        ($3, $4, '停止店2', 'ChIJ-d7-2', 'confirmed'),
        ($5, $4, '停止店3', 'ChIJ-d7-3', 'confirmed')`,
      [S1, OW1, S2, OW2, S3],
    );
    await pool.query(
      `INSERT INTO dashboard_users (id, role, operator_id, agency_id, auth_subject) VALUES
        ($1, 'operator', $3, NULL, $5),
        ($2, 'agency', $3, $4, $6)`,
      [DU_OP, DU_AG1, OP1, AG1, OP_TOKEN, AG1_TOKEN],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('代理店が他代理店の店舗を停止すると 404 で、行も監査も変わらない（1.4）', async () => {
    const before = await storeRow(S2);
    const res = await post(`/stores/${S2}/suspend`, AG1_TOKEN);
    expect(res.status).toBe(404);
    const missing = await post(`/stores/${MISSING}/suspend`, AG1_TOKEN);
    expect(missing.status).toBe(404);
    // 範囲外と不存在は本文でも区別できない。ルート未配線の Hono 既定 404 と取り違えないよう封筒も確かめる。
    const outOfScopeBody = await res.text();
    expect(outOfScopeBody).toBe(await missing.text());
    expect((JSON.parse(outOfScopeBody) as { error: { code: string } }).error.code).toBe('not_found');
    expect(await storeRow(S2)).toEqual(before);
    expect(before['suspended_at']).toBeNull();
    expect(await auditRows(S2)).toEqual([]);
  });

  it('代理店が担当店舗を停止すると停止中になり、監査がちょうど 1 行残る。二度目は 200 で監査が増えない（1.2, 1.5, 7.1, 7.3）', async () => {
    const res = await post(`/stores/${S1}/suspend`, AG1_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { store: { id: string; suspendedAt: string | null } };
    expect(body.store.id).toBe(S1);
    expect(body.store.suspendedAt).not.toBeNull();
    const row = await storeRow(S1);
    expect(row['suspended_at']).toBeInstanceOf(Date);
    expect((row['suspended_at'] as Date).toISOString()).toBe(body.store.suspendedAt);
    expect(await auditRows(S1)).toEqual([
      { action: 'store_suspended', actor_type: 'agency', actor_id: DU_AG1 },
    ]);

    const again = await post(`/stores/${S1}/suspend`, AG1_TOKEN);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { store: { suspendedAt: string | null } }).store.suspendedAt).toBe(
      body.store.suspendedAt,
    );
    expect(await auditRows(S1)).toHaveLength(1);
  });

  it('運営は他代理店の店舗も停止・再開でき、それぞれ役割つきで 1 行ずつ監査が残る（1.1, 1.3, 7.1, 7.2）', async () => {
    const suspended = await post(`/stores/${S3}/suspend`, OP_TOKEN);
    expect(suspended.status).toBe(200);
    expect((await storeRow(S3))['suspended_at']).toBeInstanceOf(Date);

    const resumed = await post(`/stores/${S3}/resume`, OP_TOKEN);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ store: { id: S3, suspendedAt: null } });
    expect((await storeRow(S3))['suspended_at']).toBeNull();

    // 利用中への再開は変化なし（200・監査なし）。
    const resumedAgain = await post(`/stores/${S3}/resume`, OP_TOKEN);
    expect(resumedAgain.status).toBe(200);

    expect(await auditRows(S3)).toEqual([
      { action: 'store_suspended', actor_type: 'operator', actor_id: DU_OP },
      { action: 'store_resumed', actor_type: 'operator', actor_id: DU_OP },
    ]);
  });

  it('不正な ID は 404、トークン無しは 401', async () => {
    expect((await post('/stores/not-a-uuid/suspend', OP_TOKEN)).status).toBe(404);
    const res = await buildApp().request(`/stores/${S1}/resume`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
