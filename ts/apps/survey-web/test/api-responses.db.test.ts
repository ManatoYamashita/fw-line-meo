import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getPool,
  closePool,
  findStoreForSurvey,
  listSurveyAspects,
  incrementTallies,
} from '@fwlm/db';
import { handleResponses, type ResponsesDeps } from '../src/app/api/responses/handler';
import { handleDrafts, type DraftsDeps } from '../src/app/api/drafts/handler';
import { createSessionTokenService } from '../src/lib/session-token';
import { createRateLimiter } from '../src/lib/rate-limit';
import { ok, err } from '../src/lib/result';
import type { DraftGenerator } from '../src/lib/draft/generator';

// 実 postgres（ts-test-db）＋実 @fwlm/db アクセサで responses/drafts を統合検証（Gemini のみモック）。
// DATABASE_URL 無しの通常 ts-test では自動 skip。

const OP = 'eeeeeeee-0000-0000-0000-000000000001';
const AG = 'eeeeeeee-0000-0000-0000-000000000002';
const OW = 'eeeeeeee-0000-0000-0000-000000000003';
const STORE = 'eeeeeeee-0000-0000-0000-000000000004';
const KEY = 'integration-signing-key';

const tokens = createSessionTokenService(KEY);

function okGen(draft = '統合下書き'): DraftGenerator {
  return { generate: () => Promise.resolve(ok(draft)) };
}
function failGen(): DraftGenerator {
  return { generate: () => Promise.resolve(err({ kind: 'API_ERROR' as const })) };
}

function responsesDeps(generator: DraftGenerator): ResponsesDeps {
  return {
    tokens,
    generator,
    rateLimiter: createRateLimiter({ limit: 1000, windowMs: 60_000 }),
    findStore: async (id) => findStoreForSurvey(await getPool(), id),
    listAspects: async () => listSurveyAspects(await getPool()),
    incrementTallies: async (input) => {
      await incrementTallies(await getPool(), input);
    },
    clientKey: () => 'itest',
    log: () => {},
  };
}

function draftsDeps(generator: DraftGenerator): DraftsDeps {
  return {
    tokens,
    generator,
    rateLimiter: createRateLimiter({ limit: 1000, windowMs: 60_000 }),
    clientKey: () => 'itest',
    log: () => {},
  };
}

function post(url: string, body: unknown): Request {
  return new Request(url, { method: 'POST', body: JSON.stringify(body) });
}

async function ratingCount(star: number): Promise<number> {
  const pool = await getPool();
  const res = await pool.query<{ count: number }>(
    'SELECT count FROM survey_rating_tallies WHERE store_id=$1 AND star=$2',
    [STORE, star],
  );
  return res.rows[0]?.count ?? 0;
}

describe.skipIf(!process.env.DATABASE_URL)('survey-web integration (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '統合運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, '統合代理店']);
    await pool.query(
      'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
      [OW, AG, 'U-integration', 'active'],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status)
       VALUES ($1, $2, $3, $4, 'confirmed')`,
      [STORE, OW, '統合店舗', 'ChIJ_integration'],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('正常回答: 実 UPSERT で rating/aspect が加算され draft/token が返る', async () => {
    const pageToken = tokens.signPage(STORE);
    const res = await handleResponses(
      post('http://x/api/responses', { pageToken, storeId: STORE, star: 5, aspectCodes: ['taste'] }),
      responsesDeps(okGen()),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.generation).toBe('ok');
    expect(json.draft).toBe('統合下書き');
    expect(await ratingCount(5)).toBe(1);
    const pool = await getPool();
    const taste = await pool.query<{ count: number }>(
      "SELECT count FROM survey_aspect_tallies WHERE store_id=$1 AND aspect_code='taste'",
      [STORE],
    );
    expect(taste.rows[0]?.count).toBe(1);
  });

  it('再回答で count が加算される（実 UNIQUE 制約上の UPSERT）', async () => {
    const pageToken = tokens.signPage(STORE);
    await handleResponses(
      post('http://x/api/responses', { pageToken, storeId: STORE, star: 5, aspectCodes: ['taste'] }),
      responsesDeps(okGen()),
    );
    expect(await ratingCount(5)).toBe(2);
  });

  it('pageToken 不正は 400 で集計を加算しない', async () => {
    const before = await ratingCount(4);
    const res = await handleResponses(
      post('http://x/api/responses', { pageToken: 'bogus', storeId: STORE, star: 4, aspectCodes: [] }),
      responsesDeps(okGen()),
    );
    expect(res.status).toBe(400);
    expect(await ratingCount(4)).toBe(before);
  });

  it('生成失敗→/api/drafts 再試行で tallies が二重加算されない（3.9×5.2）', async () => {
    const pageToken = tokens.signPage(STORE);
    // 生成失敗でも集計は 1 回加算・sessionToken 発行
    const res1 = await handleResponses(
      post('http://x/api/responses', { pageToken, storeId: STORE, star: 3, aspectCodes: [] }),
      responsesDeps(failGen()),
    );
    const json1 = await res1.json();
    expect(json1.generation).toBe('failed');
    expect(await ratingCount(3)).toBe(1);

    // /api/drafts で再試行成功 → tallies は 3 のまま不変（drafts は集計非接触）
    const res2 = await handleDrafts(
      post('http://x/api/drafts', { sessionToken: json1.sessionToken }),
      draftsDeps(okGen()),
    );
    expect((await res2.json()).generation).toBe('ok');
    expect(await ratingCount(3)).toBe(1); // 二重加算なし
  });
});
