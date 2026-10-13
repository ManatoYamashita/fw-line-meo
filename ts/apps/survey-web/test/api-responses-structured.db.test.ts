import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  addSurveyTarget,
  closePool,
  findStoreForSurvey,
  getPool,
  incrementStructuredTallies,
  incrementTallies,
  listSurveyAspects,
  readStoreSurveyDefinition,
  setSurveyTargetActive,
} from '@fwlm/db';
import { handleResponses, type ResponsesDeps } from '../src/app/api/responses/handler';
import { loadSurveyPageData } from '../src/app/s/[storeId]/page-data';
import { pendingStructuredDraft } from '../src/lib/draft/structured-draft';
import { createRateLimiter } from '../src/lib/rate-limit';
import { createSessionTokenService } from '../src/lib/session-token';
import { ok } from '../src/lib/result';

// structured survey の表示 → 送信を、実 PostgreSQL・実際のアクセサ・実際の page loader で通す（Issue #438）。
//   - 表示で発行した v2 token で送ると、星は survey_rating_tallies へちょうど 1 件・厚みは構造化集計へ 1 件・
//     legacy の観点の集計へは 0 件（星を二重に数えない）
//   - 表示の後にオーナーが設定を変えた（Stage 1 の DAL）回答は STALE_SURVEY
//   - 他店の Target・非表示の Target は 400
// 他の DB テストと DB を共有するため、衝突しない固有 UUID / line_user_id を使う。

const OP = 'a4380001-0000-4000-8000-000000000001';
const AG = 'a4380001-0000-4000-8000-000000000002';
const OW = 'a4380001-0000-4000-8000-000000000003';
const STORE = 'a4380001-0000-4000-8000-000000000004';
const OTHER = 'a4380001-0000-4000-8000-000000000005';
const KEY = 'structured-db-signing-key';
const tokens = createSessionTokenService(KEY);

function deps(): ResponsesDeps {
  return {
    tokens,
    generator: { generate: () => Promise.resolve(ok('legacy')) },
    rateLimiter: createRateLimiter({ limit: 1000, windowMs: 60_000 }),
    findStore: async (id) => findStoreForSurvey(await getPool(), id),
    listAspects: async () => listSurveyAspects(await getPool()),
    incrementTallies: async (input) => incrementTallies(await getPool(), input),
    readDefinition: async (id) => readStoreSurveyDefinition(await getPool(), id),
    incrementStructuredTallies: async (input) => incrementStructuredTallies(await getPool(), input),
    structuredDrafts: pendingStructuredDraft,
    clientKey: () => 'itest',
    log: () => {},
  };
}

/** 実際の page loader で表示し、発行された token と定義を返す。 */
async function show(storeId = STORE) {
  const data = await loadSurveyPageData(
    {
      findStore: async (id) => findStoreForSurvey(await getPool(), id),
      readDefinition: async (id) => readStoreSurveyDefinition(await getPool(), id),
      listAspects: async () => listSurveyAspects(await getPool()),
      signPage: (id) => tokens.signPage(id),
      signStructuredPage: (id, r, f) => tokens.signStructuredPage(id, r, f),
      buildReviewUrl: (p) => `https://review/${p}`,
      log: () => {},
    },
    storeId,
  );
  if (data.kind !== 'ready' || data.mode !== 'structured') throw new Error(`expected structured, got ${JSON.stringify(data)}`);
  return data;
}

async function post(body: Record<string, unknown>) {
  const res = await handleResponses(
    new Request('http://x/api/responses', { method: 'POST', body: JSON.stringify({ storeId: STORE, ...body }) }),
    deps(),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function counts(storeId = STORE) {
  const pool = await getPool();
  const q = async (sql: string) => (await pool.query<{ n: number }>(sql, [storeId])).rows[0]!.n;
  return {
    rating: await q('SELECT COALESCE(sum(count), 0)::int AS n FROM survey_rating_tallies WHERE store_id = $1'),
    structured: await q('SELECT COALESCE(sum(count), 0)::int AS n FROM survey_structured_material_tallies WHERE store_id = $1'),
    aspect: await q('SELECT COALESCE(sum(count), 0)::int AS n FROM survey_aspect_tallies WHERE store_id = $1'),
    concern: await q('SELECT COALESCE(sum(count), 0)::int AS n FROM survey_concern_tallies WHERE store_id = $1'),
    material: await q('SELECT COALESCE(sum(count), 0)::int AS n FROM survey_material_tallies WHERE store_id = $1'),
  };
}

let sashimi = '';
let hidden = '';
let otherTarget = '';

describe.skipIf(!process.env.DATABASE_URL)('/api/responses × structured survey（DB）', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '構造化送信運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [AG, OP, '構造化送信代理店']);
    await pool.query('INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)', [
      OW,
      AG,
      'U-structured-submit',
      'active',
    ]);
    for (const id of [STORE, OTHER]) {
      await pool.query(
        `INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, 'confirmed')`,
        [id, OW, `構造化送信店 ${id.slice(-1)}`, `ChIJ_structured_submit_${id.slice(-1)}`],
      );
    }
    // オーナーの設定画面と同じ DAL で Target を登録する（Stage 1・Issue #437）。
    const added = await addSurveyTarget(pool, STORE, { categoryCode: 'food', label: '刺身盛り合わせ' });
    const hiddenAdded = await addSurveyTarget(pool, STORE, { categoryCode: 'food', label: '名物もつ煮' });
    const otherAdded = await addSurveyTarget(pool, OTHER, { categoryCode: 'food', label: '他店の料理' });
    if (!added.ok || !added.changed || !hiddenAdded.ok || !hiddenAdded.changed || !otherAdded.ok || !otherAdded.changed) {
      throw new Error('fixture');
    }
    sashimi = added.targetId!;
    hidden = hiddenAdded.targetId!;
    otherTarget = otherAdded.targetId!;
    await setSurveyTargetActive(pool, STORE, hidden, false);
    // 有効化はオーナーの操作に無い（Stage 1）。ローカル・テストの fixture として直接立てる。
    await pool.query('UPDATE store_survey_configs SET structured_enabled = true WHERE store_id = ANY($1)', [[STORE, OTHER]]);
  });

  afterAll(async () => {
    await closePool();
  });

  it('表示で発行した v2 token で送ると、星は 1 件・厚みは構造化集計へ 1 件・legacy の集計へは 0 件', async () => {
    const shown = await show();
    const before = await counts();
    const res = await post({
      pageToken: shown.pageToken,
      star: 4,
      positiveSelections: [
        { categoryCode: 'food', targetId: sashimi, facetCodes: ['taste'] },
        { categoryCode: 'service_delivery', facetCodes: ['serving'] },
      ],
      concernSelections: [{ categoryCode: 'food', targetId: sashimi, facetCodes: ['taste'] }],
    });
    expect(res).toEqual({ status: 200, body: { mode: 'structured', generation: 'unavailable', draft: null } });
    const after = await counts();
    expect(after.rating - before.rating).toBe(1);
    expect(after.structured - before.structured).toBe(1);
    expect(after.aspect - before.aspect).toBe(0);
    expect(after.concern - before.concern).toBe(0);
    expect(after.material - before.material).toBe(0);
  });

  it('表示の後にオーナーが設定を変えた回答は STALE_SURVEY（409）で、何も数えない', async () => {
    const shown = await show();
    await addSurveyTarget(await getPool(), STORE, { categoryCode: 'drink', label: `表示の後に足したドリンク ${Date.now()}` });
    const before = await counts();
    const res = await post({ pageToken: shown.pageToken, star: 5, positiveSelections: [], concernSelections: [] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'STALE_SURVEY' } });
    expect(await counts()).toEqual(before);
  });

  it('他店の Target・非表示の Target は 400 で、何も数えない', async () => {
    const shown = await show();
    for (const targetId of [otherTarget, hidden]) {
      const before = await counts();
      const res = await post({
        pageToken: shown.pageToken,
        star: 3,
        positiveSelections: [{ categoryCode: 'food', targetId, facetCodes: [] }],
        concernSelections: [],
      });
      expect(res.status, targetId).toBe(400);
      expect(await counts()).toEqual(before);
    }
  });

  it('structured を無効に戻した店舗では、表示済みの v2 token の回答は STALE_SURVEY', async () => {
    const shown = await show(OTHER);
    await (await getPool()).query('UPDATE store_survey_configs SET structured_enabled = false WHERE store_id = $1', [OTHER]);
    const res = await handleResponses(
      new Request('http://x/api/responses', {
        method: 'POST',
        body: JSON.stringify({ storeId: OTHER, pageToken: shown.pageToken, star: 5, positiveSelections: [], concernSelections: [] }),
      }),
      deps(),
    );
    expect(res.status).toBe(409);
  });
});
