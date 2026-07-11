import type { Pool } from 'pg';

// 匿名集計の月次加算（本 spec 唯一の DB 書込・write-boundary.md: TS リアルタイム応答層）。
// 1 回答 = rating 1 行＋選択 aspect ごとに 1 行を単一トランザクションで UPSERT する。
export interface TallyInput {
  storeId: string;
  star: number;
  aspectCodes: string[];
}

// period_month は Asia/Tokyo 基準の月初日を SQL 側で確定（UTC ずれで隣月に入らない）。
// now を省略すると DB の now() を使う（本番）。テストは固定時刻を注入して JST 月境界を検証する。
const PERIOD_MONTH_SQL =
  "date_trunc('month', COALESCE($2::timestamptz, now()) AT TIME ZONE 'Asia/Tokyo')::date";

/**
 * 店舗×月の匿名集計に 1 回答分を加算する。
 * rating と全 aspect を単一トランザクションで処理し、いずれか失敗時は全体をロールバックする。
 */
export async function incrementTallies(
  pool: Pool,
  input: TallyInput,
  now?: Date,
): Promise<void> {
  const { storeId, star } = input;
  const aspectCodes = [...new Set(input.aspectCodes)]; // 同一回答内の重複は 1 回分
  const nowParam: Date | null = now ?? null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO survey_rating_tallies (store_id, period_month, star, count)
       VALUES ($1, ${PERIOD_MONTH_SQL}, $3, 1)
       ON CONFLICT (store_id, period_month, star)
       DO UPDATE SET count = survey_rating_tallies.count + 1`,
      [storeId, nowParam, star],
    );
    for (const code of aspectCodes) {
      await client.query(
        `INSERT INTO survey_aspect_tallies (store_id, period_month, aspect_code, count)
         VALUES ($1, ${PERIOD_MONTH_SQL}, $3, 1)
         ON CONFLICT (store_id, period_month, aspect_code)
         DO UPDATE SET count = survey_aspect_tallies.count + 1`,
        [storeId, nowParam, code],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
