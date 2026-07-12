import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, closePool } from '@fwlm/db';
import { reserveDelivery, recordDeliveryResult } from '../src/deliveries.js';

// 他テストファイルと DB を共有するため、衝突しない固有 UUID / place_id を使う（delivery-settings.db.test.ts の慣習に準拠）。
const OP = 'c0000000-0000-0000-0000-000000000001';
const AG = 'c0000000-0000-0000-0000-000000000002';
const OW = 'c0000000-0000-0000-0000-000000000011';

const ST_RETRY = 'd0000000-0000-0000-0000-000000000011'; // 二重実行の収束テスト
const ST_DELIVERED = 'd0000000-0000-0000-0000-000000000012';
const ST_FAILED = 'd0000000-0000-0000-0000-000000000013';
const ST_SKIPPED_NO_SUMMARY = 'd0000000-0000-0000-0000-000000000014';
const ST_QUOTA_EXCEEDED = 'd0000000-0000-0000-0000-000000000015';
const ST_UNRESERVED = 'd0000000-0000-0000-0000-000000000016'; // recordDeliveryResult 異常系

const TODAY = '2026-07-12';
const LINE_USER_ID = `U-${OW}`;

// retry_key は uuid 列のため有効な UUID 形式を使う。
const RETRY_KEY_1 = 'e0000000-0000-4000-8000-000000000001';
const RETRY_KEY_2 = 'e0000000-0000-4000-8000-000000000002';
const RETRY_KEY_UNRESERVED_CHECK = 'e0000000-0000-4000-8000-000000000003';
const RETRY_KEY_DELIVERED = 'e0000000-0000-4000-8000-000000000004';
const RETRY_KEY_FAILED = 'e0000000-0000-4000-8000-000000000005';
const RETRY_KEY_SKIP = 'e0000000-0000-4000-8000-000000000006';
const RETRY_KEY_QUOTA = 'e0000000-0000-4000-8000-000000000007';

async function insertStore(pool: Awaited<ReturnType<typeof getPool>>, storeId: string, placeId: string) {
  await pool.query(
    'INSERT INTO stores (id, owner_id, name, place_id, place_status) VALUES ($1, $2, $3, $4, $5)',
    [storeId, OW, `店舗 ${storeId}`, placeId, 'confirmed'],
  );
}

async function fetchRow(pool: Awaited<ReturnType<typeof getPool>>, storeId: string) {
  const res = await pool.query(
    `SELECT store_id, summary_date, line_user_id, status, retry_key, line_request_id, error_detail, delivered_at
       FROM summary_deliveries WHERE store_id = $1 AND summary_date = $2`,
    [storeId, TODAY],
  );
  return res.rows;
}

describe.skipIf(!process.env.DATABASE_URL)('deliveries (DB)', () => {
  beforeAll(async () => {
    const pool = await getPool();
    await pool.query('INSERT INTO operators (id, name) VALUES ($1, $2)', [OP, '配信記録運営']);
    await pool.query('INSERT INTO agencies (id, operator_id, name) VALUES ($1, $2, $3)', [
      AG,
      OP,
      '配信記録代理店',
    ]);
    await pool.query(
      'INSERT INTO owners (id, agency_id, line_user_id, onboarding_status) VALUES ($1, $2, $3, $4)',
      [OW, AG, LINE_USER_ID, 'active'],
    );

    for (const [storeId, suffix] of [
      [ST_RETRY, 'retry'],
      [ST_DELIVERED, 'delivered'],
      [ST_FAILED, 'failed'],
      [ST_SKIPPED_NO_SUMMARY, 'skipped'],
      [ST_QUOTA_EXCEEDED, 'quota'],
      [ST_UNRESERVED, 'unreserved'],
    ] as const) {
      await insertStore(pool, storeId, `places/delivery-${suffix}`);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  describe('reserveDelivery', () => {
    it('新規行を retry_key 付きで確保できる', async () => {
      const pool = await getPool();
      const outcome = await reserveDelivery(pool, ST_RETRY, TODAY, LINE_USER_ID, RETRY_KEY_1);
      expect(outcome).toBe('reserved');

      const rows = await fetchRow(pool, ST_RETRY);
      expect(rows).toHaveLength(1);
      expect(rows[0].retry_key).toBe(RETRY_KEY_1);
    });

    it('同一 (store_id, summary_date) への 2 回目の予約は already_processed を返し行を増やさない・上書きしない', async () => {
      const pool = await getPool();
      // 1 回目は前のテストで既に予約済み（'reserved'）。ここで 2 回目を試みる。
      const outcome = await reserveDelivery(pool, ST_RETRY, TODAY, LINE_USER_ID, RETRY_KEY_2);
      expect(outcome).toBe('already_processed');

      // 「同一対象への 2 回実行が 1 通分の記録に収束する」= 行数は 1・retry_key は 1 回目のまま。
      const rows = await fetchRow(pool, ST_RETRY);
      expect(rows).toHaveLength(1);
      expect(rows[0].retry_key).toBe(RETRY_KEY_1);
    });

    it('予約直後は CHECK 制約上の暫定 status（failed）で記録され、silent drop にならない', async () => {
      const pool = await getPool();
      const outcome = await reserveDelivery(
        pool,
        ST_UNRESERVED,
        TODAY,
        LINE_USER_ID,
        RETRY_KEY_UNRESERVED_CHECK,
      );
      expect(outcome).toBe('reserved');

      const rows = await fetchRow(pool, ST_UNRESERVED);
      expect(rows[0].status).toBe('failed');
      expect(rows[0].error_detail).toBeTruthy();
    });
  });

  describe('recordDeliveryResult', () => {
    it('delivered: line_request_id・delivered_at を含め最終結果を記録する', async () => {
      const pool = await getPool();
      await reserveDelivery(pool, ST_DELIVERED, TODAY, LINE_USER_ID, RETRY_KEY_DELIVERED);
      const deliveredAt = new Date('2026-07-12T07:00:05+09:00');

      await recordDeliveryResult(pool, ST_DELIVERED, TODAY, 'delivered', 'req-abc-123', null, deliveredAt);

      const rows = await fetchRow(pool, ST_DELIVERED);
      expect(rows[0].status).toBe('delivered');
      expect(rows[0].line_request_id).toBe('req-abc-123');
      expect(rows[0].error_detail).toBeNull();
      expect(new Date(rows[0].delivered_at as string).getTime()).toBe(deliveredAt.getTime());
    });

    it('failed: error_detail を記録し delivered_at は null のまま', async () => {
      const pool = await getPool();
      await reserveDelivery(pool, ST_FAILED, TODAY, LINE_USER_ID, RETRY_KEY_FAILED);

      await recordDeliveryResult(pool, ST_FAILED, TODAY, 'failed', 'req-fail-1', '400: invalid userId');

      const rows = await fetchRow(pool, ST_FAILED);
      expect(rows[0].status).toBe('failed');
      expect(rows[0].line_request_id).toBe('req-fail-1');
      expect(rows[0].error_detail).toBe('400: invalid userId');
      expect(rows[0].delivered_at).toBeNull();
    });

    it('skipped_no_summary: サマリー欠損対象を skip として記録する', async () => {
      const pool = await getPool();
      await reserveDelivery(pool, ST_SKIPPED_NO_SUMMARY, TODAY, LINE_USER_ID, RETRY_KEY_SKIP);

      await recordDeliveryResult(
        pool,
        ST_SKIPPED_NO_SUMMARY,
        TODAY,
        'skipped_no_summary',
        null,
        'daily_summaries not found for today',
      );

      const rows = await fetchRow(pool, ST_SKIPPED_NO_SUMMARY);
      expect(rows[0].status).toBe('skipped_no_summary');
      expect(rows[0].line_request_id).toBeNull();
      expect(rows[0].error_detail).toBe('daily_summaries not found for today');
    });

    it('quota_exceeded: 月次クォータ超過を記録する', async () => {
      const pool = await getPool();
      await reserveDelivery(pool, ST_QUOTA_EXCEEDED, TODAY, LINE_USER_ID, RETRY_KEY_QUOTA);

      await recordDeliveryResult(
        pool,
        ST_QUOTA_EXCEEDED,
        TODAY,
        'quota_exceeded',
        'req-quota-1',
        'monthly limit reached',
      );

      const rows = await fetchRow(pool, ST_QUOTA_EXCEEDED);
      expect(rows[0].status).toBe('quota_exceeded');
      expect(rows[0].error_detail).toBe('monthly limit reached');
    });

    it('異常系: reserveDelivery を経ていない対象への記録は例外を送出する（silent dropを避ける）', async () => {
      const pool = await getPool();
      const neverReservedStoreId = 'd0000000-0000-0000-0000-000000000099';
      await expect(
        recordDeliveryResult(pool, neverReservedStoreId, TODAY, 'delivered'),
      ).rejects.toThrow(/no reserved summary_deliveries row/);
    });
  });
});
