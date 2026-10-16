import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { incrementStructuredTallies, type StructuredTallyInput } from '../src/tallies.js';

// structured survey の素材の厚みの匿名集計（Issue #436）。
// 他の DB テストと DB を共有するため、衝突しない固有 UUID / line_user_id を使う。
const OP = 'a4360001-0000-4000-8000-000000000001';
const AG = 'a4360001-0000-4000-8000-000000000002';
const OW = 'a4360001-0000-4000-8000-000000000003';
const STORE = 'a4360001-0000-4000-8000-000000000004';

const SEP_LAST_MINUTE_JST = new Date('2026-09-30T14:59:00Z'); // 9/30 23:59 JST
const OCT_FIRST_MINUTE_JST = new Date('2026-09-30T15:01:00Z'); // 10/1 00:01 JST

const BASE: StructuredTallyInput = {
  storeId: STORE,
  star: 4,
  positiveGroupCount: 2,
  concernGroupCount: 1,
  positiveTargetCount: 1,
  concernTargetCount: 1,
  positiveFacetCount: 3,
  concernFacetCount: 0,
  hasComment: true,
};

async function count(sql: string, params: unknown[]): Promise<number> {
  const pool = await getPool();
  const res = await pool.query<{ n: number }>(sql, params);
  return res.rows[0]?.n ?? 0;
}

describe.skipIf(!process.env.DATABASE_URL)('incrementStructuredTallies (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '構造化集計運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      '構造化集計代理店',
    ]);
    await pool.query(
      'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
      [OW, AG, 'U-structured-tallies-line-user', 'active'],
    );
    await pool.query(
      `INSERT INTO stores (id, owner_id, name, place_id, place_status)
       VALUES ($1, $2, '構造化集計店舗', 'ChIJ_structured_tally', 'confirmed')`,
      [STORE, OW],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('星と厚みを JST の月で加算し、同じ厚みは同じ行へ数える', async () => {
    const pool = await getPool();
    await incrementStructuredTallies(pool, BASE, SEP_LAST_MINUTE_JST);
    await incrementStructuredTallies(pool, BASE, SEP_LAST_MINUTE_JST);
    await incrementStructuredTallies(pool, BASE, OCT_FIRST_MINUTE_JST);

    expect(
      await count(
        `SELECT count AS n FROM survey_rating_tallies
         WHERE store_id=$1 AND star=4 AND period_month='2026-09-01'`,
        [STORE],
      ),
    ).toBe(2);
    expect(
      await count(
        `SELECT count AS n FROM survey_structured_material_tallies
         WHERE store_id=$1 AND period_month=$2::date
           AND positive_group_count=2 AND concern_group_count=1
           AND positive_target_count=1 AND concern_target_count=1
           AND positive_facet_count=3 AND concern_facet_count=0 AND has_comment`,
        [STORE, '2026-09-01'],
      ),
    ).toBe(2);
    expect(
      await count(
        `SELECT sum(count)::int AS n FROM survey_structured_material_tallies
         WHERE store_id=$1 AND period_month='2026-10-01'`,
        [STORE],
      ),
    ).toBe(1);
  });

  it('1 回の呼び出しが星 1 件と厚み 1 件を所有する（星の件数と厚みの件数が一致する）', async () => {
    // この関数は星（survey_rating_tallies）も加算する。呼び手が incrementTallies を併せて呼ぶと
    // 星だけが 2 になり、この一致が崩れる。回答 1 件につき呼ぶのはどちらか一方だけである。
    const pool = await getPool();
    const at = new Date('2026-12-10T03:00:00Z');
    await incrementStructuredTallies(pool, { ...BASE, star: 2 }, at);
    await incrementStructuredTallies(pool, { ...BASE, star: 5, hasComment: false }, at);
    const ratings = await count(
      `SELECT sum(count)::int AS n FROM survey_rating_tallies
       WHERE store_id=$1 AND period_month='2026-12-01'`,
      [STORE],
    );
    const materials = await count(
      `SELECT sum(count)::int AS n FROM survey_structured_material_tallies
       WHERE store_id=$1 AND period_month='2026-12-01'`,
      [STORE],
    );
    expect(ratings).toBe(2);
    expect(materials).toBe(2);
  });

  it('legacy の観点・気になった点・厚みの表には書かない（意味を読み替えない）', async () => {
    for (const table of [
      'survey_aspect_tallies',
      'survey_concern_tallies',
      'survey_material_tallies',
    ]) {
      expect(await count(`SELECT count(*)::int AS n FROM ${table} WHERE store_id=$1`, [STORE])).toBe(0);
    }
  });

  it('厚みの加算が失敗したら星の加算も巻き戻す（母数をずらさない）', async () => {
    const pool = await getPool();
    const before = await count(
      `SELECT COALESCE(sum(count), 0)::int AS n FROM survey_rating_tallies
       WHERE store_id=$1 AND period_month='2026-11-01'`,
      [STORE],
    );
    // Target を指すグループ数がグループ数を超える厚みは DB の CHECK が拒否する。
    await expect(
      incrementStructuredTallies(
        pool,
        { ...BASE, positiveGroupCount: 0, positiveTargetCount: 1 },
        new Date('2026-11-10T03:00:00Z'),
      ),
    ).rejects.toThrow();
    const after = await count(
      `SELECT COALESCE(sum(count), 0)::int AS n FROM survey_rating_tallies
       WHERE store_id=$1 AND period_month='2026-11-01'`,
      [STORE],
    );
    expect(after).toBe(before);
  });
});
