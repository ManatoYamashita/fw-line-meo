import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '@fwlm/db';
import { queryDeliveryTargets, queryOwnersDueWithoutSummary } from '../src/targets.js';

// 他テストファイルと DB を共有するため、衝突しない固有 UUID / place_id を使う（delivery-settings.db.test.ts の慣習に準拠）。
const OP = 'a0000000-0000-0000-0000-000000000001';
const AG = 'a0000000-0000-0000-0000-000000000002';

const OW_READY = 'a0000000-0000-0000-0000-000000000011'; // hour=9・当日summary有・未配信 → 対象
const OW_WRONG_HOUR = 'a0000000-0000-0000-0000-000000000012'; // hour=10 → 除外
const OW_NO_SUMMARY = 'a0000000-0000-0000-0000-000000000013'; // hour=9・当日summary無 → skip候補
const OW_ALREADY_DELIVERED = 'a0000000-0000-0000-0000-000000000014'; // hour=9・当日summary有・配信済 → 除外
const OW_UNCONFIRMED = 'a0000000-0000-0000-0000-000000000015'; // hour=9・place_status=pending → 両方から除外

const ST_READY = 'b0000000-0000-0000-0000-000000000011';
const ST_WRONG_HOUR = 'b0000000-0000-0000-0000-000000000012';
const ST_NO_SUMMARY = 'b0000000-0000-0000-0000-000000000013';
const ST_ALREADY_DELIVERED = 'b0000000-0000-0000-0000-000000000014';
const ST_UNCONFIRMED = 'b0000000-0000-0000-0000-000000000015';

const TARGET_HOUR = 9;
const TODAY = '2026-07-12';

describe.skipIf(!process.env.DATABASE_URL)('targets (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();

    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '配信対象運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      '配信対象代理店',
    ]);

    const owners: Array<[string, number]> = [
      [OW_READY, TARGET_HOUR],
      [OW_WRONG_HOUR, TARGET_HOUR + 1],
      [OW_NO_SUMMARY, TARGET_HOUR],
      [OW_ALREADY_DELIVERED, TARGET_HOUR],
      [OW_UNCONFIRMED, TARGET_HOUR],
    ];
    for (const [id, hour] of owners) {
      await pool.query(
        'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status, delivery_hour) VALUES ($1, $2, $3, $4, $5)',
        [id, AG, `U-${id}`, 'active', hour],
      );
    }

    const stores: Array<[string, string, string, boolean]> = [
      [ST_READY, OW_READY, 'places/target-ready', true],
      [ST_WRONG_HOUR, OW_WRONG_HOUR, 'places/target-wrong-hour', true],
      [ST_NO_SUMMARY, OW_NO_SUMMARY, 'places/target-no-summary', true],
      [ST_ALREADY_DELIVERED, OW_ALREADY_DELIVERED, 'places/target-already-delivered', true],
      [ST_UNCONFIRMED, OW_UNCONFIRMED, 'places/target-unconfirmed', false],
    ];
    for (const [id, ownerId, placeId, confirmed] of stores) {
      if (confirmed) {
        await pool.query(
          'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
          [id, ownerId, `店舗 ${id}`, placeId, 'confirmed'],
        );
      } else {
        await pool.query('INSERT INTO stores (id, owner_id, name) VALUES ($1, $2, $3)', [
          id,
          ownerId,
          `店舗 ${id}`,
        ]);
      }
    }

    // 当日 daily_summaries: ready 対象・wrong-hour 対象・already-delivered 対象のみに用意する
    // （no-summary / unconfirmed は意図的に未挿入）。
    for (const storeId of [ST_READY, ST_WRONG_HOUR, ST_ALREADY_DELIVERED]) {
      await pool.query(
        `INSERT INTO daily_summaries (store_id, summary_date, status, rank, rank_total, rating, review_count, new_review_count)
         VALUES ($1, $2, 'ready', 1, 3, '4.5', 100, 0)`,
        [storeId, TODAY],
      );
    }

    // already-delivered には summary_deliveries 行も用意し「未配信」条件から外れることを検証する。
    await pool.query(
      `INSERT INTO summary_deliveries (store_id, summary_date, line_user_id, status, retry_key)
       VALUES ($1, $2, $3, 'delivered', gen_random_uuid())`,
      [ST_ALREADY_DELIVERED, TODAY, `U-${OW_ALREADY_DELIVERED}`],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  describe('queryDeliveryTargets', () => {
    it('正しい配信時刻・当日summary有・未配信の対象のみを返す', async () => {
      const pool = await getPool();
      const targets = await queryDeliveryTargets(pool, TARGET_HOUR, TODAY);

      const storeIds = targets.map((t) => t.storeId);
      expect(storeIds).toContain(ST_READY);
      expect(storeIds).not.toContain(ST_WRONG_HOUR);
      expect(storeIds).not.toContain(ST_NO_SUMMARY);
      expect(storeIds).not.toContain(ST_ALREADY_DELIVERED);
      expect(storeIds).not.toContain(ST_UNCONFIRMED);
    });

    it('対象の summary/lineUserId が daily_summaries・owners の実データと一致する', async () => {
      const pool = await getPool();
      const targets = await queryDeliveryTargets(pool, TARGET_HOUR, TODAY);
      const target = targets.find((t) => t.storeId === ST_READY);

      expect(target).toBeDefined();
      expect(target?.lineUserId).toBe(`U-${OW_READY}`);
      expect(target?.summary.status).toBe('ready');
      expect(target?.summary.rank).toBe(1);
      expect(target?.summary.store_id).toBe(ST_READY);
    });

    it('異なる配信時刻を指定すると wrong-hour 対象が返る', async () => {
      const pool = await getPool();
      const targets = await queryDeliveryTargets(pool, TARGET_HOUR + 1, TODAY);
      expect(targets.map((t) => t.storeId)).toContain(ST_WRONG_HOUR);
    });

    it('異常系: 範囲外の時刻は例外を送出する', async () => {
      const pool = await getPool();
      await expect(queryDeliveryTargets(pool, 24, TODAY)).rejects.toThrow(RangeError);
      await expect(queryDeliveryTargets(pool, -1, TODAY)).rejects.toThrow(RangeError);
    });
  });

  describe('queryOwnersDueWithoutSummary', () => {
    it('配信時刻は該当するが当日summaryが無い対象をskip候補として検出する（silent dropしない）', async () => {
      const pool = await getPool();
      const skipCandidates = await queryOwnersDueWithoutSummary(pool, TARGET_HOUR, TODAY);
      const storeIds = skipCandidates.map((c) => c.storeId);

      expect(storeIds).toContain(ST_NO_SUMMARY);
      // summary が既にある対象は skip 候補ではない。
      expect(storeIds).not.toContain(ST_READY);
      expect(storeIds).not.toContain(ST_ALREADY_DELIVERED);
      // 未確定店舗（place_status=pending）は「特定済み」ではないため skip 候補にもならない。
      expect(storeIds).not.toContain(ST_UNCONFIRMED);
    });

    it('lineUserId が owners の実データと一致する', async () => {
      const pool = await getPool();
      const skipCandidates = await queryOwnersDueWithoutSummary(pool, TARGET_HOUR, TODAY);
      const candidate = skipCandidates.find((c) => c.storeId === ST_NO_SUMMARY);
      expect(candidate?.lineUserId).toBe(`U-${OW_NO_SUMMARY}`);
    });

    it('既に summary_deliveries が記録済み（前回実行でskip記録済み等）の対象は再検出しない', async () => {
      const pool = await getPool();
      // ST_NO_SUMMARY に skipped_no_summary を記録した状態を模して再検出されないことを確認する。
      await pool.query(
        `INSERT INTO summary_deliveries (store_id, summary_date, line_user_id, status, retry_key)
         VALUES ($1, $2, $3, 'skipped_no_summary', gen_random_uuid())`,
        [ST_NO_SUMMARY, TODAY, `U-${OW_NO_SUMMARY}`],
      );

      const skipCandidates = await queryOwnersDueWithoutSummary(pool, TARGET_HOUR, TODAY);
      expect(skipCandidates.map((c) => c.storeId)).not.toContain(ST_NO_SUMMARY);
    });

    it('異常系: 範囲外の時刻は例外を送出する', async () => {
      const pool = await getPool();
      await expect(queryOwnersDueWithoutSummary(pool, 24, TODAY)).rejects.toThrow(RangeError);
    });
  });
});

// Issue #255: Google に評価が無い店（クチコミ 0 件）の読込時の正規化。
//
// 旧 Go は評価の欠落をゼロ値 0 として書いていた（本番の実物: 競合 5 店のうち 1 店が rating 0・
// reviewCount 0 で、比較集合の最下位に数えられ rank_total を 1 つ水増ししていた）。新 Go は null を書き、
// 比較集合から外す。配信は両方の形を読む（デプロイ当日は旧 Go が 06:00 に書いた行を後の配信時刻に読む）
// ので、読込境界で同じ形へ揃えることを実データで固定する。
//
// 上の describe と日付・時刻・識別子を分け、互いの件数検査を汚さない。
const UNRATED_OP = 'a1000000-0000-0000-0000-000000000001';
const UNRATED_AG = 'a1000000-0000-0000-0000-000000000002';
const OW_LEGACY_COMPETITOR_ZERO = 'a1000000-0000-0000-0000-000000000011';
const OW_LEGACY_SELF_ZERO = 'a1000000-0000-0000-0000-000000000012';
const OW_NEW_NULL = 'a1000000-0000-0000-0000-000000000013';
const ST_LEGACY_COMPETITOR_ZERO = 'b1000000-0000-0000-0000-000000000011';
const ST_LEGACY_SELF_ZERO = 'b1000000-0000-0000-0000-000000000012';
const ST_NEW_NULL = 'b1000000-0000-0000-0000-000000000013';
const UNRATED_HOUR = 11;
const UNRATED_DAY = '2026-07-13';

describe.skipIf(!process.env.DATABASE_URL)('targets (DB) — 評価の無い店の正規化（Issue #255）', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [UNRATED_OP, '未評価正規化運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      UNRATED_AG,
      UNRATED_OP,
      '未評価正規化代理店',
    ]);

    const rows: Array<{
      readonly owner: string;
      readonly store: string;
      readonly rank: number;
      readonly rankTotal: number;
      readonly rankPrev: number | null;
      readonly rating: string;
      readonly reviewCount: number;
      readonly ratingPrev: string | null;
      readonly competitors: ReadonlyArray<{ name: string; rating: number | null; reviewCount: number; starDiff: number | null }>;
    }> = [
      {
        // 旧 Go・自店に評価あり: 評価 0 の競合が最下位に数えられ、rank_total が 1 つ多い。
        owner: OW_LEGACY_COMPETITOR_ZERO,
        store: ST_LEGACY_COMPETITOR_ZERO,
        rank: 1,
        rankTotal: 6,
        rankPrev: 1,
        rating: '4.3',
        reviewCount: 2288,
        ratingPrev: '4.3',
        competitors: [
          { name: '競合イチ', rating: 4.0, reviewCount: 300, starDiff: 0.3 },
          { name: '競合ニ', rating: 3.9, reviewCount: 200, starDiff: 0.4 },
          { name: '競合サン', rating: 3.7, reviewCount: 100, starDiff: 0.6 },
          { name: '競合ヨン', rating: 3.3, reviewCount: 50, starDiff: 1.0 },
          { name: '競合ゴ', rating: 0, reviewCount: 0, starDiff: 4.3 },
        ],
      },
      {
        // 旧 Go・自店に評価なし: 自店が 0 として順位付けされ、星差も「0 − 競合」になっている。
        owner: OW_LEGACY_SELF_ZERO,
        store: ST_LEGACY_SELF_ZERO,
        rank: 3,
        rankTotal: 3,
        rankPrev: 3,
        rating: '0.0',
        reviewCount: 0,
        ratingPrev: '0.0',
        competitors: [
          { name: '競合イチ', rating: 4.5, reviewCount: 120, starDiff: -4.5 },
          { name: '競合ニ', rating: 4.0, reviewCount: 80, starDiff: -4.0 },
        ],
      },
      {
        // 新 Go: 評価の無い店は null で書かれ、rank_total には最初から数えられていない。
        owner: OW_NEW_NULL,
        store: ST_NEW_NULL,
        rank: 2,
        rankTotal: 3,
        rankPrev: 2,
        rating: '4.3',
        reviewCount: 50,
        ratingPrev: '4.3',
        competitors: [
          { name: '競合イチ', rating: 4.5, reviewCount: 100, starDiff: -0.2 },
          { name: '競合ニ', rating: 4.0, reviewCount: 30, starDiff: 0.3 },
          { name: '競合サン', rating: null, reviewCount: 0, starDiff: null },
        ],
      },
    ];

    for (const row of rows) {
      await pool.query(
        'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status, delivery_hour) VALUES ($1, $2, $3, $4, $5)',
        [row.owner, UNRATED_AG, `U-${row.owner}`, 'active', UNRATED_HOUR],
      );
      await pool.query(
        'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
        [row.store, row.owner, `店舗 ${row.store}`, `places/${row.store}`, 'confirmed'],
      );
      await pool.query(
        `INSERT INTO daily_summaries
           (store_id, summary_date, status, rank, rank_total, rank_prev, rating, review_count, rating_prev,
            review_count_prev, new_review_count, competitors)
         VALUES ($1, $2, 'ready', $3, $4, $5, $6, $7, $8, $7, 0, $9::jsonb)`,
        [
          row.store,
          UNRATED_DAY,
          row.rank,
          row.rankTotal,
          row.rankPrev,
          row.rating,
          row.reviewCount,
          row.ratingPrev,
          JSON.stringify(row.competitors),
        ],
      );
    }
  });

  afterAll(async () => {
    await closePool();
  });

  async function summaryOf(storeId: string) {
    const pool = await getPool();
    const targets = await queryDeliveryTargets(pool, UNRATED_HOUR, UNRATED_DAY);
    const target = targets.find((t) => t.storeId === storeId);
    if (target === undefined) {
      throw new Error(`target ${storeId} not found`);
    }
    return target.summary;
  }

  it('旧 Go の評価 0 の競合を「評価なし」として読み、水増しされた母数をその件数だけ戻す', async () => {
    const summary = await summaryOf(ST_LEGACY_COMPETITOR_ZERO);

    // 評価 0 の店は常に最下位に数えられていたので、自店の順位は正しく、母数だけが 1 つ多い。
    expect(summary.rank).toBe(1);
    expect(summary.rank_total).toBe(5);
    expect(summary.rank_prev).toBe(1);
    expect(summary.rating).toBe('4.3');
    expect(summary.competitors).toEqual([
      { name: '競合イチ', rating: 4.0, reviewCount: 300, starDiff: 0.3 },
      { name: '競合ニ', rating: 3.9, reviewCount: 200, starDiff: 0.4 },
      { name: '競合サン', rating: 3.7, reviewCount: 100, starDiff: 0.6 },
      { name: '競合ヨン', rating: 3.3, reviewCount: 50, starDiff: 1.0 },
      { name: '競合ゴ', rating: null, reviewCount: 0, starDiff: null },
    ]);
  });

  it('旧 Go の自店の評価 0 を「評価なし」として読み、順位と星差を持たせない', async () => {
    const summary = await summaryOf(ST_LEGACY_SELF_ZERO);

    expect(summary.rating).toBeNull();
    expect(summary.rating_prev).toBeNull();
    expect(summary.rank).toBeNull();
    expect(summary.rank_total).toBeNull();
    expect(summary.rank_prev).toBeNull();
    expect(summary.review_count).toBe(0);
    // 競合自身の評価は残し、自店と比べられない星差だけを消す。
    expect(summary.competitors).toEqual([
      { name: '競合イチ', rating: 4.5, reviewCount: 120, starDiff: null },
      { name: '競合ニ', rating: 4.0, reviewCount: 80, starDiff: null },
    ]);
  });

  it('新 Go の null はそのまま読み、母数を二重に引かない', async () => {
    const summary = await summaryOf(ST_NEW_NULL);

    expect(summary.rank).toBe(2);
    expect(summary.rank_total).toBe(3);
    expect(summary.competitors).toEqual([
      { name: '競合イチ', rating: 4.5, reviewCount: 100, starDiff: -0.2 },
      { name: '競合ニ', rating: 4.0, reviewCount: 30, starDiff: 0.3 },
      { name: '競合サン', rating: null, reviewCount: 0, starDiff: null },
    ]);
  });
});
