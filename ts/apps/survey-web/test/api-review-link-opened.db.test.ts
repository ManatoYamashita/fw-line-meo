import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool, incrementReviewLinkTally } from '@fwlm/db';
import { handleReviewLinkOpened, type ReviewLinkDeps } from '../src/app/api/review-link-opened/handler';
import { createSessionTokenService } from '../src/lib/session-token';
import { createRateLimiter } from '../src/lib/rate-limit';

// 実 postgres（ts-test-db）＋実 @fwlm/db アクセサで押下の加算を統合検証する（Issue #401・Requirement 5.9）。
// DATABASE_URL 無しの通常 ts-test では自動 skip。

const OP = 'a4010000-1111-4000-8000-000000000001';
const AG = 'a4010000-1111-4000-8000-000000000002';
const OW = 'a4010000-1111-4000-8000-000000000003';
const STORE = 'a4010000-1111-4000-8000-000000000004';
const KEY = 'integration-signing-key';

const tokens = createSessionTokenService(KEY);

function deps(): ReviewLinkDeps {
  return {
    tokens,
    rateLimiter: createRateLimiter({ limit: 1000, windowMs: 60_000 }),
    clientKey: () => 'itest',
    log: () => {},
    incrementReviewLinkTally: async (storeId) => incrementReviewLinkTally(await getPool(), storeId),
  };
}

function post(body: unknown): Request {
  return new Request('http://x/api/review-link-opened', { method: 'POST', body: JSON.stringify(body) });
}

/** 店舗の押下件数の全月合計（月の境界はここでは見ない。境界は @fwlm/db の DB テストが持つ）。 */
async function totalOpens(): Promise<number> {
  const pool = await getPool();
  const res = await pool.query<{ total: number }>(
    'SELECT COALESCE(sum(count), 0)::int AS total FROM survey_review_link_tallies WHERE store_id=$1',
    [STORE],
  );
  return res.rows[0]?.total ?? 0;
}

describe.skipIf(!process.env.DATABASE_URL)('POST /api/review-link-opened（DB）', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '押下運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, '押下代理店']);
    await pool.query(
      'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
      [OW, AG, 'U-review-link-itest', 'active'],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, 'confirmed')`,
      [STORE, OW, '押下店舗', 'ChIJ_review_link_itest'],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('sessionToken の押下で本物の表に 1 件増え、pageToken の押下では増えない', async () => {
    const sessionToken = tokens.sign({
      storeId: STORE,
      material: { storeName: '押下店舗', star: 4, aspectLabels: [] },
      attempt: 0,
    });
    const before = await totalOpens();

    expect((await handleReviewLinkOpened(post({ storeId: STORE, token: sessionToken }), deps())).status).toBe(204);
    expect(await totalOpens()).toBe(before + 1);

    expect(
      (await handleReviewLinkOpened(post({ storeId: STORE, token: tokens.signPage(STORE) }), deps())).status,
    ).toBe(204);
    expect(await totalOpens()).toBe(before + 1);
  });
});
