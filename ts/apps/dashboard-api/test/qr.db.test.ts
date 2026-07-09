import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import QRCode from 'qrcode';
import { getPool, closePool, findByAuthSubject, findStoreWithAgency } from '@fwlm/db';
import { createApp, type AppDeps } from '../src/app.js';

// 実 postgres（ts-test-db）＋実 @fwlm/db で QR RBAC マトリクスを app.request 経由で検証。
// firebase-admin のみモック（Bearer トークン文字列＝uid とみなす）。DATABASE_URL 無しは skip。

const OP1 = 'ffffffff-0000-0000-0000-000000000001';
const AG1 = 'ffffffff-0000-0000-0000-000000000002';
const AG2 = 'ffffffff-0000-0000-0000-000000000003';
const OW1 = 'ffffffff-0000-0000-0000-000000000004';
const OW2 = 'ffffffff-0000-0000-0000-000000000005';
const S1 = 'ffffffff-0000-0000-0000-000000000006'; // AG1・confirmed
const S2 = 'ffffffff-0000-0000-0000-000000000007'; // AG2・confirmed
const S_PENDING = 'ffffffff-0000-0000-0000-000000000008'; // AG1・pending

function buildApp(): ReturnType<typeof createApp> {
  const deps: AppDeps = {
    qr: {
      auth: {
        verifier: { verifyIdToken: (t) => Promise.resolve({ uid: t }) },
        findUser: async (uid) => findByAuthSubject(await getPool(), uid),
      },
      findStore: async (id) => findStoreWithAgency(await getPool(), id),
      renderQr: (text, size) => QRCode.toBuffer(text, { width: size }),
      surveyBaseUrl: 'https://survey.example',
    },
  };
  return createApp(deps);
}

function qr(app: ReturnType<typeof createApp>, storeId: string, bearer?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (bearer !== undefined) headers['Authorization'] = `Bearer ${bearer}`;
  return app.request(`/stores/${storeId}/qr.png`, { headers });
}

describe.skipIf(!process.env.DATABASE_URL)('QR RBAC integration (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP1, 'RBAC運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3), ($4, $2, $5)', [
      AG1, OP1, '代理店1', AG2, '代理店2',
    ]);
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
       VALUES ($1, $2, $3, 'active'), ($4, $5, $6, 'active')`,
      [OW1, AG1, 'U-rbac-1', OW2, AG2, 'U-rbac-2'],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES
        ($1, $2, '店1', 'ChIJ1', 'confirmed'),
        ($3, $4, '店2', 'ChIJ2', 'confirmed'),
        ($5, $2, '未確定店', NULL, 'pending')`,
      [S1, OW1, S2, OW2, S_PENDING],
    );
    await pool.query(
      `INSERT INTO dashboard_users (role, operator_id, agency_id, auth_subject) VALUES
        ('operator', $1, NULL, 'rbac-op-uid'),
        ('agency', $1, $2, 'rbac-ag1-uid')`,
      [OP1, AG1],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('operator は全店の QR を 200 で取得（S1・S2 とも）', async () => {
    const app = buildApp();
    expect((await qr(app, S1, 'rbac-op-uid')).status).toBe(200);
    const res2 = await qr(app, S2, 'rbac-op-uid');
    expect(res2.status).toBe(200);
    expect(res2.headers.get('Content-Type')).toBe('image/png');
  });

  it('agency は担当店(S1) 200・他店(S2) 403', async () => {
    const app = buildApp();
    expect((await qr(app, S1, 'rbac-ag1-uid')).status).toBe(200);
    expect((await qr(app, S2, 'rbac-ag1-uid')).status).toBe(403);
  });

  it('未登録 UID は 403', async () => {
    expect((await qr(buildApp(), S1, 'unknown-uid')).status).toBe(403);
  });

  it('トークン無しは 401', async () => {
    expect((await qr(buildApp(), S1)).status).toBe(401);
  });

  it('place 未確定店は 409（認可済みでも）', async () => {
    expect((await qr(buildApp(), S_PENDING, 'rbac-op-uid')).status).toBe(409);
  });

  it('存在しない store は 404', async () => {
    expect((await qr(buildApp(), 'ffffffff-0000-0000-0000-0000000000ff', 'rbac-op-uid')).status).toBe(404);
  });
});
