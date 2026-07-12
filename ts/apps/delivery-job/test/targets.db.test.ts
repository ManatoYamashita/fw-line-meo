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
