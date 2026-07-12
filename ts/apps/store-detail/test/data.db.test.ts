// lib/data.ts（queryStoreDetail, Task 5.2）の DB テスト（実 postgres 必須）。
//
// 検証対象（task 5.2 の観察可能な完了条件）:
//   - 30日窓の境界（Go の PurgeOlderThan と同一の off-by-one 規約: cutoff = asOf - 30日、
//     保持は captured_on > cutoff）: ちょうど境界の行（cutoff 自身）は除外、その翌日
//     （asOf-29日）は含まれる
//   - 競合0店（R1.3・R4.3）→ 自店のみの形（competitors=[]）
//   - 競合が存在する場合は daily_summaries.competitors（最大5件・rank順）がそのまま返る
//   - 当日 daily_summaries 行が無い場合は summary=null（silent drop せず null で表現）
//
// 他テストファイルと DB を共有するため、衝突しない固有 UUID prefix を使う
// （targets.db.test.ts / liff-auth.db.test.ts の慣習に準拠。リポジトリ内で未使用の e5/e6 を採用）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, closePool } from '@fwlm/db';
import { queryStoreDetail } from '../lib/data.js';

const OP = 'e5000000-0000-0000-0000-000000000001';
const AG = 'e5000000-0000-0000-0000-000000000002';
const OWNER = 'e5000000-0000-0000-0000-000000000011';

const ST_TREND = 'e6000000-0000-0000-0000-000000000001'; // 30日境界テスト用
const ST_NO_COMPETITORS = 'e6000000-0000-0000-0000-000000000002'; // 競合0店
const ST_WITH_COMPETITORS = 'e6000000-0000-0000-0000-000000000003'; // 競合5店
const ST_NO_SUMMARY_TODAY = 'e6000000-0000-0000-0000-000000000004'; // 当日summary無し

const AS_OF = '2026-08-30';
// cutoff = AS_OF - 30日 = 2026-07-31。保持は captured_on > cutoff。
const CUTOFF_EXCLUDED = '2026-07-31'; // cutoff ちょうど → 除外（Go の PurgeOlderThan が削除する境界と同一）
const BOUNDARY_INCLUDED = '2026-08-01'; // cutoff+1日（= asOf-29日）→ 含まれる最古の日
const TODAY_INCLUDED = '2026-08-30'; // asOf 当日 → 含まれる

describe.skipIf(!process.env.DATABASE_URL)('data: queryStoreDetail (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '詳細読取検証運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      '詳細読取検証代理店',
    ]);
    await pool.query(
      'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
      [OWNER, AG, `U-${OWNER}`, 'active'],
    );

    for (const [id, placeId] of [
      [ST_TREND, 'places/detail-trend'],
      [ST_NO_COMPETITORS, 'places/detail-no-competitors'],
      [ST_WITH_COMPETITORS, 'places/detail-with-competitors'],
      [ST_NO_SUMMARY_TODAY, 'places/detail-no-summary-today'],
    ] as const) {
      await pool.query(
        'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
        [id, OWNER, `詳細読取検証店舗 ${id}`, placeId, 'confirmed'],
      );
    }

    // --- ST_TREND: 30日境界を跨ぐ自店スナップショット（subject_kind='self'） ---
    for (const capturedOn of [CUTOFF_EXCLUDED, BOUNDARY_INCLUDED, TODAY_INCLUDED]) {
      await pool.query(
        `INSERT INTO rating_snapshots (store_id, subject_kind, competitor_id, place_id, captured_on, rating, review_count, rank)
         VALUES ($1, 'self', NULL, 'places/detail-trend', $2, '4.5', 100, 1)`,
        [ST_TREND, capturedOn],
      );
    }

    // --- ST_NO_COMPETITORS: 競合0店の当日サマリー（R1.3: status='no_competitors'） ---
    await pool.query(
      `INSERT INTO daily_summaries
         (store_id, summary_date, status, rank, rank_total, rating, review_count, new_review_count, competitors)
       VALUES ($1, $2, 'no_competitors', 1, 1, '4.2', 50, 0, '[]'::jsonb)`,
      [ST_NO_COMPETITORS, AS_OF],
    );

    // --- ST_WITH_COMPETITORS: 競合5店（上限件数）の当日サマリー ---
    const fiveCompetitors = JSON.stringify(
      Array.from({ length: 5 }, (_, i) => ({
        name: `競合店舗${i + 1}`,
        rating: `${4.0 + i * 0.1}`,
        reviewCount: 20 + i,
        starDiff: `${(i - 2) * 0.1}`,
      })),
    );
    await pool.query(
      `INSERT INTO daily_summaries
         (store_id, summary_date, status, rank, rank_total, rating, review_count, new_review_count, competitors)
       VALUES ($1, $2, 'ready', 3, 6, '4.3', 80, 2, $3::jsonb)`,
      [ST_WITH_COMPETITORS, AS_OF, fiveCompetitors],
    );
    // ST_NO_SUMMARY_TODAY: 意図的に daily_summaries を挿入しない（当日未生成のケース）。
  });

  afterAll(async () => {
    await closePool();
  });

  describe('30日窓の境界（Go PurgeOlderThan と同一の off-by-one 規約）', () => {
    it('cutoff ちょうどの行は除外し、cutoff+1日（境界）と当日は含む', async () => {
      const pool = await getPool();
      const result = await queryStoreDetail(pool, ST_TREND, { asOf: AS_OF });

      const capturedOns = result.trend.map((p) => p.capturedOn);
      expect(capturedOns).not.toContain(CUTOFF_EXCLUDED);
      expect(capturedOns).toContain(BOUNDARY_INCLUDED);
      expect(capturedOns).toContain(TODAY_INCLUDED);
    });

    it('trend は captured_on 昇順（古い→新しい）で返す', async () => {
      const pool = await getPool();
      const result = await queryStoreDetail(pool, ST_TREND, { asOf: AS_OF });

      expect(result.trend.map((p) => p.capturedOn)).toEqual([BOUNDARY_INCLUDED, TODAY_INCLUDED]);
    });

    it('trend の各点が rank/rating/reviewCount を保持する', async () => {
      const pool = await getPool();
      const result = await queryStoreDetail(pool, ST_TREND, { asOf: AS_OF });

      const point = result.trend.find((p) => p.capturedOn === TODAY_INCLUDED);
      expect(point).toEqual({
        capturedOn: TODAY_INCLUDED,
        rank: 1,
        rating: '4.5',
        reviewCount: 100,
      });
    });
  });

  describe('競合0店 → 自店のみの形（R1.3, R4.3）', () => {
    it('competitors が空配列で返る', async () => {
      const pool = await getPool();
      const result = await queryStoreDetail(pool, ST_NO_COMPETITORS, { asOf: AS_OF });

      expect(result.competitors).toEqual([]);
      expect(result.summary?.status).toBe('no_competitors');
    });
  });

  describe('競合が存在する場合', () => {
    it('daily_summaries.competitors（最大5件・rank順）がそのまま返る', async () => {
      const pool = await getPool();
      const result = await queryStoreDetail(pool, ST_WITH_COMPETITORS, { asOf: AS_OF });

      expect(result.competitors).toHaveLength(5);
      expect(result.competitors.map((c) => c.name)).toEqual([
        '競合店舗1',
        '競合店舗2',
        '競合店舗3',
        '競合店舗4',
        '競合店舗5',
      ]);
      expect(result.summary).toMatchObject({
        summaryDate: AS_OF,
        status: 'ready',
        rank: 3,
        rankTotal: 6,
        rating: '4.3',
        reviewCount: 80,
        newReviewCount: 2,
      });
    });
  });

  describe('当日 daily_summaries が無い場合', () => {
    it('summary は null（silent drop せず null で表現。competitors は空配列）', async () => {
      const pool = await getPool();
      const result = await queryStoreDetail(pool, ST_NO_SUMMARY_TODAY, { asOf: AS_OF });

      expect(result.summary).toBeNull();
      expect(result.competitors).toEqual([]);
      expect(result.trend).toEqual([]);
    });
  });

  it('storeId をそのまま結果に含める', async () => {
    const pool = await getPool();
    const result = await queryStoreDetail(pool, ST_NO_COMPETITORS, { asOf: AS_OF });
    expect(result.storeId).toBe(ST_NO_COMPETITORS);
  });
});
