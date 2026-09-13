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
const ST_LEGACY_COMPETITOR_ZERO = 'e6000000-0000-0000-0000-000000000005'; // 旧 Go: 競合の評価 0（Issue #255）
const ST_LEGACY_SELF_ZERO = 'e6000000-0000-0000-0000-000000000006'; // 旧 Go: 自店の評価 0（Issue #255）
const ST_NEW_NULL = 'e6000000-0000-0000-0000-000000000007'; // 新 Go: 評価の無い競合は null（Issue #255）

// 自店 4.3・6 店中 3 位の当日サマリーに載る競合（表示は順位の順・星差は「自店 − 競合」）。
const FIVE_COMPETITORS = [
  { name: '競合店舗1', rating: 4.5, reviewCount: 20, starDiff: -0.2 },
  { name: '競合店舗2', rating: 4.4, reviewCount: 21, starDiff: -0.1 },
  { name: '競合店舗3', rating: 4.2, reviewCount: 22, starDiff: 0.1 },
  { name: '競合店舗4', rating: 4.1, reviewCount: 23, starDiff: 0.2 },
  { name: '競合店舗5', rating: 4.0, reviewCount: 24, starDiff: 0.3 },
] as const;

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
      [ST_LEGACY_COMPETITOR_ZERO, 'places/detail-legacy-competitor-zero'],
      [ST_LEGACY_SELF_ZERO, 'places/detail-legacy-self-zero'],
      [ST_NEW_NULL, 'places/detail-new-null'],
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
    // Go が実際に書く形（rating・starDiff は JSON の数値・星差は「自店 − 競合」・表示は順位の順）に
    // 揃える。以前は文字列で書いていたが、読込時の正規化（Issue #255）は数値以外を評価として扱わない
    // ので、実物と違う形の fixture は黙って「評価なし」に化けてしまう。
    await pool.query(
      `INSERT INTO daily_summaries
         (store_id, summary_date, status, rank, rank_total, rating, review_count, new_review_count, competitors)
       VALUES ($1, $2, 'ready', 3, 6, '4.3', 80, 2, $3::jsonb)`,
      [ST_WITH_COMPETITORS, AS_OF, JSON.stringify(FIVE_COMPETITORS)],
    );
    // ST_NO_SUMMARY_TODAY: 意図的に daily_summaries を挿入しない（当日未生成のケース）。

    // --- Issue #255: Google に評価が無い店の読込時の正規化 ---
    // 旧 Go は評価の欠落をゼロ値 0 として書いていた。新 Go は null を書き、比較集合から外す。
    await pool.query(
      `INSERT INTO daily_summaries
         (store_id, summary_date, status, rank, rank_total, rank_prev, rating, review_count, rating_prev,
          review_count_prev, new_review_count, competitors)
       VALUES ($1, $2, 'ready', 1, 6, 1, '4.3', 2288, '4.3', 2286, 2, $3::jsonb)`,
      [
        ST_LEGACY_COMPETITOR_ZERO,
        AS_OF,
        JSON.stringify([
          { name: '競合イチ', rating: 4.0, reviewCount: 300, starDiff: 0.3 },
          { name: '競合ニ', rating: 3.9, reviewCount: 200, starDiff: 0.4 },
          { name: '競合サン', rating: 3.7, reviewCount: 100, starDiff: 0.6 },
          { name: '競合ヨン', rating: 3.3, reviewCount: 50, starDiff: 1.0 },
          { name: '競合ゴ', rating: 0, reviewCount: 0, starDiff: 4.3 },
        ]),
      ],
    );
    await pool.query(
      `INSERT INTO daily_summaries
         (store_id, summary_date, status, rank, rank_total, rank_prev, rating, review_count, rating_prev,
          review_count_prev, new_review_count, competitors)
       VALUES ($1, $2, 'ready', 3, 3, 3, '0.0', 0, '0.0', 0, 0, $3::jsonb)`,
      [
        ST_LEGACY_SELF_ZERO,
        AS_OF,
        JSON.stringify([
          { name: '競合イチ', rating: 4.5, reviewCount: 120, starDiff: -4.5 },
          { name: '競合ニ', rating: 4.0, reviewCount: 80, starDiff: -4.0 },
        ]),
      ],
    );
    // 旧 Go は自店の評価が無い日も rating 0・順位つきでスナップショットへ書いていた。
    await pool.query(
      `INSERT INTO rating_snapshots (store_id, subject_kind, competitor_id, place_id, captured_on, rating, review_count, rank)
       VALUES ($1, 'self', NULL, 'places/detail-legacy-self-zero', $2, 0, 0, 3)`,
      [ST_LEGACY_SELF_ZERO, AS_OF],
    );
    await pool.query(
      `INSERT INTO daily_summaries
         (store_id, summary_date, status, rank, rank_total, rank_prev, rating, review_count, rating_prev,
          review_count_prev, new_review_count, competitors)
       VALUES ($1, $2, 'ready', 2, 3, 2, '4.3', 50, '4.3', 50, 0, $3::jsonb)`,
      [
        ST_NEW_NULL,
        AS_OF,
        JSON.stringify([
          { name: '競合イチ', rating: 4.5, reviewCount: 100, starDiff: -0.2 },
          { name: '競合ニ', rating: 4.0, reviewCount: 30, starDiff: 0.3 },
          { name: '競合サン', rating: null, reviewCount: 0, starDiff: null },
        ]),
      ],
    );
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

      // 名前の並びだけでなく値まで固定する（形の違う fixture が黙って別の値に化けても気づけるように）。
      expect(result.competitors).toEqual(FIVE_COMPETITORS);
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

  describe('Google に評価が無い店の正規化（Issue #255）', () => {
    it('旧 Go の評価 0 の競合を「評価なし」として読み、水増しされた母数をその件数だけ戻す', async () => {
      const pool = await getPool();
      const result = await queryStoreDetail(pool, ST_LEGACY_COMPETITOR_ZERO, { asOf: AS_OF });

      // 評価 0 の店は常に最下位に数えられていたので、自店の順位は正しく、母数だけが 1 つ多い。
      expect(result.summary).toMatchObject({ rank: 1, rankTotal: 5, rankPrev: 1, rating: '4.3', ratingPrev: '4.3' });
      expect(result.competitors).toEqual([
        { name: '競合イチ', rating: 4.0, reviewCount: 300, starDiff: 0.3 },
        { name: '競合ニ', rating: 3.9, reviewCount: 200, starDiff: 0.4 },
        { name: '競合サン', rating: 3.7, reviewCount: 100, starDiff: 0.6 },
        { name: '競合ヨン', rating: 3.3, reviewCount: 50, starDiff: 1.0 },
        { name: '競合ゴ', rating: null, reviewCount: 0, starDiff: null },
      ]);
    });

    it('旧 Go の自店の評価 0 を「評価なし」として読み、順位と星差を持たせない', async () => {
      const pool = await getPool();
      const result = await queryStoreDetail(pool, ST_LEGACY_SELF_ZERO, { asOf: AS_OF });

      expect(result.summary).toMatchObject({
        rating: null,
        ratingPrev: null,
        rank: null,
        rankTotal: null,
        rankPrev: null,
        reviewCount: 0,
      });
      // 競合自身の評価は残し、自店と比べられない星差だけを消す。
      expect(result.competitors).toEqual([
        { name: '競合イチ', rating: 4.5, reviewCount: 120, starDiff: null },
        { name: '競合ニ', rating: 4.0, reviewCount: 80, starDiff: null },
      ]);
      // 推移も同じ規則で読む（評価の無い日は順位を持たない）。
      expect(result.trend).toEqual([{ capturedOn: AS_OF, rank: null, rating: null, reviewCount: 0 }]);
    });

    it('新 Go の null はそのまま読み、母数を二重に引かない', async () => {
      const pool = await getPool();
      const result = await queryStoreDetail(pool, ST_NEW_NULL, { asOf: AS_OF });

      expect(result.summary).toMatchObject({ rank: 2, rankTotal: 3 });
      expect(result.competitors).toEqual([
        { name: '競合イチ', rating: 4.5, reviewCount: 100, starDiff: -0.2 },
        { name: '競合ニ', rating: 4.0, reviewCount: 30, starDiff: 0.3 },
        { name: '競合サン', rating: null, reviewCount: 0, starDiff: null },
      ]);
    });
  });

  it('storeId をそのまま結果に含める', async () => {
    const pool = await getPool();
    const result = await queryStoreDetail(pool, ST_NO_COMPETITORS, { asOf: AS_OF });
    expect(result.storeId).toBe(ST_NO_COMPETITORS);
  });
});
