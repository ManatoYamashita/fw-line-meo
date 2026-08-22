import type { Pool } from 'pg';

// 匿名集計の月次加算（本 spec 唯一の DB 書込・write-boundary.md: TS リアルタイム応答層）。
// 1 回答 = rating 1 行＋選択 aspect ごとに 1 行＋素材の厚み 1 行を単一トランザクションで UPSERT する。
export interface TallyInput {
  storeId: string;
  star: number;
  aspectCodes: string[];
  /**
   * 一言が入力されたか（Issue #137 段階3）。**本文は受け取らない。**
   *
   * 呼び手は下書きの素材へ渡すのと同じ値からこれを導くこと。別々に導くと「プロンプトが見た
   * 厚み」と「記録した厚み」がずれ、入力導線を変えた効果をこのデータで検証できなくなる。
   */
  hasComment: boolean;
}

// period_month は Asia/Tokyo 基準の月初日を SQL 側で確定（UTC ずれで隣月に入らない）。
// now を省略すると DB の now() を使う（本番）。テストは固定時刻を注入して JST 月境界を検証する。
const PERIOD_MONTH_SQL =
  "date_trunc('month', COALESCE($2::timestamptz, now()) AT TIME ZONE 'Asia/Tokyo')::date";

/**
 * 店舗×月の匿名集計に 1 回答分を加算する。
 * rating・全 aspect・素材の厚みを単一トランザクションで処理し、いずれか失敗時は全体を
 * ロールバックする。
 *
 * 厚みを別トランザクションに分けない理由: 部分成功すると `sum(material.count)` と
 * `sum(rating.count)` が恒久的にずれる。厚みは「観点ゼロの回答が何割か」を出すための
 * 分母つきの指標なので、母数が合わない状態は指標そのものを無意味にする。
 */
export async function incrementTallies(
  pool: Pool,
  input: TallyInput,
  now?: Date,
): Promise<void> {
  const { storeId, star, hasComment } = input;
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
    // 素材の厚み（Issue #137 段階3）。観点の選択数は **重複除去後** の件数で、
    // aspect tallies の加算件数と必ず一致する。一言は有無だけで、本文は渡ってこない。
    await client.query(
      `INSERT INTO survey_material_tallies (store_id, period_month, aspect_count, has_comment, count)
       VALUES ($1, ${PERIOD_MONTH_SQL}, $3, $4, 1)
       ON CONFLICT (store_id, period_month, aspect_count, has_comment)
       DO UPDATE SET count = survey_material_tallies.count + 1`,
      [storeId, nowParam, aspectCodes.length, hasComment],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
