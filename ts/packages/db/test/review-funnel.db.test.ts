import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '../src/pool.js';
import { incrementReviewLinkTally, incrementTallies, readStoreReviewFunnel } from '../src/tallies.js';

// 投稿導線の押下の集計と、QR パネルが出す月別の実績（Issue #401）。
// 他の DB テストと DB を共有するため、衝突しない固有 UUID / line_user_id を使う。
const OP = 'a4010000-0000-4000-8000-000000000001';
const AG = 'a4010000-0000-4000-8000-000000000002';
const OW = 'a4010000-0000-4000-8000-000000000003';
const STORE = 'a4010000-0000-4000-8000-000000000004';
const OTHER_STORE = 'a4010000-0000-4000-8000-000000000005';
const EMPTY_STORE = 'a4010000-0000-4000-8000-000000000006';

// JST の月境界の両側（UTC 15:00 が JST の翌日 0:00）。
const SEP_LAST_MINUTE_JST = new Date('2026-09-30T14:59:00Z'); // 9/30 23:59 JST
const OCT_FIRST_MINUTE_JST = new Date('2026-09-30T15:01:00Z'); // 10/1 00:01 JST

async function reviewLinkCount(storeId: string, periodMonth: string): Promise<number> {
  const pool = await getPool();
  const res = await pool.query<{ count: number }>(
    'SELECT count FROM survey_review_link_tallies WHERE store_id=$1 AND period_month=$2::date',
    [storeId, periodMonth],
  );
  return res.rows[0]?.count ?? 0;
}

describe.skipIf(!process.env.DATABASE_URL)('review funnel tallies (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '実績運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      '実績代理店',
    ]);
    await pool.query(
      'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
      [OW, AG, 'U-review-funnel-line-user', 'active'],
    );
    for (const [id, name] of [
      [STORE, '実績店舗'],
      [OTHER_STORE, '実績店舗（別店）'],
      [EMPTY_STORE, '実績店舗（空）'],
    ] as const) {
      await pool.query(
        `INSERT INTO stores (id, owner_id, name, place_id, place_status)
         VALUES ($1, $2, $3, $4, 'confirmed')`,
        [id, OW, name, `ChIJ_${id.slice(-4)}`],
      );
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it('押下は JST の月境界で月を分けて加算する（9/30 23:59 は 9 月・10/1 00:01 は 10 月）', async () => {
    const pool = await getPool();
    await incrementReviewLinkTally(pool, STORE, SEP_LAST_MINUTE_JST);
    await incrementReviewLinkTally(pool, STORE, SEP_LAST_MINUTE_JST);
    await incrementReviewLinkTally(pool, STORE, OCT_FIRST_MINUTE_JST);

    expect(await reviewLinkCount(STORE, '2026-09-01')).toBe(2);
    expect(await reviewLinkCount(STORE, '2026-10-01')).toBe(1);
    // 他店舗の行は作らない
    expect(await reviewLinkCount(OTHER_STORE, '2026-09-01')).toBe(0);
  });

  it('当月と前月を新しい順に返し、回答件数は星を問わない合計・押下回数は別の表から読む', async () => {
    const pool = await getPool();
    // 9 月に 3 回答（星 5・5・1）、10 月に 1 回答（星 2）。星の違いは件数に現れない（Requirement 8.2）。
    for (const star of [5, 5, 1]) {
      await incrementTallies(
        pool,
        { storeId: STORE, star, aspectCodes: [], concernCodes: [], hasComment: false },
        SEP_LAST_MINUTE_JST,
      );
    }
    await incrementTallies(
      pool,
      { storeId: STORE, star: 2, aspectCodes: [], concernCodes: [], hasComment: false },
      OCT_FIRST_MINUTE_JST,
    );
    // 別店舗の回答と押下が混ざらないこと
    await incrementTallies(
      pool,
      { storeId: OTHER_STORE, star: 4, aspectCodes: [], concernCodes: [], hasComment: false },
      OCT_FIRST_MINUTE_JST,
    );
    await incrementReviewLinkTally(pool, OTHER_STORE, OCT_FIRST_MINUTE_JST);

    const funnel = await readStoreReviewFunnel(pool, STORE, OCT_FIRST_MINUTE_JST);

    expect(funnel).toEqual([
      { month: '2026-10', responses: 1, reviewLinkOpens: 1 },
      { month: '2026-09', responses: 3, reviewLinkOpens: 2 },
    ]);
  });

  it('「当月」は JST で決まる（10/1 00:01 JST の前月は 9 月・9/30 23:59 JST の当月は 9 月）', async () => {
    const pool = await getPool();
    const atSepEnd = await readStoreReviewFunnel(pool, STORE, SEP_LAST_MINUTE_JST);
    expect(atSepEnd.map((m) => m.month)).toEqual(['2026-09', '2026-08']);
  });

  it('年をまたいでも前月を返す（1 月の前月は前年 12 月）', async () => {
    const pool = await getPool();
    const funnel = await readStoreReviewFunnel(pool, EMPTY_STORE, new Date('2027-01-15T03:00:00Z'));
    expect(funnel.map((m) => m.month)).toEqual(['2027-01', '2026-12']);
  });

  it('行の無い月は 0 件で返す（空欄にしない・Requirement 8.7）', async () => {
    const pool = await getPool();
    const funnel = await readStoreReviewFunnel(pool, EMPTY_STORE, OCT_FIRST_MINUTE_JST);
    expect(funnel).toEqual([
      { month: '2026-10', responses: 0, reviewLinkOpens: 0 },
      { month: '2026-09', responses: 0, reviewLinkOpens: 0 },
    ]);
  });

  it('返す項目は月・回答件数・押下回数の 3 つだけ（星ごとの内訳を持たない）', async () => {
    const pool = await getPool();
    const [month] = await readStoreReviewFunnel(pool, STORE, OCT_FIRST_MINUTE_JST);
    expect(Object.keys(month ?? {}).sort()).toEqual(['month', 'responses', 'reviewLinkOpens']);
  });
});
