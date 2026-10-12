import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool, incrementReviewLinkTally, incrementTallies } from '@fwlm/db';
import { createApp } from '../src/app.js';
import type { TokenVerifier } from '../src/auth.js';
import { buildAppDeps } from '../src/composition.js';
import { readJson } from './support/json.js';

// 実 postgres（ts-test-db）＋実 @fwlm/db で QR パネルの実績（Issue #401）を app.request 経由で検証する。
// 配線は本番と同じ合成根（buildAppDeps）を使い、verifier だけを差し替える。DATABASE_URL 無しは skip。
// 共有 DB のため UUID は a401…-2222 の名前空間を使う。

const OP1 = 'a4010000-2222-4000-8000-000000000001';
const AG1 = 'a4010000-2222-4000-8000-000000000002';
const AG2 = 'a4010000-2222-4000-8000-000000000003';
const OW1 = 'a4010000-2222-4000-8000-000000000004';
const OW2 = 'a4010000-2222-4000-8000-000000000005';
const S1 = 'a4010000-2222-4000-8000-000000000006'; // AG1
const S2 = 'a4010000-2222-4000-8000-000000000007'; // AG2
const MISSING = 'a4010000-2222-4000-8000-0000000000ff';

const OP_TOKEN = 'a401-op-uid';
const AG1_TOKEN = 'a401-ag1-uid';

const config = {
  placesApiKey: 'test-places-key',
  corsOrigin: 'https://dash.example',
  surveyBaseUrl: 'https://survey.example',
};

const verifier: TokenVerifier = {
  verifyIdToken: (t) => Promise.resolve({ uid: t, email: null, emailVerified: false, signInProvider: null }),
};

function buildApp(): ReturnType<typeof createApp> {
  return createApp(buildAppDeps({ config, verifier, structuredLog: () => undefined }));
}

async function funnel(storeId: string, bearer?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (bearer !== undefined) headers['Authorization'] = `Bearer ${bearer}`;
  return await buildApp().request(`/stores/${storeId}/review-funnel`, { headers });
}

interface FunnelBody {
  months: { month: string; responses: number; reviewLinkOpens: number }[];
}

describe.skipIf(!process.env.DATABASE_URL)('GET /stores/:storeId/review-funnel（DB）', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP1, '実績運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3), ($4, $2, $5)', [
      AG1, OP1, '実績代理店1', AG2, '実績代理店2',
    ]);
    await pool.query(
      `INSERT INTO owners (id, agency_id, line_user_id, onboarding_status)
       VALUES ($1, $2, $3, 'active'), ($4, $5, $6, 'active')`,
      [OW1, AG1, 'U-a401-funnel-1', OW2, AG2, 'U-a401-funnel-2'],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES
        ($1, $2, '実績店1', 'ChIJ_a401_1', 'confirmed'),
        ($3, $4, '実績店2', 'ChIJ_a401_2', 'confirmed')`,
      [S1, OW1, S2, OW2],
    );
    await pool.query(
      `INSERT INTO dashboard_users (role, operator_id, agency_id, auth_subject) VALUES
        ('operator', $1, NULL, $3),
        ('agency', $1, $2, $4)`,
      [OP1, AG1, OP_TOKEN, AG1_TOKEN],
    );
    // 当月（DB の now() の JST 月）に S1 へ 2 回答・1 押下。別店舗 S2 にも 1 回答を置き、混ざらないことを見る。
    for (const star of [5, 1]) {
      await incrementTallies(pool, { storeId: S1, star, aspectCodes: [], concernCodes: [], hasComment: false });
    }
    await incrementReviewLinkTally(pool, S1);
    await incrementTallies(pool, { storeId: S2, star: 3, aspectCodes: [], concernCodes: [], hasComment: false });
  });

  afterAll(async () => {
    await closePool();
  });

  it('運営は当月の回答件数と押下回数を受け取り、前月は 0 件で返る', async () => {
    const res = await funnel(S1, OP_TOKEN);

    expect(res.status).toBe(200);
    const body = await readJson<FunnelBody>(res);
    expect(body.months).toHaveLength(2);
    expect(body.months[0]).toMatchObject({ responses: 2, reviewLinkOpens: 1 });
    expect(body.months[1]).toMatchObject({ responses: 0, reviewLinkOpens: 0 });
    expect(body.months[0]!.month > body.months[1]!.month).toBe(true);
  });

  it('担当の代理店は 200、担当外の店舗は 403', async () => {
    expect((await funnel(S1, AG1_TOKEN)).status).toBe(200);
    expect((await funnel(S2, AG1_TOKEN)).status).toBe(403);
  });

  it('トークン無しは 401・未登録 UID は 403・存在しない店舗と UUID でない ID は 404', async () => {
    expect((await funnel(S1)).status).toBe(401);
    expect((await funnel(S1, 'unknown-uid')).status).toBe(403);
    expect((await funnel(MISSING, OP_TOKEN)).status).toBe(404);
    expect((await funnel('not-a-uuid', OP_TOKEN)).status).toBe(404);
  });

  it('CORS は業務ルートと同じく許可オリジンへ応答する', async () => {
    const res = await buildApp().request(`/stores/${S1}/review-funnel`, {
      headers: { Authorization: `Bearer ${OP_TOKEN}`, Origin: 'https://dash.example' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dash.example');
  });
});
